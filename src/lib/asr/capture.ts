import { invoke } from "@tauri-apps/api/core";
import { WHISPER_SAMPLE_RATE } from "../audio/resample";
import { useMockBackend } from "../env";

/**
 * How much audio to accumulate before handing it to the backend.
 *
 * Frames arrive from the worklet every ~100 ms; sending each one would mean ten
 * IPC round-trips a second for the whole meeting. Five seconds is 160 kB per
 * call, small enough that a hitch is invisible and short enough that a crash
 * loses almost nothing.
 */
const FLUSH_SEC = 5;
const FLUSH_SAMPLES = FLUSH_SEC * WHISPER_SAMPLE_RATE;

export interface CaptureInfo {
  path: string;
  durationSec: number;
}

/** `rec-20260813-084500`, in local time so the file is findable by when it was made. */
function defaultName(now = new Date()): string {
  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  return `rec-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(
    now.getHours(),
  )}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/**
 * Streams the microphone audio to a WAV file on disk while it is being recorded,
 * so a second, more accurate pass can re-read the whole thing after the user
 * stops (and so diarization has something to work with).
 *
 * Failures here are deliberately not fatal. The live transcript is what the user
 * is watching; if the disk is full or the backend rejects a write, recording
 * carries on and only the second pass is lost. `finish()` surfaces the failure
 * so the caller can say so and skip re-transcribing.
 */
export class RecordingCapture {
  private pending: Float32Array[] = [];
  private pendingSamples = 0;
  /** Serializes flushes: out-of-order appends would interleave the audio. */
  private tail: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  private closed = false;
  // Mock-only bookkeeping (see ../env.ts) -- there is no real file, so
  // `finish()` fakes a duration from wall-clock time instead.
  private mockName = "";
  private mockStartedAt = 0;

  async start(name = defaultName()): Promise<string> {
    if (useMockBackend) {
      this.mockName = name;
      this.mockStartedAt = Date.now();
      return `mock-recordings/${name}.wav`;
    }
    return await invoke<string>("start_capture", { name });
  }

  /** Buffers one captured PCM frame, flushing once FLUSH_SEC has accumulated. */
  push(frame: Float32Array): void {
    if (this.closed || this.failure) return;
    // No file to append to -- the streaming transcript (which doesn't go
    // through this class) is what the mock backend drives instead.
    if (useMockBackend) return;
    this.pending.push(frame);
    this.pendingSamples += frame.length;
    if (this.pendingSamples >= FLUSH_SAMPLES) this.flush();
  }

  private flush(): void {
    if (this.pendingSamples === 0) return;
    const batch = new Float32Array(this.pendingSamples);
    let offset = 0;
    for (const frame of this.pending) {
      batch.set(frame, offset);
      offset += frame.length;
    }
    this.pending = [];
    this.pendingSamples = 0;

    this.tail = this.tail.then(async () => {
      // One failure is enough: a full disk would otherwise produce an error per
      // flush for the rest of the meeting.
      if (this.failure) return;
      try {
        const bytes = new Uint8Array(batch.buffer, batch.byteOffset, batch.byteLength);
        await invoke("append_capture", bytes);
      } catch (err) {
        this.failure = err instanceof Error ? err : new Error(String(err));
      }
    });
  }

  /**
   * Flushes what is left and closes the file. Rejects if any write failed, in
   * which case the recording on disk is incomplete and must not be re-transcribed.
   */
  async finish(): Promise<CaptureInfo> {
    this.closed = true;
    if (useMockBackend) {
      return {
        path: `mock-recordings/${this.mockName}.wav`,
        durationSec: Math.max(1, (Date.now() - this.mockStartedAt) / 1000),
      };
    }
    this.flush();
    await this.tail;
    const info = await invoke<CaptureInfo>("finish_capture");
    if (this.failure) throw this.failure;
    return info;
  }
}
