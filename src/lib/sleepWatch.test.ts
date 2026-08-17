import { describe, it, expect, vi, afterEach } from "vitest";
import { startSleepWatch } from "./sleepWatch";

describe("startSleepWatch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drives the watch with a clock the test owns, so a "suspend" is just a
   * number jumping -- no real waiting anywhere. */
  function harness(thresholdMs = 10_000) {
    vi.useFakeTimers();
    let clock = 1_000_000;
    const gaps: number[] = [];
    const dispose = startSleepWatch((sec) => gaps.push(sec), {
      tickMs: 1_000,
      thresholdMs,
      now: () => clock,
    });
    return {
      gaps,
      dispose,
      /** Advances both the timer queue and the clock by the same amount. */
      run: (ms: number) => {
        for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
          clock += 1_000;
          vi.advanceTimersByTime(1_000);
        }
      },
      /** The machine sleeps: the timer fires once, but the clock has moved on. */
      suspend: (ms: number) => {
        clock += ms;
        vi.advanceTimersByTime(1_000);
      },
    };
  }

  it("stays quiet while time passes normally", () => {
    const h = harness();
    h.run(60_000);
    expect(h.gaps).toEqual([]);
    h.dispose();
  });

  it("reports a suspend as a gap of roughly its real length", () => {
    const h = harness();
    h.run(5_000);
    h.suspend(3_600_000);
    expect(h.gaps).toHaveLength(1);
    // The hour that was skipped, give or take the tick that was owed.
    expect(h.gaps[0]).toBeGreaterThan(3_590);
    expect(h.gaps[0]).toBeLessThan(3_610);
    h.dispose();
  });

  it("ignores drift below the threshold", () => {
    const h = harness();
    h.suspend(4_000); // a stalled main thread, not a suspend
    expect(h.gaps).toEqual([]);
    h.dispose();
  });

  it("resynchronises after a gap instead of reporting it again", () => {
    const h = harness();
    h.suspend(600_000);
    h.run(10_000);
    expect(h.gaps).toHaveLength(1);
    h.dispose();
  });

  it("stops checking once disposed", () => {
    const h = harness();
    h.dispose();
    h.suspend(600_000);
    expect(h.gaps).toEqual([]);
  });
});
