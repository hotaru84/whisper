import {
  Trash2,
  Users,
  Wand2,
  AudioLines,
  Copy,
  Download,
  MoreHorizontal,
  FileAudio,
  Loader2,
  XCircle,
} from "lucide-react";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { ScrollArea } from "./ui/scroll-area";
import { useConfirmClick } from "./useConfirmClick";
import { ThemeToggle } from "./ThemeToggle";
import { SettingsDialog } from "./SettingsDialog";
import { useAppStore, selectCapabilities } from "../store/appStore";
import { loadRecording } from "../lib/history";
import type { RecordingHistoryMeta } from "../lib/history";
import { combinedText } from "../lib/transcript";
import { saveTranscript } from "../lib/export/saveTranscript";
import { formatTimestamp, formatDateTime } from "../lib/format";
import { cn } from "../lib/utils";

/** Feature badges are icon-only (no label) to keep each row to one line --
 * each carries its own `aria-label` rather than relying on a label learned
 * elsewhere. */
function FeatureIcons({ meta }: { meta: RecordingHistoryMeta }) {
  return (
    <span className="flex items-center gap-1 text-muted-foreground">
      {meta.usedDiarize && <Users className="h-3 w-3" aria-label="話者分離" />}
      {meta.usedVad && <Wand2 className="h-3 w-3" aria-label="VAD" />}
      {meta.usedAudioEvents && (
        <AudioLines className="h-3 w-3" aria-label="音響イベント検出" />
      )}
    </span>
  );
}

/** Copy/export act on this row's own recording, loaded on demand -- the
 * sidebar only ever holds the small projected `RecordingHistoryMeta`, not
 * full segments (see `listRecordings`' doc comment on why), so these need
 * their own `loadRecording` call rather than reading the already-loaded
 * entry a click on the row itself would show. */
function useHistoryRowActions(id: string) {
  const handleCopy = async () => {
    const entry = await loadRecording(id);
    await navigator.clipboard.writeText(combinedText(entry.segments));
  };
  const handleExport = async (format: "txt" | "srt") => {
    const entry = await loadRecording(id);
    await saveTranscript(entry.segments, format);
  };
  return { handleCopy, handleExport };
}

