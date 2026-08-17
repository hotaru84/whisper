import type { TranscriptChunk } from "../asr";
import { COLLAPSE_TOLERANCE_SEC, normalizeForCollapse } from "../transcript";

/** Floor on a displayed cue's duration -- see `prepareCues`. */
const MIN_CUE_LEN_SEC = 0.2;

/**
 * Repairs display-layer artefacts in a cue list before export, without
 * touching the transcript model or history sidecar that produced it --
 * re-exporting from saved data always reflects this function's current
 * behavior, never a stale one baked into storage.
 *
 * This is *not* the text-based non-speech filtering `asr::mark_silent_segments`
 * deliberately avoids (see its doc comment, and README's "第2パスは無音区間の
 * セグメントを…"): nothing here decides a cue is non-speech. Every cue here is
 * already believed to hold real speech; this only decides whether two
 * adjacent, already-spoken cues should render as one line, and only on a
 * timing test (did time actually advance between them), never a text-content
 * test. See the "退化重複ランの畳み込み" step below for why this stays outside
 * that rule.
 *
 * Order matters:
 * 1. Drop empty-text cues (defensive -- `combinedChunks` already does this).
 * 2. Stable-sort by start time.
 * 3. Collapse degenerate repeated runs: a cue is folded into the previous one
 *    only when its normalized text matches, its speaker matches (so two
 *    different people saying the same short phrase back-to-back never lose
 *    one of them), *and* its start does not advance past the previous cue's
 *    end by more than `COLLAPSE_TOLERANCE_SEC` -- i.e. the same text came
 *    back without time having moved, which a real repeated utterance
 *    ("はい、はい") does not do. This cannot delete a legitimate repetition
 *    (its start advances past the tolerance) and cannot delete a single
 *    spoken cue (a lone "はい" has nothing adjacent to collapse into). Shared
 *    with `collapseDegenerateSegments` in `lib/transcript.ts`, the equivalent
 *    for the live/history transcript view -- see its doc comment.
 * 4. Enforce `MIN_CUE_LEN_SEC` so a near-zero-length cue is still readable.
 * 5. Repair overlaps by trimming the earlier cue's end to the next cue's
 *    start -- unless that would violate step 4's floor, in which case the
 *    overlap is left in place (SRT players tolerate overlapping cues; a
 *    forced reorder or drop would lose more than it fixes).
 *
 * Long cues (8s+) are intentionally left alone here: Japanese has no word
 * boundaries, so guessing where to cut one would risk splitting mid-word.
 */
export function prepareCues(chunks: TranscriptChunk[]): TranscriptChunk[] {
  const nonEmpty = chunks.filter((c) => c.text.trim() !== "");
  const sorted = [...nonEmpty].sort((a, b) => a.timestamp[0] - b.timestamp[0]);

  const collapsed: TranscriptChunk[] = [];
  for (const cue of sorted) {
    const prev = collapsed[collapsed.length - 1];
    const prevEnd = prev ? (prev.timestamp[1] ?? prev.timestamp[0]) : undefined;
    if (
      prev &&
      prevEnd !== undefined &&
      normalizeForCollapse(prev.text) === normalizeForCollapse(cue.text) &&
      (prev.speaker ?? null) === (cue.speaker ?? null) &&
      cue.timestamp[0] <= prevEnd + COLLAPSE_TOLERANCE_SEC
    ) {
      const cueEnd = cue.timestamp[1] ?? cue.timestamp[0];
      prev.timestamp = [prev.timestamp[0], Math.max(prevEnd, cueEnd)];
      continue;
    }
    collapsed.push({ ...cue, timestamp: [...cue.timestamp] as [number, number] });
  }

  for (const cue of collapsed) {
    const start = cue.timestamp[0];
    const end = cue.timestamp[1] ?? start;
    cue.timestamp = [start, Math.max(end, start + MIN_CUE_LEN_SEC)];
  }

  for (let i = 0; i < collapsed.length - 1; i++) {
    const cur = collapsed[i];
    const next = collapsed[i + 1];
    const nextStart = next.timestamp[0];
    if (cur.timestamp[1] > nextStart && nextStart - cur.timestamp[0] >= MIN_CUE_LEN_SEC) {
      cur.timestamp = [cur.timestamp[0], nextStart];
    }
  }

  return collapsed;
}

function formatSrtTimestamp(seconds: number): string {
  const clamped = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalMs = Math.round(clamped * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);

  const pad2 = (n: number) => n.toString().padStart(2, "0");
  const pad3 = (n: number) => n.toString().padStart(3, "0");
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(ms)}`;
}

/** 1-indexed for readers, since the cluster index itself is an internal detail. */
function speakerPrefix(speaker: number | null | undefined): string {
  return typeof speaker === "number" ? `話者${speaker + 1}: ` : "";
}

/** Converts ASR timestamped chunks into an SRT subtitle file's text content. */
export function chunksToSrt(chunks: TranscriptChunk[]): string {
  return chunks
    .map((chunk, index) => {
      const [start, end] = chunk.timestamp;
      const endSeconds = end ?? start;
      return [
        `${index + 1}`,
        `${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(endSeconds)}`,
        speakerPrefix(chunk.speaker) + chunk.text.trim(),
        "",
      ].join("\n");
    })
    .join("\n");
}
