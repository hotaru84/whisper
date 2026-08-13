import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AsrDevice, TranscriptChunk, TranscriptionTask } from "./types";
import { logPcmStats, logResultHealth } from "./diagnostics";

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

interface ModelReadyPayload {
  device: AsrDevice;
}

interface AsrErrorPayload {
  message: string;
}

interface RefineProgressPayload {
  percent: number;
}

/**
 * Talks to the native whisper.cpp backend (see src-tauri/src/asr.rs) via Tauri
 * commands and events. Model inference runs entirely in Rust; this class only
 * relays invoke()/listen() calls and shapes the results for the app store.
 */
export class AsrClient {
  private handlers: AsrClientHandlers;
  private initialized = false;
  private unlisten: UnlistenFn[] = [];

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
    return await invoke<Array<number | null>>("diarize_recording", {
      path,
      chunks,
      threshold: settings.threshold,
      numSpeakers: settings.numSpeakers,
      minDurationOn: settings.minDurationOn,
      minDurationOff: settings.minDurationOff,
    });
  }

  dispose(): void {
    for (const un of this.unlisten) un();
    this.unlisten = [];
    this.initialized = false;
  }
}
