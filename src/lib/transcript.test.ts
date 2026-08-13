import { describe, it, expect } from "vitest";
import {
  combinedText,
  combinedChunks,
  segmentsFromResult,
  type TranscriptSegment,
} from "./transcript";

const segments: TranscriptSegment[] = [
  { id: 1, startOffsetSec: 0, text: " first.", chunks: [{ text: " first.", timestamp: [0, 2.5] }] },
  {
    id: 2,
    startOffsetSec: 3,
    text: " second part.",
    chunks: [
      { text: " second", timestamp: [0, 1] },
      { text: " part.", timestamp: [1, 2] },
    ],
  },
];

describe("combinedText", () => {
  it("joins trimmed segment texts one per line", () => {
    expect(combinedText(segments)).toBe("first.\nsecond part.");
  });

  it("drops empty segments", () => {
    expect(combinedText([{ id: 9, startOffsetSec: 0, text: "   ", chunks: [] }])).toBe("");
  });
});

describe("combinedChunks", () => {
  it("shifts each chunk onto the global timeline by its segment's startOffsetSec", () => {
    expect(combinedChunks(segments)).toEqual([
      { text: " first.", timestamp: [0, 2.5] },
      { text: " second", timestamp: [3, 4] },
      { text: " part.", timestamp: [4, 5] },
    ]);
  });
});

describe("segmentsFromResult", () => {
  const result = {
    text: "おはようございます。議事録を始めます。",
    chunks: [
      { text: "おはようございます。", timestamp: [0, 2] as [number, number] },
      { text: "議事録を始めます。", timestamp: [2, 5] as [number, number] },
    ],
  };

  it("makes one segment per chunk, numbered from startId", () => {
    const out = segmentsFromResult(result, 0, 7);
    expect(out.map((s) => s.id)).toEqual([7, 8]);
    expect(out.map((s) => s.text)).toEqual(["おはようございます。", "議事録を始めます。"]);
  });

  it("places segments on the global timeline and rebases their chunks to zero", () => {
    const out = segmentsFromResult(result, 100, 1);
    expect(out.map((s) => s.startOffsetSec)).toEqual([100, 102]);
    // The invariant the exporters rely on: chunk time is relative to the segment.
    expect(out[0].chunks).toEqual([{ text: "おはようございます。", timestamp: [0, 2] }]);
    expect(out[1].chunks).toEqual([{ text: "議事録を始めます。", timestamp: [0, 3] }]);
    // Round-tripping through combinedChunks must land back on absolute time.
    expect(combinedChunks(out)).toEqual([
      { text: "おはようございます。", timestamp: [100, 102] },
      { text: "議事録を始めます。", timestamp: [102, 105] },
    ]);
  });

  it("keeps the text when the result has no usable chunks", () => {
    // Otherwise the second pass would replace a good live transcript with nothing.
    const out = segmentsFromResult({ text: "文字起こし", chunks: [] }, 10, 1);
    expect(out).toEqual([{ id: 1, startOffsetSec: 10, text: "文字起こし", chunks: [] }]);
  });

  it("returns nothing for an empty result so the caller can keep the live pass", () => {
    expect(segmentsFromResult({ text: "   ", chunks: [] }, 0, 1)).toEqual([]);
    expect(segmentsFromResult({ text: "" }, 0, 1)).toEqual([]);
  });

  it("drops blank chunks rather than emitting empty transcript lines", () => {
    const out = segmentsFromResult(
      {
        text: "あ",
        chunks: [
          { text: "  ", timestamp: [0, 1] },
          { text: "あ", timestamp: [1, 2] },
        ],
      },
      0,
      1,
    );
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("あ");
  });

  it("never produces a negative duration from out-of-order timestamps", () => {
    const out = segmentsFromResult({ text: "x", chunks: [{ text: "x", timestamp: [5, 3] }] }, 0, 1);
    expect(out[0].chunks[0].timestamp).toEqual([0, 0]);
  });
});
