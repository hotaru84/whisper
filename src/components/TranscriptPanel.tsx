import { useEffect, useRef, useState } from "react";
import { ChevronDown, Copy, Download, Check, Trash2, RotateCw } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { TimeRangeChip } from "./TimeRangeChip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { useAppStore, selectCapabilities } from "../store/appStore";
import { combinedText, type TranscriptSegment } from "../lib/transcript";
import { saveTranscript } from "../lib/export/saveTranscript";
import { audioEventLabelJa } from "../lib/audioEvents";
import { cn } from "../lib/utils";

/** How close to the bottom (px) still counts as "at the bottom" for
 * auto-scroll purposes -- exact equality is too strict, a fraction of a
 * pixel of sub-pixel layout rounding would otherwise flip this every frame. */
const AUTO_SCROLL_THRESHOLD_PX = 24;

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
function SegmentRow({
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
    ? { borderLeftColor: `var(--chart-${(segment.speaker as number) % 5 + 1})` }
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
        active && "bg-accent",
      )}
      style={strokeStyle}
    >
      <TimeRangeChip start={segment.startOffsetSec} onClick={onSeek} title={onSeek && "この位置から再生"} className="w-14 pt-0.5" />
      {hasSpeaker && (
        <Badge variant="outline" className="mt-0.5 shrink-0">
          話者{(segment.speaker as number) + 1}
        </Badge>
      )}
      <p
        className={cn("flex-1 whitespace-pre-wrap text-sm text-foreground", onSeek && "cursor-pointer")}
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
function ExcludedGapRow({ segment, onSeek }: { segment: TranscriptSegment; onSeek?: () => void }) {
  const duration = segment.chunks[0]?.timestamp[1] ?? 0;
  const label = segment.excludedReason ? audioEventLabelJa(segment.excludedReason) : "非会話と判定";

  const pillClass = cn(
    "flex items-center gap-1.5 rounded-full border border-dashed border-border px-2.5 py-0.5 text-xs text-muted-foreground",
    onSeek && "hover:border-foreground/40",
  );
  const content = (
    <>
      <span aria-hidden="true">⋯ 除外区間</span>
      <TimeRangeChip start={segment.startOffsetSec} end={segment.startOffsetSec + duration} />
      <span>{label}</span>
    </>
  );

  return (
    <div className="flex justify-center py-1">
      {onSeek ? (
        <button type="button" onClick={onSeek} title="この位置から再生" className={pillClass}>
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
function PendingRow() {
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

/** Finds the scrollable viewport `ScrollArea` renders internally. Radix does
 * not expose a ref to it directly, so this reaches through the DOM instead --
 * the same workaround this component's auto-scroll and its "resume at
 * bottom" detection both need. */
function getViewport(container: HTMLDivElement | null): HTMLElement | null {
  return container?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null;
}

export function TranscriptPanel() {
  const segments = useAppStore((s) => s.segments);
  const recordingPhase = useAppStore((s) => s.recordingPhase);
  const processing = useAppStore((s) => s.processing);
  const modelStatus = useAppStore((s) => s.modelStatus);
  const refineNotice = useAppStore((s) => s.refineNotice);
  const recordingHistory = useAppStore((s) => s.recordingHistory);
  const selectedHistoryId = useAppStore((s) => s.selectedHistoryId);
  const deleteHistoryEntry = useAppStore((s) => s.deleteHistoryEntry);
  const rerunHistoryEntry = useAppStore((s) => s.rerunHistoryEntry);
  const playback = useAppStore((s) => s.playback);
  const seekTo = useAppStore((s) => s.seekTo);
  const [copied, setCopied] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const activeRowRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const prevPhaseRef = useRef(recordingPhase);
  const can = selectCapabilities({ recordingPhase, processing, modelStatus });

  const viewingHistory = recordingHistory.find((r) => r.id === selectedHistoryId);
  // Whatever recording is currently loaded for playback -- set both when
  // browsing a history entry and right after a live recording's second pass
  // finishes (see `refineRecording`'s `loadPlayback` call), so this reanalyze
  // button is not gated on having gone through the history sidebar first.
  const currentRecordingId = playback.recordingId;

  const hasTranscript = segments.length > 0;
  const text = combinedText(segments);
  const isRefining = processing === "refining";
  // "More text is still on its way": a take is open (recording or paused, since
  // pausing flushes but does not end it), or the final flush is running.
  const isLive = recordingPhase !== "stopped" || processing === "transcribing";

  // Whether `segment` falls inside whatever recording is currently loaded for
  // playback -- see `PlaybackState.timelineOffsetSec`'s doc comment. Only
  // these segments get a working seek target; an earlier take in the same
  // session (if any) has no audio loaded for it right now.
  const playbackLoaded = playback.recordingId != null && !playback.loading;
  const isSeekable = (segment: TranscriptSegment) =>
    playbackLoaded &&
    segment.startOffsetSec >= playback.timelineOffsetSec &&
    segment.startOffsetSec <= playback.timelineOffsetSec + playback.durationSec;

  const globalPlaybackTimeSec = playbackLoaded ? playback.timelineOffsetSec + playback.currentTimeSec : null;
  // The last segment starting at or before the playhead, among the ones the
  // loaded recording actually covers -- segments are always appended in
  // ascending time order, so a linear scan doubles as "latest match".
  let activeSegmentId: number | null = null;
  if (globalPlaybackTimeSec != null) {
    for (const seg of segments) {
      if (isSeekable(seg) && seg.startOffsetSec <= globalPlaybackTimeSec) activeSegmentId = seg.id;
    }
  }

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
      const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
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
  }, [segments.length, recordingPhase, autoScroll]);

  // Follow the playhead during playback, same escape hatch: a manual scroll
  // (tracked by the same `autoScroll` flag) leaves it wherever the user put it.
  useEffect(() => {
    if (!playback.isPlaying || !autoScroll) return;
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeSegmentId, playback.isPlaying, autoScroll]);

  const jumpToLatest = () => {
    setAutoScroll(true);
    const viewport = getViewport(scrollContainerRef.current);
    viewport?.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  };

  const handleCopy = async () => {
    if (!hasTranscript) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleExport = async (format: "txt" | "srt") => {
    if (!hasTranscript) return;
    await saveTranscript(segments, format);
  };

  return (
    <div className="flex w-full flex-1 flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">文字起こし結果</h2>
        <div className="flex gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm" disabled={!hasTranscript}>
                {copied ? <Check className="h-4 w-4" /> : <Download className="h-4 w-4" />}
                コピー・保存
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void handleCopy()}>
                <Copy className="h-4 w-4" />
                コピー
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void handleExport("txt")}>
                <Download className="h-4 w-4" />
                .txt として保存
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void handleExport("srt")}>
                <Download className="h-4 w-4" />
                .srt として保存
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {currentRecordingId && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void rerunHistoryEntry(currentRecordingId)}
              disabled={!can.reanalyze}
              title="現在の設定（話者分離・VAD・音響イベント）でこの録音のパス2（精度向上パス）を再分析し、履歴を上書きします"
            >
              <RotateCw className="h-4 w-4" />
              パス2を再分析
            </Button>
          )}
          {viewingHistory && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void deleteHistoryEntry(viewingHistory.id)}
              disabled={!can.browseHistory}
              title="この録音履歴を削除"
            >
              <Trash2 className="h-4 w-4" />
              履歴を削除
            </Button>
          )}
        </div>
      </div>

      {viewingHistory && (
        <p className="text-xs text-muted-foreground">
          履歴を表示中 —{" "}
          <span className="font-mono">
            {viewingHistory.createdAt.getFullYear()}-{String(viewingHistory.createdAt.getMonth() + 1).padStart(2, "0")}-
            {String(viewingHistory.createdAt.getDate()).padStart(2, "0")}{" "}
            {String(viewingHistory.createdAt.getHours()).padStart(2, "0")}:
            {String(viewingHistory.createdAt.getMinutes()).padStart(2, "0")}
          </span>
        </p>
      )}

      {isRefining && (
        // The numeric progress and "what's happening" text live in StatusBar
        // (always visible regardless of scroll position); this is only the
        // one thing StatusBar can't say, since it's specific to what's shown
        // below.
        <p className="text-xs text-muted-foreground">
          録音全体を通しで読み直して精度を上げています。完了すると下の文字起こしが差し替わります。今の内容もそのまま使えます。
        </p>
      )}

      {refineNotice && <p className="text-xs text-amber">{refineNotice}</p>}

      <div className="relative min-h-32 max-h-[60vh] flex-1">
        {hasTranscript || isLive ? (
          <ScrollArea
            ref={scrollContainerRef}
            className={cn(
              "h-full rounded-md bg-muted transition-opacity",
              isRefining && "pointer-events-none opacity-60",
            )}
          >
            <div className="flex flex-col gap-0.5 p-3">
              {segments.map((seg) => {
                const onSeek = isSeekable(seg)
                  ? () => seekTo(seg.startOffsetSec - playback.timelineOffsetSec)
                  : undefined;
                if (seg.text.trim() === "") {
                  return <ExcludedGapRow key={seg.id} segment={seg} onSeek={onSeek} />;
                }
                const active = seg.id === activeSegmentId;
                return (
                  <SegmentRow
                    key={seg.id}
                    segment={seg}
                    active={active}
                    onSeek={onSeek}
                    rowRef={active ? (el) => { activeRowRef.current = el; } : undefined}
                  />
                );
              })}
              {isLive && <PendingRow />}
            </div>
          </ScrollArea>
        ) : (
          <div className="flex h-full min-h-32 items-center rounded-md bg-muted p-3 text-sm text-muted-foreground">
            録音を開始すると、ここに文字起こし結果が表示されます。
          </div>
        )}

        {recordingPhase === "recording" && !autoScroll && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="absolute bottom-2 left-1/2 -translate-x-1/2 shadow-sm"
            onClick={jumpToLatest}
          >
            最新へ
          </Button>
        )}
      </div>
    </div>
  );
}
