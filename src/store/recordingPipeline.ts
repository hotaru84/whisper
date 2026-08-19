/**
 * The re-transcribe/diarize/audio-tag accuracy pass that runs after a
 * recording stops (`refineRecording`, `finishRecordOnly`'s record-only
 * counterpart, and the shared `runAccuracyPipeline` core also reused by
 * `reanalyzeHistoryEntry`), plus the live-streaming append helpers that feed
 * the same session timeline (`timeline.ts`) this pipeline rebases onto.
 *
 * Ownership split with `src/store/analysisQueue.ts`: this module owns *what*
 * a job's steps are (model calls, timeline rebasing, history persistence);
 * `analysisQueue.ts` owns *when* a job runs (queueing, per-recording status,
 * cancellation requests) and is the only one of the two that imports the
 * other, so this module never needs to know a queue exists above it --
 * status updates go out through the `onStatus` callback parameters below,
 * and a job that was asked to stop is discovered through `wasCancelled`,
 * both supplied by the caller rather than read from any shared store here.
 *
 * `useAppStore` is only ever read via `.getState()`/`.setState()` inside
 * function bodies here, never at module top level -- same as `clients.ts`,
 * this is safe despite `appStore.ts` importing back from this module.
 */
import type {
  RecordingCapture,
  StreamingSegment,
  AudioEvent,
  TranscribeResult,
  DiarizeSettings,
  VadSettings,
  HallucinationSettings,
  AudioEventSettings,
} from "../lib/asr";
import { isCancelledError, DIARIZATION_MODEL_UNAVAILABLE, runWhisperTask, WHISPER_PRIORITY_BACKGROUND } from "../lib/asr";
import type { TranscriptSegment } from "../lib/transcript";
import { nonBlankChunks, projectOntoNonBlankChunks, segmentsFromResult } from "../lib/transcript";
import { saveRecordingHistory, wavPath } from "../lib/history";
import { autoSaveTranscript } from "../lib/export/autoSave";
import { toErrorMessage } from "../lib/errors";
import type { AsrSettings } from "./persistedSettings";
import { asrClient } from "./clients";
import {
  consumeSegmentId,
  peekNextSegmentId,
  consumeSegmentIds,
  getTimelineBaseSec,
  getRecordingBaseSec,
} from "./timeline";
import { useAppStore, markRecordingViewed } from "./appStore";

/** The filename stem `capture.rs` uses for both the WAV and (once
 * `history.ts` writes it) its sidecar JSON, extracted from the full path
 * `capture.finish()` returns. Handles both path separator styles since the
 * Rust side reports a native (backslash, on Windows) path. */
export function idFromWavPath(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  return base.replace(/\.wav$/i, "");
}

// Appends a streaming segment (offset relative to the current recording) onto the
// global transcript timeline.
export function appendStreamingSegment(seg: StreamingSegment): void {
  const segment: TranscriptSegment = {
    id: consumeSegmentId(),
    startOffsetSec: getTimelineBaseSec() + seg.offsetSec,
    text: seg.text,
    chunks: seg.chunks,
  };
  useAppStore.setState((s) => ({ segments: [...s.segments, segment] }));
}

// Appends a live window's audio-tagging results (on the current recording's
// own 0-based timeline) onto the global audioEvents timeline. Mirrors
// refineRecording's own rebase of the post-hoc pass's events -- see
// PlaybackState.timelineOffsetSec's doc comment for the same "own timeline
// vs. global timeline" distinction.
export function appendLiveAudioEvents(events: AudioEvent[]): void {
  const base = getRecordingBaseSec();
  const rebased = events.map((e) => ({
    ...e,
    start: e.start + base,
    end: e.end + base,
  }));
  useAppStore.setState((s) => ({
    audioEvents: [...s.audioEvents, ...rebased],
  }));
}

/** What `runAccuracyPipeline` produces: the re-transcription, plus whatever
 * diarization/audio-tagging managed to add, plus any user-facing notices
 * about the parts that did not go perfectly (never a hard failure -- see the
 * function's own doc). */
interface AccuracyPipelineResult {
  result: TranscribeResult;
  speakers?: Array<number | null>;
  excluded?: boolean[];
  newEvents: AudioEvent[];
  notices: string[];
}

/** `runAccuracyPipeline`'s return: either a completed pass, or the fact that
 * the user cancelled it. A cancellation carries nothing else -- every partial
 * result is discarded, because what it is being weighed against is a
 * transcript the user already has on screen. */
type AccuracyPipelineOutcome =
  | ({ cancelled: false } & AccuracyPipelineResult)
  | { cancelled: true };

