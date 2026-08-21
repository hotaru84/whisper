import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useMockBackend } from "../env";

interface AppAudioErrorPayload {
  message: string;
}

/**
 * Talks to the Rust WASAPI endpoint-loopback capture (`src-tauri/src/appaudio.rs`).
 *
 * Captures whatever plays through the default output device -- not scoped to
 * any one application -- so `startCapture`'s frames arrive at 16 kHz mono,
 * already resampled by WASAPI itself (no client-side resampling needed).
 */
export class AppAudioClient {
  private unlistenError: UnlistenFn | null = null;

  /**
   * Starts capturing whatever plays through the default output device.
   * `onFrame` receives 16 kHz mono f32 PCM frames as they arrive, roughly
   * every 100ms.
   *
   * `onError` fires if the capture fails after starting -- the caller is
   * expected to fall back to mic-only rather than lose the whole recording
   * over this.
   */
  async startCapture(onFrame: (frame: Float32Array) => void, onError: (message: string) => void): Promise<void> {
    await this.stopCapture();

    // Nothing to capture and nothing to report: `AudioMixer` is paced by the
    // microphone, so a source that never delivers a frame simply mixes in as
    // silence and the rest of the recording path is unchanged.
    if (useMockBackend) return;

    this.unlistenError = await listen<AppAudioErrorPayload>("asr:app-audio-error", (event) => {
      onError(event.payload.message);
    });

    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buffer) => {
      onFrame(new Float32Array(buffer));
    };

    await invoke("start_app_audio_capture", { channel });
  }

  async stopCapture(): Promise<void> {
    this.unlistenError?.();
    this.unlistenError = null;
    if (useMockBackend) return;
    try {
      await invoke("stop_app_audio_capture");
    } catch {
      // Nothing was running -- fine, this is also how callers unconditionally
      // clean up after a recording that never had app audio enabled.
    }
  }
}
