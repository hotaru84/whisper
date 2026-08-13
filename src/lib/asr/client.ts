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
  ): Promise<TranscribeResult> {
    const result = await invoke<TranscribeResult>("transcribe_recording", {
      path,
      language: options.language ?? null,
      task: options.task ?? null,
      prompt: options.glossary?.trim() ? options.glossary : null,
    });
    logResultHealth(result.text);
    return result;
  }

  dispose(): void {
    for (const un of this.unlisten) un();
    this.unlisten = [];
    this.initialized = false;
  }
}