/** The two stages of `runAccuracyPipeline` worth reporting live: while the
 * whisper-touching transcription call is (queued, then) actually running,
 * and everything after it (diarization/audio-tagging, which run concurrently
 * with each other and don't touch the whisper model at all). Queued/done/
 * cancelled/error are the caller's (`analysisQueue.ts`'s) own bookkeeping,
 * not something this pipeline reports -- it only knows about its own two
 * internal stages. */
export type AnalysisPipelineStatus = "transcribing" | "post-processing";

/**
 * The re-transcribe/diarize/audio-tag sequence shared by `refineRecording`
 * (a just-finished live recording) and `reanalyzeHistoryEntry` (any past one,
 * typically after the user changed a setting). Everything here operates on
 * `path`'s own 0-based timeline; rebasing onto a session's global timeline
 * (if the caller even has one -- `reanalyzeHistoryEntry` does not) is the
 * caller's job, same as `nonBlankChunks`' doc comment already describes.
 *
 * `jobId` (the recording id) identifies this pass to the backend's per-job
 * cancel flag (`cancel.rs`) and whisper progress events, and to
 * `src/lib/asr/whisperQueue.ts`'s priority queue -- the actual
 * `transcribeRecording` call is submitted there at
 * `WHISPER_PRIORITY_BACKGROUND` rather than invoked directly, so it queues
 * behind (or, per the queue's priority rule, is jumped by) whatever else is
 * using the model rather than racing it. `onStatus` fires as this pass moves
 * between its two stages -- see `AnalysisPipelineStatus`.
 *
 * Diarization/audio-tagging failures are collected as notices rather than
 * thrown: a transcript without speaker labels or event filtering is still
 * the whole point of this pass, so losing the transcript over either would
 * be a much worse trade than just not having that one extra.
 *
 * A *cancellation* is not a failure and so is not a notice: it aborts the
 * remaining stages and returns `{ cancelled: true }`. Without that
 * distinction, one press of the cancel button would produce a "話者分離に失敗
 * した" and a "音響イベント検出に失敗しました" on the way out.
 *
 * Being the one entry point both callers share also makes this the right
 * place to clear the backend's cancel flag for this job at the start
 * (`beginAnalysis`) and release it once this pass is fully done
 * (`endAnalysis`, in `finally`) -- see `cancel.rs`'s per-job map.
 */
