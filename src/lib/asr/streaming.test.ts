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

  // A single chunk that ends before the window does must not cost us the rest of
  // the window. whisper.cpp abandons the tail of a chunk when a decode ends on a
  // lone timestamp, and that audio has to get another pass rather than being
  // silently dropped.
  it("carries the untranscribed tail when a single chunk ends early", async () => {
    const windows: number[] = []; // window length in seconds, per call
    // Always reports speech over the first 8s of whatever it is given.
    const endsEarly = (audio: Float32Array): Promise<TranscribeResult> => {
      windows.push(audio.length / SR);
      return Promise.resolve({ text: "x", chunks: [{ text: "x", timestamp: [0, 8] }] });
    };
    const segments: StreamingSegment[] = [];
    const t = new StreamingTranscriber(endsEarly, (s) => segments.push(s));

    await feed(t, 30);

    // The floor is WINDOW_SEC - MAX_CARRY_SEC = 10s, so the 5s beyond the
    // transcribed 8s is carried and the next window is longer than a bare window.
    expect(windows.length).toBeGreaterThan(1);
    expect(windows[1]).toBeGreaterThan(windows[0] - 1e-6);
    expect(segments.length).toBeGreaterThan(0);

    await t.finish();
  });

  // The carry must stay bounded: a model that always stops early must not make
  // the cursor crawl and the transcriber re-run forever on nearly the same audio.
  it("bounds the carry so an always-early model cannot stall the cursor", async () => {
    let calls = 0;
    const barelyAny = (audio: Float32Array): Promise<TranscribeResult> => {
      calls++;
      if (calls > 100) throw new Error("spin detected: cursor failed to advance");
      void audio;
      return Promise.resolve({ text: "x", chunks: [{ text: "x", timestamp: [0, 0.1] }] });
    };
    const t = new StreamingTranscriber(barelyAny, () => {});

    await feed(t, 60);
    await t.finish();

    // 60s of audio advancing >= 10s per window is a handful of calls, not dozens.
    expect(calls).toBeLessThanOrEqual(10);
  });

  // Silence must never reach the model. Handing whisper a window with no speech
  // is how this app produces hallucinated stock phrases and "なぜなぜなぜ..."
  // repetition loops, and the short ones evade whisper.cpp's own guard entirely.
  it("never transcribes a silent window, and still advances past it", async () => {
    let calls = 0;
    const t = new StreamingTranscriber(
      (audio) => {
        calls++;
        void audio;
        return Promise.resolve({ text: "hallucination", chunks: [{ text: "hallucination", timestamp: [0, 1] }] });
      },
      () => {
        throw new Error("a silent window must not emit a segment");
      },
    );

    // Digital silence, fed the same way the recorder would.
    let sample = 0;
    const end = 60 * SR;
    while (sample < end) {
      const len = Math.min(FRAME, end - sample);
      t.pushFrame(new Float32Array(len)); // all zeros
      sample += len;
      if (sample % SR < FRAME) await new Promise((r) => setTimeout(r, 0));
    }
    await t.finish();

    expect(calls).toBe(0);
  });

  // The gate must not swallow quiet speech: it keys on a very low RMS, well under
  // any real microphone's noise floor.
  it("still transcribes quiet audio that is not silence", async () => {
    let calls = 0;
    const t = new StreamingTranscriber(
      (audio) => {
        calls++;
        void audio;
        return Promise.resolve({ text: "x", chunks: [{ text: "x", timestamp: [0, 1] }] });
      },
      () => {},
    );

    let sample = 0;
    const end = 20 * SR;
    while (sample < end) {
      const len = Math.min(FRAME, end - sample);
      const frame = new Float32Array(len);
      // 0.01 RMS: quiet, but an order of magnitude above the gate.
      for (let i = 0; i < len; i++) frame[i] = i % 2 === 0 ? 0.01 : -0.01;
      t.pushFrame(frame);
      sample += len;
      if (sample % SR < FRAME) await new Promise((r) => setTimeout(r, 0));
    }
    await t.finish();

    expect(calls).toBeGreaterThan(0);
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
