import { describe, it, expect } from "vitest";
import { evaluateMicHealth } from "./pcmRecorder";

/** The recorder's own constants, mirrored here so the cases read in the same
 * units the watchdog runs in. */
const quietMs = 3_000;
const graceMs = 5_000;

function verdict(over: Partial<Parameters<typeof evaluateMicHealth>[0]>) {
  return evaluateMicHealth({
    paused: false,
    trackEnded: false,
    msSinceFrame: 100,
    msSinceProbe: null,
    quietMs,
    graceMs,
    ...over,
  });
}

describe("evaluateMicHealth", () => {
  it("is happy while frames keep arriving", () => {
    expect(verdict({ msSinceFrame: 100 })).toBe("ok");
    expect(verdict({ msSinceFrame: quietMs - 1 })).toBe("ok");
  });

  it("treats a paused recorder as healthy, however long the silence", () => {
    // Pausing stops frame collection on purpose (see `setPaused`), so silence
    // there is the feature working, not the microphone dying.
    expect(verdict({ paused: true, msSinceFrame: 60_000 })).toBe("ok");
    expect(verdict({ paused: true, msSinceFrame: 60_000, msSinceProbe: 60_000 })).toBe("ok");
  });

  it("calls an ended track a dropout immediately", () => {
    // Terminal state: no grace period can bring the device back.
    expect(verdict({ trackEnded: true, msSinceFrame: 0 })).toBe("dropout");
  });

  it("only probes on the first quiet check, never declares a dropout", () => {
    // This is the resume case: the first check after an hour-long suspend sees
    // an hour-long frame gap whether or not the microphone survived it.
    expect(verdict({ msSinceFrame: 3_600_000, msSinceProbe: null })).toBe("probe");
  });

  it("keeps probing until the grace period has really elapsed", () => {
    expect(verdict({ msSinceFrame: 10_000, msSinceProbe: graceMs - 1 })).toBe("probe");
  });

  it("declares a dropout once the silence outlives the grace period", () => {
    expect(verdict({ msSinceFrame: 10_000, msSinceProbe: graceMs })).toBe("dropout");
  });

  it("recovers as soon as one frame arrives, whatever the probe said", () => {
    // A mic that came back from the suspend: the probe mark is stale and the
    // fresh frame is what counts.
    expect(verdict({ msSinceFrame: 50, msSinceProbe: 60_000 })).toBe("ok");
  });
});