export async function runAccuracyPipeline(
  jobId: string,
  path: string,
  settings: AsrSettings,
  vadSettings: VadSettings,
  diarizeSettings: DiarizeSettings,
  audioEventSettings: AudioEventSettings,
  hallucinationSettings: HallucinationSettings,
  onStatus?: (status: AnalysisPipelineStatus) => void,
): Promise<AccuracyPipelineOutcome> {
  await asrClient.beginAnalysis(jobId);

  try {
    const notices: string[] = [];
    let result: TranscribeResult;
    try {
      result = await runWhisperTask(
        WHISPER_PRIORITY_BACKGROUND,
        () => asrClient.transcribeRecording(path, jobId, settings, vadSettings, hallucinationSettings),
        () => onStatus?.("transcribing"),
      ).promise;
    } catch (err) {
      // Only a cancellation is caught here -- a real failure still propagates,
      // so the caller keeps its "the second pass broke, hold on to the live
      // transcript" path exactly as before.
      if (isCancelledError(err)) return { cancelled: true };
      throw err;
    }
    onStatus?.("post-processing");
    if (result.vadUnavailable) {
      notices.push(
        "VAD 用のモデルファイルが見つからないため、VAD 無しで実行しました。README の手順でモデルを配置すると有効になります。",
      );
    }
    // A regression signal, not an accuracy score (see QualityReport's doc
    // comment): voicedGapSec is audio the RMS gate says holds speech but no
    // cue covers, so a few seconds of it is worth surfacing even though the
    // pipeline gave no error.
    if ((result.quality?.voicedGapSec ?? 0) >= 1) {
      notices.push(
        `音声があるのに文字起こしされなかった区間が約${result.quality!.voicedGapSec.toFixed(1)}秒あります（無音以外の理由でスキップされた可能性があります）。`,
      );
    }
    // mark_silent_segments flags rather than drops (see its doc comment), so
    // this is purely informational -- the flagged chunks already render as a
    // "無音" placeholder via segmentsFromResult's `silent` parameter.
    if (result.silence && result.silence.length === result.chunks.length) {
      const silentDurationSec = result.chunks.reduce((sum, c, i) => {
        if (!result.silence![i].silent) return sum;
        const end = c.timestamp[1] ?? c.timestamp[0];
        return sum + Math.max(0, end - c.timestamp[0]);
      }, 0);
      const silentCount = result.silence.filter((m) => m.silent).length;
      if (silentCount > 0) {
        notices.push(
          `無音と判定されて除外された区間が${silentCount}件、合計約${silentDurationSec.toFixed(1)}秒あります（RMS < ${hallucinationSettings.silenceRms}）。`,
        );
      }
    }

    // Diarization and audio tagging both read the same WAV on its own 0-based
    // timeline, so they have to run on result.chunks *before* segmentsFromResult
    // rebases anything -- see nonBlankChunks' doc comment.
    const targets = nonBlankChunks(result).map((c) => c.timestamp);

    // Independent Rust-side commands -- diarization is sherpa-onnx, audio
    // tagging loads its own model per call (see events.rs's module doc), and
    // neither touches the whisper model's mutex (or this queue) the way
    // transcribeRecording above does -- so they're started together rather
    // than one `await`ed before the other even begins, and can run alongside
    // a *different* job's transcription too. Both invoke() calls fire before
    // either is awaited, so the two spawn_blocking passes actually overlap
    // instead of stacking their multi-minute runtimes back to back.
    const diarizePromise =
      diarizeSettings.enabled && targets.length > 0
        ? asrClient.diarizeRecording(path, jobId, targets, diarizeSettings)
        : undefined;
    const audioEventsPromise =
      audioEventSettings.enabled && targets.length > 0
        ? asrClient.detectAudioEvents(path, jobId, targets, audioEventSettings)
        : undefined;

    let speakers: Array<number | null> | undefined;
    if (diarizePromise) {
      try {
        speakers = await diarizePromise;
      } catch (err) {
        if (isCancelledError(err)) return { cancelled: true };
        // Distinguished from a genuine failure so the common case -- diarization
        // defaults on, but its model files are an opt-in download most installs
        // never make -- reads the same as vadUnavailable's calm guidance rather
        // than an alarming "failed" notice on every single recording.
        notices.push(
          String(err).includes(DIARIZATION_MODEL_UNAVAILABLE)
            ? "話者分離用のモデルファイルが見つからないため、話者ラベルなしで実行しました。README の手順でモデルを配置すると有効になります。"
            : `話者分離に失敗したため、話者ラベルは付きません（文字起こし自体はそのまま使えます）: ${toErrorMessage(err)}`,
        );
      }
    }

    let excluded: boolean[] | undefined;
    let newEvents: AudioEvent[] = [];
    if (audioEventsPromise) {
      try {
        const eventResult = await audioEventsPromise;
        excluded = eventResult.exclude;
        newEvents = eventResult.events;
      } catch (err) {
        if (isCancelledError(err)) return { cancelled: true };
        notices.push(
          `音響イベント検出に失敗しました（文字起こし自体はそのまま使えます）: ${toErrorMessage(err)}`,
        );
      }
    }

    return { cancelled: false, result, speakers, excluded, newEvents, notices };
  } finally {
    // Best-effort hygiene: freeing this job's entry in the backend's cancel
    // map costs nothing to skip on failure, and must never mask whatever
    // outcome the `try` above already produced.
    try {
      await asrClient.endAnalysis(jobId);
    } catch (err) {
      console.warn(`[asr] failed to clear cancel state for job ${jobId}:`, err);
    }
  }
}

/**
 * Files a take in history: the sidecar, then the list refresh the sidebar
 * reads, then `markRecordingViewed`. Shared by `refineRecording`'s completed
 * and cancelled paths, which differ only in what goes into the entry.
 *
 * The refresh is awaited rather than fire-and-forget: only once
 * `recordingHistory` actually contains this entry does `markRecordingViewed`
 * have anything for `TranscriptPanel`/`HistorySidebar` to find by id. A `void`
 * here let `viewedRecordingId` become "correct" a beat before the sidebar list
 * caught up, so the delete button and the "履歴を表示中" banner both failed
 * their lookup for the length of that IPC round-trip -- the same bug
 * `finishRecordOnly` already avoids by awaiting the equivalent call.
 *
 * Returns whether it worked, and reports failure as a notice rather than
 * throwing: the transcript on screen (and its place in this session) is
 * unaffected, only future browsing of this take from the sidebar is lost,
 * which is a much smaller loss than any other failure path around it.
 */
