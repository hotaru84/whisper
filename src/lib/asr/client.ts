import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AsrDevice, TranscriptChunk, TranscriptionTask } from "./types";
import { logPcmStats, logResultHealth } from "./diagnostics";
import { ANALYSIS_CANCELLED } from "./cancel";
import { useMockBackend } from "../env";
import { WHISPER_SAMPLE_RATE } from "../audio/resample";

export interface AsrClientHandlers {
  onDeviceInfo?: (device: AsrDevice) => void;
  onModelReady?: () => void;
  onError?: (message: string) => void;
  /** 0-100, while the second pass re-reads a finished recording. */
  onRefineProgress?: (percent: number) => void;
}

export interface TranscribeOptions {
  language?: string;
  task?: TranscriptionTask;
  /**
   * Terminology to prime the decoder with, passed through as whisper's
   * `initial_prompt`.
   *
   * Must only ever be text the user wrote. Feeding the model's own output back in
   * was tried and reverted: it turns one stumble into a self-amplifying
   * repetition loop.
   */
  glossary?: string;
}

export interface TranscribeResult {
  text: string;
  chunks: TranscriptChunk[];
  /** True when VAD was requested but its model file was missing, so the pass
   * ran without it. Only ever set by `transcribeRecording`. */
  vadUnavailable?: boolean;
}

/**
 * User-facing speaker diarization knobs, mirroring `diarize::DiarizeSettings`
 * in Rust. Kept as its own settings slice rather than folded into
 * `TranscribeOptions`: diarization is a separate model pass that runs after
 * transcription, not a decoding parameter.
 */
export interface DiarizeSettings {
  /** Off by default -- see `diarize::DiarizeSettings` for why. */
  enabled: boolean;
  threshold: number;
  /** -1 = estimate the speaker count automatically. */
  numSpeakers: number;
  minDurationOn: number;
  minDurationOff: number;
}

export const DEFAULT_DIARIZE_SETTINGS: DiarizeSettings = {
  enabled: false,
  threshold: 0.5,
  numSpeakers: -1,
  minDurationOn: 0.3,
  minDurationOff: 0.5,
};

/**
 * Voice-activity-detection knobs for the second pass, mirroring the
 * `vad_*` fields of `asr::DecodeSettings` in Rust. Only ever applied to
 * `transcribeRecording`: the live pass already gates near-silent windows on
 * the frontend (see `diagnostics.isNearSilent`), so a second, heavier filter
 * there would mostly add model-load cost without much left to catch.
 */
export interface VadSettings {
  /** On by default: the whole-file second pass cannot skip silence on the way
   * in (a meeting's pauses sit in the middle of audio it still has to decode
   * as one piece), which is exactly the case VAD helps most. */
  enabled: boolean;
  threshold: number;
}

export const DEFAULT_VAD_SETTINGS: VadSettings = {
  enabled: true,
  threshold: 0.5,
};

/**
 * Audio event (audio tagging) knobs, mirroring `events::AudioEventSettings`
 * in Rust. A separate settings slice for the same reason as diarization: a
 * post-hoc model pass over the finished recording, not a decoding parameter.
 */
export interface AudioEventSettings {
  /** Off by default -- see `events::AudioEventSettings` for why. */
  enabled: boolean;
  threshold: number;
  topK: number;
}

export const DEFAULT_AUDIO_EVENT_SETTINGS: AudioEventSettings = {
  enabled: false,
  threshold: 0.3,
  topK: 3,
};

/** One detected tag on a `[start, end)` window of the recording, mirroring
 * `events::AudioEvent` in Rust. Never rendered into the transcript body --
 * see `events.rs`'s module doc for why. */
export interface AudioEvent {
  start: number;
  end: number;
  name: string;
  index: number;
  prob: number;
}

export interface AudioEventResult {
  events: AudioEvent[];
  /** One entry per input chunk, in the same order -- see `diarizeRecording`. */
  exclude: boolean[];
}

interface ModelReadyPayload {
  device: AsrDevice;
}

interface AsrErrorPayload {
  message: string;
}

interface RefineProgressPayload {
  percent: number;
}

// --- Mock backend (see ../env.ts) --------------------------------------
// Everything below this line only ever runs when `useMockBackend` is true --
// `npm run dev` opened in a plain browser, with no Tauri/Rust backend behind
// it. It exists purely so the app's screen transitions (record -> starting ->
// recording -> stop -> home, the history 解析/解析中止 toggle) can still be
// clicked through for UI review; the fake text below is never meant to look
// like a real transcript.

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let mockWindowCount = 0;
const MOCK_LIVE_PHRASES = [
  "（モック）これはバックエンドなしのプレビュー用の文字起こしです。",
  "（モック）実際の音声認識は行われていません。",
  "（モック）画面遷移の確認用のダミーテキストです。",
];

