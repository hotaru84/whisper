import { formatTimestamp } from "../lib/format";
import { cn } from "../lib/utils";

/**
 * A monospace timestamp chip -- either a single point in time (`start` only)
 * or a `start`–`end` range. Shared visual for every "this is a timecode"
 * affordance in the app: `TranscriptPanel`'s per-segment timestamp,
 * `AudioEventPanel`'s per-event range, and the excluded-gap placeholder
 * between them. Pass `onClick` to make it an interactive seek target
 * (rendered as a `<button>`); omit it for the plain read-only case.
 */
export function TimeRangeChip({
  start,
  end,
  onClick,
  title,
  className,
}: {
  start: number;
  end?: number;
  onClick?: () => void;
  title?: string;
  className?: string;
}) {
  const label = end != null ? `${formatTimestamp(start)}–${formatTimestamp(end)}` : formatTimestamp(start);
  const classes = cn("shrink-0 font-mono text-xs tabular-nums text-muted-foreground", className);

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        className={cn(classes, "rounded hover:text-foreground hover:underline focus-visible:text-foreground")}
      >
        {label}
      </button>
    );
  }

  return (
    <span title={title} className={classes}>
      {label}
    </span>
  );
}
