import { Mic, Square, Pause, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import { useAppStore, selectCapabilities } from "../store/appStore";
import { cn } from "../lib/utils";

/** Both buttons are the same circle, so the pair reads as one control rather
 * than a big button with a stray secondary bolted on. Emphasis comes from the
 * fill, not the size. */
const CIRCLE = "h-16 w-16 rounded-full p-0";

/**
 * The record transport, one matched pair of circular buttons.
 *
 * The primary button changes role with `recordingPhase` (start → pause →
 * resume) and carries the `--signal` red fill whenever a take is in progress,
 * so "a recording exists right now" is legible at a glance in both the
 * recording and paused states. The pulse is what separates them: live pulses,
 * paused is static.
 */
export function RecordButton() {
  const recordingPhase = useAppStore((s) => s.recordingPhase);
  const processing = useAppStore((s) => s.processing);
  const modelStatus = useAppStore((s) => s.modelStatus);
  const startRecording = useAppStore((s) => s.startRecording);
  const stopRecording = useAppStore((s) => s.stopRecording);
  const pauseRecording = useAppStore((s) => s.pauseRecording);
  const resumeRecording = useAppStore((s) => s.resumeRecording);
  const can = selectCapabilities({ recordingPhase, processing, modelStatus });

  if (recordingPhase === "stopped") {
    const label = processing !== null ? "処理中です" : "録音を開始";
    return (
      <Button
        type="button"
        size="lg"
        disabled={!can.startRecording}
        onClick={() => void startRecording()}
        className={CIRCLE}
        aria-label={label}
        title={label}
      >
        {processing !== null ? <Loader2 className="h-6 w-6 animate-spin" /> : <Mic className="h-6 w-6" />}
      </Button>
    );
  }

  const paused = recordingPhase === "paused";
  const primaryLabel = paused ? "録音を再開" : "一時停止";

  return (
    <div className="flex items-center gap-4">
      <Button
        type="button"
        size="lg"
        onClick={() => (paused ? resumeRecording() : void pauseRecording())}
        // The `destructive` variant is a subtle tint meant for delete buttons;
        // the transport's primary gets the app's full --signal red instead,
        // the same fill the recording indicator uses.
        className={cn(
          CIRCLE,
          "bg-signal text-white hover:bg-signal/90",
          !paused && "animate-pulse motion-reduce:animate-none",
        )}
        aria-label={primaryLabel}
        title={primaryLabel}
      >
        {paused ? <Mic className="h-6 w-6" /> : <Pause className="h-6 w-6" />}
      </Button>

      <Button
        type="button"
        size="lg"
        variant="outline"
        onClick={() => void stopRecording()}
        className={CIRCLE}
        aria-label="停止して保存"
        title="停止して保存"
      >
        <Square className="h-6 w-6" />
      </Button>
    </div>
  );
}
