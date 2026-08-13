import { useEffect } from "react";
import { TitleBar } from "./components/TitleBar";
import { StatusBar } from "./components/StatusBar";
import { HistorySidebar } from "./components/HistorySidebar";
import { ModelLoadingOverlay } from "./components/ModelLoadingOverlay";
import { RecordButton } from "./components/RecordButton";
import { LevelMeter } from "./components/LevelMeter";
import { TranscriptPanel } from "./components/TranscriptPanel";
import { AudioEventPanel } from "./components/AudioEventPanel";
import { TooltipProvider } from "./components/ui/tooltip";
import { useAppStore, debugTranscribeUrl, debugStreamTranscribeUrl } from "./store/appStore";

function App() {
  const initModel = useAppStore((s) => s.initModel);
  const refreshAudioInputDevices = useAppStore((s) => s.refreshAudioInputDevices);
  const refreshRecordingHistory = useAppStore((s) => s.refreshRecordingHistory);
  const recordingStatus = useAppStore((s) => s.recordingStatus);
  const errorMessage = useAppStore((s) => s.errorMessage);

  useEffect(() => {
    void initModel();
    // Listable (with placeholder labels) even before microphone permission is
    // granted, so the settings dropdown isn't empty on a first visit.
    void refreshAudioInputDevices();
    void refreshRecordingHistory();
    // Dev diagnostic hooks: window.__debugTranscribe(url, overrides) and
    // window.__store for inspecting/driving the zustand store from the console.
    Object.assign(window as unknown as Record<string, unknown>, {
      __debugTranscribe: debugTranscribeUrl,
      __debugStreamTranscribe: debugStreamTranscribeUrl,
      __store: useAppStore,
    });
  }, [initModel, refreshAudioInputDevices, refreshRecordingHistory]);

  return (
    <TooltipProvider>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
        <TitleBar />
        <ModelLoadingOverlay />
        <StatusBar />
        <div className="flex flex-1 overflow-hidden">
          <HistorySidebar />
          <main className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
            {recordingStatus === "error" && errorMessage && (
              <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{errorMessage}</p>
            )}

            <div className="flex flex-col items-center gap-3">
              <RecordButton />
              <div className="w-full max-w-sm">
                <LevelMeter />
              </div>
            </div>

            <TranscriptPanel />
            <AudioEventPanel />
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}

export default App;
