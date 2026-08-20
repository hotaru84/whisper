import {
  Copy,
  Check,
  FolderOpen,
  Trash2,
  Wand2,
  XCircle,
} from "lucide-react";
import { Button } from "./ui/button";
import { useConfirmClick } from "./useConfirmClick";
import { useMockBackend } from "../lib/env";
import { MOCK_NATIVE_FEATURE_UNAVAILABLE } from "../lib/mock/fixtures";

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
 * The transcript's action row: copy (always available once there's text),
 * and three history-only actions (open folder, analyze, delete) that only
 * make sense once there is a recording behind what's on screen.
 * `openFolder`/`analyze`/`deleteHistory` are left `undefined` by the
 * caller (`TranscriptPanel`) exactly when that recording doesn't exist yet --
 * a plain presentational split, so this component never has to know why a
 * button might not apply. WAV/transcript files themselves are written
 * automatically (see `AutoSaveSettings`), so there is no manual save/export
 * button here any more.
 *
 * `analyze.mode` mirrors the history sidebar's own per-row quick action
 * (`analysisAction` in `lib/history.ts`): `"start"` for a take never
 * analyzed, `"resume"` for one whose post-hoc pass was cancelled partway
 * through, and `"cancel"` while the recording currently on screen is the one
 * being analyzed right now -- `TranscriptPanel` switches to that mode
 * instead of rendering a separate cancel button next to it. Once analysis
 * has fully completed, `TranscriptPanel` passes `undefined` here: analysis
 * is one-shot, there is no re-running it.
 */
export function TranscriptToolbar({
  hasTranscript,
  copied,
  onCopy,
  openFolder,
  analyze,
  deleteHistory,
}: {
  hasTranscript: boolean;
  copied: boolean;
  onCopy: () => void;
  /** Undefined exactly when there is no recording behind what's on screen
   * yet to open a folder for -- same condition `analyze`/`deleteHistory`
   * use, see this component's own doc comment. */
  openFolder?: { onClick: () => void; disabled: boolean };
  analyze?: {
    mode: "start" | "resume" | "cancel";
    onClick: () => void;
    disabled: boolean;
  };
  deleteHistory?: { id: string; onClick: () => void; disabled: boolean };
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onCopy}
        disabled={!hasTranscript}
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        コピー
      </Button>
      {openFolder && (
        // Needs a native file manager, which a plain browser tab does not
        // have -- disabled rather than silently doing nothing in the browser
        // preview. See lib/env.ts.
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={openFolder.onClick}
          disabled={openFolder.disabled || useMockBackend}
          title={useMockBackend ? MOCK_NATIVE_FEATURE_UNAVAILABLE : "この録音が保存されているフォルダを開きます"}
        >
          <FolderOpen className="h-4 w-4" />
          フォルダを開く
        </Button>
      )}
      {analyze &&
        (analyze.mode === "cancel" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={analyze.onClick}
            disabled={analyze.disabled}
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
            onClick={analyze.onClick}
            disabled={analyze.disabled}
            title={
              analyze.mode === "resume"
                ? "前回の続きから解析を再開します（音声認識モデルの読み込みが必要な場合があります）"
                : "この録音を文字起こしします（音声認識モデルの読み込みが必要な場合があります）"
            }
          >
            <Wand2 className="h-4 w-4" />
            {analyze.mode === "resume" ? "続きを解析" : "解析"}
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