async function persistTake(
  recordingId: string,
  entry: Parameters<typeof saveRecordingHistory>[1],
): Promise<boolean> {
  try {
    await saveRecordingHistory(recordingId, entry);
    await useAppStore.getState().refreshRecordingHistory();
    markRecordingViewed(recordingId);
    // Best-effort, same as the history write above: a failure here loses
    // only this take's auto-saved copy, not anything already on screen or
    // already filed in history.
    if (entry.transcribed && entry.segments.length > 0) {
      const { autoSaveSettings } = useAppStore.getState();
      if (autoSaveSettings.directory) {
        try {
          await autoSaveTranscript(entry.segments, recordingId, autoSaveSettings.directory);
        } catch (err) {
          console.warn(`[autosave] failed to write transcript for ${recordingId}:`, err);
        }
      }
    }
    return true;
  } catch (err) {
    useAppStore.setState({
      refineNotice: `録音履歴への保存に失敗しました（今の文字起こしはそのまま使えます）: ${toErrorMessage(err)}`,
    });
    return false;
  }
}

/**
 * This take's live output so far, rebased onto the recording's own 0-based
 * timeline with freshly sequential ids -- the same convention every history
 * write uses. Shared by every place that has to file *something* in history
 * before (or instead of) the accuracy pass has a result of its own: the
 * pass being cancelled, the pass never getting a chance to run at all, and
 * (below) the provisional entry `fileTakeProvisionally` writes immediately on
 * stop so the take is not invisible to the sidebar for however long the
 * pass takes.
 *
 * Reads the *current* global `segments`/`audioEvents` -- safe only while this
 * recording is still the one those represent on screen. Every caller must
 * check that first (see `refineRecording`/`finishCancelledTake`'s own
 * `viewedRecordingId` guards): once a later recording has taken over --
 * another take started in the same session, or the user browsed elsewhere --
 * these arrays no longer describe *this* recording alone, and slicing them
 * here would mix the two takes' segments together.
 */
function liveTakeSnapshot(
  baseSec: number,
  keptSegments: number,
): { segments: TranscriptSegment[]; audioEvents: AudioEvent[]; hasText: boolean } {
  const state = useAppStore.getState();
  const liveSegments = state.segments.slice(keptSegments);
  const segments = liveSegments.map((s, i) => ({
    ...s,
    id: i + 1,
    startOffsetSec: s.startOffsetSec - baseSec,
  }));
  const audioEvents = state.audioEvents
    .filter((e) => e.start >= baseSec)
    .map((e) => ({ ...e, start: e.start - baseSec, end: e.end - baseSec }));
  return { segments, audioEvents, hasText: liveSegments.some((s) => s.text.trim() !== "") };
}

/**
 * Winds up a take whose accuracy pass the user cancelled: keep what the live
 * pass already put on screen, and (usually) file exactly that in history.
 *
 * Nothing partial is kept from the cancelled pass. What it would be weighed
 * against is a transcript the user is already reading, and half a second pass
 * spliced onto the front of the live one would be worse than either.
 *
 * `fileTakeProvisionally` already filed a live snapshot in history *before*
 * this pass even started, so persisting again here only matters for catching
 * the trailing window `streamer.finish()` flushes just after that (see its
 * own doc comment) -- and only while `recordingId` is still the recording
 * `segments`/`audioEvents` represent on screen. If a later recording has
 * since taken over (another take started in the same session, or the user
 * browsed elsewhere), re-reading those arrays here would mix that other
 * recording's segments into this one's history entry -- so in that case the
 * already-filed provisional entry (missing only that one trailing window) is
 * left as-is rather than risk overwriting it with mixed data.
 */
async function finishCancelledTake(
  recordingId: string,
  baseSec: number,
  keptSegments: number,
  recordingDurationSec: number,
  language: string,
): Promise<void> {
  useAppStore.setState({
    refineNotice:
      "解析をキャンセルしました（表示中の文字起こしはそのまま使えます）。あとから履歴の「再解析」でやり直せます。",
  });

  if (useAppStore.getState().viewedRecordingId !== recordingId) return;

  const snapshot = liveTakeSnapshot(baseSec, keptSegments);
  await persistTake(recordingId, {
    durationSec: recordingDurationSec,
    language,
    // A cancelled take with nothing on screen is not transcribed, and saying
    // so is what puts the 解析 button on its history row -- the same door
    // record-only takes come through.
    transcribed: snapshot.hasText,
    // None of the three ran to completion, so none of them describe what was
    // saved.
    usedDiarize: false,
    usedVad: false,
    usedAudioEvents: false,
    segments: snapshot.segments,
    audioEvents: snapshot.audioEvents,
  });
}

/** What `fileTakeProvisionally` hands off to `refineRecording` once the WAV
 * is closed and a provisional history entry is already filed. */
export interface TakeFiling {
  recordingId: string;
  path: string;
  recordingDurationSec: number;
}

