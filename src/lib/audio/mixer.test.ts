import { describe, it, expect } from "vitest";
import { AudioMixer } from "./mixer";

function tone(length: number, value: number): Float32Array {
  return new Float32Array(length).fill(value);
}

describe("AudioMixer", () => {
  it("mixes mic and app audio at equal gain when both are present", () => {
    const mixer = new AudioMixer();
    mixer.pushAppAudio(tone(4, 0.2));
    const out = mixer.mix(tone(4, 0.1));
    // 0.1*0.7 + 0.2*0.7 = 0.21
    for (const v of out) expect(v).toBeCloseTo(0.21, 5);
  });

  it("pads with silence when no app audio has arrived yet", () => {
    const mixer = new AudioMixer();
    const out = mixer.mix(tone(4, 0.1));
    // 0.1*0.7 + 0*0.7 = 0.07
    for (const v of out) expect(v).toBeCloseTo(0.07, 5);
  });

  it("pads only the missing tail when app audio is shorter than the mic frame", () => {
    const mixer = new AudioMixer();
    mixer.pushAppAudio(tone(2, 0.2));
    const out = mixer.mix(tone(4, 0.1));
    expect(out[0]).toBeCloseTo(0.21, 5);
    expect(out[1]).toBeCloseTo(0.21, 5);
    expect(out[2]).toBeCloseTo(0.07, 5); // silence-padded tail
    expect(out[3]).toBeCloseTo(0.07, 5);
  });

  it("clamps to [-1, 1] instead of overflowing on simultaneous loud peaks", () => {
    const mixer = new AudioMixer();
    mixer.pushAppAudio(tone(2, 1.0));
    const out = mixer.mix(tone(2, 1.0));
    // 1.0*0.7 + 1.0*0.7 = 1.4, clamped to 1
    for (const v of out) expect(v).toBe(1);

    const mixer2 = new AudioMixer();
    mixer2.pushAppAudio(tone(2, -1.0));
    const out2 = mixer2.mix(tone(2, -1.0));
    for (const v of out2) expect(v).toBe(-1);
  });

  it("carries leftover app audio into the next mix() call rather than dropping it", () => {
    const mixer = new AudioMixer();
    mixer.pushAppAudio(tone(6, 0.2)); // more than one mic frame's worth
    const first = mixer.mix(tone(4, 0.0));
    const second = mixer.mix(tone(4, 0.0));
    // First 4 samples of app audio go to `first`, remaining 2 to the start of `second`.
    for (const v of first) expect(v).toBeCloseTo(0.14, 5);
    expect(second[0]).toBeCloseTo(0.14, 5);
    expect(second[1]).toBeCloseTo(0.14, 5);
    expect(second[2]).toBeCloseTo(0, 5); // exhausted, silence for the rest
    expect(second[3]).toBeCloseTo(0, 5);
  });

  it("consumes app audio across multiple pushAppAudio calls in arrival order", () => {
    const mixer = new AudioMixer();
    mixer.pushAppAudio(tone(2, 0.1));
    mixer.pushAppAudio(tone(2, 0.3));
    const out = mixer.mix(tone(4, 0.0));
    expect(out[0]).toBeCloseTo(0.07, 5);
    expect(out[1]).toBeCloseTo(0.07, 5);
    expect(out[2]).toBeCloseTo(0.21, 5);
    expect(out[3]).toBeCloseTo(0.21, 5);
  });

  it("never mutates the mic frame passed in", () => {
    const mixer = new AudioMixer();
    mixer.pushAppAudio(tone(4, 0.5));
    const mic = tone(4, 0.1);
    const micCopy = mic.slice();
    mixer.mix(mic);
    expect(mic).toEqual(micCopy);
  });

  it("reports queued app sample count and drains it via mix()", () => {
    const mixer = new AudioMixer();
    mixer.pushAppAudio(tone(10, 0.1));
    expect(mixer.queuedAppSamples).toBe(10);
    mixer.mix(tone(4, 0.0));
    expect(mixer.queuedAppSamples).toBe(6);
  });

  it("drops the oldest queued app audio once the overflow cap is exceeded", () => {
    const mixer = new AudioMixer();
    // Push far more than the 5s (80,000 sample) cap without ever draining it.
    for (let i = 0; i < 20; i++) {
      mixer.pushAppAudio(tone(10_000, 0.1));
    }
    expect(mixer.queuedAppSamples).toBeLessThanOrEqual(80_000);
  });

  it("handles a zero-length mic frame without error", () => {
    const mixer = new AudioMixer();
    mixer.pushAppAudio(tone(4, 0.5));
    const out = mixer.mix(new Float32Array(0));
    expect(out.length).toBe(0);
    // Nothing was consumed from the app queue for an empty mic frame.
    expect(mixer.queuedAppSamples).toBe(4);
  });

  it("ignores a zero-length app audio push", () => {
    const mixer = new AudioMixer();
    mixer.pushAppAudio(new Float32Array(0));
    expect(mixer.queuedAppSamples).toBe(0);
  });
});
