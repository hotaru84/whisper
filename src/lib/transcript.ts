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
