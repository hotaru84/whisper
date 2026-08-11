import { describe, it, expect } from "vitest";
import { StreamingTranscriber, type StreamingSegment } from "./streaming";
import type { TranscribeResult } from "./client";
import type { TranscriptChunk } from "./types";

const SR = 16000;
const FRAME = 128;

/**
 * Feeds `seconds` of audio in which every sample encodes its own absolute time in
 * seconds, so a mock transcriber can read `audio[0]` to know where its window
 * starts. Yields roughly once per second so the transcriber's async commit loop
 * can run mid-recording, as it would live.
 */
async function feed(t: StreamingTranscriber, seconds: number, startSample = 0): Promise<number> {
  let sample = startSample;
  const end = startSample + seconds * SR;
  while (sample < end) {
    const len = Math.min(FRAME, end - sample);
    const frame = new Float32Array(len);
    for (let i = 0; i < len; i++) frame[i] = (sample + i) / SR;
    t.pushFrame(frame);
    sample += len;
    if (sample % SR < FRAME) await new Promise((r) => setTimeout(r, 0)); // ~once per second
  }
  return sample;
}

// One ground-truth "word" per second, each spanning [s, s+0.9].
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

describe("StreamingTranscriber", () => {
  it("commits every word exactly once, in order, on the correct global timeline", async () => {
    const segments: StreamingSegment[] = [];
    const t = new StreamingTranscriber(wordsMock, (s) => segments.push(s));

    await feed(t, 60);
    await t.finish();

    const committed: { word: string; globalStart: number }[] = [];
    for (const seg of segments) {
      for (const c of seg.chunks) {
        committed.push({ word: c.text.trim(), globalStart: seg.offsetSec + c.timestamp[0] });
      }
    }

    expect(committed.map((c) => c.word)).toEqual(Array.from({ length: 60 }, (_, s) => `w${s}`));
    for (const { word, globalStart } of committed) {
      expect(globalStart).toBeCloseTo(Number(word.slice(1)), 1);
    }
  });

  it("emits nothing until a full window accumulates, then streams during recording", async () => {
    const segments: StreamingSegment[] = [];
    const t = new StreamingTranscriber(wordsMock, (s) => segments.push(s));

    await feed(t, 10);
    expect(segments.length).toBe(0);

    await feed(t, 40, 10 * SR);
    expect(segments.length).toBeGreaterThan(0);

    await t.finish();
    const words = segments.flatMap((s) => s.chunks.map((c) => c.text.trim()));
    expect(words).toEqual(Array.from({ length: 50 }, (_, s) => `w${s}`));
  });

  // Regression: a window that Whisper returns as a single coarse chunk (common
  // for continuous speech) must not make the transcriber re-run on the same audio
  // forever. Each window must advance, so transcribe is called a bounded number
  // of times and the timeline is covered once with no gaps or overlaps.
  it("does not spin on coarse single-chunk windows", async () => {
    let calls = 0;
    const coarse = (audio: Float32Array): Promise<TranscribeResult> => {
      calls++;
      if (calls > 100) throw new Error("spin detected: transcribe called too many times");
      const winSec = audio.length / SR;
      return Promise.resolve({ text: "x", chunks: [{ text: "x", timestamp: [0, winSec] }] });
    };
    const segments: StreamingSegment[] = [];
    const t = new StreamingTranscriber(coarse, (s) => segments.push(s));

    await feed(t, 60);
    await t.finish();

    // ~3 windows (25 + 25 + 10) rather than hundreds of re-transcriptions.
    expect(calls).toBeLessThanOrEqual(6);

    // The committed windows tile [0, 60s] contiguously (no re-passed / dropped audio).
    const spans = segments
      .map((s) => [s.offsetSec, s.offsetSec + (s.chunks[0]?.timestamp[1] ?? 0)] as const)
      .sort((a, b) => a[0] - b[0]);
    expect(spans[0][0]).toBeCloseTo(0, 1);
    for (let i = 1; i < spans.length; i++) expect(spans[i][0]).toBeCloseTo(spans[i - 1][1], 1);
    expect(spans[spans.length - 1][1]).toBeCloseTo(60, 0);
  });

  // Regression: silent windows (no speech chunks) are dropped without emitting,
  // and still advance (no spin, no lost accounting).
  it("drops silent windows without emitting and without spinning", async () => {
    let calls = 0;
    const silence = (): Promise<TranscribeResult> => {
      calls++;
      if (calls > 100) throw new Error("spin detected on silence");
      return Promise.resolve({ text: "", chunks: [] });
    };
    const segments: StreamingSegment[] = [];
    const t = new StreamingTranscriber(silence, (s) => segments.push(s));

    await feed(t, 60);
    await t.finish();

    expect(segments.length).toBe(0);
    expect(calls).toBeLessThanOrEqual(6);
  });
});
