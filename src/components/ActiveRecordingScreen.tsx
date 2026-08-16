import { Loader2 } from "lucide-react";
import { RecordButton } from "./RecordButton";
import { LevelMeter } from "./LevelMeter";
import { TranscriptPanel } from "./TranscriptPanel";
import { ThemeToggle } from "./ThemeToggle";

/**
 * The Active screen: what replaces the whole Home layout (sidebar included --
 * see `App.tsx`) for as long as a take is open. Two sub-states, both gated on
 * `starting`:
 *
 * - `starting`: between the record press and `recordingPhase` actually
 *   becoming `"recording"` (`AppState.startingRecording`) -- there is
 *   nothing to transport yet, only device/capture setup happening off
 *   screen, so this shows a plain indeterminate wait rather than a
 *   transport with nothing live behind it.
 * - otherwise (`recording`/`paused`): the normal transport.
 *
 * `ThemeToggle` is repeated here because it otherwise has no way to be
 * reached during a take at all: its only other home is the history
 * sidebar's footer, and the sidebar doesn't exist on this screen.
 */
export function ActiveRecordingScreen({ starting }: { starting: boolean }) {
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4">
      <div className="flex shrink-0 justify-end">
        <ThemeToggle />
      </div>

      {starting ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">マイクを準備しています…</p>
        </div>
      ) : (
        <>
          <div className="flex shrink-0 flex-col items-center gap-3">
            <RecordButton />
            <div className="w-full max-w-sm">
              <LevelMeter />
            </div>
          </div>
          <TranscriptPanel />
        </>
      )}
    </main>
  );
}
