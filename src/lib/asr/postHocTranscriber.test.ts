import { describe, it, expect, vi, afterEach } from "vitest";
import { transcribeWavPostHoc } from "./postHocTranscriber";
import type { TranscribeResult } from "./client";
import { DEFAULT_HALLUCINATION_SETTINGS } from "./client";
import { ANALYSIS_CANCELLED } from "./cancel";
import type { TranscriptChunk } from "./types";
import type { TranscriptSegment } from "../transcript";

const SR = 16000;

// Mirrors streaming.test.ts's wordsMock: one ground-truth "word" per second,
// keyed off the window's absolute start time encoded into audio[0].
function wordsMock(audio: Float32Array): Promise<TranscribeResult> {
  const startSec = audio[0];
  const winSec = audio.length / SR;
  const chunks: TranscriptChunk[] = [];
  for (let s = Math.ceil(startSec - 1e-6); s < startSec + winSec; s++) {
    const relStart = s - startSec;
    const relEnd = relStart + 0.9;
    if (relStart >= -1e-6 && relEnd <= winSec + 1e-6) {
      chunks.push({ text: `w${s} `, timestamp: [relStart, relEnd] });
    }
  }
  return Promise.resolve({ text: chunks.map((c) => c.text).join(""), chunks });
}

/** A `readWavPcm` stand-in delivering time-encoded audio (matching
 * `wordsMock`) from `fromSec` up to `totalSeconds`, as a single chunk --
 * mirrors `read_wav_pcm` handing back one large IPC chunk rather than this
 * test file pacing frames one at a time. */
function fakeReadWavPcm(totalSeconds: number) {
  return async (fromSec: number, onChunk: (chunk: Float32Array) => void): Promise<void> => {
    if (fromSec >= totalSeconds) return;
    const samples = Math.round((totalSeconds - fromSec) * SR);
    const chunk = new Float32Array(samples);
    for (let i = 0; i < samples; i++) chunk[i] = fromSec + i / SR;
    onChunk(chunk);
  };
}

function words(segments: TranscriptSegment[]): string[] {
  return segments.flatMap((s) => s.chunks.map((c) => c.text.trim()));
}

