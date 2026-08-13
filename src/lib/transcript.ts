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
 *
 * `speaker` is set only by the second pass when diarization is enabled
 * (`diarize::assign_speakers` in Rust). Three states: absent (`undefined`) means
 * diarization did not run on this segment at all (live-pass segments, or the
 * second pass with diarization off); `null` means it ran but found no speaker
 * overlapping this segment; a number is a cluster index, stable only within one
 * recording -- not a stable identity across recordings.
 */
export interface TranscriptSegment {
  id: number;
  startOffsetSec: number;
  text: string;
  chunks: TranscriptChunk[];
  speaker?: number | null;
}

/**
 * The non-blank chunks of a transcription result, in order.
 *
 * Exported so a caller that needs to line something else up per-chunk (namely
 * diarization: `assign_speakers` in Rust returns one entry per chunk it was
 * given) can build that request against exactly the set `segmentsFromResult`
 * will iterate over. Filtering independently in two places would only need to
 * drift once for the two to silently go out of alignment and attach a
 * transcript line to the wrong speaker.
 */
export function nonBlankChunks(result: { chunks?: TranscriptChunk[] }): TranscriptChunk[] {
  return (result.chunks ?? []).filter((c) => c.text.trim() !== "");
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
 *
 * `speakers`, if given, must have exactly one entry per entry of
 * `nonBlankChunks(result)`, in the same order (i.e. built from that same
 * function) -- that positional correspondence is how a speaker reaches the
 * right segment, there is no id-based matching.
 *
 * `excluded`, if given, has the same shape: `true` drops that chunk entirely
 * (no segment is produced for it) rather than keeping it with blank text, so
 * a filtered-out window leaves no trace in the transcript. This is
 * `events::classify_chunks`'s non-speech exclusion (see `events.rs`), applied
 * here rather than left to the caller so the id-gap bookkeeping below stays
 * in one place.
 */
export function segmentsFromResult(
  result: { text: string; chunks?: TranscriptChunk[] },
  baseSec: number,
  startId: number,
  speakers?: Array<number | null>,
  excluded?: boolean[],
): TranscriptSegment[] {
  const chunks = nonBlankChunks(result);

  // A result with text but no usable chunks (whisper can return one coarse
  // untimed blob) still has to survive, or the second pass would silently
  // replace a good transcript with nothing.
  if (chunks.length === 0) {
    return result.text.trim() === ""
      ? []
      : [{ id: startId, startOffsetSec: baseSec, text: result.text, chunks: [] }];
  }

  const segments: TranscriptSegment[] = [];
  chunks.forEach((c, i) => {
    if (excluded?.[i]) return;
    const start = c.timestamp[0] ?? 0;
    const end = c.timestamp[1] ?? start;
    const segment: TranscriptSegment = {
      id: startId + i,
      startOffsetSec: baseSec + start,
      text: c.text,
      chunks: [{ text: c.text, timestamp: [0, Math.max(0, end - start)] as [number, number] }],
    };
    if (speakers) segment.speaker = speakers[i] ?? null;
    segments.push(segment);
  });
  return segments;
}

/**
 * Human-facing label for a speaker index, or the empty string when there is
 * none to show. 1-indexed ("話者1") because the cluster index is an internal
 * implementation detail nobody reading a transcript should have to see 0 of.
 */
function speakerLabel(speaker: number | null | undefined): string {
  return typeof speaker === "number" ? `話者${speaker + 1}: ` : "";
}

/** Joins all segment texts into the full transcript, one segment per line. */
export function combinedText(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => (s.text.trim() ? speakerLabel(s.speaker) + s.text.trim() : ""))
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
      speaker: seg.speaker,
    })),
  );
}
