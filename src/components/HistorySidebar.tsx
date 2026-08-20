import {
  Trash2,
  Users,
  Wand2,
  AudioLines,
  Copy,
  FolderOpen,
  MoreHorizontal,
  FileAudio,
  Loader2,
  XCircle,
  CircleCheck,
  CircleDashed,
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
import { useAppStore, selectCapabilities, effectiveRecordOnly, useAnalysisQueueStore } from "../store/appStore";
import { loadRecording, openRecordingFolder, analysisAction } from "../lib/history";
import type { RecordingHistoryMeta } from "../lib/history";
import { combinedText, collapseDegenerateSegments } from "../lib/transcript";
import { useMockBackend } from "../lib/env";
import { MOCK_NATIVE_FEATURE_UNAVAILABLE } from "../lib/mock/fixtures";
import { formatTimestamp, formatDateTime } from "../lib/format";
import { cn } from "../lib/utils";

/** Feature badges are icon-only (no label) to keep each row to one line --
 * each carries its own `aria-label` rather than relying on a label learned
 * elsewhere. */
function FeatureIcons({ meta }: { meta: RecordingHistoryMeta }) {
  return (
    <span className="flex items-center gap-1 text-muted-foreground">
      {meta.usedDiarize && <Users className="h-3 w-3" aria-label="話者分離" />}
      {meta.usedAudioEvents && (
        <AudioLines className="h-3 w-3" aria-label="音響イベント検出" />
      )}
    </span>
  );
}

/** Copy acts on this row's own recording, loaded on demand -- the sidebar
 * only ever holds the small projected `RecordingHistoryMeta`, not full
 * segments (see `listRecordings`' doc comment on why), so this needs its own
 * `loadRecording` call rather than reading the already-loaded entry a click
 * on the row itself would show. Opening the folder needs no such load --
 * `openRecordingFolder` only needs the id. */
function useHistoryRowActions(id: string) {
  const handleCopy = async () => {
    const entry = await loadRecording(id);
    await navigator.clipboard.writeText(combinedText(collapseDegenerateSegments(entry.segments)));
  };
  const handleOpenFolder = () => openRecordingFolder(id);
  return { handleCopy, handleOpenFolder };
}

function HistoryRow({ meta }: { meta: RecordingHistoryMeta }) {
  const viewedRecordingId = useAppStore((s) => s.viewedRecordingId);
  // This row's own job, if it has one -- more than one recording can have
  // analysis in flight at once now (see `src/store/analysisQueue.ts`), so
  // "is *this* row processing" is answered per-row from here rather than
  // from a single app-wide field.
  const job = useAnalysisQueueStore((s) => s.jobs[meta.id]);
  const loadHistoryEntry = useAppStore((s) => s.loadHistoryEntry);
  const deselectHistoryEntry = useAppStore((s) => s.deselectHistoryEntry);
  const deleteHistoryEntry = useAppStore((s) => s.deleteHistoryEntry);
  const rerunHistoryEntry = useAppStore((s) => s.rerunHistoryEntry);
  const cancelAnalysis = useAppStore((s) => s.cancelAnalysis);
  const recordingPhase = useAppStore((s) => s.recordingPhase);
  const modelStatus = useAppStore((s) => s.modelStatus);
  const recordOnly = useAppStore((s) => effectiveRecordOnly(s.recordingMode, s.powerSource));
  const can = selectCapabilities({
    recordingPhase,
    modelStatus,
    recordOnly,
  });
  // Opening an entry replaces the on-screen transcript and every timeline
  // counter, so it is a stopped-only action -- the store enforces this too,
  // but a dead-looking click is worse than a disabled control.
  const browsable = recordingPhase === "stopped";
  // Shown unconditionally rather than only on hover (unlike the action
  // buttons below) since this is the answer to "which one is it doing", not
  // an action the user reaches for.
  const isProcessing = job !== undefined;
  // Distinguishes "actively running, with progress to show and a pass that
  // can still be cancelled" from "cancel was already pressed and this is
  // winding down".
  const isRefiningThis = isProcessing && job.status !== "cancelling";
  const action = analysisAction(meta);
  const { confirming: confirmingDelete, onClick: onDeleteClick } =
    useConfirmClick(() => {
      void deleteHistoryEntry(meta.id);
    });
  const { handleCopy, handleOpenFolder } = useHistoryRowActions(meta.id);
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
              {!isRefiningThis
                ? "中止中…"
                : job.status === "queued"
                  ? "待機中…"
                  : job.status === "transcribing"
                    ? `解析中… ${Math.round(job.progress ?? 0)}%`
                    : "解析中…"}
            </span>
          ) : (
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {formatTimestamp(meta.durationSec)}
            </span>
          )}
        </div>
        {isRefiningThis && job.status === "transcribing" && (
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-foreground transition-[width]"
              style={{ width: `${Math.min(100, Math.max(0, job.progress ?? 0))}%` }}
            />
          </div>
        )}
        {action === null ? (
          meta.preview && (
            <div className="flex items-start gap-1">
              <CircleCheck
                className="mt-0.5 h-3 w-3 shrink-0 text-trace"
                aria-label="解析完了"
              />
              <p className="line-clamp-2 text-xs text-foreground">
                {meta.preview}
              </p>
            </div>
          )
        ) : action === "resume" ? (
          <p className="flex items-center gap-1 text-xs text-amber">
            <CircleDashed className="h-3 w-3 shrink-0" aria-hidden="true" />
            {Math.round((meta.analyzedThroughSec / meta.durationSec) * 100)}
            %まで解析済み・続きから再開できます
          </p>
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
              void cancelAnalysis(meta.id);
            }}
          >
            <XCircle className="h-3 w-3" />
            解析中止
          </Button>
        ) : (
          !isProcessing &&
          action && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs opacity-0 group-hover:opacity-100"
              disabled={!can.reanalyze}
              title={
                action === "resume"
                  ? "前回の続きから解析を再開します（音声認識モデルの読み込みが必要な場合があります）"
                  : "この録音を文字起こしします（音声認識モデルの読み込みが必要な場合があります）"
              }
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
              {action === "resume" ? "続きを解析" : "解析"}
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
              aria-label="その他の操作"
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
            {/* Unlike copy, this doesn't need a transcript -- even an
                unanalyzed (record-only) row has a WAV to open a folder for.
                Disabled in the browser preview, which has no native file
                manager -- same as TranscriptToolbar's copy of this button. */}
            <DropdownMenuItem
              disabled={useMockBackend}
              title={useMockBackend ? MOCK_NATIVE_FEATURE_UNAVAILABLE : undefined}
              onSelect={() => void handleOpenFolder()}
            >
              <FolderOpen className="h-4 w-4" />
              フォルダを開く
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          type="button"
          variant={confirmingDelete ? "destructive" : "ghost"}
          size="sm"
          className="h-6 px-2 text-xs opacity-0 group-hover:opacity-100 data-[confirming=true]:opacity-100"
          data-confirming={confirmingDelete}
          // Deleting the entry a job is currently working against would let
          // its eventual `saveRecordingHistory` call silently recreate the
          // sidecar JSON out from under the delete -- `isProcessing` is this
          // row's own job (see its declaration above), not any other row's.
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
