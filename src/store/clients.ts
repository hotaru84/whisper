/**
 * The two Tauri IPC client singletons the store drives, plus the pieces of
 * global wiring (`onAudioDeviceChange`, `startSleepWatch`, `watchPowerSource`)
 * that reach into the store on their own rather than through a store action.
 * Kept apart from `appStore.ts` so "which external client does this" has one
 * obvious home; the recording lifecycle (`appStore.ts`) and the accuracy
 * pipeline (`recordingPipeline.ts`) both import from here.
 *
 * `useAppStore` is imported for the callbacks below to call, not at module
 * top level -- each callback only runs after the whole module graph
 * (including `appStore.ts`'s own `create()` call) has finished initializing,
 * so this is safe despite `appStore.ts` importing `asrClient`/`appAudioClient`
 * back from here.
 */
import { AsrClient } from "../lib/asr";
import { AppAudioClient, onAudioDeviceChange } from "../lib/audio";
import { startSleepWatch } from "../lib/sleepWatch";
import { watchPowerSource } from "../lib/power";
import { useAppStore } from "./appStore";

// One instance shared by the app-list refresh and the actual capture start/stop:
// listing apps touches neither the Channel nor the error listener the capture
// methods manage, so the two uses never interfere with each other.
export const appAudioClient = new AppAudioClient();

export const asrClient = new AsrClient({
  onModelReady: () => useAppStore.setState({ modelStatus: "ready" }),
  onError: (message) => useAppStore.setState({ modelStatus: "error", errorMessage: message }),
  // `refineProgress` only means anything while `processing === "refining"`
  // (see appStore.ts's field-cluster doc comment) -- this event isn't
  // guaranteed to stop arriving the instant the frontend's own `finally`
  // block resets both to null, so a late/stray one must not resurrect
  // `refineProgress` on its own.
  onRefineProgress: (percent) => {
    if (useAppStore.getState().processing === "refining") {
      useAppStore.setState({ refineProgress: percent });
    }
  },
});

// Keeps the settings dropdown in sync when a microphone is plugged or
// unplugged, without the UI needing to poll for it.
onAudioDeviceChange(() => {
  void useAppStore.getState().refreshAudioInputDevices();
});

// Tells the user when the machine was asleep during a take.
//
// A suspend costs audio without breaking anything visible: no frames are
// captured while the process is frozen, so the recording simply skips that
// stretch and every derived number stays self-consistent (see
// `sleepWatch.ts`). Whether the recorder survives the resume is a separate
// question, handled separately (`handleMicDropout`) -- this notice is about
// the audio that was already missed by the time anything could react.
//
// Only a live take is worth interrupting for. A suspend while idle or while
// browsing history costs nothing, and a notice there would be noise.
startSleepWatch((gapSec) => {
  const { recordingPhase } = useAppStore.getState();
  if (recordingPhase === "stopped") return;
  const minutes = Math.max(1, Math.round(gapSec / 60));
  useAppStore.setState({
    refineNotice: `PC がスリープしていた約 ${minutes} 分間の音声は録音されていません（前後の音声はつながって記録されます）。`,
  });
});

// Feeds `powerSource`, which "自動" recording mode reads to decide record-only
// vs. the normal analyzed take (`capabilities.ts`'s `effectiveRecordOnly`).
// Routed through the `setPowerSource` action rather than a bare `setState`
// (unlike the two wirings above) because auto mode has a side effect the
// store itself owns: warming the model when a live take would no longer need
// to be record-only -- see that action's own doc comment.
watchPowerSource((source) => {
  useAppStore.getState().setPowerSource(source);
});