function mockTranscribeWindow(audio: Float32Array): TranscribeResult {
  const text = MOCK_LIVE_PHRASES[mockWindowCount % MOCK_LIVE_PHRASES.length];
  mockWindowCount += 1;
  const durationSec = Math.max(1, audio.length / WHISPER_SAMPLE_RATE);
  return { text, chunks: [{ text, timestamp: [0, durationSec] }] };
}

const MOCK_REFINED_TEXT =
  "（モック）精度向上パス完了後の文字起こし結果です。バックエンドに接続されていないため、実際の音声内容は反映されていません。";

/**
 * Talks to the native whisper.cpp backend (see src-tauri/src/asr.rs) via Tauri
 * commands and events. Model inference runs entirely in Rust; this class only
 * relays invoke()/listen() calls and shapes the results for the app store.
 */
export class AsrClient {
  private handlers: AsrClientHandlers;
  private initialized = false;
  private unlisten: UnlistenFn[] = [];
  // Mock-only (see ../env.ts): mirrors the backend's own begin/cancel flag
  // (cancel.rs) closely enough that the 解析中止 UI has something real to
  // exercise even without a backend.
  private mockCancelled = false;

  constructor(handlers: AsrClientHandlers = {}) {
    this.handlers = handlers;
  }

  /**
   * Loads the model in the Rust backend. Idempotent: repeated calls (e.g. React
   * StrictMode double-invoking effects) are ignored so the model loads once.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    if (useMockBackend) {
      // Long enough that `ModelLoadingOverlay` is visibly exercised too,
      // short enough not to be annoying on every reload.
      await wait(500);
      this.handlers.onModelReady?.();
      return;
    }

    this.unlisten.push(
      await listen<ModelReadyPayload>("asr:model-ready", (event) => {
        this.handlers.onDeviceInfo?.(event.payload.device);
        this.handlers.onModelReady?.();
      }),
      await listen<AsrErrorPayload>("asr:model-error", (event) => {
        this.handlers.onError?.(event.payload.message);
      }),
      await listen<RefineProgressPayload>("asr:refine-progress", (event) => {
        this.handlers.onRefineProgress?.(event.payload.percent);
      }),
    );

    try {
      await invoke("init_model");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.handlers.onError?.(message);
      throw err;
    }
  }

  async transcribe(audio: Float32Array, options: TranscribeOptions = {}): Promise<TranscribeResult> {
    if (useMockBackend) {
      await wait(150);
      return mockTranscribeWindow(audio);
    }

    logPcmStats(audio, options.language, options.task);

    // Send the PCM window as a raw binary IPC body (not a JSON number array) to
    // avoid serializing ~1MB of individual numbers on every window.
    // Language/task ride along as headers since they only change with settings.
    const bytes = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
    const headers: Record<string, string> = {};
    if (options.language) headers["X-Asr-Language"] = options.language;
    if (options.task) headers["X-Asr-Task"] = options.task;
    // Header values must be visible ASCII, so percent-encode the (Japanese) glossary.
    if (options.glossary?.trim()) headers["X-Asr-Prompt"] = encodeURIComponent(options.glossary);

    const result = await invoke<TranscribeResult>("transcribe_window", bytes, { headers });
    logResultHealth(result.text);
    return result;
  }

  /**
   * Re-transcribes a finished recording in one pass over the whole file.
   *
   * Slower than the live pass and worth it: the model sees the recording as one
   * continuous piece instead of a series of 15-second windows, so sentences that
   * straddled a window boundary are decoded intact. Progress arrives via
   * `onRefineProgress`.
   */
  async transcribeRecording(
    path: string,
    options: TranscribeOptions = {},
    vad: VadSettings = DEFAULT_VAD_SETTINGS,
  ): Promise<TranscribeResult> {
    if (useMockBackend) {
      // A few ticks with a delay between each, so `refineProgress` (and the
      // history row's progress bar / titlebar readout it drives) has
      // something to visibly animate rather than jumping straight to 100.
      for (const percent of [15, 35, 60, 85, 100]) {
        await wait(350);
        if (this.mockCancelled) throw new Error(ANALYSIS_CANCELLED);
        this.handlers.onRefineProgress?.(percent);
      }
      return { text: MOCK_REFINED_TEXT, chunks: [{ text: MOCK_REFINED_TEXT, timestamp: [0, 3] }] };
    }

    const result = await invoke<TranscribeResult>("transcribe_recording", {
      path,
      language: options.language ?? null,
      task: options.task ?? null,
      prompt: options.glossary?.trim() ? options.glossary : null,
      vad: vad.enabled,
      vadThreshold: vad.threshold,
    });
    logResultHealth(result.text);
    return result;
  }