/**
 * Closes the WAV and files a provisional history entry from whatever the
 * live pass already produced -- *before* the accuracy pass has run, and
 * (per its caller, `stopRecording`) even before the live pass's own trailing
 * window has finished flushing. `refineRecording` below overwrites this with
 * the refined result once the accuracy pass actually finishes.
 *
 * Split out of what used to be `refineRecording`'s own opening so
 * `stopRecording` can run this *before*, rather than after,
 * `streamer.finish()`/`eventStreamer.finish()` -- those are real
 * transcription calls and can take several seconds on their own, and closing
 * the WAV / writing the sidecar don't depend on them at all. Making the
 * sidebar wait for that flush too was exactly the "recording exists but
 * isn't browsable yet" gap this function exists to close. One consequence:
 * the live snapshot below can be one trailing window short of what
 * `streamer.finish()` would otherwise have flushed -- acceptable, since this
 * entry is provisional by construction and gets overwritten by the real
 * refined transcript within moments regardless.
 *
 * `null` return means `capture.finish()` itself failed; the caller skips the
 * accuracy pass entirely in that case, same as before this was split out.
 */
export async function fileTakeProvisionally(
  capture: RecordingCapture,
  baseSec: number,
  keptSegments: number,
): Promise<TakeFiling | null> {
  let path: string;
  let recordingDurationSec: number;
  try {
    const info = await capture.finish();
    path = info.path;
    recordingDurationSec = info.durationSec;
  } catch (err) {
    useAppStore.setState({
      refineNotice: `録音ファイルの保存に失敗したため、精度向上パスは省略しました（表示中の文字起こしはそのまま使えます）: ${toErrorMessage(err)}`,
    });
    return null;
  }
  const recordingId = idFromWavPath(path);

  // The WAV is fully written at this point regardless of how the accuracy
  // pass below goes, so playback becomes available immediately rather than
  // waiting on (possibly minutes of) diarization/audio-tagging. `baseSec` is
  // where this take's segments start on the session's global timeline (see
  // `PlaybackState.timelineOffsetSec`'s doc comment) -- the WAV itself is
  // always 0-based, only the segments referring to it are shifted.
  void useAppStore.getState().loadPlayback(recordingId, path, baseSec);

  const liveSnapshot = liveTakeSnapshot(baseSec, keptSegments);
  await persistTake(recordingId, {
    durationSec: recordingDurationSec,
    language: useAppStore.getState().settings.language,
    transcribed: liveSnapshot.hasText,
    usedDiarize: false,
    usedVad: false,
    usedAudioEvents: false,
    segments: liveSnapshot.segments,
    audioEvents: liveSnapshot.audioEvents,
  });

  return { recordingId, path, recordingDurationSec };
}

/**
 * Re-transcribes the finished recording as one continuous piece and swaps the
 * result in for the segments the live pass produced. Takes over from
 * `fileTakeProvisionally`, which `stopRecording` has already run (and which
 * already filed the take in history) by the time this is called.
 *
 * Every failure path here keeps the live transcript. The second pass is an
 * improvement on something the user already has; losing it costs accuracy, while
 * discarding the live result would cost them the meeting.
 *
 * `onStatus`/`wasCancelled` are supplied by the caller (`analysisQueue.ts`) --
 * see this module's own doc comment for why this stays free of any direct
 * dependency on the job queue.
 *
 * On-screen `segments`/`audioEvents` are only ever touched here while
 * `filing.recordingId` is still the recording those represent
 * (`viewedRecordingId` match) -- this pass can now finish well after a *later*
 * recording has started in the same session (recording and analysis run in
 * parallel, see `src/store/analysisQueue.ts`), and blindly splicing into
 * `segments` at that point would corrupt whichever recording is now live
 * instead. The history file write (keyed by `filing.recordingId`) is always
 * safe and stays unconditional either way.
 */
