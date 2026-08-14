import { useEffect, useRef, useState } from "react";
import { TitleBar } from "./components/TitleBar";
import { StatusBar } from "./components/StatusBar";
import { HistorySidebar } from "./components/HistorySidebar";
import { ModelLoadingOverlay } from "./components/ModelLoadingOverlay";
import { RecordButton } from "./components/RecordButton";
import { LevelMeter } from "./components/LevelMeter";
import { RecordingTimeline } from "./components/RecordingTimeline";
import { TranscriptTabs } from "./components/TranscriptTabs";
import { TooltipProvider } from "./components/ui/tooltip";
import { useAppStore, debugTranscribeUrl, debugStreamTranscribeUrl } from "./store/appStore";

const SIDEBAR_WIDTH_KEY = "sidebar-width";
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 420;
const DEFAULT_SIDEBAR_WIDTH = 224;

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function loadSidebarWidth(): number {
  try {
    const stored = globalThis.localStorage?.getItem(SIDEBAR_WIDTH_KEY);
    const width = stored ? Number(stored) : NaN;
    return Number.isFinite(width) ? clampSidebarWidth(width) : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

/** Drag-to-resize for the history sidebar. The sidebar is the flex row's
 * first child starting at the window's left edge, so the pointer's own
 * clientX already *is* the desired width -- no extra offset bookkeeping
 * needed. Width is only persisted on release, not on every pointermove, so
 * dragging doesn't spam localStorage. */
function useSidebarWidth(): { width: number; onDragHandleDown: (e: React.PointerEvent) => void } {
  const [width, setWidth] = useState(loadSidebarWidth);
  const draggingRef = useRef(false);

  const onDragHandleDown = (e: React.PointerEvent) => {
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
      setWidth(clampSidebarWidth(ev.clientX));
    };
    const onUp = () => {
      draggingRef.current = false;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setWidth((current) => {
        try {
          globalThis.localStorage?.setItem(SIDEBAR_WIDTH_KEY, String(current));
        } catch {
          // Persistence is a convenience; losing it is not worth surfacing an error.
        }
        return current;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return { width, onDragHandleDown };
}

function App() {
  const initModel = useAppStore((s) => s.initModel);
  const refreshAudioInputDevices = useAppStore((s) => s.refreshAudioInputDevices);
  const refreshAppAudioApps = useAppStore((s) => s.refreshAppAudioApps);
  const refreshRecordingHistory = useAppStore((s) => s.refreshRecordingHistory);
  const errorMessage = useAppStore((s) => s.errorMessage);
  const { width: sidebarWidth, onDragHandleDown } = useSidebarWidth();

  useEffect(() => {
    void initModel();
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
          <HistorySidebar width={sidebarWidth} />
          {/* w-1.5 visual line inside a wider w-2.5 hit target -- a 4px-wide
              click target is uncomfortably thin for a real cursor (verified
              by hand: easy to miss and select the transcript text behind it
              instead), so the interactive area is wider than what's drawn. */}
          <div
            onPointerDown={onDragHandleDown}
            role="separator"
            aria-orientation="vertical"
            aria-label="履歴パネルの幅を調整"
            className="group flex w-4 shrink-0 cursor-col-resize touch-none items-stretch justify-center"
          >
            <div className="w-1 bg-transparent transition-colors group-hover:bg-border group-active:bg-border" />
          </div>
          <main className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
            {errorMessage && (
              <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{errorMessage}</p>
            )}

            <div className="flex flex-col items-center gap-3">
              <RecordButton />
              <div className="w-full max-w-sm">
                <LevelMeter />
              </div>
            </div>

            <RecordingTimeline />
            <TranscriptTabs />
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}

export default App;
