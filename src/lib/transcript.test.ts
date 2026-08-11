import { describe, it, expect } from "vitest";
import { combinedText, combinedChunks, type TranscriptSegment } from "./transcript";

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
