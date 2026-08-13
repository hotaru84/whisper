import { create } from "zustand";
import { AsrClient, RecordingCapture, StreamingTranscriber } from "../lib/asr";
import type { AsrDevice, TranscriptionTask, TranscribeResult, StreamingSegment } from "../lib/asr";
import type { TranscriptSegment } from "../lib/transcript";
import { segmentsFromResult } from "../lib/transcript";
import { startPcmRecording, decodeAudioToPcm16k, createAudioLevelMeter, WHISPER_SAMPLE_RATE } from "../lib/audio";
import type { PcmRecorderController, AudioLevelMeter } from "../lib/audio";

/**
 * `processing` flushes the last live window; `refining` is the second pass
 * re-reading the whole recording. They are distinct because they take wildly
 * different amounts of time -- a second or two versus minutes -- and only the
 * second one has progress to report.
 */
export type RecordingStatus = "idle" | "recording" | "processing" | "refining" | "done" | "error";
export type ModelStatus = "loading" | "ready" | "error";

export interface AsrSettings {
  language: string;
  task: TranscriptionTask;
  /**
   * Terminology the model should be primed with: product names, jargon, people —
   * anything it would otherwise mis-hear. Passed to whisper as `initial_prompt`.
   *
   * A soft bias, not a constraint, and a small budget: ~224 tokens, which for
   * Japanese is roughly 200 characters. Text past that is silently dropped.
   */
  glossary: string;
}

const SETTINGS_KEY = "asr-settings";

/**
 * Settings survive restarts, which matters most for the glossary: retyping it
 * every session would make the feature not worth using.
 */
function loadSettings(): AsrSettings {
  const defaults: AsrSettings = { language: "ja", task: "transcribe", glossary: "" };
  try {
    const stored = globalThis.localStorage?.getItem(SETTINGS_KEY);
    if (!stored) return defaults;
    const parsed = JSON.parse(stored) as Partial<AsrSettings>;
    return {
      language: typeof parsed.language === "string" ? parsed.language : defaults.language,
      task: parsed.task === "translate" ? "translate" : "transcribe",
      glossary: typeof parsed.glossary === "string" ? parsed.glossary : defaults.glossary,
    };
  } catch {
    // Corrupt or unavailable storage must never stop the app from starting.
    return defaults;
  }
}

function saveSettings(settings: AsrSettings): void {
  try {
    globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Persistence is a convenience; losing it is not worth surfacing an error.
  }
}

interface AppState {
  recordingStatus: RecordingStatus;
  modelStatus: ModelStatus;
  modelDevice: AsrDevice | null;
  /** Accumulated transcript. Grows across start/stop cycles; cleared via clearTranscript(). */
  segments: TranscriptSegment[];
  errorMessage: string | null;
  /**
   * Why the second pass did not happen, when the live transcript is still good.
   * Kept apart from `errorMessage` because nothing is broken: the user has a
   * transcript, it just did not get the accuracy pass.
   */
  refineNotice: string | null;
  /** 0-100 while `recordingStatus` is "refining", otherwise null. */
  refineProgress: number | null;
  settings: AsrSettings;
  levelMeter: AudioLevelMeter | null;

  initModel: () => Promise<void>;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  updateSettings: (partial: Partial<AsrSettings>) => void;
  clearTranscript: () => void;
  reset: () => void;
}

let activeRecorder: PcmRecorderController | null = null;
let activeStreamer: StreamingTranscriber | null = null;
let activeCapture: RecordingCapture | null = null;
// Monotonic segment id and the running timeline position where the *next*
// recording's audio begins, so appended segments keep a continuous timeline.
let nextSegmentId = 1;
let timelineBaseSec = 0;
// Where the current recording starts, on the timeline and in the segment list.
// The second pass replaces everything this recording produced, so it needs both.
let recordingBaseSec = 0;
let segmentsBeforeRecording = 0;

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Appends a streaming segment (offset relative to the current recording) onto the
// global transcript timeline.
function appendStreamingSegment(seg: StreamingSegment) {
  const segment: TranscriptSegment = {
    id: nextSegmentId++,
    startOffsetSec: timelineBaseSec + seg.offsetSec,
    text: seg.text,
    chunks: seg.chunks,
  };
  useAppStore.setState((s) => ({ segments: [...s.segments, segment] }));
}

