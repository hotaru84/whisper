/**
 * The post-stop transcription/diarize/audio-tag pipeline, plus the
 * live-streaming append helpers that feed the same session timeline
 * (`timeline.ts`) this pipeline rebases onto.
 *
 * There is one transcription decode path, not two: `refineRecording` (live
 * "record and analyze" mode) and `runPostHocAnalysis` (record-only's
 * deferred "解析" and history "再解析") both eventually call the shared
 * `finalizeAndEnrich` tail (repair/diarize/audio-tag), but only
 * `runPostHocAnalysis` actually decodes anything -- `refineRecording`'s
 * transcript was already fully produced live, by the time recording
 * stopped, so it only has to flatten what's already on screen
 * (`flattenSegmentsToChunks`) before handing it to the shared tail.
 * `runPostHocAnalysis` is resumable: see its own doc comment.
 *
 * Ownership split with `src/store/analysisQueue.ts`: this module owns *what*
 * a job's steps are (model calls, timeline rebasing, history persistence);
 * `analysisQueue.ts` owns *when* a job runs (queueing, per-recording status,
 * cancellation requests) and is the only one of the two that imports the
 * other, so this module never needs to know a queue exists above it --
 * status updates go out through the `onStatus`/`onProgress` callback
 * parameters below, and a job that was asked to stop is discovered through
 * `wasCancelled`, all supplied by the caller rather than read from any
 * shared store here.
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
  TranscriptChunk,
  DiarizeSettings,
  HallucinationSettings,
  AudioEventSettings,
} from "../lib/asr";
import {
  isCancelledError,
  DIARIZATION_MODEL_UNAVAILABLE,
  runWhisperTask,
  WHISPER_PRIORITY_BACKGROUND,
  transcribeWavPostHoc,
} from "../lib/asr";
import type { TranscriptSegment } from "../lib/transcript";
import { nonBlankChunks, projectOntoNonBlankChunks, segmentsFromResult } from "../lib/transcript";
import { saveRecordingHistory, wavPath, loadRecording } from "../lib/history";
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

/**
 * Flattens a run of already-transcribed `TranscriptSegment`s into one
 * absolute-recording-timeline chunk list, for `finalizeAndEnrich`'s repair
 * pass and for `diarizeRecording`/`detectAudioEvents`, both of which need
 * `(start, end)` pairs on the recording's own 0-based timeline rather than
 * per-segment-relative ones (`TranscriptSegment.chunks[].timestamp` is
 * relative to that segment's own `startOffsetSec` -- see `transcript.ts`).
 *
 * `baseSec` is the session's global timeline offset the segments'
 * `startOffsetSec` values already carry (see
 * `PlaybackState.timelineOffsetSec`'s doc comment); subtracted back out so
 * the result lands on the *recording's* own 0-based timeline. Pass `0` when
 * `segments` are already recording-relative (as history sidecars always
 * store them).
 */
export function flattenSegmentsToChunks(segments: TranscriptSegment[], baseSec: number): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = [];
  for (const seg of segments) {
    const segStart = seg.startOffsetSec - baseSec;
    for (const c of seg.chunks) {
      chunks.push({ text: c.text, timestamp: [c.timestamp[0] + segStart, c.timestamp[1] + segStart] });
    }
  }
  return chunks;
}

/** What `finalizeAndEnrich` produces: the finalized transcript, plus
 * whatever diarization/audio-tagging managed to add, plus any user-facing
 * notices about the parts that did not go perfectly (never a hard failure --
 * see the function's own doc). */
interface AccuracyPipelineResult {
  result: TranscribeResult;
  speakers?: Array<number | null>;
  excluded?: boolean[];
  newEvents: AudioEvent[];
  notices: string[];
}

/** `finalizeAndEnrich`'s return: either a completed pass, or the fact that
 * the user cancelled it. A cancellation carries nothing else -- every partial
 * result from *this* call is discarded, because what it is being weighed
 * against is a transcript the user already has (on screen, for
 * `refineRecording`; already persisted incrementally, for
 * `runPostHocAnalysis` -- see that function's own doc comment for why a
 * cancellation there loses nothing despite this). */
type AccuracyPipelineOutcome =
  | ({ cancelled: false } & AccuracyPipelineResult)
  | { cancelled: true };

/** The two stages of `finalizeAndEnrich` worth reporting live: while the
 * whisper-touching `finalizeTranscript` call is (queued, then) actually
 * running, and everything after it (diarization/audio-tagging, which run
 * concurrently with each other and don't touch the whisper model at all).
 * Queued/done/cancelled/error are the caller's (`analysisQueue.ts`'s) own
 * bookkeeping, not something this pipeline reports -- it only knows about
 * its own two internal stages. */
export type AnalysisPipelineStatus = "transcribing" | "post-processing";

