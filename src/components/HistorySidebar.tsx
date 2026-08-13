import { useState } from "react";
import { Plus, Trash2, Users, Wand2, AudioLines } from "lucide-react";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { useAppStore } from "../store/appStore";
import type { RecordingHistoryMeta } from "../lib/history";

function formatDateTime(date: Date): { day: string; time: string } {
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    day: `${date.getMonth() + 1}/${date.getDate()}`,
    time: `${p(date.getHours())}:${p(date.getMinutes())}`,
  };
}

function formatDuration(durationSec: number): string {
  const m = Math.floor(durationSec / 60);
  const s = Math.floor(durationSec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
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

function HistoryRow({ meta }: { meta: RecordingHistoryMeta }) {
  const selectedHistoryId = useAppStore((s) => s.selectedHistoryId);
  const loadHistoryEntry = useAppStore((s) => s.loadHistoryEntry);
  const deleteHistoryEntry = useAppStore((s) => s.deleteHistoryEntry);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
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
            {formatDuration(meta.durationSec)}
          </span>
        </div>
        {meta.preview && <p className="line-clamp-2 text-xs text-foreground">{meta.preview}</p>}
        <FeatureIcons meta={meta} />
      </button>
      <div className="flex justify-end">
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
export function HistorySidebar() {
  const recordingHistory = useAppStore((s) => s.recordingHistory);
  const clearTranscript = useAppStore((s) => s.clearTranscript);
  const recordingStatus = useAppStore((s) => s.recordingStatus);
  const busy = recordingStatus === "recording" || recordingStatus === "processing" || recordingStatus === "refining";

  return (
    <div className="flex h-full w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="p-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full justify-start"
          disabled={busy}
          onClick={clearTranscript}
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
