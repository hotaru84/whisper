import { describe, it, expect } from "vitest";
import {
  combinedText,
  combinedChunks,
  nonBlankChunks,
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

  it("prefixes a 1-indexed speaker label when the segment has one", () => {
    const withSpeakers: TranscriptSegment[] = [
      { id: 1, startOffsetSec: 0, text: "First", chunks: [], speaker: 0 },
      { id: 2, startOffsetSec: 1, text: "Second", chunks: [], speaker: 1 },
      { id: 3, startOffsetSec: 2, text: "Unlabeled", chunks: [], speaker: null },
    ];
    expect(combinedText(withSpeakers)).toBe("話者1: First\n話者2: Second\nUnlabeled");
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

  it("carries the segment's speaker onto every chunk it flattens", () => {
    const withSpeaker: TranscriptSegment[] = [
      {
        id: 1,
        startOffsetSec: 0,
        text: "a b",
        speaker: 2,
        chunks: [
          { text: "a", timestamp: [0, 1] },
          { text: "b", timestamp: [1, 2] },
        ],
      },
    ];
    expect(combinedChunks(withSpeaker).map((c) => c.speaker)).toEqual([2, 2]);
  });
});

describe("nonBlankChunks", () => {
  it("filters out whitespace-only chunks, preserving order", () => {
    const result = {
      chunks: [
        { text: "a", timestamp: [0, 1] as [number, number] },
        { text: "   ", timestamp: [1, 2] as [number, number] },
        { text: "b", timestamp: [2, 3] as [number, number] },
      ],
    };
    expect(nonBlankChunks(result).map((c) => c.text)).toEqual(["a", "b"]);
  });

  it("returns an empty array when chunks is missing or empty", () => {
    expect(nonBlankChunks({})).toEqual([]);
    expect(nonBlankChunks({ chunks: [] })).toEqual([]);
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

  it("attaches speakers positionally when given, one per non-blank chunk", () => {
    const out = segmentsFromResult(result, 0, 1, [0, 1]);
    expect(out.map((s) => s.speaker)).toEqual([0, 1]);
  });

  it("stores a null assignment as null, not as absent", () => {
    const out = segmentsFromResult(result, 0, 1, [0, null]);
    expect(out[0].speaker).toBe(0);
    expect(out[1].speaker).toBeNull();
    expect("speaker" in out[1]).toBe(true);
  });

  it("leaves speaker unset when no speakers array is given at all", () => {
    // Diarization off, or the second pass ran without it -- must not be
    // mistaken for "diarization ran and assigned nobody" (null).
    const out = segmentsFromResult(result, 0, 1);
    expect(out[0].speaker).toBeUndefined();
    expect("speaker" in out[0]).toBe(false);
  });

  it("aligns speakers to non-blank chunks, not raw chunk indices", () => {
    // If the caller built `speakers` from nonBlankChunks (as intended), the
    // blank chunk at index 0 never consumes an entry.
    const withBlank = {
      text: "b",
      chunks: [
        { text: "  ", timestamp: [0, 1] as [number, number] },
        { text: "b", timestamp: [1, 2] as [number, number] },
      ],
    };
    const out = segmentsFromResult(withBlank, 0, 1, [3]);
    expect(out).toHaveLength(1);
    expect(out[0].speaker).toBe(3);
  });
});