function HistoryRow({ meta }: { meta: RecordingHistoryMeta }) {
  const viewedRecordingId = useAppStore((s) => s.viewedRecordingId);
  const processingRecordingId = useAppStore((s) => s.processingRecordingId);
  const loadHistoryEntry = useAppStore((s) => s.loadHistoryEntry);
  const deselectHistoryEntry = useAppStore((s) => s.deselectHistoryEntry);
  const deleteHistoryEntry = useAppStore((s) => s.deleteHistoryEntry);
  const rerunHistoryEntry = useAppStore((s) => s.rerunHistoryEntry);
  const cancelAnalysis = useAppStore((s) => s.cancelAnalysis);
  const refineProgress = useAppStore((s) => s.refineProgress);
  const recordingPhase = useAppStore((s) => s.recordingPhase);
  const processing = useAppStore((s) => s.processing);
  const modelStatus = useAppStore((s) => s.modelStatus);
  const recordOnly = useAppStore((s) => s.recordingMode.recordOnly);
  const can = selectCapabilities({
    recordingPhase,
    processing,
    modelStatus,
    recordOnly,
  });
  // Opening an entry replaces the on-screen transcript and every timeline
  // counter, so it is a stopped-only action -- the store enforces this too,
  // but a dead-looking click is worse than a disabled control.
  const browsable = recordingPhase === "stopped";
  // This row specifically -- not just "some reanalysis is running somewhere"
  // (that's `!can.reanalyze`, which already greys out every row's own 解析
  // button) -- is the target of the accuracy pass right now. Shown
  // unconditionally rather than only on hover (unlike the action buttons
  // below) since this is the answer to "which one is it doing", not an
  // action the user reaches for.
  const isProcessing = processingRecordingId === meta.id;
  // Distinguishes "actively running, with progress to show and a pass that
  // can still be cancelled" from "cancel was already pressed and this is
  // winding down" -- `can.cancelAnalysis` excludes `cancelling` for exactly
  // this reason (see its own doc comment), so it doubles as the row's own
  // refining/cancelling split once paired with `isProcessing`.
  const isRefiningThis = isProcessing && can.cancelAnalysis;
  const { confirming: confirmingDelete, onClick: onDeleteClick } =
    useConfirmClick(() => {
      void deleteHistoryEntry(meta.id);
    });
  const { handleCopy, handleExport } = useHistoryRowActions(meta.id);
  const { day, time } = formatDateTime(meta.createdAt);
  const selected = viewedRecordingId === meta.id;

  return (
    <div
      className={cn(
        "group flex flex-col gap-1 rounded-md p-2 text-sm",
        selected ? "bg-accent" : browsable && "hover:bg-accent/60",
        !browsable && "opacity-50",
      )}
    >
      <button
        type="button"
        className="flex flex-col gap-1 text-left"
        disabled={!browsable}
        aria-pressed={selected}
        title={selected ? "選択を解除" : undefined}
        // Clicking the already-selected row again backs out to the blank
        // "record to begin" screen instead of doing nothing -- otherwise
        // browsing history was a one-way door with no way back short of
        // starting a new recording or picking a different entry.
        onClick={() =>
          selected ? deselectHistoryEntry() : void loadHistoryEntry(meta.id)
        }
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {day} {time}
          </span>
          {isProcessing ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
              {isRefiningThis
                ? `解析中… ${Math.round(refineProgress ?? 0)}%`
                : "中止中…"}
            </span>
          ) : (
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {formatTimestamp(meta.durationSec)}
            </span>
          )}
        </div>
        {isRefiningThis && (
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-foreground transition-[width]"
              style={{ width: `${Math.min(100, Math.max(0, refineProgress ?? 0))}%` }}
            />
          </div>
        )}
        {meta.transcribed ? (
          meta.preview && (
            <p className="line-clamp-2 text-xs text-foreground">
              {meta.preview}
            </p>
          )
        ) : (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <FileAudio className="h-3 w-3" aria-hidden="true" />
            未解析（録音のみ）
          </p>
        )}
        <FeatureIcons meta={meta} />
      </button>
      <div className="flex items-center justify-end gap-1">
        {isRefiningThis ? (
          // Same button, swapped to the opposite action -- see `isRefiningThis`'s
          // doc comment. Shown unconditionally rather than only on hover
          // (unlike every other action here) since this row is busy right
          // now, not something the user has to reach for.
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            title="解析を中止します。すでに表示されている文字起こしと録音ファイルはそのまま残ります"
            onClick={(e) => {
              e.stopPropagation();
              void cancelAnalysis();
            }}
          >
            <XCircle className="h-3 w-3" />
            解析中止
          </Button>
        ) : (
          !meta.transcribed &&
          !isProcessing && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs opacity-0 group-hover:opacity-100"
              disabled={!can.reanalyze}
              title="この録音を文字起こしします（音声認識モデルの読み込みが必要な場合があります）"
              onClick={(e) => {
                e.stopPropagation();
                // Opens the entry first so the transcript panel switches to it
                // right away (showing the "未解析" placeholder), then runs the
                // analysis against that same now-selected recording -- without
                // this, `rerunHistoryEntry` still transcribes correctly but has
                // nothing to display its result into until the user separately
                // clicks the row.
                void (async () => {
                  await loadHistoryEntry(meta.id);
                  await rerunHistoryEntry(meta.id);
                })();
              }}
            >
              <Wand2 className="h-3 w-3" />
              解析
            </Button>
          )
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 opacity-0 group-hover:opacity-100"
              aria-label="保存"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            {/* Copying/exporting an unanalyzed entry would silently produce an
                empty file -- disabled rather than hidden, so the row's actions
                stay in the same place regardless of transcription state. */}
            <DropdownMenuItem
              disabled={!meta.transcribed}
              onSelect={() => void handleCopy()}
            >
              <Copy className="h-4 w-4" />
              コピー
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!meta.transcribed}
              onSelect={() => void handleExport("txt")}
            >
              <Download className="h-4 w-4" />
              .txt として保存
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!meta.transcribed}
              onSelect={() => void handleExport("srt")}
            >
              <Download className="h-4 w-4" />
              .srt として保存
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          type="button"
          variant={confirmingDelete ? "destructive" : "ghost"}
          size="sm"
          className="h-6 px-2 text-xs opacity-0 group-hover:opacity-100 data-[confirming=true]:opacity-100"
          data-confirming={confirmingDelete}
          // Deleting the entry `rerunHistoryEntry` is currently working
          // against would let its eventual `saveRecordingHistory` call
          // silently recreate the sidecar JSON out from under the delete --
          // see `isProcessing`'s own doc comment above.
          disabled={!browsable || isProcessing}
          onClick={onDeleteClick}
        >
          <Trash2 className="h-3 w-3" />
          {confirmingDelete ? "本当に削除?" : "削除"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Browses past recordings -- the "content of interest" pane, kept separate
 * from the always-visible titlebar (operating state) and the on-demand
 * SettingsDialog (configuration) per the design plan. Selecting an entry
 * replaces the main view's transcript/audio-events; see
 * `appStore.loadHistoryEntry`.
 */
export function HistorySidebar({ width }: { width: number }) {
  const recordingHistory = useAppStore((s) => s.recordingHistory);

  return (
    // No border-r: the divider between this and the main area is drawn by the
    // resize handle in App.tsx, so that the line and the thing you grab to move
    // it are the same element rather than two rules a few pixels apart.
    //
    // pr-2 keeps the ScrollArea's own scrollbar clear of that handle, which
    // overlaps this panel's right 8px -- without the gutter the scrollbar sits
    // flush against the edge and is unreachable under a col-resize cursor.
    <div
      className="flex h-full shrink-0 flex-col overflow-hidden bg-sidebar pr-2 text-sidebar-foreground"
      style={{ width }}
    >
      {/* min-h-0 is what makes the list scroll at all: without it this flex
          child keeps `min-height: auto` and grows to its content, so the
          ScrollArea's viewport is never shorter than what's inside it and has
          nothing to scroll. Same wrapper pattern as TranscriptPanel's. */}
      <div className="min-h-0 flex-1 pt-2 pl-2">
        <ScrollArea className="h-full">
          {recordingHistory.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">
              録音履歴はまだありません。
            </p>
          ) : (
            <div className="flex flex-col gap-1 pb-2">
              {recordingHistory.map((meta) => (
                <HistoryRow key={meta.id} meta={meta} />
              ))}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* App-wide settings, not history-browsing actions -- placed here
          rather than the titlebar because both are consulted occasionally,
          not per-recording (see TitleBar.tsx's doc comment). -mr-2 pr-4
          extends the border-t past the root's own pr-2 (reserved for the
          ScrollArea's scrollbar gutter above), so the rule reaches the
          panel's actual right edge instead of stopping 8px short. */}
      <div className="-mr-2 flex shrink-0 items-center gap-1 border-t border-sidebar-border px-2 py-1.5 pr-4">
        <ThemeToggle />
        <SettingsDialog />
      </div>
    </div>
  );
}