const asrClient = new AsrClient({
  onDeviceInfo: (device) => useAppStore.setState({ modelDevice: device }),
  onModelReady: () => useAppStore.setState({ modelStatus: "ready" }),
  onError: (message) => useAppStore.setState({ modelStatus: "error", errorMessage: message }),
  onRefineProgress: (percent) => useAppStore.setState({ refineProgress: percent }),
});

/**
 * Re-transcribes the finished recording as one continuous piece and swaps the
 * result in for the segments the live pass produced.
 *
 * Every failure path here keeps the live transcript. The second pass is an
 * improvement on something the user already has; losing it costs accuracy, while
 * discarding the live result would cost them the meeting.
 */
async function refineRecording(capture: RecordingCapture): Promise<void> {
  const keptSegments = segmentsBeforeRecording;
  const baseSec = recordingBaseSec;

  let path: string;
  try {
    path = (await capture.finish()).path;
  } catch (err) {
    useAppStore.setState({
      refineNotice: `録音ファイルの保存に失敗したため、精度向上パスは省略しました（表示中の文字起こしはそのまま使えます）: ${toErrorMessage(err)}`,
    });
    return;
  }

  useAppStore.setState({ recordingStatus: "refining", refineProgress: 0 });
  try {
    const result = await asrClient.transcribeRecording(path, useAppStore.getState().settings);
    const refined = segmentsFromResult(result, baseSec, nextSegmentId);
    // An empty second pass means something went wrong upstream, not that the
    // meeting was silent -- the live pass already found speech in this audio.
    if (refined.length > 0) {
      nextSegmentId += refined.length;
      useAppStore.setState((s) => ({
        segments: [...s.segments.slice(0, keptSegments), ...refined],
      }));
    }
  } catch (err) {
    useAppStore.setState({
      refineNotice: `精度向上パスに失敗しました（表示中の文字起こしはそのまま使えます）: ${toErrorMessage(err)}`,
    });
  } finally {
    useAppStore.setState({ recordingStatus: "done", refineProgress: null });
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  recordingStatus: "idle",
  modelStatus: "loading",
  modelDevice: null,
  segments: [],
  errorMessage: null,
  refineNotice: null,
  refineProgress: null,
  settings: loadSettings(),
  levelMeter: null,

  initModel: async () => {
    try {
      await asrClient.init();
    } catch (err) {
      set({ modelStatus: "error", errorMessage: toErrorMessage(err) });
    }
  },

  startRecording: async () => {
    try {
      // Transcribe on the fly: the recorder streams PCM frames into the streaming
      // transcriber, which commits transcript segments while recording continues.
      const streamer = new StreamingTranscriber(
        (audio) => asrClient.transcribe(audio, get().settings),
        appendStreamingSegment,
      );

      // The same frames also go to disk, for the second pass after stop. If that
      // cannot be started, record anyway: a live-only transcript beats no
      // recording because the cache directory was not writable.
      const capture = new RecordingCapture();
      let captureStarted = true;
      try {
        await capture.start();
      } catch (err) {
        captureStarted = false;
        console.warn("[capture] disabled for this recording:", err);
      }

      const controller = await startPcmRecording((frame) => {
        streamer.pushFrame(frame);
        if (captureStarted) capture.push(frame);
      });
      activeRecorder = controller;
      activeStreamer = streamer;
      activeCapture = captureStarted ? capture : null;
      recordingBaseSec = timelineBaseSec;
      segmentsBeforeRecording = get().segments.length;
      const levelMeter = createAudioLevelMeter(controller.stream);
      // Existing segments are kept: a new recording appends to the transcript.
      set({
        recordingStatus: "recording",
        errorMessage: null,
        refineNotice: captureStarted
          ? null
          : "録音を保存できないため、停止後の精度向上パスは行われません。",
        levelMeter,
      });
    } catch (err) {
      activeRecorder = null;
      activeStreamer = null;
      activeCapture = null;
      set({ recordingStatus: "error", errorMessage: toErrorMessage(err) });
    }
  },

  stopRecording: async () => {
    const controller = activeRecorder;
    const streamer = activeStreamer;
    const capture = activeCapture;
    if (!controller || !streamer) return;
    activeRecorder = null;
    activeStreamer = null;
    activeCapture = null;
    get().levelMeter?.dispose();
    set({ recordingStatus: "processing", levelMeter: null });

    try {
      const totalSamples = await controller.stop();
      // Flush any audio not yet committed by the streaming pass.
      await streamer.finish();
      timelineBaseSec = recordingBaseSec + totalSamples / WHISPER_SAMPLE_RATE;
      set({ recordingStatus: "done" });
    } catch (err) {
      // The capture file is left open here on purpose: it is valid on disk at
      // every moment (see wav::Writer), and the backend closes it when the next
      // recording starts. Nothing is lost by not finishing it.
      set({ recordingStatus: "error", errorMessage: toErrorMessage(err) });
      return;
    }

    // Then re-read the whole recording for accuracy, replacing what the live
    // windows produced. Runs after the live result is already on screen, so the
    // user has a transcript throughout.
    if (capture) await refineRecording(capture);
  },

  updateSettings: (partial) =>
    set((s) => {
      const settings = { ...s.settings, ...partial };
      saveSettings(settings);
      return { settings };
    }),

  clearTranscript: () => {
    nextSegmentId = 1;
    timelineBaseSec = 0;
    recordingBaseSec = 0;
    segmentsBeforeRecording = 0;
    set({
      segments: [],
      recordingStatus: "idle",
      errorMessage: null,
      refineNotice: null,
      refineProgress: null,
    });
  },

  reset: () => set({ recordingStatus: "idle", errorMessage: null, refineNotice: null }),
}));