describe("transcribeWavPostHoc", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resumes from fromSec, continuing segment ids after existingSegments", async () => {
    const existing: TranscriptSegment[] = [
      { id: 1, startOffsetSec: 0, text: "w0 ", chunks: [{ text: "w0 ", timestamp: [0, 0.9] }] },
    ];

    const outcome = await transcribeWavPostHoc(
      wordsMock,
      fakeReadWavPcm(2),
      1,
      2,
      existing,
      DEFAULT_HALLUCINATION_SETTINGS,
      () => {},
    );

    expect(outcome.status).toBe("complete");
    expect(outcome.newSegments).toHaveLength(1);
    expect(outcome.newSegments[0].id).toBe(2);
    expect(words(outcome.newSegments)).toEqual(["w1"]);
  });

  it("fires onSegmentPersist with the accumulated segment list and cursor after each committed window", async () => {
    const persisted: { segments: TranscriptSegment[]; cursor: number }[] = [];

    const outcome = await transcribeWavPostHoc(
      wordsMock,
      fakeReadWavPcm(70),
      0,
      70,
      [],
      DEFAULT_HALLUCINATION_SETTINGS,
      (segs, cursor) => persisted.push({ segments: [...segs], cursor }),
    );

    expect(outcome.status).toBe("complete");
    expect(persisted.length).toBeGreaterThan(1);
    for (let i = 1; i < persisted.length; i++) {
      expect(persisted[i].segments.length).toBeGreaterThanOrEqual(persisted[i - 1].segments.length);
      expect(persisted[i].cursor).toBeGreaterThanOrEqual(persisted[i - 1].cursor);
    }
    expect(persisted[persisted.length - 1].segments).toEqual(outcome.newSegments);
  });

  it("fires onProgress once up front at fromSec, then again per commit", async () => {
    const progress: number[] = [];

    await transcribeWavPostHoc(
      wordsMock,
      fakeReadWavPcm(70),
      5,
      70,
      [],
      DEFAULT_HALLUCINATION_SETTINGS,
      () => {},
      (through) => progress.push(through),
    );

    expect(progress[0]).toBe(5);
    expect(progress.length).toBeGreaterThan(1);
  });

  it("reports status: cancelled with the resume cursor (not totalSec) once wasCancelled flips true", async () => {
    let cancelled = false;

    const outcome = await transcribeWavPostHoc(
      wordsMock,
      fakeReadWavPcm(90),
      0,
      90,
      [],
      DEFAULT_HALLUCINATION_SETTINGS,
      (segs) => {
        // Cancel right after the first window commits, mid-recording.
        if (segs.length >= 1) cancelled = true;
      },
      undefined,
      () => cancelled,
    );

    expect(outcome.status).toBe("cancelled");
    expect(outcome.analyzedThroughSec).toBeGreaterThan(0);
    expect(outcome.analyzedThroughSec).toBeLessThan(90);
  });

  it("swallows a cancelled readWavPcm rejection instead of rethrowing, and still flushes what already arrived", async () => {
    let cancelled = false;
    const readWavPcm = async (fromSec: number, onChunk: (c: Float32Array) => void): Promise<void> => {
      const samples = 5 * SR;
      const chunk = new Float32Array(samples);
      for (let i = 0; i < samples; i++) chunk[i] = fromSec + i / SR;
      onChunk(chunk);
      cancelled = true;
      throw new Error(`command failed: ${ANALYSIS_CANCELLED}`);
    };

    const outcome = await transcribeWavPostHoc(
      wordsMock,
      readWavPcm,
      0,
      90,
      [],
      DEFAULT_HALLUCINATION_SETTINGS,
      () => {},
      undefined,
      () => cancelled,
    );

    expect(outcome.status).toBe("cancelled");
    expect(outcome.analyzedThroughSec).toBeLessThan(90);
  });

  it("rethrows a non-cancellation readWavPcm error", async () => {
    const readWavPcm = async (): Promise<void> => {
      throw new Error("disk read failed");
    };

    await expect(
      transcribeWavPostHoc(wordsMock, readWavPcm, 0, 90, [], DEFAULT_HALLUCINATION_SETTINGS, () => {}),
    ).rejects.toThrow("disk read failed");
  });

  // The stall-bug regression: a transient failure must not silently cut the
  // transcript short. All PCM arrives up front (one big readWavPcm chunk,
  // like read_wav_pcm's real IPC chunks) and finish() is the only drain --
  // exactly the shape that used to abandon everything past the first retry.
  it("recovers from a transient failure and still reaches status: complete with every window transcribed", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const flaky = (audio: Float32Array): Promise<TranscribeResult> => {
      calls++;
      if (calls === 1) return Promise.reject(new Error("transient"));
      return wordsMock(audio);
    };

    const outcomePromise = transcribeWavPostHoc(
      flaky,
      fakeReadWavPcm(40),
      0,
      40,
      [],
      DEFAULT_HALLUCINATION_SETTINGS,
      () => {},
    );
    // The retry inside drain() waits out RETRY_BACKOFF_MS (streaming.ts) --
    // advance the fake clock so the test doesn't block on a real 2s delay.
    await vi.advanceTimersByTimeAsync(5_000);
    const outcome = await outcomePromise;

    expect(outcome.status).toBe("complete");
    expect(outcome.analyzedThroughSec).toBe(40);
    expect(calls).toBeGreaterThan(1);
    expect(words(outcome.newSegments)).toEqual(Array.from({ length: 40 }, (_, s) => `w${s}`));
  });

  it("resumes correctly on a subsequent call from a prior cancelled run's analyzedThroughSec", async () => {
    let cancelled = false;
    const first = await transcribeWavPostHoc(
      wordsMock,
      fakeReadWavPcm(60),
      0,
      60,
      [],
      DEFAULT_HALLUCINATION_SETTINGS,
      (segs) => {
        if (segs.length >= 1) cancelled = true;
      },
      undefined,
      () => cancelled,
    );
    expect(first.status).toBe("cancelled");

    const second = await transcribeWavPostHoc(
      wordsMock,
      fakeReadWavPcm(60),
      first.analyzedThroughSec,
      60,
      first.newSegments,
      DEFAULT_HALLUCINATION_SETTINGS,
      () => {},
    );

    expect(second.status).toBe("complete");
    expect(second.analyzedThroughSec).toBe(60);
    // Every second across the whole recording is covered exactly once
    // between the two runs, with no gap or overlap at the resume point.
    const allWords = words([...first.newSegments, ...second.newSegments]);
    expect(allWords).toEqual(Array.from({ length: 60 }, (_, s) => `w${s}`));
  });
});
