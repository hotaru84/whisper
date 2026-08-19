import { describe, it, expect, vi } from "vitest";

// `appStore.ts` (imported transitively by `analysisQueue.ts` and
// `recordingPipeline.ts`) pulls in `clients.ts`, whose module-level wiring
// touches browser-only APIs (`navigator.mediaDevices`, the Battery Status
// API) that don't exist in this Node test environment. Neutralized here so
// the store itself -- which is what this file actually exercises -- can be
// imported at all; everything else in each module stays real.
vi.mock("../lib/audio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/audio")>();
  return { ...actual, onAudioDeviceChange: () => () => {} };
});
vi.mock("../lib/sleepWatch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/sleepWatch")>();
  return { ...actual, startSleepWatch: () => () => {} };
});
vi.mock("../lib/power", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/power")>();
  return {
    ...actual,
    // Never calls back: `clients.ts` calls this at its own module top level,
    // while `appStore.ts` (which it imports back from, circularly) is still
    // mid-evaluation -- `useAppStore` isn't assigned yet, so any callback
    // reachable before that finishes would throw. `powerSource` already
    // defaults to `"unknown"` in the store's initial state, which is exactly
    // what the real implementation's own equivalent fallback (Battery Status
    // API unavailable) would report anyway, so there is nothing this needs
    // to actually report for these tests.
    watchPowerSource: () => () => {},
  };
});

import type { TakeFiling } from "./recordingPipeline";

const { useAppStore } = await import("./appStore");
const { enqueueRefine, cancelJob, hasActiveJob, useAnalysisQueueStore } = await import("./analysisQueue");
const { asrClient } = await import("./clients");

/** Everything here runs against the app's own built-in mock backend
 * (`useMockBackend`, see `src/lib/env.ts`): this file has no Tauri runtime
 * available, and `AsrClient`/`saveRecordingHistory`/etc. already know how to
 * fall back to deterministic fake data in that case -- the same fallback
 * `npm run dev` uses for UI review without Rust. */

function waitForJobToFinish(id: string, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (!hasActiveJob(id)) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`job ${id} did not finish within ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, 20);
    };
    check();
  });
}

function filingFor(recordingId: string): TakeFiling {
  return { recordingId, path: `mock-recordings/${recordingId}.wav`, recordingDurationSec: 10 };
}

describe("analysisQueue", () => {
  it(
    "never corrupts a different recording's on-screen segments (regression: recording and analysis run in parallel)",
    async () => {
      // Simulates the scenario this whole feature exists for: recording B is
      // now what's on screen (started right after A stopped, in the same
      // session -- see `refineRecording`'s own doc comment), while A's
      // background refine is still finishing up.
      const bSegment = { id: 1, startOffsetSec: 0, text: "B's own live text", chunks: [] };
      useAppStore.setState({
        viewedRecordingId: "rec-b",
        segments: [bSegment],
        audioEvents: [],
      });

      enqueueRefine(filingFor("rec-a"), 0, 0);
      expect(hasActiveJob("rec-a")).toBe(true);

      await waitForJobToFinish("rec-a");

      // A's refine must never have touched B's on-screen state: B is still
      // "viewed", and its segments are byte-for-byte what they were before A's
      // pass ran, not spliced/overwritten by A's (unrelated) refined result.
      expect(useAppStore.getState().viewedRecordingId).toBe("rec-b");
      expect(useAppStore.getState().segments).toEqual([bSegment]);
    },
    10000,
  );

  it("tracks a job's lifecycle from enqueue to completion", async () => {
    expect(hasActiveJob("rec-lifecycle")).toBe(false);

    enqueueRefine(filingFor("rec-lifecycle"), 0, 0);
    expect(hasActiveJob("rec-lifecycle")).toBe(true);

    await waitForJobToFinish("rec-lifecycle");
    expect(hasActiveJob("rec-lifecycle")).toBe(false);
  }, 10000);

  it("cancelling one recording's job leaves a different recording's job untouched", async () => {
    const cancelSpy = vi.spyOn(asrClient, "cancelAnalysis");

    enqueueRefine(filingFor("rec-cancel-a"), 0, 0);
    enqueueRefine(filingFor("rec-cancel-b"), 0, 0);

    await cancelJob("rec-cancel-a");

    // The backend call targeted only "rec-cancel-a" -- see `cancel.rs`'s
    // per-job flag map, which this isolation depends on.
    expect(cancelSpy).toHaveBeenCalledWith("rec-cancel-a");
    expect(cancelSpy).not.toHaveBeenCalledWith("rec-cancel-b");
    expect(useAnalysisQueueStore.getState().jobs["rec-cancel-a"]?.status).toBe("cancelling");
    expect(useAnalysisQueueStore.getState().jobs["rec-cancel-b"]?.status).not.toBe("cancelling");

    await waitForJobToFinish("rec-cancel-a");
    await waitForJobToFinish("rec-cancel-b");
    cancelSpy.mockRestore();
  }, 10000);
});
