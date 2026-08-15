import { useEffect, useRef } from "react";
import { TitleBar } from "./components/TitleBar";
import { StatusBar } from "./components/StatusBar";
import { HistorySidebar } from "./components/HistorySidebar";
import { ModelLoadingOverlay } from "./components/ModelLoadingOverlay";
import { RecordButton } from "./components/RecordButton";
import { LevelMeter } from "./components/LevelMeter";
import { RecordingTimeline } from "./components/RecordingTimeline";
import { TranscriptPanel } from "./components/TranscriptPanel";
import { TooltipProvider } from "./components/ui/tooltip";
import { useAppStore, debugTranscribeUrl, debugStreamTranscribeUrl } from "./store/appStore";

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
  const refreshAppAudioApps = useAppStore((s) => s.refreshAppAudioApps);
  const refreshRecordingHistory = useAppStore((s) => s.refreshRecordingHistory);
  const errorMessage = useAppStore((s) => s.errorMessage);
  const sidebar = useAppStore((s) => s.sidebar);
  const recordingPhase = useAppStore((s) => s.recordingPhase);
  const processing = useAppStore((s) => s.processing);
  const segmentCount = useAppStore((s) => s.segments.length);
  const playbackRecordingId = useAppStore((s) => s.playback.recordingId);
  const onDragHandleDown = useSidebarDrag();

  // A take is open (recording or paused). Both keep the transport as a centered
  // pair with the level meter under it -- pausing does not end the take, so the
  // layout should not change out from under the user mid-recording.
  const takeOpen = recordingPhase !== "stopped";
  // Nothing to show on the right at all: no transcript, no loaded audio, no
  // pass running. Only then does the record button become the panel's whole
  // content. Note this is *not* the same as "no history entry selected" --
  // `selectedHistoryId` stays null right after a recording finishes, but by
  // then `segments` and/or `playback.recordingId` are populated.
  const idleEmpty = !takeOpen && processing === null && segmentCount === 0 && playbackRecordingId == null;

  useEffect(() => {
    // Skipped entirely in record-only mode -- loading the model is the cost
    // that mode exists to avoid, and nothing in a record-only session needs
    // it. `rerunHistoryEntry` loads it on demand if the user asks for an
    // analysis later, and leaving the mode loads it right away
    // (`updateRecordingMode`).
    if (!useAppStore.getState().recordingMode.recordOnly) void initModel();
    // Listable (with placeholder labels) even before microphone permission is
    // granted, so the settings dropdown isn't empty on a first visit.
    void refreshAudioInputDevices();
    // Toolbar dropdown also refreshes itself on open (see StatusBar.tsx), but
    // this fills it in for the case where the user never opens it before
    // hitting record with a target already in mind.
    void refreshAppAudioApps();
    void refreshRecordingHistory();
    // Dev diagnostic hooks: window.__debugTranscribe(url, overrides) and
    // window.__store for inspecting/driving the zustand store from the console.
    Object.assign(window as unknown as Record<string, unknown>, {
      __debugTranscribe: debugTranscribeUrl,
      __debugStreamTranscribe: debugStreamTranscribeUrl,
      __store: useAppStore,
    });
  }, [initModel, refreshAudioInputDevices, refreshAppAudioApps, refreshRecordingHistory]);

  return (
    <TooltipProvider>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
        <TitleBar />
        <ModelLoadingOverlay />
        <StatusBar />
        <div className="flex flex-1 overflow-hidden">
          {sidebar.visible && (
            <>
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
            </>
          )}
          {/* overflow-hidden + min-h-0 (rather than overflow-y-auto) so this
              column itself never scrolls -- only TranscriptPanel's own
              transcript list does. Everything else here (the error banner,
              record button, timeline) is shrink-0 fixed content; TranscriptPanel
              is the sole flex-1 min-h-0 child that absorbs the remaining
              height and hands it to its internal ScrollArea. `relative` is the
              positioning context for the FAB below. */}
          <main className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4">
            {errorMessage && (
              <p className="shrink-0 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{errorMessage}</p>
            )}

            {idleEmpty ? (
              // Nothing recorded and nothing selected: the one thing that can
              // be done here owns the panel, instead of a big button sitting
              // above an empty transcript box saying the same thing.
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
                <RecordButton />
                <p className="text-sm text-muted-foreground">
                  録音を開始すると、ここに文字起こし結果が表示されます。
                </p>
              </div>
            ) : (
              <>
                {takeOpen && (
                  <div className="flex shrink-0 flex-col items-center gap-3">
                    <RecordButton />
                    <div className="w-full max-w-sm">
                      <LevelMeter />
                    </div>
                  </div>
                )}

                <RecordingTimeline />
                <TranscriptPanel />

                {/* Stopped with something on screen: the transcript is what the
                    user came for, so the transport shrinks to a FAB rather than
                    holding a full row at the top. right-8 clears the transcript
                    panel's own scrollbar; z-20 keeps it under the loading
                    overlay (z-40), dialogs (z-50) and the titlebar (z-[60]).
                    The level meter is dropped here -- with no take open it
                    would only ever draw silence. */}
                {!takeOpen && (
                  <div className="absolute right-8 bottom-6 z-20">
                    <RecordButton placement="fab" />
                  </div>
                )}
              </>
            )}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}

export default App;
