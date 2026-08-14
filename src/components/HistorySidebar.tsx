import { useState } from "react";
import { Trash2, Users, Wand2, AudioLines, Copy, Download, MoreHorizontal, FileAudio } from "lucide-react";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { ScrollArea } from "./ui/scroll-area";
import { useAppStore, selectCapabilities } from "../store/appStore";
import { loadRecording } from "../lib/history";
import type { RecordingHistoryMeta } from "../lib/history";
import { combinedText } from "../lib/transcript";
import { saveTranscript } from "../lib/export/saveTranscript";
import { formatTimestamp } from "../lib/format";
import { cn } from "../lib/utils";

function formatDateTime(date: Date): { day: string; time: string } {
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    day: `${date.getMonth() + 1}/${date.getDate()}`,
    time: `${p(date.getHours())}:${p(date.getMinutes())}`,
  };
}

/** Feature badges are icon-only (no label) to keep each row to one line --
 * the icons mirror the ones used for the same features elsewhere (StatusBar,
 * RecordingTimeline's event band) so their meaning is learned once. */
function FeatureIcons({ meta }: { meta: RecordingHistoryMeta }) {
  return (
    <span className="flex items-center gap-1 text-muted-foreground">
      {meta.usedDiarize && <Users className="h-3 w-3" aria-label="話者分離" />}
      {meta.usedVad && <Wand2 className="h-3 w-3" aria-label="VAD" />}
      {meta.usedAudioEvents && <AudioLines className="h-3 w-3" aria-label="音響イベント検出" />}
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
  const selectedHistoryId = useAppStore((s) => s.selectedHistoryId);
  const loadHistoryEntry = useAppStore((s) => s.loadHistoryEntry);
  const deleteHistoryEntry = useAppStore((s) => s.deleteHistoryEntry);
  const rerunHistoryEntry = useAppStore((s) => s.rerunHistoryEntry);
  const recordingPhase = useAppStore((s) => s.recordingPhase);
  const processing = useAppStore((s) => s.processing);
  const modelStatus = useAppStore((s) => s.modelStatus);
  const recordOnly = useAppStore((s) => s.recordingMode.recordOnly);
  const can = selectCapabilities({ recordingPhase, processing, modelStatus, recordOnly });
  // Opening an entry replaces the on-screen transcript and every timeline
  // counter, so it is a stopped-only action -- the store enforces this too,
  // but a dead-looking click is worse than a disabled control.
  const browsable = recordingPhase === "stopped";
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { handleCopy, handleExport } = useHistoryRowActions(meta.id);
  const { day, time } = formatDateTime(meta.createdAt);
  const selected = selectedHistoryId === meta.id;

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
        onClick={() => void loadHistoryEntry(meta.id)}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {day} {time}
          </span>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {formatTimestamp(meta.durationSec)}
          </span>
        </div>
        {meta.transcribed ? (
          meta.preview && <p className="line-clamp-2 text-xs text-foreground">{meta.preview}</p>
        ) : (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <FileAudio className="h-3 w-3" aria-hidden="true" />
            未解析（録音のみ）
          </p>
        )}
        <FeatureIcons meta={meta} />
      </button>
      <div className="flex items-center justify-end gap-1">
        {!meta.transcribed && (
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
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 opacity-0 group-hover:opacity-100"
              aria-label="コピー・保存"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            {/* Copying/exporting an unanalyzed entry would silently produce an
                empty file -- disabled rather than hidden, so the row's actions
                stay in the same place regardless of transcription state. */}
            <DropdownMenuItem disabled={!meta.transcribed} onSelect={() => void handleCopy()}>
              <Copy className="h-4 w-4" />
              コピー
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!meta.transcribed} onSelect={() => void handleExport("txt")}>
              <Download className="h-4 w-4" />
              .txt として保存
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!meta.transcribed} onSelect={() => void handleExport("srt")}>
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
          disabled={!browsable}
          onClick={(e) => {
            e.stopPropagation();
            if (!confirmingDelete) {
              setConfirmingDelete(true);
              setTimeout(() => setConfirmingDelete(false), 3000);
              return;
            }
            void deleteHistoryEntry(meta.id);
          }}
        >
          <Trash2 className="h-3 w-3" />
          {confirmingDelete ? "本当に削除" : "削除"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Browses past recordings -- the "content of interest" pane, kept separate
 * from the always-visible StatusBar (operating state) and the on-demand
 * SettingsDialog (configuration) per the design plan. Selecting an entry
 * replaces the main view's transcript/audio-events; see
 * `appStore.loadHistoryEntry`.
 */
export function HistorySidebar({ width }: { width: number }) {
  const recordingHistory = useAppStore((s) => s.recordingHistory);

  return (
    <div
      className="flex h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
      style={{ width }}
    >
      <ScrollArea className="flex-1 px-2 pt-2">
        {recordingHistory.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">録音履歴はまだありません。</p>
        ) : (
          <div className="flex flex-col gap-1 pb-2">
            {recordingHistory.map((meta) => (
              <HistoryRow key={meta.id} meta={meta} />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
