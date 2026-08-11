import { describe, expect, it } from "vitest";
import { chunksToSrt } from "./srt";

describe("chunksToSrt", () => {
  it("returns an empty string for no chunks", () => {
    expect(chunksToSrt([])).toBe("");
  });

  it("formats a single chunk with sequence number and timestamp range", () => {
    const srt = chunksToSrt([{ text: "Hello world", timestamp: [0, 2.5] }]);
    expect(srt).toBe("1\n00:00:00,000 --> 00:00:02,500\nHello world\n");
  });

  it("numbers multiple chunks sequentially and separates them with a blank line", () => {
    const srt = chunksToSrt([
      { text: "First", timestamp: [0, 1] },
      { text: "Second", timestamp: [1, 3.2] },
    ]);
    expect(srt).toBe(
      ["1", "00:00:00,000 --> 00:00:01,000", "First", "", "2", "00:00:01,000 --> 00:00:03,200", "Second", ""].join(
        "\n",
      ),
    );
  });

  it("pads hours, minutes, and seconds, and formats an hour-plus timestamp", () => {
    const srt = chunksToSrt([{ text: "Late chunk", timestamp: [3661.05, 3665.999] }]);
    expect(srt).toContain("01:01:01,050 --> 01:01:05,999");
  });

  it("trims surrounding whitespace from chunk text", () => {
    const srt = chunksToSrt([{ text: "  padded text  ", timestamp: [0, 1] }]);
    expect(srt).toContain("padded text\n");
  });

  it("falls back to the start time when the end timestamp is missing", () => {
    const srt = chunksToSrt([
      { text: "Cut off", timestamp: [5, undefined as unknown as number] },
    ]);
    expect(srt).toContain("00:00:05,000 --> 00:00:05,000");
  });

  it("clamps negative or non-finite timestamps to zero", () => {
    const srt = chunksToSrt([{ text: "Odd", timestamp: [-1, Number.NaN] }]);
    expect(srt).toContain("00:00:00,000 --> 00:00:00,000");
  });
});
