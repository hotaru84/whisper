import { ArrowLeft } from "lucide-react";
import { Button } from "./ui/button";
import { useAppStore } from "../store/appStore";

/**
 * Left cluster of the titlebar. Used to also carry the mic/app-audio/
 * record-only controls (moved to `RecordStartPanel.tsx`) and a manual
 * sidebar visibility toggle (removed -- the sidebar's automatic Home/Active
 * show/hide, per `App.tsx`, already covers what that toggle was for, and a
 * manual override on top of it would just be one more piece of state to
 * keep in sync with it).
 *
 * What's here now is a single "戻る" (back to Home) button, shown only while
 * Home is displaying a selected or just-finished recording -- there's
 * nothing to go back *from* on Home's own empty/CTA state, so it stays
 * hidden there and on the Active screen (`App.tsx` unmounts this component
 * entirely then). This is the same `deselectHistoryEntry()` call
 * `TranscriptPanel`'s row-reclick shortcut already made, just given a
 * far more visible, always-in-the-same-place home in the titlebar instead
 * of a small icon easy to miss inside the panel.
 */
export function TitleBarControls() {
  const recordingPhase = useAppStore((s) => s.recordingPhase);
  const processing = useAppStore((s) => s.processing);
  const segmentCount = useAppStore((s) => s.segments.length);
  const playbackRecordingId = useAppStore((s) => s.playback.recordingId);
  const deselectHistoryEntry = useAppStore((s) => s.deselectHistoryEntry);

  if (recordingPhase !== "stopped") return null;

  // Mirrors App.tsx's `showRecordStart` (Home's empty/CTA state) -- see its
  // own doc comment for why these three fields rather than
  // `viewedRecordingId`. Inverted here: this button is the complement of
  // that state.
  const showingSomething = !(processing === null && segmentCount === 0 && playbackRecordingId == null);
  if (!showingSomething) return null;

  return (
    <div className="flex items-center gap-0.5">
      <Button type="button" variant="ghost" size="sm" onClick={deselectHistoryEntry}>
        <ArrowLeft className="h-4 w-4" />
        戻る
      </Button>
    </div>
  );
}
