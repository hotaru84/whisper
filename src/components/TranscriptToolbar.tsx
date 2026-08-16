import {
  ChevronDown,
  Copy,
  Download,
  Check,
  Trash2,
  RotateCw,
  XCircle,
} from "lucide-react";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { useConfirmClick } from "./useConfirmClick";

/**
 * Deleting a recording is the same operation the history sidebar's row button
 * performs, so it asks the same way: the first click only arms the button.
 * Its own component rather than an inline branch because the hook cannot be
 * called from a conditionally rendered position -- and being keyed on the
 * recording's id, switching to a different history entry disarms it.
 */
function DeleteHistoryButton({
  onClick: onDelete,
  disabled,
}: {
  onClick: () => void;
  disabled: boolean;
}) {
  const { confirming, onClick } = useConfirmClick(onDelete);
  return (
    <Button
      type="button"
      variant={confirming ? "destructive" : "outline"}
      size="sm"
      onClick={onClick}
      disabled={disabled}
      title="この録音履歴を削除"
    >
      <Trash2 className="h-4 w-4" />
      {confirming ? "本当に削除?" : "削除"}
    </Button>
  );
}

/**
 * The transcript's action row: copy/export, and the two history-only actions
 * (reanalyze, delete) that only make sense once there is a recording behind
 * what's on screen. `reanalyze`/`deleteHistory` are left `undefined` by the
 * caller (`TranscriptPanel`) exactly when that recording doesn't exist yet --
 * a plain presentational split, so this component never has to know why a
 * button might not apply.
 *
 * `reanalyze.mode` doubles this one button as the accuracy pass's cancel
 * control: while the recording currently on screen is the one being
 * refined, `TranscriptPanel` switches it to `"cancel"` instead of rendering
 * a separate cancel button next to it -- there is only ever one thing to do
 * with this button at a time, so there is no need for two.
 */
export function TranscriptToolbar({
  hasTranscript,
  copied,
  onCopy,
  onExport,
  reanalyze,
  deleteHistory,
}: {
  hasTranscript: boolean;
  copied: boolean;
  onCopy: () => void;
  onExport: (format: "txt" | "srt") => void;
  reanalyze?: {
    mode: "reanalyze" | "cancel";
    onClick: () => void;
    disabled: boolean;
  };
  deleteHistory?: { id: string; onClick: () => void; disabled: boolean };
}) {
  return (
    <div className="flex justify-end gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!hasTranscript}
          >
            {copied ? (
              <Check className="h-4 w-4" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            保存
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onCopy}>
            <Copy className="h-4 w-4" />
            コピー
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onExport("txt")}>
            <Download className="h-4 w-4" />
            .txt として保存
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onExport("srt")}>
            <Download className="h-4 w-4" />
            .srt として保存
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {reanalyze &&
        (reanalyze.mode === "cancel" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={reanalyze.onClick}
            disabled={reanalyze.disabled}
            title="解析を中止します。すでに表示されている文字起こしと録音ファイルはそのまま残ります"
          >
            <XCircle className="h-4 w-4" />
            解析中止
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={reanalyze.onClick}
            disabled={reanalyze.disabled}
            title="現在の設定（話者分離・VAD・音響イベント）でこの録音を詳しく解析し直し、履歴を上書きします"
          >
            <RotateCw className="h-4 w-4" />
            再解析
          </Button>
        ))}
      {deleteHistory && (
        <DeleteHistoryButton
          key={deleteHistory.id}
          onClick={deleteHistory.onClick}
          disabled={deleteHistory.disabled}
        />
      )}
    </div>
  );
}
