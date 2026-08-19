import { Mic, Square, Pause, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import { useAppStore, selectCapabilities, effectiveRecordOnly } from "../store/appStore";
import { cn } from "../lib/utils";

/** Both buttons are the same circle, so the pair reads as one control rather
 * than a big button with a stray secondary bolted on. Emphasis comes from the
 * fill, not the size.
 *
 * "hero" is the button as the panel's whole content (nothing recorded yet);
 * "fab" is the same control floating over a transcript, slightly smaller and
 * lifted off the surface so it reads as being *above* the content rather than
 * part of it. */
const CIRCLE = {
  hero: "h-16 w-16 rounded-full p-0",
  fab: "h-14 w-14 rounded-full p-0 shadow-lg",
} as const;

/**
 * The record transport, one matched pair of circular buttons.
 *
 * The primary button changes role with `recordingPhase` (start → pause →
 * resume) and carries the `--signal` red fill whenever a take is in progress,
 * so "a recording exists right now" is legible at a glance in both the
 * recording and paused states. The pulse is what separates them: live pulses,
 * paused is static.
 *
 * `placement` only sizes the circles. An open take always renders the pair at
 * "hero" size regardless (App never asks for a FAB while one is in progress),
 * so in practice only the start button is ever drawn as a FAB.
 */
export function RecordButton({ placement = "hero" }: { placement?: keyof typeof CIRCLE }) {
  const circle = CIRCLE[placement];
  const recordingPhase = useAppStore((s) => s.recordingPhase);
  // Only the brief WAV-close/provisional-filing window after stop, not
  // whatever background analysis follows -- that runs independently now (see
  // `recordingCloseOutPhase`'s own doc comment in appStore.ts), so it must
  // never make this button look busy or disabled.
  const recordingCloseOutPhase = useAppStore((s) => s.recordingCloseOutPhase);
  const modelStatus = useAppStore((s) => s.modelStatus);
  const startRecording = useAppStore((s) => s.startRecording);
  const stopRecording = useAppStore((s) => s.stopRecording);
  const pauseRecording = useAppStore((s) => s.pauseRecording);
  const resumeRecording = useAppStore((s) => s.resumeRecording);
  const recordOnly = useAppStore((s) => effectiveRecordOnly(s.recordingMode, s.powerSource));
  const autoSaveSettings = useAppStore((s) => s.autoSaveSettings);
  const directoryConfigured = autoSaveSettings.directory !== "";
  const can = selectCapabilities({ recordingPhase, modelStatus, recordOnly, directoryConfigured });

  if (recordingPhase === "stopped") {
    const busy = recordingCloseOutPhase !== null;
    const label = busy ? "処理中です" : !directoryConfigured ? "保存先フォルダを設定してください" : "録音を開始";
    return (
      <Button
        type="button"
        size="lg"
        // `busy` isn't part of `can.startRecording` (see
        // `recordingCloseOutPhase`'s doc comment in appStore.ts -- background
        // analysis must never disable this button), but the brief closeout
        // window it also covers is a real, if short-lived, block on the
        // `startRecording` action itself, so the button must say so too.
        disabled={!can.startRecording || busy}
        onClick={() => void startRecording()}
        className={circle}
        aria-label={label}
        title={label}
      >
        {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : <Mic className="h-6 w-6" />}
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
          circle,
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
        className={circle}
        aria-label="停止して保存"
        title="停止して保存"
      >
        <Square className="h-6 w-6" />
      </Button>
    </div>
  );
}
