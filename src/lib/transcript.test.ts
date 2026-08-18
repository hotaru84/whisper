import { describe, it, expect } from "vitest";
import {
  combinedText,
  combinedTextWithTimestamps,
  collapseDegenerateSegments,
  nonBlankChunks,
  projectOntoNonBlankChunks,
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

describe("combinedTextWithTimestamps", () => {
  const recordingStart = new Date(2026, 7, 18, 9, 0, 0); // 2026-08-18 09:00:00 local

  it("prefixes each line with an absolute local timestamp derived from startOffsetSec", () => {
    expect(combinedTextWithTimestamps(segments, recordingStart)).toBe(
      "[2026-08-18 09:00:00] first.\n[2026-08-18 09:00:03] second part.",
    );
  });

  it("drops empty segments", () => {
    expect(
      combinedTextWithTimestamps([{ id: 9, startOffsetSec: 0, text: "   ", chunks: [] }], recordingStart),
    ).toBe("");
  });

  it("prefixes a 1-indexed speaker label after the timestamp when the segment has one", () => {
    const withSpeakers: TranscriptSegment[] = [
      { id: 1, startOffsetSec: 0, text: "First", chunks: [], speaker: 0 },
      { id: 2, startOffsetSec: 61, text: "Second", chunks: [], speaker: 1 },
    ];
    expect(combinedTextWithTimestamps(withSpeakers, recordingStart)).toBe(
      "[2026-08-18 09:00:00] 話者1: First\n[2026-08-18 09:01:01] 話者2: Second",
    );
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

  it("turns an excluded chunk into a blank placeholder rather than dropping it", () => {
    const out = segmentsFromResult(result, 0, 1, undefined, [true, false]);
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe("");
    expect(out[0].excludedReason).toBeUndefined();
    expect(out[1].text).toBe("議事録を始めます。");
  });

  it("preserves an excluded chunk's timing in its placeholder", () => {
    const out = segmentsFromResult(result, 100, 1, undefined, [true, false]);
    expect(out[0]).toMatchObject({
      startOffsetSec: 100,
      text: "",
      chunks: [{ text: "", timestamp: [0, 2] }],
    });
  });

  it("keeps every chunk when excluded is not given at all", () => {
    const out = segmentsFromResult(result, 0, 1);
    expect(out).toHaveLength(2);
  });

  it("still assigns one id per non-blank chunk when excluding, no gaps or reuse", () => {
    const out = segmentsFromResult(result, 0, 7, undefined, [true, false]);
    expect(out.map((s) => s.id)).toEqual([7, 8]);
  });

  it("turns every chunk into a placeholder when every entry is excluded, none dropped", () => {
    const out = segmentsFromResult(result, 0, 1, undefined, [true, true]);
    expect(out).toHaveLength(2);
    expect(out.every((s) => s.text === "")).toBe(true);
  });

  it("labels an excluded placeholder with the overlapping noise/music event's name", () => {
    const events = [{ start: 1.5, end: 2.5, name: "Music", index: 0, prob: 0.8 }];
    const out = segmentsFromResult(result, 0, 1, undefined, [true, false], events);
    expect(out[0].excludedReason).toBe("Music");
  });

  it("does not attribute a reason to a speech-only overlapping event", () => {
    const events = [{ start: 0, end: 2, name: "Speech", index: 0, prob: 0.8 }];
    const out = segmentsFromResult(result, 0, 1, undefined, [true, false], events);
    expect(out[0].excludedReason).toBeUndefined();
  });

  it("ignores an event that does not overlap the excluded chunk's window", () => {
    const events = [{ start: 10, end: 12, name: "Music", index: 0, prob: 0.8 }];
    const out = segmentsFromResult(result, 0, 1, undefined, [true, false], events);
    expect(out[0].excludedReason).toBeUndefined();
  });

  it("keeps combinedText blind to placeholders, same as any other blank segment", () => {
    const out = segmentsFromResult(result, 0, 1, undefined, [true, false]);
    expect(combinedText(out)).toBe("議事録を始めます。");
  });

  it("turns a silent-flagged chunk into a 無音 placeholder", () => {
    const out = segmentsFromResult(result, 0, 1, undefined, undefined, undefined, [true, false]);
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe("");
    expect(out[0].excludedReason).toBe("無音");
    expect(out[1].text).toBe("議事録を始めます。");
  });

  it("prefers the audio-event exclusion reason over a silence flag on the same chunk", () => {
    const events = [{ start: 0, end: 2, name: "Music", index: 0, prob: 0.8 }];
    const out = segmentsFromResult(result, 0, 1, undefined, [true, false], events, [true, false]);
    expect(out[0].excludedReason).toBe("Music");
  });

  it("ignores the silent array when it is not given at all", () => {
    const out = segmentsFromResult(result, 0, 1);
    expect(out.every((s) => s.text !== "")).toBe(true);
  });
});

describe("projectOntoNonBlankChunks", () => {
  it("drops the entries lined up with a blank-text chunk", () => {
    const withBlank = {
      chunks: [
        { text: "a", timestamp: [0, 1] as [number, number] },
        { text: "  ", timestamp: [1, 2] as [number, number] },
        { text: "b", timestamp: [2, 3] as [number, number] },
      ],
    };
    expect(projectOntoNonBlankChunks(withBlank, [true, true, false])).toEqual([true, false]);
  });

  it("passes every value through when there are no blank chunks", () => {
    const noBlanks = {
      chunks: [
        { text: "a", timestamp: [0, 1] as [number, number] },
        { text: "b", timestamp: [1, 2] as [number, number] },
      ],
    };
    expect(projectOntoNonBlankChunks(noBlanks, [1, 2])).toEqual([1, 2]);
  });

  it("returns an empty array for a result with no chunks", () => {
    expect(projectOntoNonBlankChunks({}, [true, false])).toEqual([]);
  });
});

function seg(
  id: number,
  startOffsetSec: number,
  text: string,
  durationSec: number,
  speaker?: number | null,
): TranscriptSegment {
  const s: TranscriptSegment = {
    id,
    startOffsetSec,
    text,
    chunks: [{ text, timestamp: [0, durationSec] }],
  };
  if (speaker !== undefined) s.speaker = speaker;
  return s;
}

describe("collapseDegenerateSegments", () => {
  it("collapses a run of identical segments whose time never advances", () => {
    // The shape of a stalled decode: "ん" repeated many times, each cue
    // starting at (or before) the previous one's end.
    const out = collapseDegenerateSegments([
      seg(1, 10.0, "ん", 0.3),
      seg(2, 10.3, "ん", 0.3),
      seg(3, 10.6, "ん", 0.3),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 1, startOffsetSec: 10.0, text: "ん" });
    expect(out[0].chunks[0].timestamp[0]).toBe(0);
    expect(out[0].chunks[0].timestamp[1]).toBeCloseTo(0.9);
  });

  it("does not collapse the same phrase spoken again after real time passes", () => {
    const out = collapseDegenerateSegments([seg(1, 0, "はい", 1), seg(2, 5, "はい", 1)]);
    expect(out).toHaveLength(2);
  });

  it("does not collapse across a speaker change even when text and timing match", () => {
    const out = collapseDegenerateSegments([
      seg(1, 0, "はい", 0.5, 0),
      seg(2, 0.5, "はい", 0.5, 1),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.speaker)).toEqual([0, 1]);
  });

  it("never merges an excluded-gap placeholder, on either side", () => {
    const placeholder: TranscriptSegment = {
      id: 2,
      startOffsetSec: 1,
      text: "",
      chunks: [{ text: "", timestamp: [0, 1] }],
      excludedReason: "Music",
    };
    const out = collapseDegenerateSegments([seg(1, 0, "a", 1), placeholder, seg(3, 2, "a", 1)]);
    expect(out).toHaveLength(3);
  });

  it("leaves a transcript with no repeats untouched", () => {
    const out = collapseDegenerateSegments([seg(1, 0, "first", 1), seg(2, 1, "second", 1)]);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.text)).toEqual(["first", "second"]);
  });

  it("does not mutate the input segments", () => {
    const input = [seg(1, 10.0, "ん", 0.3), seg(2, 10.3, "ん", 0.3)];
    const snapshotBefore = JSON.parse(JSON.stringify(input));
    collapseDegenerateSegments(input);
    expect(input).toEqual(snapshotBefore);
  });
});