/**
 * Repair + diarize + audio-tag tail shared by `refineRecording` (live
 * "record and analyze" mode, transcription already done live) and
 * `runPostHocAnalysis` (record-only deferred analysis / history
 * re-analysis, transcription just finished via `transcribeWavPostHoc`).
 *
 * `chunks` must already be on the recording's own absolute 0-based timeline
 * -- see `flattenSegmentsToChunks`. Runs `asrClient.finalizeTranscript` (the
 * repair/analysis tail: degenerate-loop repair, voiced-gap redecode, silence
 * marking, structural quality report -- see `asr::finalize_transcript`'s own
 * doc comment for why this applies identically regardless of how `chunks`
 * was originally decoded), then diarization and audio-tagging concurrently
 * against the finalized result's non-blank chunks.
 *
 * The caller owns `beginAnalysis`/`endAnalysis` for the whole operation this
 * is one step of -- this function does not touch the per-job cancel flag
 * itself, so `runPostHocAnalysis` can call it as the second half of a single
 * caller-owned cancellable window that starts with its own windowed-decode
 * phase.
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
 */
async function finalizeAndEnrich(
  jobId: string,
  path: string,
  chunks: TranscriptChunk[],
  settings: AsrSettings,
  diarizeSettings: DiarizeSettings,
  audioEventSettings: AudioEventSettings,
  hallucinationSettings: HallucinationSettings,
  onStatus?: (status: AnalysisPipelineStatus) => void,
): Promise<AccuracyPipelineOutcome> {
  const notices: string[] = [];
  let result: TranscribeResult;
  try {
    result = await runWhisperTask(
      WHISPER_PRIORITY_BACKGROUND,
      () => asrClient.finalizeTranscript(path, jobId, chunks, settings, hallucinationSettings),
      () => onStatus?.("transcribing"),
    ).promise;
  } catch (err) {
    // Only a cancellation is caught here -- a real failure still propagates,
    // so the caller keeps its "keep whatever transcript already exists"
    // path exactly as before.
    if (isCancelledError(err)) return { cancelled: true };
    throw err;
  }
  onStatus?.("post-processing");
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
  // finalizeTranscript above does -- so they're started together rather
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
      // never make -- reads the same as any other "optional model missing"
      // guidance rather than an alarming "failed" notice on every recording.
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
 *
 * `analyzedThroughSec` is always `recordingDurationSec` here, regardless of
 * whether the cancelled pass had anything to show: the live streaming pass
 * already transcribed the whole recording by the time this runs (see this
 * module's own doc comment), so there is no windowed post-hoc decode left to
 * resume -- a later "再解析" on a live-mode take is always a full redo via
 * `runPostHocAnalysis`, never a resume.
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
    // Neither ran to completion, so neither describes what was saved.
    usedDiarize: false,
    usedAudioEvents: false,
    analyzedThroughSec: recordingDurationSec,
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
      refineNotice: `録音ファイルの保存に失敗したため、解析は省略しました（表示中の文字起こしはそのまま使えます）: ${toErrorMessage(err)}`,
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
    usedAudioEvents: false,
    // Provisional by construction -- `refineRecording` overwrites this
    // within moments with `recordingDurationSec` once it actually finishes.
    analyzedThroughSec: 0,
    segments: liveSnapshot.segments,
    audioEvents: liveSnapshot.audioEvents,
  });

  return { recordingId, path, recordingDurationSec };
}