// Dev-only diagnostic: transcribe an audio file from a URL through the exact
// same decode + pipeline path as the mic flow, to isolate model/audio issues
// from microphone capture. Exposed on window in dev via App.
export async function debugTranscribeUrl(
  url: string,
  overrides?: Partial<AsrSettings>,
): Promise<TranscribeResult> {
  const response = await fetch(url);
  const blob = await response.blob();
  const pcm = await decodeAudioToPcm16k(blob);
  const settings = { ...useAppStore.getState().settings, ...overrides };
  const result = await asrClient.transcribe(pcm, settings);
  console.log("[debugTranscribeUrl]", url, settings, "->", result);
  return result;
}

// Dev-only diagnostic: feed an audio file through the *streaming* path (chunk-
// and-commit + real model), simulating a live recording, to exercise the same
// integration the mic flow uses without a microphone. Returns the emitted
// streaming segments.
export async function debugStreamTranscribeUrl(
  url: string,
  overrides?: Partial<AsrSettings>,
): Promise<StreamingSegment[]> {
  const response = await fetch(url);
  const blob = await response.blob();
  const pcm = await decodeAudioToPcm16k(blob);
  const settings = { ...useAppStore.getState().settings, ...overrides };

  const segments: StreamingSegment[] = [];
  const streamer = new StreamingTranscriber(
    (audio) => asrClient.transcribe(audio, settings),
    (seg) => segments.push(seg),
  );
  // Push in ~100ms frames to mimic live capture.
  const frameLen = Math.round(WHISPER_SAMPLE_RATE * 0.1);
  for (let i = 0; i < pcm.length; i += frameLen) {
    streamer.pushFrame(pcm.slice(i, Math.min(i + frameLen, pcm.length)));
    await Promise.resolve();
  }
  await streamer.finish();
  console.log("[debugStreamTranscribeUrl]", url, settings, "->", segments);
  return segments;
}