export async function refineRecording(
  filing: TakeFiling,
  baseSec: number,
  keptSegments: number,
  onStatus?: (status: AnalysisPipelineStatus) => void,
  wasCancelled?: () => boolean,
): Promise<void> {
  const { recordingId, path, recordingDurationSec } = filing;
  const { settings, vadSettings, diarizeSettings, audioEventSettings, hallucinationSettings } =
    useAppStore.getState();
  try {
    const outcome = await runAccuracyPipeline(
      recordingId,
      path,
      settings,
      vadSettings,
      diarizeSettings,
      audioEventSettings,
      hallucinationSettings,
      onStatus,
    );

    // The job's own status is consulted as well as the outcome so that a
    // cancel which lost a race with the last stage's completion still gets
    // the answer the user asked for. Pressing cancel and then watching the
    // transcript get swapped anyway would be the one outcome the button must
    // never produce.
    if (outcome.cancelled || wasCancelled?.()) {
      await finishCancelledTake(recordingId, baseSec, keptSegments, recordingDurationSec, settings.language);
      return;
    }

    const { result, speakers, excluded, newEvents, notices } = outcome;
    if (notices.length > 0) {
      useAppStore.setState({ refineNotice: notices.join(" ") });
    }

    const targets = nonBlankChunks(result).map((c) => c.timestamp);
    const audioEventsUsable = excluded !== undefined;

    const silent = result.silence
      ? projectOntoNonBlankChunks(result, result.silence.map((m) => m.silent))
      : undefined;
    const refined = segmentsFromResult(
      result,
      baseSec,
      peekNextSegmentId(),
      speakers,
      excluded,
      newEvents,
      silent,
    );
    // One segment per non-blank chunk, always -- an excluded chunk becomes a
    // blank placeholder rather than being dropped (see
    // TranscriptSegment.excludedReason), so refined.length === targets.length
    // whenever there were any chunks to begin with.
    if (targets.length > 0) {
      consumeSegmentIds(targets.length);
    } else if (refined.length > 0) {
      consumeSegmentIds(refined.length);
    }

    // An empty (or all-excluded-placeholder) second pass means something went
    // wrong upstream, not that the meeting was silent -- the live pass
    // already found speech in this audio. Checked by actual text rather than
    // refined.length, since a recording audio-tagging excluded *everything*
    // from now produces only placeholders, not an empty array.
    const secondPassUsable = refined.some((s) => s.text.trim() !== "");

    // Still this take's own recording on screen -- safe to touch `segments`/
    // `audioEvents` and to read the live pass's own segments back out of them
    // (see this function's own doc comment, and `liveTakeSnapshot`'s).
    const stillOnScreen = useAppStore.getState().viewedRecordingId === recordingId;

    if (stillOnScreen) {
      // Audio-tagging is a separate call from transcription (detectAudioEvents,
      // run against `targets` from this same result -- see runAccuracyPipeline)
      // that can fail or get skipped on its own: disabled in settings, nothing
      // to tag because `targets` came back empty, or the call itself threw.
      // `excluded` only comes back defined when it actually completed; when
      // it's undefined, `newEvents` is just its unset initial value, not "no
      // events found". Overwriting the live pass's own preview with that would
      // silently discard real data over a failure that says nothing about
      // whether the preview was wrong -- so, mirroring the segments fallback
      // below, keep the live preview instead.
      if (audioEventsUsable) {
        const rebasedEvents = newEvents.map((e) => ({
          ...e,
          start: e.start + baseSec,
          end: e.end + baseSec,
        }));
        useAppStore.setState((s) => ({
          audioEvents: [
            ...s.audioEvents.filter((e) => e.start < baseSec),
            ...rebasedEvents,
          ],
        }));
      }

      if (secondPassUsable) {
        useAppStore.setState((s) => ({
          segments: [...s.segments.slice(0, keptSegments), ...refined],
        }));
      }
    }

    // Whichever segments are now this take's authoritative record -- the
    // second pass's, if it produced anything usable, otherwise the live
    // pass's -- always get saved. This used to be conditional on
    // `secondPassUsable`, which meant an empty second pass made the take
    // vanish from history for good: the WAV stayed valid on disk, but with
    // no sidecar `listRecordings` could never find it again -- exactly the
    // one thing `finishRecordOnly`'s own doc comment says this feature must
        // never do to a take.
    //
    // The live-pass fallback (`liveSegments`/`liveHasText`) needs
    // `stillOnScreen` too: it's read back out of the *global* `segments`, and
    // once a later recording has taken over that array no longer describes
    // this take alone (see this function's own doc comment). When the second
    // pass isn't usable and this take is no longer on screen, the safest
    // thing is to leave `fileTakeProvisionally`'s already-filed provisional
    // entry alone rather than risk persisting a mixed snapshot.
    if (!stillOnScreen && !secondPassUsable) return;

    const liveSegments = stillOnScreen ? useAppStore.getState().segments.slice(keptSegments) : [];
    const liveHasText = liveSegments.some((s) => s.text.trim() !== "");

    // Persisted on the recording's own 0-based timeline (not the session's
    // global one) and with freshly sequential ids, so a history entry looks
    // identical whether it was the first or the fifth recording of its
    // original session -- see history.ts's module doc.
    const localSegments = (secondPassUsable ? refined : liveSegments).map((s, i) => ({
      ...s,
      id: i + 1,
      startOffsetSec: s.startOffsetSec - baseSec,
    }));
    // Same idea as `localSegments`, for audio events: whichever pass's
    // results are now live in the store for this take -- the post-hoc pass's,
    // if `audioEventsUsable`, otherwise whatever the live preview already had
    // -- read back out and rebased onto the recording's own 0-based timeline
    // for persistence, rather than re-reading `newEvents` (which, unlike the
    // state, doesn't reflect the fallback when the pass wasn't usable).
    const localAudioEvents = stillOnScreen
      ? useAppStore
          .getState()
          .audioEvents.filter((e) => e.start >= baseSec)
          .map((e) => ({ ...e, start: e.start - baseSec, end: e.end - baseSec }))
      : [];
    const saved = await persistTake(recordingId, {
      durationSec: recordingDurationSec,
      language: settings.language,
      transcribed: true,
      // Speaker labels and VAD-based exclusion only ever land on the
      // second pass's own segments -- claiming them here when the live
      // pass's segments are what actually got saved would describe data
      // that isn't there.
      usedDiarize: secondPassUsable && diarizeSettings.enabled,
      usedVad: secondPassUsable && vadSettings.enabled,
      usedAudioEvents: audioEventsUsable,
      segments: localSegments,
      audioEvents: localAudioEvents,
    });
    // Only worth surfacing when the live pass actually had something the
    // second pass then lost -- a genuinely silent recording ending up with an
    // empty transcript both times is not a failure worth reporting as one.
    if (saved && !secondPassUsable && liveHasText) {
      useAppStore.setState({
        refineNotice:
          "精度向上パスの結果が空だったため、ライブの文字起こしをそのまま履歴に保存しました（話者分離・VAD は未適用です）。設定を確認のうえ「再解析」をお試しください。",
      });
    }
  } catch (err) {
    useAppStore.setState({
      refineNotice: `精度向上パスに失敗しました（表示中の文字起こしはそのまま使えます）: ${toErrorMessage(err)}`,
    });
  }
}

