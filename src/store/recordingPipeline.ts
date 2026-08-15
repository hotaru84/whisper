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
import { useAppStore } from "./appStore";

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
  const rebased = events.map((e) => ({ ...e, start: e.start + base, end: e.end + base }));
  useAppStore.setState((s) => ({ audioEvents: [...s.audioEvents, ...rebased] }));
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
 */
export async function runAccuracyPipeline(
  path: string,
  settings: AsrSettings,
  vadSettings: VadSettings,
  diarizeSettings: DiarizeSettings,
  audioEventSettings: AudioEventSettings,
): Promise<AccuracyPipelineResult> {
  const notices: string[] = [];
  const result = await asrClient.transcribeRecording(path, settings, vadSettings);
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
      speakers = await asrClient.diarizeRecording(path, targets, diarizeSettings);
    } catch (err) {
      notices.push(`話者分離に失敗したため、話者ラベルは付きません（文字起こし自体はそのまま使えます）: ${toErrorMessage(err)}`);
    }
  }

  let excluded: boolean[] | undefined;
  let newEvents: AudioEvent[] = [];
  if (audioEventSettings.enabled && targets.length > 0) {
    try {
      const eventResult = await asrClient.detectAudioEvents(path, targets, audioEventSettings);
      excluded = eventResult.exclude;
      newEvents = eventResult.events;
    } catch (err) {
      notices.push(`音響イベント検出に失敗しました（文字起こし自体はそのまま使えます）: ${toErrorMessage(err)}`);
    }
  }

  return { result, speakers, excluded, newEvents, notices };
}

/**
 * Re-transcribes the finished recording as one continuous piece and swaps the
 * result in for the segments the live pass produced.
 *
 * Every failure path here keeps the live transcript. The second pass is an
 * improvement on something the user already has; losing it costs accuracy, while
 * discarding the live result would cost them the meeting.
 */
export async function refineRecording(capture: RecordingCapture): Promise<void> {
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

  // The WAV is fully written at this point regardless of how the accuracy
  // pass below goes, so playback becomes available immediately rather than
  // waiting on (possibly minutes of) diarization/audio-tagging. `baseSec` is
  // where this take's segments start on the session's global timeline (see
  // `PlaybackState.timelineOffsetSec`'s doc comment) -- the WAV itself is
  // always 0-based, only the segments referring to it are shifted.
  void useAppStore.getState().loadPlayback(idFromWavPath(path), path, baseSec);

  useAppStore.setState({ processing: "refining", refineProgress: 0 });
  try {
    const { settings, vadSettings, diarizeSettings, audioEventSettings } = useAppStore.getState();
    const { result, speakers, excluded, newEvents, notices } = await runAccuracyPipeline(
      path,
      settings,
      vadSettings,
      diarizeSettings,
      audioEventSettings,
    );
    if (notices.length > 0) {
      useAppStore.setState({ refineNotice: notices.join(" ") });
    }

    const targets = nonBlankChunks(result).map((c) => c.timestamp);
    const rebasedEvents = newEvents.map((e) => ({ ...e, start: e.start + baseSec, end: e.end + baseSec }));
    useAppStore.setState((s) => ({
      audioEvents: [...s.audioEvents.filter((e) => e.start < baseSec), ...rebasedEvents],
    }));

    const refined = segmentsFromResult(result, baseSec, peekNextSegmentId(), speakers, excluded, newEvents);
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
    if (refined.some((s) => s.text.trim() !== "")) {
      useAppStore.setState((s) => ({
        segments: [...s.segments.slice(0, keptSegments), ...refined],
      }));

      // Persisted on the recording's own 0-based timeline (not the session's
      // global one) and with freshly sequential ids, so a history entry looks
      // identical whether it was the first or the fifth recording of its
      // original session -- see history.ts's module doc.
      const localSegments = refined.map((s, i) => ({
        ...s,
        id: i + 1,
        startOffsetSec: s.startOffsetSec - baseSec,
      }));
      try {
        await saveRecordingHistory(idFromWavPath(path), {
          durationSec: recordingDurationSec,
          language: settings.language,
          transcribed: true,
          usedDiarize: diarizeSettings.enabled,
          usedVad: vadSettings.enabled,
          usedAudioEvents: audioEventSettings.enabled,
          segments: localSegments,
          audioEvents: newEvents,
        });
        void useAppStore.getState().refreshRecordingHistory();
      } catch (err) {
        // The transcript on screen (and its place in this session) is
        // unaffected -- only future browsing of it from the history sidebar
        // is lost, which is a much smaller loss than any other failure path
        // in this function.
        useAppStore.setState({
          refineNotice: `録音履歴への保存に失敗しました（今の文字起こしはそのまま使えます）: ${toErrorMessage(err)}`,
        });
      }
    }
  } catch (err) {
    useAppStore.setState({
      refineNotice: `精度向上パスに失敗しました（表示中の文字起こしはそのまま使えます）: ${toErrorMessage(err)}`,
    });
  } finally {
    useAppStore.setState({ processing: null, refineProgress: null });
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
export async function finishRecordOnly(capture: RecordingCapture): Promise<void> {
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
