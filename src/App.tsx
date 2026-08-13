import { useEffect } from "react";
import { ModelLoadingOverlay } from "./components/ModelLoadingOverlay";
import { RecordButton } from "./components/RecordButton";
import { LevelMeter } from "./components/LevelMeter";
import { TranscriptPanel } from "./components/TranscriptPanel";
import { AudioEventPanel } from "./components/AudioEventPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { useAppStore, debugTranscribeUrl, debugStreamTranscribeUrl } from "./store/appStore";

function App() {
  const initModel = useAppStore((s) => s.initModel);
  const refreshAudioInputDevices = useAppStore((s) => s.refreshAudioInputDevices);
  const recordingStatus = useAppStore((s) => s.recordingStatus);
  const errorMessage = useAppStore((s) => s.errorMessage);

  useEffect(() => {
    void initModel();
    // Listable (with placeholder labels) even before microphone permission is
    // granted, so the settings dropdown isn't empty on a first visit.
    void refreshAudioInputDevices();
    // Dev diagnostic hooks: window.__debugTranscribe(url, overrides) and
    // window.__store for inspecting/driving the zustand store from the console.
    Object.assign(window as unknown as Record<string, unknown>, {
      __debugTranscribe: debugTranscribeUrl,
      __debugStreamTranscribe: debugStreamTranscribeUrl,
      __store: useAppStore,
    });
  }, [initModel, refreshAudioInputDevices]);

  return (
    <main className="mx-auto flex h-screen max-w-2xl flex-col gap-6 p-6">
      <ModelLoadingOverlay />

      <h1 className="text-lg font-semibold text-neutral-900">WhisperScribe</h1>

      {recordingStatus === "error" && errorMessage && (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-600">{errorMessage}</p>
      )}

      <div className="flex flex-col items-center gap-3">
        <RecordButton />
        <div className="w-full max-w-xs">
          <LevelMeter />
        </div>
      </div>

      <TranscriptPanel />
      <AudioEventPanel />
      <SettingsPanel />
    </main>
  );
}

export default App;
