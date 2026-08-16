import { XCircle } from "lucide-react";
import { useAppStore, selectCapabilities } from "../store/appStore";
import { Button } from "./ui/button";

/**
 * Stops the accuracy pass (the second transcription, plus diarization and
 * audio tagging) partway through.
 *
 * Rendered in two places -- the titlebar status readout, which is visible no
 * matter where the user has scrolled, and next to the transcript panel's
 * explanation of what the pass is doing, which is where the question "how long
 * is this going to take" actually gets asked. Same action either way, so it
 * lives here rather than being written twice.
 *
 * Visibility is entirely `can.cancelAnalysis` (`processing === "refining"`):
 * the button disappears the moment it is pressed, because pressing it moves
 * the phase to `cancelling`. Nothing here has to track "already asked".
 */
export function CancelAnalysisButton({ className }: { className?: string }) {
  const cancelAnalysis = useAppStore((s) => s.cancelAnalysis);
  const can = selectCapabilities({
    recordingPhase: useAppStore((s) => s.recordingPhase),
    processing: useAppStore((s) => s.processing),
    modelStatus: useAppStore((s) => s.modelStatus),
    recordOnly: useAppStore((s) => s.recordingMode.recordOnly),
  });

  if (!can.cancelAnalysis) return null;

  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      onClick={() => void cancelAnalysis()}
      className={className}
      title="解析を中止します。すでに表示されている文字起こしと録音ファイルはそのまま残ります"
    >
      <XCircle className="h-3 w-3" />
      キャンセル
    </Button>
  );
}
