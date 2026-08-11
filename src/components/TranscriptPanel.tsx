import { useState } from "react";
import { Copy, Download, Check, Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import { useAppStore } from "../store/appStore";
import { combinedText } from "../lib/transcript";
import { saveTranscript } from "../lib/export/saveTranscript";

export function TranscriptPanel() {
  const segments = useAppStore((s) => s.segments);
  const recordingStatus = useAppStore((s) => s.recordingStatus);
  const clearTranscript = useAppStore((s) => s.clearTranscript);
  const [copied, setCopied] = useState(false);

  const hasTranscript = segments.length > 0;
  const text = combinedText(segments);

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
            disabled={!hasTranscript || recordingStatus === "recording" || recordingStatus === "processing"}
            title="文字起こしをすべて消して新規に開始"
          >
            <Trash2 className="h-4 w-4" />
            新規
          </Button>
        </div>
      </div>
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
