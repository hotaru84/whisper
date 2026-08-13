/**
 * Combines the microphone stream with a second 16 kHz mono f32 stream (the
 * target app's rendered audio, from `appAudio.ts`) into one PCM stream for
 * the streaming transcriber and the WAV capture.
 *
 * The mic drives the pace: every mic frame produces exactly one mixed frame
 * of the same length, since the rest of the recording pipeline (chunk-and-
 * commit windowing, the WAV writer) is already built around "one call per mic
 * frame". App audio is a passenger -- it accumulates in a queue and gets
 * drawn down by however much a mic frame needs. If the app hasn't sent enough
 * yet, the missing tail is silence, not a stall: waiting for app audio to
 * catch up would delay the transcript on a stream that is, from the
 * transcript's point of view, optional. See `appaudio.rs`'s own capture loop
 * for the other half of this: it already pads its own output with silence on
 * a wall-clock schedule, so under normal operation this mixer rarely needs to
 * pad anything itself -- the padding here is a second line of defense for
 * startup lag and scheduling jitter between the two independent streams.
 */

/** Each source is scaled down before summing, so two simultaneous full-scale
 * peaks (0.7 + 0.7 = 1.4) clip only mildly and rarely, instead of every
 * loud moment in either stream clipping on its own. */
const GAIN = 0.7;

/** Caps how much unconsumed app audio can pile up if it arrives faster than
 * the mic draws it down (e.g. a burst after the mic stream briefly stalls).
 * 5s at 16 kHz mono; well beyond anything a healthy stream should reach. */
const MAX_QUEUED_SAMPLES = 5 * 16_000;

export class AudioMixer {
  private appPending: Float32Array[] = [];
  private appSamples = 0;

  /** Queues app-audio samples to be drawn down by subsequent `mix()` calls. */
  pushAppAudio(frame: Float32Array): void {
    if (frame.length === 0) return;
    this.appPending.push(frame);
    this.appSamples += frame.length;
    this.dropOverflow();
  }

  /**
   * Mixes `micFrame` with an equal-length slice of queued app audio (silence
   * where none has arrived yet) and returns the combined frame. `micFrame`
   * itself is never mutated.
   */
  mix(micFrame: Float32Array): Float32Array {
    const appSlice = this.takeAppAudio(micFrame.length);
    const out = new Float32Array(micFrame.length);
    for (let i = 0; i < micFrame.length; i++) {
      out[i] = clamp(micFrame[i] * GAIN + appSlice[i] * GAIN);
    }
    return out;
  }

  /** Samples currently queued and not yet consumed by `mix()`. Exposed for tests. */
  get queuedAppSamples(): number {
    return this.appSamples;
  }

  private takeAppAudio(n: number): Float32Array {
    const out = new Float32Array(n); // zero-filled: silence by default
    let filled = 0;
    while (filled < n && this.appPending.length > 0) {
      const head = this.appPending[0];
      const take = Math.min(head.length, n - filled);
      out.set(head.subarray(0, take), filled);
      filled += take;
      this.appSamples -= take;
      if (take === head.length) {
        this.appPending.shift();
      } else {
        this.appPending[0] = head.subarray(take);
      }
    }
    return out;
  }

  private dropOverflow(): void {
    while (this.appSamples > MAX_QUEUED_SAMPLES && this.appPending.length > 0) {
      this.appSamples -= this.appPending[0].length;
      this.appPending.shift();
    }
  }
}

function clamp(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
