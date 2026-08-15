import { useEffect, useRef, useState } from "react";
import type { RecordingPhase } from "../store/appStore";

/** How close to the bottom (px) still counts as "at the bottom" for
 * auto-scroll purposes -- exact equality is too strict, a fraction of a
 * pixel of sub-pixel layout rounding would otherwise flip this every frame. */
const AUTO_SCROLL_THRESHOLD_PX = 24;

/** Finds the scrollable viewport `ScrollArea` renders internally. Radix does
 * not expose a ref to it directly, so this reaches through the DOM instead --
 * the same workaround this hook's auto-scroll and its "resume at bottom"
 * detection both need. */
function getViewport(container: HTMLDivElement | null): HTMLElement | null {
  return (
    container?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    ) ?? null
  );
}

/**
 * Everything about keeping the transcript list scrolled to the right place --
 * following new segments while recording, following the playhead during
 * playback, jumping to an explicit seek, and the "user scrolled away, stop
 * auto-following" escape hatch all four of those share. Pulled into its own
 * hook the same way `TitleBarStatus.tsx`'s `useElapsedRecordingSec` is: the effects
 * only make sense read together, and inlining them left `TranscriptPanel`'s
 * render logic sandwiched between five independent `useEffect`s.
 */
export function useTranscriptScrollTracking({
  recordingPhase,
  segmentsLength,
  isPlaying,
  activeSegmentId,
  seekSeq,
}: {
  recordingPhase: RecordingPhase;
  segmentsLength: number;
  isPlaying: boolean;
  activeSegmentId: number | null;
  seekSeq: number;
}) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const activeRowRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const prevPhaseRef = useRef(recordingPhase);

  // A fresh recording starts back at the bottom, even if the previous one
  // left auto-scroll suspended (the user had scrolled up to re-read it).
  // Resuming from a pause deliberately does not reset it: the user very likely
  // scrolled up to read something during the pause, which is the whole point
  // of being able to pause.
  useEffect(() => {
    if (recordingPhase === "recording" && prevPhaseRef.current === "stopped") {
      setAutoScroll(true);
    }
    prevPhaseRef.current = recordingPhase;
  }, [recordingPhase]);

  // Track whether the user is at the bottom/away-from-the-playhead, so a
  // manual scroll suspends auto-scroll instead of fighting it on every new
  // segment or every playback tick.
  useEffect(() => {
    const viewport = getViewport(scrollContainerRef.current);
    if (!viewport) return;
    const onScroll = () => {
      const distanceFromBottom =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      setAutoScroll(distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX);
    };
    viewport.addEventListener("scroll", onScroll);
    return () => viewport.removeEventListener("scroll", onScroll);
  }, []);

  // Follow new segments to the bottom while recording, as long as the user
  // hasn't scrolled away to read something earlier.
  useEffect(() => {
    if (recordingPhase !== "recording" || !autoScroll) return;
    const viewport = getViewport(scrollContainerRef.current);
    viewport?.scrollTo({ top: viewport.scrollHeight });
  }, [segmentsLength, recordingPhase, autoScroll]);

  // Follow the playhead during playback, same escape hatch: a manual scroll
  // (tracked by the same `autoScroll` flag) leaves it wherever the user put it.
  useEffect(() => {
    if (!isPlaying || !autoScroll) return;
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeSegmentId, isPlaying, autoScroll]);

  // Jump to the seeked-to segment unconditionally -- unlike the
  // playhead-follow effect above, this ignores both `autoScroll` and
  // `isPlaying`. Dragging the timeline slider, clicking a segment's own
  // timestamp, or clicking an audio-event block (`RecordingTimeline`) are all
  // explicit "take me there" actions, not the passive tail-following that
  // escape hatch exists for -- see `PlaybackState.seekSeq`'s doc comment.
  // Keyed off the seq rather than `activeSegmentId` alone so re-seeking to a
  // point inside the *same* segment (which doesn't change `activeSegmentId`)
  // still re-centers it.
  const lastSeekSeqRef = useRef(seekSeq);
  useEffect(() => {
    if (seekSeq === lastSeekSeqRef.current) return;
    lastSeekSeqRef.current = seekSeq;
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [seekSeq]);

  const jumpToLatest = () => {
    setAutoScroll(true);
    const viewport = getViewport(scrollContainerRef.current);
    viewport?.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  };

  return { scrollContainerRef, activeRowRef, autoScroll, jumpToLatest };
}
