/**
 * The re-transcribe/diarize/audio-tag accuracy pass that runs after a
 * recording stops (`refineRecording`, `finishRecordOnly`'s record-only
 * counterpart, and the shared `runAccuracyPipeline` core also reused by
 * `appStore.ts`'s `rerunHistoryEntry`), plus the live-streaming append
 * helpers that feed the same session timeline (`timeline.ts`) this pipeline
 * rebases onto.
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
  AudioEventSettings,
} from "../lib/asr";
import type { TranscriptSegment } from "../lib/transcript";
import { isCancelledError } from "../lib/asr";
import { nonBlankChunks, segmentsFromResult } from "../lib/transcript";
import { saveRecordingHistory } from "../lib/history";
import { toErrorMessage } from "../lib/errors";
import type { AsrSettings } from "./persistedSettings";
import { asrClient } from "./clients";
import {
  consumeSegmentId,
  peekNextSegmentId,
  consumeSegmentIds,
  getTimelineBaseSec,
  getRecordingBaseSec,
  getSegmentsBeforeRecording,
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

/**
 * The re-transcribe/diarize/audio-tag sequence shared by `refineRecording`
 * (a just-finished live recording) and `rerunHistoryEntry` (any past one,
 * typically after the user changed a setting). Everything here operates on
 * `path`'s own 0-based timeline; rebasing onto a session's global timeline
 * (if the caller even has one -- `rerunHistoryEntry` does not) is the
 * caller's job, same as `nonBlankChunks`' doc comment already describes.
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
 * place to clear the backend's cancel flag, so a cancel that arrived too late
 * to stop the previous pass cannot kill this one on sight.
 */
