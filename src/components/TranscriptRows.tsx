import { Badge } from "./ui/badge";
import { TimeRangeChip } from "./TimeRangeChip";
import type { TranscriptSegment } from "../lib/transcript";
import { audioEventLabelJa } from "../lib/audioEvents";
import { cn } from "../lib/utils";

/**
 * One committed segment, rendered as its own row rather than folded into one
 * giant string: a left border strip encodes the speaker (when diarization
 * ran), a monospace chip shows where it starts, and an optional badge spells
 * the speaker out. A blank-text segment (an excluded-gap placeholder --
 * `nonBlankChunks`/`segmentsFromResult` guarantee this is the only way a
 * segment ever has one) is routed to `ExcludedGapRow` by the caller instead
 * of reaching this component at all.
 *
 * `onSeek` is only given when this segment's time falls inside whatever
 * recording is currently loaded for playback (see `TranscriptPanel`'s
 * `isSeekable`) -- a segment from an earlier take in the same session, with
 * no audio loaded for it, stays plain text rather than offering a click that
 * would seek the wrong recording.
 */
export function SegmentRow({
  segment,
  active,
  onSeek,
  rowRef,
}: {
  segment: TranscriptSegment;
  active: boolean;
  onSeek?: () => void;
  rowRef?: (el: HTMLDivElement | null) => void;
}) {
  const hasSpeaker = typeof segment.speaker === "number";
  const strokeStyle = hasSpeaker
    ? {
        borderLeftColor: `var(--chart-${((segment.speaker as number) % 5) + 1})`,
      }
    : undefined;

  // A drag-selection ending on this text must not also fire a seek -- text is
  // meant to be selectable/copyable, and "I dragged to select a phrase"
  // should never also jump playback out from under the user.
  const handleTextClick = () => {
    if (!onSeek) return;
    if (window.getSelection()?.isCollapsed === false) return;
    onSeek();
  };

  return (
    <div
      ref={rowRef}
      className={cn(
        "flex items-start gap-2 rounded-sm border-l-2 py-1 pl-2 transition-colors",
        !hasSpeaker && "border-l-border",
        // `bg-accent` used to carry this alone, but `--accent` sits only a
        // few points of lightness from `--muted` (the scroll area's own
        // background), so the "currently playing" row was nearly invisible
        // against it. A tinted ring plus a stronger wash reads clearly
        // regardless of theme or the row's own speaker-color border.
        active && "bg-primary/10 ring-1 ring-inset ring-primary/20",
      )}
      style={strokeStyle}
    >
      <TimeRangeChip
        start={segment.startOffsetSec}
        onClick={onSeek}
        title={onSeek && "この位置から再生"}
        className="w-14 pt-0.5"
      />
      {hasSpeaker && (
        <Badge variant="outline" className="mt-0.5 shrink-0">
          話者{(segment.speaker as number) + 1}
        </Badge>
      )}
      <p
        className={cn(
          "flex-1 whitespace-pre-wrap text-sm text-foreground",
          onSeek && "cursor-pointer",
        )}
        onClick={handleTextClick}
      >
        {segment.text}
      </p>
    </div>
  );
}

/**
 * A window audio-tagging excluded from the transcript (see
 * `TranscriptSegment.excludedReason`), shown as a distinct dashed pill
 * instead of a normal text line -- no speaker strip, no solid background --
 * so it reads as "nothing was transcribed here, and here's why" rather than
 * being mistaken for actual spoken content. This is the visual trace the
 * transcript used to have none of: previously the gap was simply silent,
 * with no indication a chunk had been dropped at all.
 */
export function ExcludedGapRow({
  segment,
  onSeek,
}: {
  segment: TranscriptSegment;
  onSeek?: () => void;
}) {
  const duration = segment.chunks[0]?.timestamp[1] ?? 0;
  const label = segment.excludedReason
    ? audioEventLabelJa(segment.excludedReason)
    : "非会話と判定";

  const pillClass = cn(
    "flex items-center gap-1.5 rounded-full border border-dashed border-border px-2.5 py-0.5 text-xs text-muted-foreground",
    onSeek && "hover:border-foreground/40",
  );
  const content = (
    <>
      <span aria-hidden="true">⋯ 除外区間</span>
      <TimeRangeChip
        start={segment.startOffsetSec}
        end={segment.startOffsetSec + duration}
      />
      <span>{label}</span>
    </>
  );

  return (
    <div className="flex justify-center py-1">
      {onSeek ? (
        <button
          type="button"
          onClick={onSeek}
          title="この位置から再生"
          className={pillClass}
        >
          {content}
        </button>
      ) : (
        <span className={pillClass}>{content}</span>
      )}
    </div>
  );
}

/** Low-emphasis trailing row shown while more audio is still being turned
 * into text. Honest about the actual granularity (the live pass commits in
 * ~15s bursts, not word by word) rather than implying token-level streaming
 * that doesn't exist -- see the design plan for why. */
export function PendingRow() {
  return (
    <div className="flex items-center gap-2 py-1 pl-2 text-xs text-muted-foreground">
      <span
        className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-muted-foreground motion-reduce:animate-none"
        aria-hidden="true"
      />
      次の区切りを処理中…
    </div>
  );
}
