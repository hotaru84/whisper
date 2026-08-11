import { create } from "zustand";
import { AsrClient, StreamingTranscriber } from "../lib/asr";
import type { AsrDevice, TranscriptionTask, TranscribeResult, StreamingSegment } from "../lib/asr";
import type { TranscriptSegment } from "../lib/transcript";
import { startPcmRecording, decodeAudioToPcm16k, createAudioLevelMeter, WHISPER_SAMPLE_RATE } from "../lib/audio";
import type { PcmRecorderController, AudioLevelMeter } from "../lib/audio";

export type RecordingStatus = "idle" | "recording" | "processing" | "done" | "error";
export type ModelStatus = "loading" | "ready" | "error";

export interface AsrSettings {
  language: string;
  task: TranscriptionTask;
}

interface AppState {
  recordingStatus: RecordingStatus;
  modelStatus: ModelStatus;
  modelDevice: AsrDevice | null;
  /** Accumulated transcript. Grows across start/stop cycles; cleared via clearTranscript(). */
  segments: TranscriptSegment[];
  errorMessage: string | null;
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
// Monotonic segment id and the running timeline position where the *next*
// recording's audio begins, so appended segments keep a continuous timeline.
let nextSegmentId = 1;
let timelineBaseSec = 0;

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
});

export const useAppStore = create<AppState>((set, get) => ({
  recordingStatus: "idle",
  modelStatus: "loading",
  modelDevice: null,
  segments: [],
  errorMessage: null,
  settings: { language: "ja", task: "transcribe" },
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
      const controller = await startPcmRecording((frame) => streamer.pushFrame(frame));
      activeRecorder = controller;
      activeStreamer = streamer;
      const levelMeter = createAudioLevelMeter(controller.stream);
      // Existing segments are kept: a new recording appends to the transcript.
      set({ recordingStatus: "recording", errorMessage: null, levelMeter });
    } catch (err) {
      activeRecorder = null;
      activeStreamer = null;
      set({ recordingStatus: "error", errorMessage: toErrorMessage(err) });
    }
  },

  stopRecording: async () => {
    const controller = activeRecorder;
    const streamer = activeStreamer;
    if (!controller || !streamer) return;
    activeRecorder = null;
    activeStreamer = null;
    get().levelMeter?.dispose();
    set({ recordingStatus: "processing", levelMeter: null });

    try {
      const totalSamples = await controller.stop();
      // Flush any audio not yet committed by the streaming pass.
      await streamer.finish();
      timelineBaseSec += totalSamples / WHISPER_SAMPLE_RATE;
      set({ recordingStatus: "done" });
    } catch (err) {
      set({ recordingStatus: "error", errorMessage: toErrorMessage(err) });
    }
  },

  updateSettings: (partial) => set((s) => ({ settings: { ...s.settings, ...partial } })),

  clearTranscript: () => {
    nextSegmentId = 1;
    timelineBaseSec = 0;
    set({ segments: [], recordingStatus: "idle", errorMessage: null });
  },

  reset: () => set({ recordingStatus: "idle", errorMessage: null }),
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