/**
 * Runs the post-stop tail for a just-finished live "record and analyze"
 * recording. Takes over from `fileTakeProvisionally`, which `stopRecording`
 * has already run (and which already filed the take in history) by the time
 * this is called.
 *
 * There is no transcription left to do here: the live streaming pass
 * already transcribed the whole recording in real time while it was
 * running, so this flattens whatever's already on screen
 * (`flattenSegmentsToChunks`) and hands it straight to `finalizeAndEnrich`
 * for the repair/diarize/audio-tag tail. Every failure path here keeps the
 * live transcript. The finalize pass is an improvement on something the
 * user already has; losing it costs accuracy, while discarding the live
 * result would cost them the meeting.
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
  const { settings, diarizeSettings, audioEventSettings, hallucinationSettings } = useAppStore.getState();
  // Read synchronously, before any `await` below -- including
  // `beginAnalysis`'s -- so this cannot race a *later* take starting and
  // mutating `segments` out from under it. `enqueueRefine` calls this
  // function in the same tick `stopRecording` finishes in, so nothing else
  // can have run yet.
  const liveChunks = flattenSegmentsToChunks(useAppStore.getState().segments.slice(keptSegments), baseSec);

  await asrClient.beginAnalysis(recordingId);
  try {
    const outcome = await finalizeAndEnrich(
      recordingId,
      path,
      liveChunks,
      settings,
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

    // An empty (or all-excluded-placeholder) finalized result means
    // something went wrong upstream, not that the meeting was silent -- the
    // live pass already found speech in this audio. Checked by actual text
    // rather than refined.length, since a recording audio-tagging excluded
    // *everything* from now produces only placeholders, not an empty array.
    const secondPassUsable = refined.some((s) => s.text.trim() !== "");

    // Still this take's own recording on screen -- safe to touch `segments`/
    // `audioEvents` and to read the live pass's own segments back out of them
    // (see this function's own doc comment, and `liveTakeSnapshot`'s).
    const stillOnScreen = useAppStore.getState().viewedRecordingId === recordingId;

    if (stillOnScreen) {
      // Audio-tagging is a separate call from transcription (detectAudioEvents,
      // run against `targets` from this same result -- see finalizeAndEnrich)
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
    // finalized pass's, if it produced anything usable, otherwise the live
    // pass's -- always get saved. This used to be conditional on
    // `secondPassUsable`, which meant an empty finalized result made the take
    // vanish from history for good: the WAV stayed valid on disk, but with
    // no sidecar `listRecordings` could never find it again -- exactly the
    // one thing `finishRecordOnly`'s own doc comment says this feature must
    // never do to a take.
    //
    // The live-pass fallback (`liveSegments`/`liveHasText`) needs
    // `stillOnScreen` too: it's read back out of the *global* `segments`, and
    // once a later recording has taken over that array no longer describes
    // this take alone (see this function's own doc comment). When the
    // finalized pass isn't usable and this take is no longer on screen, the
    // safest thing is to leave `fileTakeProvisionally`'s already-filed
    // provisional entry alone rather than risk persisting a mixed snapshot.
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
      // Speaker labels only ever land on the finalized pass's own segments --
      // claiming them here when the live pass's segments are what actually
      // got saved would describe data that isn't there.
      usedDiarize: secondPassUsable && diarizeSettings.enabled,
      usedAudioEvents: audioEventsUsable,
      // The live pass already transcribed the whole recording by the time
      // this runs -- see this module's own doc comment -- so this take is
      // always "fully analyzed" regardless of whether the repair pass above
      // found anything worth swapping in. A later "再解析" on it is always a
      // full redo via `runPostHocAnalysis`, never a resume.
      analyzedThroughSec: recordingDurationSec,
      segments: localSegments,
      audioEvents: localAudioEvents,
    });
    // Only worth surfacing when the live pass actually had something the
    // finalized pass then lost -- a genuinely silent recording ending up with
    // an empty transcript both times is not a failure worth reporting as one.
    if (saved && !secondPassUsable && liveHasText) {
      useAppStore.setState({
        refineNotice:
          "解析の結果が空だったため、ライブの文字起こしをそのまま履歴に保存しました（話者分離は未適用です）。設定を確認のうえ「再解析」をお試しください。",
      });
    }
  } catch (err) {
    useAppStore.setState({
      refineNotice: `解析に失敗しました（表示中の文字起こしはそのまま使えます）: ${toErrorMessage(err)}`,
    });
  } finally {
    // Best-effort hygiene: freeing this job's entry in the backend's cancel
    // map costs nothing to skip on failure, and must never mask whatever
    // outcome the `try` above already produced.
    try {
      await asrClient.endAnalysis(recordingId);
    } catch (err) {
      console.warn(`[asr] failed to clear cancel state for job ${recordingId}:`, err);
    }
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
      // Both passes are part of the analysis this mode defers, so neither
      // describes this recording yet. They get their real values when the
      // user runs `runPostHocAnalysis` on it.
      usedDiarize: false,
      usedAudioEvents: false,
      analyzedThroughSec: 0,
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
 * Transcribes (or resumes transcribing) a recording that was never fully
 * transcribed live -- a record-only take's deferred "解析", or a past
 * recording's "再解析" -- via the same windowed `StreamingTranscriber` the
 * live pass uses, driven from the saved WAV instead of live mic frames
 * (`transcribeWavPostHoc` in `postHocTranscriber.ts`). Once decoding
 * reaches the end, runs `finalizeAndEnrich` over the fully assembled chunk
 * list, exactly as `refineRecording` does for the live path.
 *
 * **Resumable, but only when there is nothing to lose by resuming.**
 * `alreadyComplete` (the entry was already fully transcribed by a previous
 * run) decides everything below:
 * - `alreadyComplete`: this is a full redo (glossary changed, language
 *   changed, whatever prompted "再解析"). Nothing is persisted until the redo
 *   actually finishes -- overwriting the existing complete transcript with a
 *   same-run partial one would turn a cancel into data loss, which is a
 *   worse outcome than the redo simply not having happened. Cancelling here
 *   leaves the old sidecar completely untouched, exactly like before this
 *   feature existed.
 * - otherwise (never analyzed, or resuming a previously-cancelled run):
 *   there is nothing yet to protect, so every committed window is persisted
 *   to the sidecar immediately, serialized so writes cannot land out of
 *   order (`persistProgress` below). This is what makes cancelling lose
 *   nothing: by the time this function (or the user) can even notice a
 *   cancel request, whatever was already committed is already on disk. A
 *   later "解析"/"続きを解析" click resumes from `analyzedThroughSec`
 *   instead of re-decoding from the start.
 */
