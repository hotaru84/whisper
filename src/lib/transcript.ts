import type { TranscriptChunk } from "./asr";

/**
 * One contiguous piece of transcript. A recording produces one or more segments
 * (Phase 1: one per recording; Phase 3: one per committed streaming window), and
 * segments accumulate across start/stop cycles so the transcript can be appended
 * to rather than reset.
 *
 * `chunks` carry timestamps relative to the segment's own start; `startOffsetSec`
 * is where that start sits on the global transcript timeline, so global time is
 * `chunk.timestamp + startOffsetSec`.
 */
export interface TranscriptSegment {
  id: number;
  startOffsetSec: number;
  text: string;
  chunks: TranscriptChunk[];
}

/**
 * Turns the second pass's single whole-recording result into transcript segments.
 *
 * The second pass returns one result covering the entire recording, with chunk
 * timestamps measured from its start. One segment per chunk (rather than one
 * segment for the lot) keeps the transcript reading as separate lines the way
 * the live pass renders it, and keeps SRT export at whisper's own granularity.
 *
 * `baseSec` is where this recording starts on the global timeline; `startId` is
 * the next free segment id. Chunk timestamps are rebased to the segment start so
 * the `startOffsetSec` + relative-chunk invariant holds.
 */
export function segmentsFromResult(
  result: { text: string; chunks?: TranscriptChunk[] },
  baseSec: number,
  startId: number,
): TranscriptSegment[] {
  const chunks = (result.chunks ?? []).filter((c) => c.text.trim() !== "");

  // A result with text but no usable chunks (whisper can return one coarse
  // untimed blob) still has to survive, or the second pass would silently
  // replace a good transcript with nothing.
  if (chunks.length === 0) {
    return result.text.trim() === ""
      ? []
      : [{ id: startId, startOffsetSec: baseSec, text: result.text, chunks: [] }];
  }

  return chunks.map((c, i) => {
    const start = c.timestamp[0] ?? 0;
    const end = c.timestamp[1] ?? start;
    return {
      id: startId + i,
      startOffsetSec: baseSec + start,
      text: c.text,
      chunks: [{ text: c.text, timestamp: [0, Math.max(0, end - start)] as [number, number] }],
    };
  });
}

/** Joins all segment texts into the full transcript, one segment per line. */
export function combinedText(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join("\n");
}

/** Flattens all segments' chunks onto the global timeline (for SRT export). */
export function combinedChunks(segments: TranscriptSegment[]): TranscriptChunk[] {
  return segments.flatMap((seg) =>
    seg.chunks.map((c) => ({
      text: c.text,
      timestamp: [
        c.timestamp[0] + seg.startOffsetSec,
        (c.timestamp[1] ?? c.timestamp[0]) + seg.startOffsetSec,
      ] as [number, number],
    })),
  );
}