/**
 * `refineRecording`'s record-only counterpart: close the WAV, make it playable,
 * and file it in history -- with no transcription, diarization or audio
 * tagging, none of which ran (and none of which could, since the model was
 * never loaded).
 *
 * The sidecar is written even though it holds no segments. Without it the
 * recording would be invisible: `listRecordings` enumerates sidecars, not
 * WAVs, so a take with no JSON is a file the user can neither find nor ask to
 * be transcribed later -- which is the whole promise of this mode.
 *
 * Failure is reported the same way every other post-stop failure is: a
 * `refineNotice`, not an error. The WAV is valid on disk at every moment (see
 * `wav::Writer`), so even a failure here costs only the history entry.
 */
export async function finishRecordOnly(
  capture: RecordingCapture,
): Promise<void> {
  const baseSec = getRecordingBaseSec();
  try {
    const { path, durationSec } = await capture.finish();
    const id = idFromWavPath(path);
    void useAppStore.getState().loadPlayback(id, path, baseSec);
    await saveRecordingHistory(id, {
      durationSec,
      language: useAppStore.getState().settings.language,
      transcribed: false,
      // All three passes are part of the analysis this mode defers, so none of
      // them describe this recording yet. They get their real values when the
      // user runs `reanalyzeHistoryEntry` on it.
      usedDiarize: false,
      usedVad: false,
      usedAudioEvents: false,
      segments: [],
      audioEvents: [],
    });
    await useAppStore.getState().refreshRecordingHistory();
    // Marks this recording as the one being viewed, same as clicking it in
    // the sidebar would -- without this, the entry existed on disk and was
    // loaded for playback, but nothing about the screen said so: no delete
    // button, and the transcript area still showed the "start a recording"
    // placeholder instead of this one's (empty, since nothing has
    // transcribed it yet) content. See `markRecordingViewed`'s doc comment
    // for why this needs its own guard even though nothing can race the
    // *recording* itself in record-only mode.
    markRecordingViewed(id);
  } catch (err) {
    useAppStore.setState({
      refineNotice: `録音の保存に失敗したため、履歴に残せませんでした: ${toErrorMessage(err)}`,
    });
  }
}

/**
 * Re-runs the accuracy pass (transcribe + diarize + audio-tag, per whatever
 * is currently enabled in settings) against a past recording's WAV and
 * overwrites its history entry -- e.g. after turning on diarization or
 * changing its threshold and wanting this recording relabeled with it.
 *
 * Moved out of `appStore.ts`'s `rerunHistoryEntry` action so the job body
 * lives next to `refineRecording`'s, both driven by `analysisQueue.ts`'s
 * `enqueueReanalyze`/`enqueueRefine` -- `appStore.ts` keeps only the thin
 * capability check and hand-off to the queue.
 */
