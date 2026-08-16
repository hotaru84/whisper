/**
 * The app's state axes and the "what may the user do right now" derivation
 * built on them.
 *
 * Split out of `appStore.ts` (which re-exports all of it, so consumers are
 * unaffected) purely so `selectCapabilities` can be unit-tested: `appStore.ts`
 * pulls in the Tauri IPC client and the whole audio stack at import time,
 * while everything here is plain data with no imports at all. This is the one
 * function in the app whose entire reason for existing is that adding a state
 * must not silently fall through an `===` chain -- so it is also the one most
 * worth an exhaustive test.
 */

/**
 * What the recorder itself is doing -- the app's primary, user-visible state.
 *
 * Deliberately only three values, with the post-stop pipeline (`ProcessingPhase`)
 * and failures (`errorMessage`) kept on their own axes. Folding all three into
 * one enum, as this used to, meant every consumer had to re-derive "is a take
 * in progress" from a different subset of values, and adding a state silently
 * fell through every `===` chain that did not list it.
 */
export type RecordingPhase = "stopped" | "recording" | "paused";

/**
 * The pipeline that runs after a recording stops, orthogonal to `RecordingPhase`
 * (it is only ever non-null while stopped). `transcribing` flushes the last live
 * window; `refining` is the second pass re-reading the whole recording. They are
 * distinct because they take wildly different amounts of time -- a second or two
 * versus minutes -- and only the second one has progress to report.
 *
 * `saving` is the record-only mode's counterpart: there is no live window to
 * flush and no second pass to run, only closing the WAV and writing its
 * sidecar. It gets its own value rather than reusing `transcribing` because
 * the status bar would otherwise claim a transcription is happening when none
 * is -- while still keeping `processing` non-null, which is what stops a new
 * take from starting in the gap (see `stopRecording`).
 *
 * `cancelling` exists for the same pair of reasons as `saving`: once the user
 * has asked to stop the analysis pass, saying "精度向上パス実行中" would be a
 * lie, but `processing` has to stay non-null until the pass has actually wound
 * down -- diarization cannot be interrupted mid-call, so that can take a while,
 * and letting a new take start into it would be the same bug `saving` prevents.
 */
export type ProcessingPhase = "transcribing" | "refining" | "saving" | "cancelling" | null;

/**
 * `idle` means the model has not been loaded and nothing is wrong -- the state
 * record-only mode sits in, since it never calls `initModel`. Distinct from
 * `loading` so `ModelLoadingOverlay` can tell "not loaded on purpose" from
 * "loading right now", and from `error` so nothing reports a failure that
 * never happened.
 */
export type ModelStatus = "idle" | "loading" | "ready" | "error";

/**
 * What the user may do right now, derived from the state axes above rather
 * than re-assembled per component. Every consumer reads these instead of
 * spelling out its own status comparison, so adding a phase cannot silently
 * leave one control behind -- which is exactly how the old flat enum let
 * `loadHistoryEntry` stay reachable mid-recording.
 */
export interface Capabilities {
  startRecording: boolean;
  pause: boolean;
  resume: boolean;
  stop: boolean;
  browseHistory: boolean;
  playback: boolean;
  reanalyze: boolean;
  /** Whether the analysis pass can be asked to stop. Deliberately excludes
   * `cancelling`, so the button disables itself the instant it is pressed
   * without any consumer having to track "already asked" separately. */
  cancelAnalysis: boolean;
  /** Settings that feed the live pass must not change mid-take: the streaming
   * transcriber re-reads `settings` on every window, so switching language
   * while paused would silently decode the rest of the recording differently. */
  editSettings: boolean;
}

export interface CapabilityInputs {
  recordingPhase: RecordingPhase;
  processing: ProcessingPhase;
  modelStatus: ModelStatus;
  /** `recordingMode.recordOnly` -- see `RecordingModeSettings` in the store. */
  recordOnly: boolean;
}

export function selectCapabilities(s: CapabilityInputs): Capabilities {
  const stopped = s.recordingPhase === "stopped";
  const idle = stopped && s.processing === null;
  return {
    // Record-only mode is the whole point of not loading the model, so it
    // cannot be gated on the model being ready. Its recordings are
    // transcribed later via `reanalyze`, which loads the model on demand.
    startRecording: idle && (s.recordOnly || s.modelStatus === "ready"),
    pause: s.recordingPhase === "recording",
    resume: s.recordingPhase === "paused",
    stop: !stopped,
    browseHistory: stopped,
    playback: stopped,
    // Deliberately not gated on `modelStatus`: this is the action that
    // *causes* the model to load in record-only mode. `rerunHistoryEntry`
    // awaits `ensureModelReady` itself and reports a notice if it fails.
    reanalyze: idle,
    // Only the accuracy pass is cancellable. The live flush (`transcribing`)
    // is a second or two, and `saving` runs no inference at all.
    cancelAnalysis: s.processing === "refining",
    editSettings: stopped,
  };
}