  /**
   * Clears any leftover cancellation, at the head of an analysis pass.
   *
   * Called by `runAccuracyPipeline` -- the single entry point both the
   * post-stop second pass and history re-analysis go through -- so a cancel
   * that arrived too late to stop the previous pass cannot kill the next one
   * on sight.
   */
  async beginAnalysis(): Promise<void> {
    if (useMockBackend) {
      this.mockCancelled = false;
      return;
    }
    await invoke("begin_analysis");
  }

  /**
   * Asks the running analysis pass to stop. Resolves as soon as the backend
   * flag is set, *not* when the pass has actually wound down: the in-flight
   * `transcribeRecording`/`diarizeRecording`/`detectAudioEvents` promise is
   * what eventually rejects with `ANALYSIS_CANCELLED`.
   */
  async cancelAnalysis(): Promise<void> {
    if (useMockBackend) {
      this.mockCancelled = true;
      return;
    }
    await invoke("cancel_analysis");
  }

  /**
   * Diarizes a finished recording and returns one speaker (or `null`) per
   * entry of `chunks`, in the same order.
   *
   * `chunks` must be `nonBlankChunks(result).map(c => c.timestamp)` from the
   * very same `TranscribeResult` this recording produced -- diarization reads
   * the WAV file directly, on its own 0-based timeline, and that positional
   * correspondence is the only thing connecting a returned speaker back to a
   * transcript line. See `transcript.nonBlankChunks`.
   *
   * Throws if the model files are missing (see README for how to obtain them)
   * or diarization otherwise fails; the caller is expected to fall back to an
   * un-labeled transcript rather than lose the recording over this.
   */
  async diarizeRecording(
    path: string,
    chunks: Array<[number, number]>,
    settings: DiarizeSettings,
  ): Promise<Array<number | null>> {
    if (useMockBackend) {
      await wait(200);
      // Alternates two fake speakers, just enough to exercise speaker labels
      // in the transcript UI.
      return chunks.map((_, i) => i % 2);
    }
    return await invoke<Array<number | null>>("diarize_recording", {
      path,
      chunks,
      threshold: settings.threshold,
      numSpeakers: settings.numSpeakers,
      minDurationOn: settings.minDurationOn,
      minDurationOff: settings.minDurationOff,
    });
  }

  /**
   * Detects audio events on a finished recording and, for each entry of
   * `chunks`, whether it should be excluded from the transcript (no
   * overlapping speech tag, but an overlapping music/noise one).
   *
   * `chunks` must be `nonBlankChunks(result).map(c => c.timestamp)` from the
   * same `TranscribeResult`, exactly as `diarizeRecording` requires -- see its
   * doc comment for why the positional correspondence matters.
   *
   * Throws if the model files are missing (see README) or detection otherwise
   * fails; the caller is expected to keep the un-filtered transcript rather
   * than lose it over this.
   */
  async detectAudioEvents(
    path: string,
    chunks: Array<[number, number]>,
    settings: AudioEventSettings,
  ): Promise<AudioEventResult> {
    if (useMockBackend) {
      await wait(200);
      return { events: [], exclude: chunks.map(() => false) };
    }
    return await invoke<AudioEventResult>("detect_audio_events", {
      path,
      chunks,
      threshold: settings.threshold,
      topK: settings.topK,
    });
  }

  /**
   * Live counterpart to `detectAudioEvents`: tags one ~10s window of
   * already-captured PCM instead of a whole finished-recording WAV. Used by
   * `AudioEventStreamer` while a recording is still in progress; its result
   * is a preview only, always overwritten by `detectAudioEvents`' whole-
   * recording pass once the recording stops -- see `events.rs`'s module doc.
   *
   * `startSec` is where this window sits on the recording's own 0-based
   * timeline (the caller's bookkeeping, same as `transcribe`'s windows).
   */
  async detectEventsWindow(audio: Float32Array, startSec: number, settings: AudioEventSettings): Promise<AudioEvent[]> {
    if (useMockBackend) return [];
    const bytes = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
    const headers: Record<string, string> = {
      "X-Threshold": String(settings.threshold),
      "X-Top-K": String(settings.topK),
      "X-Start-Sec": String(startSec),
    };
    return await invoke<AudioEvent[]>("detect_events_window", bytes, { headers });
  }

  dispose(): void {
    for (const un of this.unlisten) un();
    this.unlisten = [];
    this.initialized = false;
  }
}