export async function reanalyzeHistoryEntry(
  id: string,
  onStatus?: (status: AnalysisPipelineStatus) => void,
  wasCancelled?: () => boolean,
): Promise<void> {
  // The one place the model gets loaded on demand: in record-only mode this
  // is the first time it is needed at all. A no-op once it is loaded, so the
  // normal path is unaffected.
  if (!(await ensureModelReady())) {
    useAppStore.setState({
      refineNotice: `音声認識モデルを読み込めなかったため、解析できませんでした（録音はそのまま残っています）: ${
        useAppStore.getState().errorMessage ?? "原因不明"
      }`,
    });
    return;
  }

  const durationSec = useAppStore.getState().recordingHistory.find((r) => r.id === id)?.durationSec ?? 0;
  const path = await wavPath(id);

  try {
    const { settings, vadSettings, diarizeSettings, audioEventSettings, hallucinationSettings } =
      useAppStore.getState();
    const outcome = await runAccuracyPipeline(
      id,
      path,
      settings,
      vadSettings,
      diarizeSettings,
      audioEventSettings,
      hallucinationSettings,
      onStatus,
    );
    // Bailing out before `saveRecordingHistory` is the whole cancellation
    // story here: the existing sidecar and the segments on screen are both
    // left exactly as they were, so a cancelled re-analysis costs the user
    // nothing but the time it ran. See `refineRecording` for why the job's
    // own status is consulted alongside the outcome.
    if (outcome.cancelled || wasCancelled?.()) {
      useAppStore.setState({ refineNotice: "解析をキャンセルしました（既存の履歴はそのまま残っています）。" });
      return;
    }
    const { result, speakers, excluded, newEvents, notices } = outcome;

    // Always the recording's own 0-based timeline with fresh sequential
    // ids -- this entry has no "session" of its own to rebase onto, and
    // saveRecordingHistory always stores under that same convention (see
    // refineRecording's persistence step).
    const silent = result.silence
      ? projectOntoNonBlankChunks(result, result.silence.map((m) => m.silent))
      : undefined;
    const refined = segmentsFromResult(result, 0, 1, speakers, excluded, newEvents, silent);
    if (!refined.some((s) => s.text.trim() !== "")) {
      // Mirrors refineRecording's own guard: an empty (or all-excluded-
      // placeholder) result is far more likely a setting change gone wrong
      // (wrong language, an overly strict threshold) than "this recording
      // legitimately has nothing in it now" -- the existing history entry
      // is worth more than a result this suspicious.
      useAppStore.setState({
        refineNotice:
          "この設定では文字起こし結果が0件になったため、履歴は上書きしていません。設定を確認してから再度お試しください。",
      });
      return;
    }
    const localSegments = refined.map((s, i) => ({ ...s, id: i + 1 }));

    await saveRecordingHistory(id, {
      durationSec,
      language: settings.language,
      transcribed: true,
      usedDiarize: diarizeSettings.enabled,
      usedVad: vadSettings.enabled,
      usedAudioEvents: audioEventSettings.enabled,
      segments: localSegments,
      audioEvents: newEvents,
    });
    await useAppStore.getState().refreshRecordingHistory();

    // Refresh what's on screen too, if this is the recording currently
    // shown. Unlike before recording/analysis ran in parallel, `reanalyze`
    // no longer implies nothing else can be live in the meantime -- another
    // recording (or a browse to a different entry) may have taken over
    // `segments` while this pass was running, so this check is load-bearing,
    // not defensive.
    if (useAppStore.getState().viewedRecordingId === id) {
      useAppStore.setState({ segments: localSegments, audioEvents: newEvents });
    }
    if (notices.length > 0) {
      useAppStore.setState({ refineNotice: notices.join(" ") });
    }
  } catch (err) {
    useAppStore.setState({ refineNotice: `再実行に失敗しました（既存の履歴はそのまま残っています）: ${toErrorMessage(err)}` });
  }
}

/**
 * Loads the model if it isn't loaded yet and resolves once it actually is.
 *
 * `asrClient.init()` only *starts* the load -- readiness arrives later on the
 * `asr:model-ready` event (see client.ts), so awaiting it is not enough. This
 * waits on the state that event drives instead.
 *
 * Resolves `false` rather than throwing when the model cannot be loaded: the
 * one caller (`reanalyzeHistoryEntry`) reports that as a notice next to a
 * history entry that is still perfectly intact, not as a failure of the app.
 */
export async function ensureModelReady(): Promise<boolean> {
  const { modelStatus, initModel } = useAppStore.getState();
  if (modelStatus === "ready") return true;
  if (modelStatus === "error") return false;
  if (modelStatus === "idle") void initModel();
  return new Promise((resolve) => {
    const unsubscribe = useAppStore.subscribe((s) => {
      if (s.modelStatus === "ready") {
        unsubscribe();
        resolve(true);
      } else if (s.modelStatus === "error") {
        unsubscribe();
        resolve(false);
      }
    });
  });
}
