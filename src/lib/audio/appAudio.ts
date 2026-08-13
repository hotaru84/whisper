import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface AudioAppInfo {
  processId: number;
  name: string;
  /** A `data:image/png;base64,...` URI ready for an `<img src>`, or `null`
   * when the executable had no icon resource or extraction failed. */
  icon: string | null;
}

interface AppAudioErrorPayload {
  message: string;
}

/**
 * Talks to the Rust WASAPI process-loopback capture (`src-tauri/src/appaudio.rs`).
 *
 * Only apps with an active audio session are listable -- if the target hasn't
 * joined its call yet, it won't appear until `listApps()` is called again
 * after it starts making sound. `startCapture`'s frames arrive at 16 kHz mono,
 * already resampled by WASAPI itself (no client-side resampling needed).
 */
export class AppAudioClient {
  private unlistenError: UnlistenFn | null = null;

  /** Apps currently capable of being captured (have an active audio session). */
  async listApps(): Promise<AudioAppInfo[]> {
    return await invoke<AudioAppInfo[]>("list_audio_apps");
  }

  /**
   * Starts capturing `processId`'s rendered audio. `onFrame` receives 16 kHz
   * mono f32 PCM frames as they arrive, roughly every 100ms.
   *
   * `onError` fires if the capture fails after starting (most commonly: the
   * target process exited) -- the caller is expected to fall back to
   * mic-only rather than lose the whole recording over this.
   */
  async startCapture(
    processId: number,
    onFrame: (frame: Float32Array) => void,
    onError: (message: string) => void,
  ): Promise<void> {
    await this.stopCapture();

    this.unlistenError = await listen<AppAudioErrorPayload>("asr:app-audio-error", (event) => {
      onError(event.payload.message);
    });

    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buffer) => {
      onFrame(new Float32Array(buffer));
    };

    await invoke("start_app_audio_capture", { processId, channel });
  }

  async stopCapture(): Promise<void> {
    this.unlistenError?.();
    this.unlistenError = null;
    try {
      await invoke("stop_app_audio_capture");
    } catch {
      // Nothing was running -- fine, this is also how callers unconditionally
      // clean up after a recording that never had app audio enabled.
    }
  }
}
