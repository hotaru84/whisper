import { useState } from "react";
import { Copy, Download, Check, Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import { useAppStore } from "../store/appStore";
import { combinedText } from "../lib/transcript";
import { saveTranscript } from "../lib/export/saveTranscript";

export function TranscriptPanel() {
  const segments = useAppStore((s) => s.segments);
  const recordingStatus = useAppStore((s) => s.recordingStatus);
  const refineProgress = useAppStore((s) => s.refineProgress);
  const refineNotice = useAppStore((s) => s.refineNotice);
  const clearTranscript = useAppStore((s) => s.clearTranscript);
  const recordingHistory = useAppStore((s) => s.recordingHistory);
  const selectedHistoryId = useAppStore((s) => s.selectedHistoryId);
  const deleteHistoryEntry = useAppStore((s) => s.deleteHistoryEntry);
  const [copied, setCopied] = useState(false);

  const viewingHistory = recordingHistory.find((r) => r.id === selectedHistoryId);

  const hasTranscript = segments.length > 0;
  const text = combinedText(segments);
  const isRefining = recordingStatus === "refining";
  // The transcript is mid-replacement while refining, and the file is still open
  // while processing, so both have to hold off destructive and export actions.
  const busy = recordingStatus === "recording" || recordingStatus === "processing" || isRefining;

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
          <Button type="button" variant="outline" size="sm" onClick={handleCopy} disabled={!hasTranscript}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            コピー
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleExport("txt")}
            disabled={!hasTranscript}
          >
            <Download className="h-4 w-4" />
            .txt
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleExport("srt")}
            disabled={!hasTranscript}
          >
            <Download className="h-4 w-4" />
            .srt
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={clearTranscript}
            disabled={!hasTranscript || busy}
            title="文字起こしをすべて消して新規に開始"
          >
            <Trash2 className="h-4 w-4" />
            新規
          </Button>
          {viewingHistory && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void deleteHistoryEntry(viewingHistory.id)}
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
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            録音全体を通しで読み直して精度を上げています… <span className="font-mono">{refineProgress ?? 0}%</span>
          </p>
          {/* Minutes-long on a long meeting, so a determinate bar rather than a
              spinner: the user needs to see it is advancing, not just spinning. */}
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-foreground transition-[width] duration-300"
              style={{ width: `${Math.min(100, Math.max(0, refineProgress ?? 0))}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            完了すると下の文字起こしが差し替わります。今の内容もそのまま使えます。
          </p>
        </div>
      )}

      {refineNotice && <p className="text-xs text-amber">{refineNotice}</p>}

      <div className="min-h-32 flex-1 whitespace-pre-wrap rounded-md bg-muted p-3 text-sm text-foreground">
        {hasTranscript
          ? text
          : recordingStatus === "processing"
            ? "文字起こし中..."
            : "録音を開始すると、ここに文字起こし結果が表示されます。"}
        {hasTranscript && recordingStatus === "processing" && (
          <span className="text-muted-foreground">{"\n"}文字起こし中...</span>
        )}
      </div>
    </div>
  );
}
