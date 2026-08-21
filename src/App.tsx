import { useEffect, useRef } from "react";
import { TitleBar } from "./components/TitleBar";
import { HistorySidebar } from "./components/HistorySidebar";
import { ModelLoadingOverlay } from "./components/ModelLoadingOverlay";
import { RecordStartPanel } from "./components/RecordStartPanel";
import { ActiveRecordingScreen } from "./components/ActiveRecordingScreen";
import { RecordingTimeline } from "./components/RecordingTimeline";
import { TranscriptPanel } from "./components/TranscriptPanel";
import { TooltipProvider } from "./components/ui/tooltip";
import { useAppStore, effectiveRecordOnly, debugTranscribeUrl, debugStreamTranscribeUrl } from "./store/appStore";

/** Drag-to-resize for the history sidebar. The sidebar is the flex row's
 * first child starting at the window's left edge, so the pointer's own
 * clientX already *is* the desired width -- no extra offset bookkeeping
 * needed. Width is only persisted on release, not on every pointermove, so
 * dragging doesn't spam localStorage. */
function useSidebarDrag(): (e: React.PointerEvent) => void {
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const persistSidebarSettings = useAppStore((s) => s.persistSidebarSettings);
  const draggingRef = useRef(false);

  return (e: React.PointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    // Without this, dragging across the transcript panel selects its text
    // instead of (or in addition to) resizing -- preventDefault on the
    // handle's own pointerdown does not stop the browser's separate
    // text-selection heuristic once the pointer moves over selectable text
    // elsewhere in the window. Restored on release.
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      setSidebarWidth(ev.clientX);
    };
    const onUp = () => {
      draggingRef.current = false;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      persistSidebarSettings();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
}

function App() {
  const initModel = useAppStore((s) => s.initModel);
  const refreshAudioInputDevices = useAppStore((s) => s.refreshAudioInputDevices);
  const refreshRecordingHistory = useAppStore((s) => s.refreshRecordingHistory);
  const recoverInterruptedRecordings = useAppStore((s) => s.recoverInterruptedRecordings);
  const errorMessage = useAppStore((s) => s.errorMessage);
  const sidebar = useAppStore((s) => s.sidebar);
  const recordingPhase = useAppStore((s) => s.recordingPhase);
  const startingRecording = useAppStore((s) => s.startingRecording);
  const recordingCloseOutPhase = useAppStore((s) => s.recordingCloseOutPhase);
  const segmentCount = useAppStore((s) => s.segments.length);
  const playbackRecordingId = useAppStore((s) => s.playback.recordingId);
  const onDragHandleDown = useSidebarDrag();

  // The Active screen (record transport, no sidebar) replaces the whole Home
  // layout for as long as a take is open -- including the async setup window
  // before `recordingPhase` itself has flipped away from "stopped" (see
  // `startingRecording`'s own doc comment in appStore.ts). This is the one
  // discriminant every top-level branch below keys off.
  const isActive = recordingPhase !== "stopped" || startingRecording;
  // Home only: nothing recorded and nothing selected, so the record-start CTA
  // owns the whole panel instead of sitting above an empty transcript box.
  // Note this is *not* the same as "no recording currently viewed"
  // (`viewedRecordingId == null`) -- that field only catches up to a
  // just-finished take once its post-stop pipeline resolves (see
  // `markRecordingViewed`), so checking it here instead would flash the CTA
  // back in for the gap while `segments`/`playback.recordingId` are already
  // populated but the entry isn't "viewed" yet. `recordingCloseOutPhase`
  // (not background analysis, which runs independently -- see its own doc
  // comment in appStore.ts) covers the same brief closeout gap for a
  // record-only take that ends up with nothing transcribed and no playback
  // loaded yet.
  const showRecordStart =
    !isActive && recordingCloseOutPhase === null && segmentCount === 0 && playbackRecordingId == null;

  useEffect(() => {
    // Skipped entirely in (effective) record-only mode -- loading the model is
    // the cost that mode exists to avoid, and nothing in a record-only session
    // needs it. `rerunHistoryEntry` loads it on demand if the user asks for an
    // analysis later, and switching away from this mode loads it right away
    // (`setRecordingMode`/`setPowerSource`). In auto mode this reads whatever
    // `powerSource` happens to be at this exact tick -- "unknown" (before the
    // first battery reading lands) resolves to the analyzed take, same safe
    // default as everywhere else `effectiveRecordOnly` is read.
    const { recordingMode, powerSource } = useAppStore.getState();
    if (!effectiveRecordOnly(recordingMode, powerSource)) void initModel();
    // Listable (with placeholder labels) even before microphone permission is
    // granted, so the settings dropdown isn't empty on a first visit.
    void refreshAudioInputDevices();
    void refreshRecordingHistory();
    // Startup is the only safe moment for this (a live take's WAV looks the
    // same on disk), and it refreshes the list itself when it finds anything.
    void recoverInterruptedRecordings();
    // Dev diagnostic hooks: window.__debugTranscribe(url, overrides) and
    // window.__store for inspecting/driving the zustand store from the console.
    Object.assign(window as unknown as Record<string, unknown>, {
      __debugTranscribe: debugTranscribeUrl,
      __debugStreamTranscribe: debugStreamTranscribeUrl,
      __store: useAppStore,
    });
  }, [initModel, refreshAudioInputDevices, refreshRecordingHistory, recoverInterruptedRecordings]);

  return (
    <TooltipProvider>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
        <TitleBar />
        <ModelLoadingOverlay />
        <div className="flex flex-1 overflow-hidden">
          {isActive ? (
            // No sidebar at all here, not even a hidden one: switching
            // recordings mid-take makes no sense, so there is nothing for it
            // to do on this screen -- see design.md's rationale for hiding
            // rather than collapsing to a rail.
            <ActiveRecordingScreen starting={startingRecording && recordingPhase === "stopped"} />
          ) : (
            <>
              {/* Always shown on Home -- no manual visibility toggle any more
                  (see TitleBarControls.tsx's doc comment); the automatic
                  Home/Active split already covers what that toggle was for. */}
              <HistorySidebar width={sidebar.width} />
              {/* The divider and the thing you grab to move it are the same
                  element: -mx-2 takes the handle out of the layout entirely
                  (zero width contributed), so its 16px hit area straddles the
                  line it draws instead of sitting beside it. A 1px-wide click
                  target is unusable with a real cursor, hence the hit area
                  being much wider than what's drawn. */}
              <div
                onPointerDown={onDragHandleDown}
                role="separator"
                aria-orientation="vertical"
                aria-label="履歴パネルの幅を調整"
                className="group relative z-20 -mx-2 flex w-4 shrink-0 cursor-col-resize touch-none items-stretch justify-center"
              >
                <div className="w-px bg-sidebar-border transition-[width,background-color] group-hover:w-0.5 group-hover:bg-ring group-active:bg-ring" />
              </div>
              {/* overflow-hidden + min-h-0 (rather than overflow-y-auto) so this
                  column itself never scrolls -- only TranscriptPanel's own
                  transcript list does. Everything else here (the error banner,
                  timeline) is shrink-0 fixed content; TranscriptPanel is the
                  sole flex-1 min-h-0 child that absorbs the remaining height
                  and hands it to its internal ScrollArea. */}
              <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4">
                {errorMessage && (
                  <p className="shrink-0 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                    {errorMessage}
                  </p>
                )}

                {showRecordStart ? (
                  <RecordStartPanel />
                ) : (
                  <>
                    <RecordingTimeline />
                    <TranscriptPanel />
                  </>
                )}
              </main>
            </>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

export default App;
