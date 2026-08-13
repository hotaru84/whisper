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
  const [copied, setCopied] = useState(false);

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
    <div className="flex w-full flex-1 flex-col gap-3 rounded-lg border border-neutral-200 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-700">文字起こし結果</h2>
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
        </div>
      </div>
      {isRefining && (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-neutral-600">
            録音全体を通しで読み直して精度を上げています… {refineProgress ?? 0}%
          </p>
          {/* Minutes-long on a long meeting, so a determinate bar rather than a
              spinner: the user needs to see it is advancing, not just spinning. */}
          <div className="h-1 w-full overflow-hidden rounded-full bg-neutral-200">
            <div
              className="h-full bg-neutral-700 transition-[width] duration-300"
              style={{ width: `${Math.min(100, Math.max(0, refineProgress ?? 0))}%` }}
            />
          </div>
          <p className="text-xs text-neutral-400">
            完了すると下の文字起こしが差し替わります。今の内容もそのまま使えます。
          </p>
        </div>
      )}

      {refineNotice && <p className="text-xs text-amber-700">{refineNotice}</p>}

      <div className="min-h-32 flex-1 whitespace-pre-wrap rounded-md bg-neutral-50 p-3 text-sm text-neutral-800">
        {hasTranscript
          ? text
          : recordingStatus === "processing"
            ? "文字起こし中..."
            : "録音を開始すると、ここに文字起こし結果が表示されます。"}
        {hasTranscript && recordingStatus === "processing" && (
          <span className="text-neutral-400">{"\n"}文字起こし中...</span>
        )}
      </div>
    </div>
  );
}