export async function runAccuracyPipeline(
  path: string,
  settings: AsrSettings,
  vadSettings: VadSettings,
  diarizeSettings: DiarizeSettings,
  audioEventSettings: AudioEventSettings,
): Promise<AccuracyPipelineOutcome> {
  await asrClient.beginAnalysis();

  const notices: string[] = [];
  let result: TranscribeResult;
  try {
    result = await asrClient.transcribeRecording(path, settings, vadSettings);
  } catch (err) {
    // Only a cancellation is caught here -- a real failure still propagates,
    // so the caller keeps its "the second pass broke, hold on to the live
    // transcript" path exactly as before.
    if (isCancelledError(err)) return { cancelled: true };
    throw err;
  }
  if (result.vadUnavailable) {
    notices.push(
      "VAD 用のモデルファイルが見つからないため、VAD 無しで実行しました。README の手順でモデルを配置すると有効になります。",
    );
  }

  // Diarization and audio tagging both read the same WAV on its own 0-based
  // timeline, so they have to run on result.chunks *before* segmentsFromResult
  // rebases anything -- see nonBlankChunks' doc comment.
  const targets = nonBlankChunks(result).map((c) => c.timestamp);

  let speakers: Array<number | null> | undefined;
  if (diarizeSettings.enabled && targets.length > 0) {
    try {
      speakers = await asrClient.diarizeRecording(
        path,
        targets,
        diarizeSettings,
      );
    } catch (err) {
      if (isCancelledError(err)) return { cancelled: true };
      notices.push(
        `話者分離に失敗したため、話者ラベルは付きません（文字起こし自体はそのまま使えます）: ${toErrorMessage(err)}`,
      );
    }
  }

  let excluded: boolean[] | undefined;
  let newEvents: AudioEvent[] = [];
  if (audioEventSettings.enabled && targets.length > 0) {
    try {
      const eventResult = await asrClient.detectAudioEvents(
        path,
        targets,
        audioEventSettings,
      );
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
 * (below) the provisional entry `refineRecording` writes immediately on
 * stop so the take is not invisible to the sidebar for however long the
 * pass takes.
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
 * pass already put on screen, and file exactly that in history.
 *
 * Nothing partial is kept from the cancelled pass. What it would be weighed
 * against is a transcript the user is already reading, and half a second pass
 * spliced onto the front of the live one would be worse than either.
 *
 * The history write is *not* optional. Skipping it would leave the WAV on disk
 * with no sidecar, and `listRecordings` enumerates sidecars -- the take would
 * become a file the user can neither find nor ask to be transcribed later,
 * which `finishRecordOnly`'s doc comment calls out as the one thing this
 * feature must never do.
 */
async function finishCancelledTake(
  path: string,
  baseSec: number,
  keptSegments: number,
  recordingDurationSec: number,
  language: string,
): Promise<void> {
  const snapshot = liveTakeSnapshot(baseSec, keptSegments);

  useAppStore.setState({
    refineNotice:
      "解析をキャンセルしました（表示中の文字起こしはそのまま使えます）。あとから履歴の「再解析」でやり直せます。",
  });

  await persistTake(idFromWavPath(path), {
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

/**
 * Re-transcribes the finished recording as one continuous piece and swaps the
 * result in for the segments the live pass produced.
 *
 * Every failure path here keeps the live transcript. The second pass is an
 * improvement on something the user already has; losing it costs accuracy, while
 * discarding the live result would cost them the meeting.
 */
export async function refineRecording(
  capture: RecordingCapture,
): Promise<void> {
  const keptSegments = getSegmentsBeforeRecording();
  const baseSec = getRecordingBaseSec();

  let path: string;
  let recordingDurationSec: number;
  try {
    const info = await capture.finish();
    path = info.path;
    recordingDurationSec = info.durationSec;
  } catch (err) {
    // `stopRecording` handed over still in a processing phase (so the gap
    // before "refining" could not be mistaken for idle), so this bail-out has
    // to be the one to clear it.
    useAppStore.setState({
      processing: null,
      refineNotice: `録音ファイルの保存に失敗したため、精度向上パスは省略しました（表示中の文字起こしはそのまま使えます）: ${toErrorMessage(err)}`,
    });
    return;
  }
  const recordingId = idFromWavPath(path);

  // The WAV is fully written at this point regardless of how the accuracy
  // pass below goes, so playback becomes available immediately rather than
  // waiting on (possibly minutes of) diarization/audio-tagging. `baseSec` is
  // where this take's segments start on the session's global timeline (see
  // `PlaybackState.timelineOffsetSec`'s doc comment) -- the WAV itself is
  // always 0-based, only the segments referring to it are shifted.
  void useAppStore.getState().loadPlayback(recordingId, path, baseSec);

  // `processingRecordingId` lets the UI say *which* recording "精度向上パス
  // 実行中" refers to (see its own doc comment in appStore.ts) -- unlike
  // `rerunHistoryEntry`, the id here only exists once `capture.finish()`
  // above has already resolved, so it can't be set any earlier than this.
  useAppStore.setState({
    processing: "refining",
    refineProgress: 0,
    processingRecordingId: recordingId,
  });
  try {
    // File the take in history right away, using whatever the live pass
    // already produced -- otherwise the sidebar has nothing to show for this
    // recording (and `viewedRecordingId` has nothing to resolve to, hiding
    // the transcript panel's own "close" button) for however long the
    // accuracy pass below takes, even though the transcript panel is already
    // showing its content. `persistTake` below overwrites this with the
    // refined result once the pass actually finishes.
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

    const { settings, vadSettings, diarizeSettings, audioEventSettings } =
      useAppStore.getState();
    const outcome = await runAccuracyPipeline(
      path,
      settings,
      vadSettings,
      diarizeSettings,
      audioEventSettings,
    );

    // The store is consulted as well as the outcome so that a cancel which
    // lost a race with the last stage's completion still gets the answer the
    // user asked for. Pressing cancel and then watching the transcript get
    // swapped anyway would be the one outcome the button must never produce.
    if (
      outcome.cancelled ||
      useAppStore.getState().processing === "cancelling"
    ) {
      await finishCancelledTake(
        path,
        baseSec,
        keptSegments,
        recordingDurationSec,
        settings.language,
      );
      return;
    }

    const { result, speakers, excluded, newEvents, notices } = outcome;
    if (notices.length > 0) {
      useAppStore.setState({ refineNotice: notices.join(" ") });
    }

    const targets = nonBlankChunks(result).map((c) => c.timestamp);
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
    const audioEventsUsable = excluded !== undefined;
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

    const refined = segmentsFromResult(
      result,
      baseSec,
      peekNextSegmentId(),
      speakers,
      excluded,
      newEvents,
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

    if (secondPassUsable) {
      useAppStore.setState((s) => ({
        segments: [...s.segments.slice(0, keptSegments), ...refined],
      }));
    }
    // The live pass's own segments for this take -- already on screen, and
    // (unlike `refined`) never replaced when the second pass comes back
    // suspicious. Sliced out here regardless of `secondPassUsable`, since
    // whether it has anything in it also distinguishes two very different
    // reasons `refined` might be empty: something went wrong upstream (this
    // has text -- fall back to it below), versus the recording was
    // genuinely silent throughout (this is empty too -- nothing went wrong,
    // there's just nothing to transcribe).
    const liveSegments = useAppStore.getState().segments.slice(keptSegments);
    const liveHasText = liveSegments.some((s) => s.text.trim() !== "");
    // Whichever segments are now this take's authoritative record -- the
    // second pass's, if it produced anything usable, otherwise the live
    // pass's -- always get saved. This used to be conditional on
    // `secondPassUsable`, which meant an empty second pass made the take
    // vanish from history for good: the WAV stayed valid on disk, but with
    // no sidecar `listRecordings` could never find it again -- exactly the
    // one thing `finishRecordOnly`'s own doc comment says this feature must
    // never do to a take. Persisted on the recording's own 0-based timeline
    // (not the session's global one) and with freshly sequential ids, so a
    // history entry looks identical whether it was the first or the fifth
    // recording of its original session -- see history.ts's module doc.
    const localSegments = (secondPassUsable ? refined : liveSegments).map(
      (s, i) => ({
        ...s,
        id: i + 1,
        startOffsetSec: s.startOffsetSec - baseSec,
      }),
    );
    // Same idea as `localSegments`, for audio events: whichever pass's
    // results are now live in the store for this take -- the post-hoc pass's,
    // if `audioEventsUsable`, otherwise whatever the live preview already had
    // -- read back out and rebased onto the recording's own 0-based timeline
    // for persistence, rather than re-reading `newEvents` (which, unlike the
    // state, doesn't reflect the fallback when the pass wasn't usable).
    const localAudioEvents = useAppStore
      .getState()
      .audioEvents.filter((e) => e.start >= baseSec)
      .map((e) => ({ ...e, start: e.start - baseSec, end: e.end - baseSec }));
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
  } finally {
    useAppStore.setState({
      processing: null,
      refineProgress: null,
      processingRecordingId: null,
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
      // user runs `rerunHistoryEntry` on it.
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
  } finally {
    useAppStore.setState({ processing: null });
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
 * one caller (`rerunHistoryEntry`) reports that as a notice next to a history
 * entry that is still perfectly intact, not as a failure of the app.
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
