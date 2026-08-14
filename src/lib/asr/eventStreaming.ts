import type { AudioEvent } from "./client";
import { WHISPER_SAMPLE_RATE as SR } from "../audio/resample";

/** Matches `events.rs`'s `WINDOW_SEC` -- the AudioSet models this app uses
 * were trained on 10-second clips, so a live window has to match that
 * exactly (not just "at least"), unlike whisper's live window which is
 * allowed to grow past its target while draining a backlog. */
const WINDOW_SEC = 10;

/**
 * Live counterpart to `StreamingTranscriber` (`streaming.ts`), feeding the
 * same kind of chunk-and-commit windowing into `events::detect_events_window`
 * instead of whisper. Considerably simpler than the ASR streamer: a tag is a
 * whole-window classification with no mid-sentence carry-over to negotiate,
 * so this always extracts exactly `WINDOW_SEC` of audio per window (never
 * more), and drains any backlog as several fixed-size windows rather than
 * one oversized one.
 *
 * Its output is a live *preview* -- see `events.rs`'s module doc for the
 * two-layer "live preview, post-hoc authoritative" split this streamer only
 * ever feeds the preview half of.
 */
export class AudioEventStreamer {
  private frames: Float32Array[] = [];
  private pendingSamples = 0;
  private elapsedSec = 0;
  private processing = false;

  constructor(
    private readonly detect: (audio: Float32Array, startSec: number) => Promise<AudioEvent[]>,
    private readonly onEvents: (events: AudioEvent[]) => void,
  ) {}

  /** Feed one captured PCM frame (called from the recorder's onFrame). */
  pushFrame(frame: Float32Array): void {
    this.frames.push(frame);
    this.pendingSamples += frame.length;
    void this.maybeProcess();
  }

  /** Flushes a final, possibly short, trailing window. Await after stopping. */
  async finish(): Promise<void> {
    while (this.processing) await delay(50);
    this.processing = true;
    try {
      await this.drain(true);
    } finally {
      this.processing = false;
    }
  }

  private async maybeProcess(): Promise<void> {
    if (this.processing) return;
    if (this.pendingSamples < WINDOW_SEC * SR) return;
    this.processing = true;
    try {
      await this.drain(false);
    } finally {
      this.processing = false;
    }
  }

  /**
   * Unlike `StreamingTranscriber`'s drain loop, this needs no "did it make
   * progress" guard: every non-final window always takes exactly
   * `WINDOW_SEC * SR` samples (the loop only runs when at least that much is
   * pending), and a final flush always takes everything left, so each
   * iteration strictly reduces `pendingSamples` -- there is no partial-commit
   * case here that could stall, the way whisper's "how much did it actually
   * transcribe" carry-over logic can.
   */
  private async drain(final: boolean): Promise<void> {
    while (final ? this.pendingSamples > 0 : this.pendingSamples >= WINDOW_SEC * SR) {
      await this.processWindow(final);
    }
  }

  private async processWindow(final: boolean): Promise<void> {
    const take = final ? this.pendingSamples : Math.min(this.pendingSamples, WINDOW_SEC * SR);
    if (take === 0) return;

    const audio = this.takeFront(take);
    const startSec = this.elapsedSec;
    this.elapsedSec += take / SR;

    try {
      const events = await this.detect(audio, startSec);
      if (events.length > 0) this.onEvents(events);
    } catch (err) {
      // A dropped window of tagging costs a gap in the preview, not the
      // recording itself -- never worth interrupting recording over.
      console.warn("[audio-events] live detection failed for one window:", err);
    }
  }

  /** Removes and returns exactly `n` samples from the front of `frames`. */
  private takeFront(n: number): Float32Array {
    const out = new Float32Array(n);
    let filled = 0;
    while (filled < n && this.frames.length > 0) {
      const frame = this.frames[0];
      const need = n - filled;
      if (frame.length <= need) {
        out.set(frame, filled);
        filled += frame.length;
        this.frames.shift();
      } else {
        out.set(frame.subarray(0, need), filled);
        this.frames[0] = frame.subarray(need);
        filled += need;
      }
    }
    this.pendingSamples -= filled;
    return out;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