export async function runPostHocAnalysis(
  id: string,
  onStatus?: (status: AnalysisPipelineStatus) => void,
  onProgress?: (analyzedThroughSec: number, totalSec: number) => void,
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

  const stored = await loadRecording(id);
  const durationSec = stored.durationSec;
  const alreadyComplete = stored.transcribed && stored.analyzedThroughSec >= durationSec;
  const resuming = !alreadyComplete && stored.analyzedThroughSec > 0;
  const fromSec = resuming ? stored.analyzedThroughSec : 0;
  const existingSegments = resuming ? stored.segments : [];
  const path = await wavPath(id);

  const { settings, diarizeSettings, audioEventSettings, hallucinationSettings } = useAppStore.getState();

  // Chained rather than fire-and-forget: `saveRecordingHistory` is a full
  // overwrite each time (see its own doc comment), so two writes landing out
  // of order could let an earlier, less-complete write clobber a later,
  // more-complete one. A no-op whenever `alreadyComplete` -- see this
  // function's own doc comment for why a full redo must not touch the
  // sidecar until it actually finishes.
  let persistChain: Promise<void> = Promise.resolve();
  const persistProgress = (segments: TranscriptSegment[], analyzedThroughSec: number) => {
    if (alreadyComplete) return;
    persistChain = persistChain
      .then(() =>
        saveRecordingHistory(id, {
          durationSec,
          language: settings.language,
          transcribed: true,
          // Neither has run yet at this point -- both only ever run once,
          // inside finalizeAndEnrich, after decoding finishes.
          usedDiarize: false,
          usedAudioEvents: false,
          analyzedThroughSec,
          segments,
          audioEvents: [],
        }),
      )
      .catch((err) => {
        console.warn(`[asr] failed to persist partial post-hoc analysis for ${id}:`, err);
      });
  };

  const cancelledNotice = alreadyComplete
    ? "解析をキャンセルしました（既存の履歴はそのまま残っています）。"
    : "解析を一部完了した状態で中止しました。続きは「解析」で再開します。";

  await asrClient.beginAnalysis(id);
  try {
    const outcome = await transcribeWavPostHoc(
      (audio) => {
        const options = { ...settings, entropyThold: hallucinationSettings.entropyThold };
        return runWhisperTask(WHISPER_PRIORITY_BACKGROUND, () => asrClient.transcribe(audio, options)).promise;
      },
      (from, onChunk) => asrClient.readWavPcm(path, id, from, onChunk),
      fromSec,
      durationSec,
      existingSegments,
      hallucinationSettings,
      persistProgress,
      onProgress,
      wasCancelled,
    );
    // Make sure the last incremental write actually landed before deciding
    // what to tell the user or what to show on screen -- otherwise a
    // cancellation could report "kept" before it truly is.
    await persistChain;

    if (outcome.cancelled) {
      useAppStore.setState({ refineNotice: cancelledNotice });
      if (!alreadyComplete) {
        await useAppStore.getState().refreshRecordingHistory();
        if (useAppStore.getState().viewedRecordingId === id) {
          useAppStore.setState({ segments: [...existingSegments, ...outcome.newSegments], audioEvents: [] });
        }
      }
      return;
    }

    const decodedChunks = flattenSegmentsToChunks([...existingSegments, ...outcome.newSegments], 0);
    const enrichOutcome = await finalizeAndEnrich(
      id,
      path,
      decodedChunks,
      settings,
      diarizeSettings,
      audioEventSettings,
      hallucinationSettings,
      onStatus,
    );

    if (enrichOutcome.cancelled || wasCancelled?.()) {
      useAppStore.setState({ refineNotice: cancelledNotice });
      return;
    }

    const { result, speakers, excluded, newEvents, notices } = enrichOutcome;

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
      usedAudioEvents: audioEventSettings.enabled,
      analyzedThroughSec: durationSec,
      segments: localSegments,
      audioEvents: newEvents,
    });
    await useAppStore.getState().refreshRecordingHistory();

    // Refresh what's on screen too, if this is the recording currently
    // shown. Unlike before recording/analysis ran in parallel, `再解析`
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
  } finally {
    try {
      await asrClient.endAnalysis(id);
    } catch (err) {
      console.warn(`[asr] failed to clear cancel state for job ${id}:`, err);
    }
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
 * one caller (`runPostHocAnalysis`) reports that as a notice next to a
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
