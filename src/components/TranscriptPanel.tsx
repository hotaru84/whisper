import { useState } from "react";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { TranscriptToolbar } from "./TranscriptToolbar";
import { SegmentRow, ExcludedGapRow, PendingRow } from "./TranscriptRows";
import { useTranscriptScrollTracking } from "./useTranscriptScrollTracking";
import { useAppStore, selectCapabilities } from "../store/appStore";
import { combinedText, type TranscriptSegment } from "../lib/transcript";
import { saveTranscript } from "../lib/export/saveTranscript";
import { cn } from "../lib/utils";

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
  const recordOnly = useAppStore((s) => s.recordingMode.recordOnly);
  const can = selectCapabilities({
    recordingPhase,
    processing,
    modelStatus,
    recordOnly,
  });

  const viewingHistory = recordingHistory.find(
    (r) => r.id === selectedHistoryId,
  );
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

  const globalPlaybackTimeSec = playbackLoaded
    ? playback.timelineOffsetSec + playback.currentTimeSec
    : null;
  // The last segment starting at or before the playhead, among the ones the
  // loaded recording actually covers -- segments are always appended in
  // ascending time order, so a linear scan doubles as "latest match".
  let activeSegmentId: number | null = null;
  if (globalPlaybackTimeSec != null) {
    for (const seg of segments) {
      if (isSeekable(seg) && seg.startOffsetSec <= globalPlaybackTimeSec)
        activeSegmentId = seg.id;
    }
  }

  const { scrollContainerRef, activeRowRef, autoScroll, jumpToLatest } = useTranscriptScrollTracking({
    recordingPhase,
    segmentsLength: segments.length,
    isPlaying: playback.isPlaying,
    activeSegmentId,
    seekSeq: playback.seekSeq,
  });

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
    <div className="flex w-full min-h-0 flex-1 flex-col gap-3 rounded-lg border border-border p-4">
      <TranscriptToolbar
        hasTranscript={hasTranscript}
        copied={copied}
        onCopy={() => void handleCopy()}
        onExport={(format) => void handleExport(format)}
        reanalyze={
          currentRecordingId
            ? { onClick: () => void rerunHistoryEntry(currentRecordingId), disabled: !can.reanalyze }
            : undefined
        }
        deleteHistory={
          viewingHistory
            ? {
                id: viewingHistory.id,
                onClick: () => void deleteHistoryEntry(viewingHistory.id),
                disabled: !can.browseHistory,
              }
            : undefined
        }
      />

      {viewingHistory && (
        <p className="text-xs text-muted-foreground">
          履歴を表示中 —{" "}
          <span className="font-mono">
            {viewingHistory.createdAt.getFullYear()}-
            {String(viewingHistory.createdAt.getMonth() + 1).padStart(2, "0")}-
            {String(viewingHistory.createdAt.getDate()).padStart(2, "0")}{" "}
            {String(viewingHistory.createdAt.getHours()).padStart(2, "0")}:
            {String(viewingHistory.createdAt.getMinutes()).padStart(2, "0")}
          </span>
        </p>
      )}

      {isRefining && (
        // The numeric progress and "what's happening" text live in the
        // titlebar's status readout (always visible regardless of scroll
        // position); this is only the one thing it can't say, since it's
        // specific to what's shown below.
        <p className="text-xs text-muted-foreground">
          録音全体を通しで読み直して精度を上げています。完了すると下の文字起こしが差し替わります。今の内容もそのまま使えます。
        </p>
      )}

      {refineNotice && <p className="text-xs text-amber">{refineNotice}</p>}

      <div className="relative min-h-0 flex-1">
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
                  ? () =>
                      seekTo(seg.startOffsetSec - playback.timelineOffsetSec)
                  : undefined;
                if (seg.text.trim() === "") {
                  return (
                    <ExcludedGapRow
                      key={seg.id}
                      segment={seg}
                      onSeek={onSeek}
                    />
                  );
                }
                const active = seg.id === activeSegmentId;
                return (
                  <SegmentRow
                    key={seg.id}
                    segment={seg}
                    active={active}
                    onSeek={onSeek}
                    rowRef={
                      active
                        ? (el) => {
                            activeRowRef.current = el;
                          }
                        : undefined
                    }
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
