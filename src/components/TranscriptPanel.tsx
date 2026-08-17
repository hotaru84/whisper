import { useState } from "react";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { TranscriptToolbar } from "./TranscriptToolbar";
import { SegmentRow, ExcludedGapRow, PendingRow } from "./TranscriptRows";
import { useTranscriptScrollTracking } from "./useTranscriptScrollTracking";
import { useAppStore, selectCapabilities, effectiveRecordOnly } from "../store/appStore";
import { combinedText, collapseDegenerateSegments, type TranscriptSegment } from "../lib/transcript";
import { saveTranscript } from "../lib/export/saveTranscript";
import { cn } from "../lib/utils";

export function TranscriptPanel() {
  const segments = useAppStore((s) => s.segments);
  const recordingPhase = useAppStore((s) => s.recordingPhase);
  const processing = useAppStore((s) => s.processing);
  const modelStatus = useAppStore((s) => s.modelStatus);
  const refineNotice = useAppStore((s) => s.refineNotice);
  const recordingHistory = useAppStore((s) => s.recordingHistory);
  const viewedRecordingId = useAppStore((s) => s.viewedRecordingId);
  const deleteHistoryEntry = useAppStore((s) => s.deleteHistoryEntry);
  const rerunHistoryEntry = useAppStore((s) => s.rerunHistoryEntry);
  const cancelAnalysis = useAppStore((s) => s.cancelAnalysis);
  const processingRecordingId = useAppStore((s) => s.processingRecordingId);
  const playback = useAppStore((s) => s.playback);
  const seekTo = useAppStore((s) => s.seekTo);
  const [copied, setCopied] = useState(false);
  const recordOnly = useAppStore((s) => effectiveRecordOnly(s.recordingMode, s.powerSource));
  const can = selectCapabilities({
    recordingPhase,
    processing,
    modelStatus,
    recordOnly,
  });

  const viewedRecording = recordingHistory.find(
    (r) => r.id === viewedRecordingId,
  );
  // Whatever recording is currently loaded for playback -- set both when
  // browsing a history entry and right after a live recording's second pass
  // finishes (see `refineRecording`'s `loadPlayback` call), so this reanalyze
  // button is not gated on having gone through the history sidebar first.
  const currentRecordingId = playback.recordingId;

  const hasTranscript = segments.length > 0;
  // A rendering-only view of `segments`: folds a stalled decode's repeated
  // cues (see collapseDegenerateSegments's doc comment) into one row. Never
  // fed back into the store -- `segments` itself, and everything keyed off
  // its ids (history persistence, refine-pass bookkeeping), stays
  // uncollapsed.
  const displaySegments = collapseDegenerateSegments(segments);
  const text = combinedText(displaySegments);
  const isRefining = processing === "refining";
  // Whether the recording on screen is specifically the one the accuracy
  // pass is running against -- `can.cancelAnalysis` alone doesn't say
  // *which* recording, and offering to cancel a pass running against a
  // different history entry than the one being viewed would cancel the
  // wrong thing.
  const isCancelable = can.cancelAnalysis && currentRecordingId === processingRecordingId;
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
    for (const seg of displaySegments) {
      if (isSeekable(seg) && seg.startOffsetSec <= globalPlaybackTimeSec)
        activeSegmentId = seg.id;
    }
  }

  const { scrollContainerRef, activeRowRef, autoScroll, jumpToLatest } = useTranscriptScrollTracking({
    recordingPhase,
    segmentsLength: displaySegments.length,
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
            ? isCancelable
              ? { mode: "cancel", onClick: () => void cancelAnalysis(), disabled: false }
              : {
                  mode: "reanalyze",
                  onClick: () => void rerunHistoryEntry(currentRecordingId),
                  disabled: !can.reanalyze,
                }
            : undefined
        }
        deleteHistory={
          viewedRecording
            ? {
                id: viewedRecording.id,
                onClick: () => void deleteHistoryEntry(viewedRecording.id),
                disabled: !can.browseHistory,
              }
            : undefined
        }
      />

      {/* Gated on `recordingPhase` rather than `viewedRecording` resolving:
          this panel is only ever mounted stopped-and-showing-something (Home's
          "something selected" state -- App.tsx's `showRecordStart` already
          excludes the alternative), so this belongs here the instant that's
          true, not only once `recordingHistory` has caught up enough for the
          `.find()` below to resolve (a just-stopped take can briefly go
          through that gap -- see `refineRecording`'s early `persistTake`
          call, which now keeps this gap essentially instant). Returning to
          Home from here is the titlebar's own "戻る" button
          (`TitleBarControls.tsx`), not a control local to this panel. */}
      {recordingPhase === "stopped" && (
        <p className="text-xs text-muted-foreground">
          {viewedRecording ? (
            <>
              履歴を表示中 —{" "}
              <span className="font-mono">
                {viewedRecording.createdAt.getFullYear()}-
                {String(viewedRecording.createdAt.getMonth() + 1).padStart(2, "0")}-
                {String(viewedRecording.createdAt.getDate()).padStart(2, "0")}{" "}
                {String(viewedRecording.createdAt.getHours()).padStart(2, "0")}:
                {String(viewedRecording.createdAt.getMinutes()).padStart(2, "0")}
              </span>
            </>
          ) : (
            "録音を処理中…"
          )}
        </p>
      )}

      {isRefining && (
        // The numeric progress lives in the titlebar's status readout
        // (always visible regardless of scroll position); this is only the
        // one thing it can't say, since it's specific to what's shown below.
        // Cancelling happens via the toolbar's 解析中止 button above rather
        // than a second button here -- see `isCancelable`.
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
              {displaySegments.map((seg) => {
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
