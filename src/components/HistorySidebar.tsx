import { useState } from "react";
import { Plus, Trash2, Users, Wand2, AudioLines, Copy, Download, MoreHorizontal } from "lucide-react";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { ScrollArea } from "./ui/scroll-area";
import { useAppStore } from "../store/appStore";
import { loadRecording } from "../lib/history";
import type { RecordingHistoryMeta } from "../lib/history";
import { combinedText } from "../lib/transcript";
import { saveTranscript } from "../lib/export/saveTranscript";
import { formatTimestamp } from "../lib/format";

function formatDateTime(date: Date): { day: string; time: string } {
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    day: `${date.getMonth() + 1}/${date.getDate()}`,
    time: `${p(date.getHours())}:${p(date.getMinutes())}`,
  };
}

/** Feature badges are icon-only (no label) to keep each row to one line --
 * the icons mirror the ones used for the same features elsewhere (StatusBar,
 * AudioEventPanel) so their meaning is learned once. */
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
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { handleCopy, handleExport } = useHistoryRowActions(meta.id);
  const { day, time } = formatDateTime(meta.createdAt);
  const selected = selectedHistoryId === meta.id;

  return (
    <div
      className={
        selected
          ? "group flex flex-col gap-1 rounded-md bg-accent p-2 text-sm"
          : "group flex flex-col gap-1 rounded-md p-2 text-sm hover:bg-accent/60"
      }
    >
      <button type="button" className="flex flex-col gap-1 text-left" onClick={() => void loadHistoryEntry(meta.id)}>
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {day} {time}
          </span>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {formatTimestamp(meta.durationSec)}
          </span>
        </div>
        {meta.preview && <p className="line-clamp-2 text-xs text-foreground">{meta.preview}</p>}
        <FeatureIcons meta={meta} />
      </button>
      <div className="flex items-center justify-end gap-1">
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
        <Button
          type="button"
          variant={confirmingDelete ? "destructive" : "ghost"}
          size="sm"
          className="h-6 px-2 text-xs opacity-0 group-hover:opacity-100 data-[confirming=true]:opacity-100"
          data-confirming={confirmingDelete}
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
  const clearTranscript = useAppStore((s) => s.clearTranscript);
  const startRecording = useAppStore((s) => s.startRecording);
  const recordingStatus = useAppStore((s) => s.recordingStatus);
  const modelStatus = useAppStore((s) => s.modelStatus);
  const busy = recordingStatus === "recording" || recordingStatus === "processing" || recordingStatus === "refining";

  return (
    <div
      className="flex h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
      style={{ width }}
    >
      <div className="p-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full justify-start"
          disabled={busy || modelStatus !== "ready"}
          // The label promises a new recording, so it starts one -- not just
          // clears the view (that silently did nothing when there was
          // nothing to clear, which a user reported as "the button doesn't
          // do anything"). Clearing first discards whatever is currently
          // shown (live transcript or a loaded history entry) so the new
          // recording starts from a blank transcript rather than appending
          // onto it.
          onClick={() => {
            clearTranscript();
            void startRecording();
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          新規録音
        </Button>
      </div>
      <ScrollArea className="flex-1 px-2">
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
