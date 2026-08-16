import { create, type StateCreator } from "zustand";
import {
  RecordingCapture,
  StreamingTranscriber,
  AudioEventStreamer,
} from "../lib/asr";
import type {
  DiarizeSettings,
  VadSettings,
  AudioEventSettings,
  AudioEvent,
  TranscribeResult,
  StreamingSegment,
} from "../lib/asr";
import type { TranscriptSegment } from "../lib/transcript";
import { segmentsFromResult } from "../lib/transcript";
import { saveRecordingHistory, listRecordings, loadRecording, deleteRecording, wavPath } from "../lib/history";
import type { RecordingHistoryMeta, RecordingHistoryEntry } from "../lib/history";
import {
  startPcmRecording,
  decodeAudioToPcm16k,
  createAudioLevelMeter,
  listAudioInputDevices,
  AudioMixer,
  WHISPER_SAMPLE_RATE,
} from "../lib/audio";
import type { PcmRecorderController, AudioLevelMeter, AudioInputDevice, AudioAppInfo } from "../lib/audio";
import { asrClient, appAudioClient } from "./clients";
import { loadPlayback, unloadPlayback, togglePlayback, seekTo, skip, setPlaybackRate, IDLE_PLAYBACK } from "./playback";
import type { PlaybackState } from "./playback";
// The state axes and `selectCapabilities` live in their own import-free module
// so they can be unit-tested without dragging in the Tauri client and the
// audio stack -- see capabilities.ts.
import { selectCapabilities } from "./capabilities";
import type { RecordingPhase, ProcessingPhase, ModelStatus } from "./capabilities";
import { toErrorMessage } from "../lib/errors";
import {
  loadSettings,
  saveSettings,
  loadDiarizeSettings,
  saveDiarizeSettings,
  loadVadSettings,
  saveVadSettings,
  loadAudioEventSettings,
  saveAudioEventSettings,
  loadRecordingMode,
  saveRecordingMode,
  loadSidebarSettings,
  saveSidebarSettings,
  clampSidebarWidth,
} from "./persistedSettings";
import type { AsrSettings, RecordingModeSettings, SidebarSettings } from "./persistedSettings";
import {
  setNextSegmentId,
  getTimelineBaseSec,
  setTimelineBaseSec,
  getRecordingBaseSec,
  setRecordingBaseSec,
  setSegmentsBeforeRecording,
  resetTimeline,
} from "./timeline";
import {
  runAccuracyPipeline,
  refineRecording,
  finishRecordOnly,
  ensureModelReady,
  appendStreamingSegment,
  appendLiveAudioEvents,
} from "./recordingPipeline";

// Re-exported because this is where every consumer already imports them from.
export {
  selectCapabilities,
  type RecordingPhase,
  type ProcessingPhase,
  type ModelStatus,
  type Capabilities,
  type CapabilityInputs,
} from "./capabilities";
export {
  type AsrSettings,
  type RecordingModeSettings,
  type SidebarSettings,
  DEFAULT_RECORDING_MODE,
} from "./persistedSettings";
export { type PlaybackState } from "./playback";

interface AppState {
  /** What the recorder is doing. The primary state everything else keys off. */
  recordingPhase: RecordingPhase;
  /** The post-stop pipeline, orthogonal to `recordingPhase`. */
  processing: ProcessingPhase;
  modelStatus: ModelStatus;
  /** Accumulated transcript. Grows across start/stop cycles. */
  segments: TranscriptSegment[];
  /**
   * Accumulated audio-tagging events, on the same global timeline as
   * `segments`, for the standalone timeline panel (never merged into the
   * transcript body -- see `events.rs`'s module doc). Only populated when
   * `audioEventSettings.enabled`; grows and is pruned the same way `segments`
   * does across recordings (see `refineRecording`).
   */
  audioEvents: AudioEvent[];
  /** Past recordings, newest first, for the history sidebar. Populated on
   * startup and refreshed after every save (see `refineRecording`) or
   * delete. Metadata only -- opening one reads its full content on demand
   * via `loadHistoryEntry`, see `lib/history.ts`. */
  recordingHistory: RecordingHistoryMeta[];
  /**
   * The id of whichever specific saved recording `segments`/`audioEvents`/
   * `playback` currently represent, if any -- regardless of how it got
   * there: picked from the sidebar, or just finished (live or record-only).
   * `null` means the live/in-progress session, not "no recordings exist".
   *
   * This is the single field every "is recording X currently on screen"
   * question should be answered from (the sidebar's row highlight, the
   * transcript panel's delete/reanalyze buttons, `rerunHistoryEntry`'s
   * "refresh what's shown"). It used to be narrower (`selectedHistoryId`,
   * set only by `loadHistoryEntry`) and every other "here's a recording to
   * show" call site had to remember to update it by hand -- one didn't
   * (`finishRecordOnly`), which is what let a record-only take finish into a
   * screen with no delete button and no indication anything was selected.
   * Writes go through `markRecordingViewed`/`resetToBlankSession` (both
   * below) rather than ad hoc `set()` calls, so that can't happen again.
   */
  viewedRecordingId: string | null;
  errorMessage: string | null;
  /**
   * Why the second pass did not happen, when the live transcript is still good.
   * Kept apart from `errorMessage` because nothing is broken: the user has a
   * transcript, it just did not get the accuracy pass.
   */
  refineNotice: string | null;
  /** 0-100 while `processing` is "refining", otherwise null. */
  refineProgress: number | null;
  /**
   * The id of whichever recording `processing` is currently running the
   * accuracy pass against, when known. Set by `rerunHistoryEntry` (the id is
   * its own parameter) and by `refineRecording` (once `capture.finish()`
   * resolves and the id is known -- so this stays `null` for the brief
   * moment `processing` first becomes `"refining"` but the WAV isn't closed
   * yet). Deliberately independent of `viewedRecordingId`: unlike that
   * field, this one must stay correct even if the user browses to a
   * *different* entry while a reanalysis keeps running in the background
   * (`rerunHistoryEntry`'s `browseHistory`/`loadHistoryEntry` gate is
   * `recordingPhase` alone, not `processing`, so that's reachable) -- see
   * `TitleBarStatus`/`HistorySidebar` for where this is shown.
   */
  processingRecordingId: string | null;
  settings: AsrSettings;
  diarizeSettings: DiarizeSettings;
  vadSettings: VadSettings;
  audioEventSettings: AudioEventSettings;
  recordingMode: RecordingModeSettings;
  /** History sidebar width/visibility. Layout, not behaviour, but it lives
   * here because the toggle (TitleBarControls) and the panel itself (App)
   * are siblings with no common owner below the root. */
  sidebar: SidebarSettings;
  levelMeter: AudioLevelMeter | null;
  /** Available microphones, for the settings dropdown. Labels are placeholders
   * ("マイク N") until the first successful getUserMedia call in this session. */
  audioInputDevices: AudioInputDevice[];
  /** Apps with an active audio session right now, for the app-audio target
   * picker. Only ever populated by an explicit refresh (see its doc comment
   * on why this can't just be kept fresh automatically). */
  appAudioApps: AudioAppInfo[];
  /** The app-audio target for the *next* recording, and the sole switch for
   * whether app-audio capture is used at all -- `null` means mic-only, no
   * separate enabled flag needed. Not persisted: a PID from a previous
   * session almost certainly does not refer to the same process next time,
   * so the picker always starts unselected and the user re-picks from a
   * freshly listed set of currently-active sessions. Unrelated to whether a
   * recording is currently capturing it -- that is internal to `startRecording`. */
  appAudioTargetPid: number | null;
  /** Playback of a finished recording's WAV -- either the one just recorded
   * (loaded once `refineRecording` has a path) or a past one selected from
   * history (loaded by `loadHistoryEntry`). `recordingId` is the same id
   * `segments`/`audioEvents` are keyed by, so callers can tell whether the
   * loaded audio actually matches what's on screen. */
  playback: PlaybackState;

  initModel: () => Promise<void>;
  startRecording: () => Promise<void>;
  /** Ends the take for good: flushes the live pass, closes the WAV, and kicks
   * off the accuracy pass. Callable from both "recording" and "paused". */
  stopRecording: () => Promise<void>;
  /** Suspends capture without ending the take. Audio stops being collected
   * entirely (rather than being recorded as silence), so the paused span is
   * simply absent from the recording -- see `setPaused`'s doc comment in
   * `pcmRecorder.ts`. Also flushes the live transcriber so what the user has
   * said so far is fully on screen while they are stopped. */
  pauseRecording: () => Promise<void>;
  resumeRecording: () => void;
  updateSettings: (partial: Partial<AsrSettings>) => void;
  updateDiarizeSettings: (partial: Partial<DiarizeSettings>) => void;
  updateVadSettings: (partial: Partial<VadSettings>) => void;
  updateAudioEventSettings: (partial: Partial<AudioEventSettings>) => void;
  /** Turning record-only *off* starts loading the model right away rather
   * than waiting for the next record press: `startRecording` is gated on the
   * model being ready outside this mode, so without it the button would sit
   * disabled with nothing on screen explaining why. */
  updateRecordingMode: (partial: Partial<RecordingModeSettings>) => void;
  /** Live width during a resize drag. Deliberately does *not* persist: this
   * fires on every pointermove, and the drag's final width is committed once
   * on release via `persistSidebarSettings`. */
  setSidebarWidth: (width: number) => void;
  persistSidebarSettings: () => void;
  toggleSidebar: () => void;
  setAppAudioTarget: (processId: number | null) => void;
  refreshAudioInputDevices: () => Promise<void>;
  refreshAppAudioApps: () => Promise<void>;
  refreshRecordingHistory: () => Promise<void>;
  loadHistoryEntry: (id: string) => Promise<void>;
  /** Backs out of viewing whatever recording is currently shown (browsed
   * from the sidebar, or just finished) to the same blank state a fresh
   * session starts in -- no-op if nothing is being viewed. */
  deselectHistoryEntry: () => void;
  deleteHistoryEntry: (id: string) => Promise<void>;
  /** Re-runs the accuracy pass (transcribe + diarize + audio-tag, per
   * whatever is currently enabled in settings) against a past recording's
   * WAV and overwrites its history entry -- e.g. after turning on
   * diarization or changing its threshold and wanting this recording
   * relabeled with it. Reuses `processing: "refining"` and `refineProgress`,
   * so the same progress UI `refineRecording` drives applies here too. */
  rerunHistoryEntry: (id: string) => Promise<void>;
  /** Loads `path`'s audio for playback, tagged with `recordingId` so the UI
   * can tell it apart from whatever was loaded before. Replaces (and
   * disposes) any previously loaded audio; a no-op if `recordingId` is
   * already the one loaded. */
  loadPlayback: (recordingId: string, path: string, timelineOffsetSec?: number) => Promise<void>;
  unloadPlayback: () => void;
  togglePlayback: () => void;
  seekTo: (sec: number) => void;
  skip: (deltaSec: number) => void;
  setPlaybackRate: (rate: number) => void;
}

/**
 * Fields above that must change *together*, and where that's enforced. Every
 * bug found in this store so far (see git history around `viewedRecordingId`,
 * `resetToBlankSession`, `markRecordingViewed`) was one of these clusters
 * drifting out of sync because a call site updated only some of its members.
 * Before adding a new `set()`/`setState()` call that touches any field
 * listed below, check whether it belongs in one of these groups instead.
 *
 * - `segments` / `audioEvents` / `viewedRecordingId` / `playback.recordingId`
 *   -- together represent "what recording is currently on screen". Write
 *   through `resetToBlankSession` (leaving), `viewLoadedRecording` (opening
 *   a past entry), or `markRecordingViewed` (a just-finished take claiming
 *   the entry it was just filed under) -- never a bespoke `set()`.
 * - `recordingPhase` / `processing` / `modelStatus` -- deliberately
 *   orthogonal axes (see each field's own doc comment and `capabilities.ts`),
 *   not a cluster in the same sense, but any transition that changes more
 *   than one of them must do so in a single `set()` call so a reader never
 *   observes a combination that shouldn't exist.
 * - `refineProgress` -- only meaningful while `processing === "refining"`;
 *   every writer (both in this file, plus `clients.ts`'s `onRefineProgress`
 *   handler for the one write site outside it) must check that before
 *   applying an update, since the backend event feeding it isn't guaranteed
 *   to stop arriving the instant the frontend moves on.
 * - `processingRecordingId` -- only meaningful while `processing !== null`;
 *   set alongside it in `rerunHistoryEntry` and (once the id is known)
 *   `refineRecording`, cleared alongside it in every `finally`. Deliberately
 *   *not* required to equal `viewedRecordingId` -- see its own doc comment.
 */

/**
 * `selectCapabilities` against the store's own shape, so the actions below
 * don't each have to remember that `recordOnly` lives one level down inside
 * `recordingMode`. Components build the argument themselves instead, because
 * they subscribe to each field separately (a selector returning a fresh
 * object would re-render on every store change).
 */
function capabilitiesOf(s: Pick<AppState, "recordingPhase" | "processing" | "modelStatus" | "recordingMode">) {
  return selectCapabilities({
    recordingPhase: s.recordingPhase,
    processing: s.processing,
    modelStatus: s.modelStatus,
    recordOnly: s.recordingMode.recordOnly,
  });
}

/**
 * Clears whatever recording -- the live/just-finished one, or a past entry
 * loaded from history -- is currently on screen, back to the same blank
 * state a fresh session starts in. Shared by `deselectHistoryEntry` (an
 * explicit "stop browsing this" click) and `deleteHistoryEntry` (when the
 * entry being deleted is the one currently shown): both are "nothing valid
 * is left to display" moments, and leaving the old segments/audio in view
 * after either would show content that no longer corresponds to anything on
 * disk.
 */
function resetToBlankSession(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1],
): void {
  resetTimeline();
  get().unloadPlayback();
  set({
    segments: [],
    audioEvents: [],
    viewedRecordingId: null,
    refineNotice: null,
    errorMessage: null,
  });
}

/**
 * Loads a past recording's own content as what's now on screen --
 * `resetToBlankSession`'s counterpart on the "entering" side for
 * `loadHistoryEntry`. Rebases the module-level timeline counters (`timeline.ts`)
 * onto this entry the same way `resetToBlankSession` does when leaving one,
 * so a browsed entry's segments/audio events land at the right offsets
 * whether or not the user goes on to press record afterward.
 *
 * `loadPlayback` is deliberately left to the caller, same as
 * `resetToBlankSession` leaves `unloadPlayback` to itself rather than a
 * separate helper -- both are one line, and keeping them inline next to
 * their one call site is clearer than a wrapper with a single caller.
 */
function viewLoadedRecording(set: Parameters<StateCreator<AppState>>[0], entry: RecordingHistoryEntry): void {
  setNextSegmentId(entry.segments.length + 1);
  setTimelineBaseSec(entry.durationSec);
  setRecordingBaseSec(entry.durationSec);
  setSegmentsBeforeRecording(entry.segments.length);
  set({
    segments: entry.segments,
    audioEvents: entry.audioEvents,
    viewedRecordingId: entry.id,
    refineNotice: null,
    errorMessage: null,
  });
}

/**
 * Marks `id` as the recording `segments`/`audioEvents`/`playback` now
 * represent -- `resetToBlankSession`'s counterpart on the "entering" side,
 * for the two places (`refineRecording`, `finishRecordOnly`) that finish
 * filing a just-recorded take into history and need to say so.
 *
 * `loadHistoryEntry` does not go through this: it sets `viewedRecordingId`
 * synchronously as part of its own single `set()`, before `playback.
 * recordingId` has caught up (`loadPlayback` runs after, fire-and-forget),
 * so the guard below would reject it. The guard exists for the other two
 * callers specifically because they call this *after* an `await` (saving to
 * disk) -- `browseHistory` is gated on `recordingPhase` alone, not
 * `processing`, so picking a *different* entry from the sidebar while a save
 * is still in flight is reachable. Without the guard, the stale call
 * resolving afterwards would stomp that new selection back to the take that
 * just finished.
 */
export function markRecordingViewed(id: string): void {
  if (useAppStore.getState().playback.recordingId !== id) return;
  useAppStore.setState({ viewedRecordingId: id });
}

let activeRecorder: PcmRecorderController | null = null;
let activeStreamer: StreamingTranscriber | null = null;
let activeCapture: RecordingCapture | null = null;
// Only instantiated when audioEventSettings.enabled at recording start -- see
// startRecording. Its output is a live preview, always overwritten by the
// post-hoc pass once the recording stops (events.rs's module doc).
let activeEventStreamer: AudioEventStreamer | null = null;
// Whether the current recording has app-audio capture running, so
// startRecording's frame callback knows whether to mix or pass mic frames
// through untouched.
let appAudioActive = false;
// Mirrors `recordingPhase === "paused"` for the audio callbacks, which run far
// too often to read the store. The mic side is gated inside the recorder
// itself (it also has to stop counting samples -- see `setPaused`); this is
// the app-audio half of the same gate.
let recordingPaused = false;
// `recordingMode.recordOnly` as it was when the current take started. The
// setting is locked for the duration of a take anyway, but `stopRecording`
// has to branch on the mode the take actually *ran* in -- reading the store
// there would let a mode change land between start and stop and send a
// record-only take down the refine path (or worse, the reverse).
let recordingRecordOnly = false;

export const useAppStore = create<AppState>((set, get) => ({
  recordingPhase: "stopped",
  processing: null,
  // Not "loading": nothing is loading until something asks for it. Record-only
  // mode never does, and starting in "loading" would put the blocking overlay
  // on screen for a load that is never going to happen.
  modelStatus: "idle",
  segments: [],
  audioEvents: [],
  recordingHistory: [],
  viewedRecordingId: null,
  errorMessage: null,
  refineNotice: null,
  refineProgress: null,
  processingRecordingId: null,
  settings: loadSettings(),
  diarizeSettings: loadDiarizeSettings(),
  vadSettings: loadVadSettings(),
  audioEventSettings: loadAudioEventSettings(),
  recordingMode: loadRecordingMode(),
  sidebar: loadSidebarSettings(),
  levelMeter: null,
  audioInputDevices: [],
  appAudioApps: [],
  appAudioTargetPid: null,
  playback: IDLE_PLAYBACK,

  initModel: async () => {
    // Only ever a no-op if the load already happened -- `asrClient.init()` is
    // itself idempotent, so a second caller riding an in-flight load is fine.
    if (get().modelStatus === "ready") return;
    set({ modelStatus: "loading" });
    try {
      await asrClient.init();
    } catch (err) {
      set({ modelStatus: "error", errorMessage: toErrorMessage(err) });
    }
  },

  refreshAudioInputDevices: async () => {
    try {
      const devices = await listAudioInputDevices();
      set({ audioInputDevices: devices });
    } catch (err) {
      // Best-effort: the settings dropdown just stays at whatever it last had
      // (typically empty, meaning "use the system default").
      console.warn("[devices] failed to list audio input devices:", err);
    }
  },

  refreshAppAudioApps: async () => {
    try {
      const apps = await appAudioClient.listApps();
      set((s) => ({
        appAudioApps: apps,
        // A previously picked target that dropped off the (now refreshed)
        // active-session list is no longer capturable -- clear it rather than
        // silently keep a selection startRecording would fail on.
        appAudioTargetPid: apps.some((a) => a.processId === s.appAudioTargetPid)
          ? s.appAudioTargetPid
          : null,
      }));
    } catch (err) {
      console.warn("[app-audio] failed to list apps:", err);
    }
  },

  setAppAudioTarget: (processId) => set({ appAudioTargetPid: processId }),

  refreshRecordingHistory: async () => {
    try {
      const recordingHistory = await listRecordings();
      set({ recordingHistory });
    } catch (err) {
      // Best-effort, like the other list refreshes -- the sidebar just stays
      // at whatever it last had.
      console.warn("[history] failed to list recordings:", err);
    }
  },

  loadHistoryEntry: async (id) => {
    // Loading an entry rewrites `segments` and every timeline counter
    // `viewLoadedRecording` sets, so doing it mid-take would leave the
    // running recorder writing against the history entry's offsets -- the
    // transcript would then be truncated at the wrong point when the take
    // stops.
    if (!capabilitiesOf(get()).browseHistory) return;
    try {
      const entry = await loadRecording(id);
      // These counters matter only while merely browsing -- if the user goes
      // on to press record, `startRecording` resets them (and clears
      // `segments`) to start a genuinely new session rather than appending
      // after this entry.
      viewLoadedRecording(set, entry);
      void get().loadPlayback(id, await wavPath(id));
    } catch (err) {
      set({ errorMessage: toErrorMessage(err) });
    }
  },

  deselectHistoryEntry: () => {
    if (!capabilitiesOf(get()).browseHistory) return;
    if (get().viewedRecordingId === null) return;
    resetToBlankSession(set, get);
  },

  deleteHistoryEntry: async (id) => {
    if (!capabilitiesOf(get()).browseHistory) return;
    try {
      await deleteRecording(id);
      // `viewedRecordingId` alone would almost always be enough, but this is
      // reachable (`browseHistory` is gated on `recordingPhase`, not
      // `processing`) during the narrow async window inside
      // `refineRecording`/`finishRecordOnly` between `loadPlayback` setting
      // `playback.recordingId` and `markRecordingViewed` catching up to it --
      // keeping both checks means a delete landing in that window still
      // triggers the reset instead of leaving orphaned segments/playback
      // behind.
      const wasShown = get().viewedRecordingId === id || get().playback.recordingId === id;
      set((s) => ({
        recordingHistory: s.recordingHistory.filter((r) => r.id !== id),
        errorMessage: null,
      }));
      if (wasShown) resetToBlankSession(set, get);
    } catch (err) {
      set({ errorMessage: toErrorMessage(err) });
    }
  },

  rerunHistoryEntry: async (id) => {
    if (!capabilitiesOf(get()).reanalyze) return;

    // The one place the model gets loaded on demand: in record-only mode this
    // is the first time it is needed at all. A no-op once it is loaded, so the
    // normal path is unaffected.
    if (!(await ensureModelReady())) {
      set({
        refineNotice: `音声認識モデルを読み込めなかったため、解析できませんでした（録音はそのまま残っています）: ${
          get().errorMessage ?? "原因不明"
        }`,
      });
      return;
    }

    const durationSec = get().recordingHistory.find((r) => r.id === id)?.durationSec ?? 0;
    const path = await wavPath(id);

    set({ processing: "refining", refineProgress: 0, refineNotice: null, processingRecordingId: id });
    try {
      const { settings, vadSettings, diarizeSettings, audioEventSettings } = get();
      const { result, speakers, excluded, newEvents, notices } = await runAccuracyPipeline(
        path,
        settings,
        vadSettings,
        diarizeSettings,
        audioEventSettings,
      );

      // Always the recording's own 0-based timeline with fresh sequential
      // ids -- this entry has no "session" of its own to rebase onto, and
      // saveRecordingHistory always stores under that same convention (see
      // refineRecording's persistence step).
      const refined = segmentsFromResult(result, 0, 1, speakers, excluded, newEvents);
      if (!refined.some((s) => s.text.trim() !== "")) {
        // Mirrors refineRecording's own guard: an empty (or all-excluded-
        // placeholder) result is far more likely a setting change gone wrong
        // (wrong language, an overly strict threshold) than "this recording
        // legitimately has nothing in it now" -- the existing history entry
        // is worth more than a result this suspicious.
        set({
          refineNotice:
            "この設定では文字起こし結果が0件になったため、履歴は上書きしていません。設定を確認してから再度お試しください。",
        });
        return;
      }
      const localSegments = refined.map((s, i) => ({ ...s, id: i + 1 }));

      await saveRecordingHistory(id, {
        durationSec,
        language: settings.language,
        transcribed: true,
        usedDiarize: diarizeSettings.enabled,
        usedVad: vadSettings.enabled,
        usedAudioEvents: audioEventSettings.enabled,
        segments: localSegments,
        audioEvents: newEvents,
      });
      await get().refreshRecordingHistory();

      // Refresh what's on screen too, if this is the recording currently
      // shown. Safe to gate on `viewedRecordingId` alone here (unlike
      // `deleteHistoryEntry`'s equivalent check): `reanalyze` requires
      // `idle` (`processing === null`), which only becomes true again after
      // `markRecordingViewed` has already run for a just-finished take, so
      // there's no async window where the two fields could disagree.
      if (get().viewedRecordingId === id) {
        set({ segments: localSegments, audioEvents: newEvents });
      }
      if (notices.length > 0) {
        set({ refineNotice: notices.join(" ") });
      }
    } catch (err) {
      set({ refineNotice: `再実行に失敗しました（既存の履歴はそのまま残っています）: ${toErrorMessage(err)}` });
    } finally {
      set({ processing: null, refineProgress: null, processingRecordingId: null });
    }
  },

  // Implementations live in playback.ts, which is self-contained enough
  // (nothing outside it ever touches `playbackController`) to not need the
  // rest of this store's `set`/`get` closures -- see that file.
  loadPlayback,
  unloadPlayback,
  togglePlayback,
  seekTo,
  skip,
  setPlaybackRate,

  startRecording: async () => {
    // Without this, a second call while a take is live would overwrite
    // `activeRecorder`/`activeStreamer`/`activeCapture` and orphan the running
    // one -- its frames would keep arriving forever, and `capture.start()`
    // would drop the old WAV writer out from under it.
    if (!capabilitiesOf(get()).startRecording) return;
    // Leaving whatever was being viewed -- a past entry, or a just-finished
    // take -- happens atomically, in this one synchronous tick, before any
    // of the async device/capture setup below even starts: `playback`,
    // `segments`, `audioEvents`, and `viewedRecordingId` all clear together.
    // They used to clear at different points in time (`unloadPlayback` here
    // immediately, `segments`/`audioEvents` only after several `await`s
    // below had already resolved, `viewedRecordingId` later still, in the
    // final `set()`), which left the screen showing an inconsistent mix for
    // however long the device/capture setup below took: a delete button and
    // "履歴を表示中" header for an entry whose audio had already been
    // unloaded, transcript rows that looked seekable but no longer were,
    // and no `RecordingTimeline` at all (it hides once `playback.
    // recordingId` is null, whether or not something is still "viewed").
    //
    // Not called unconditionally: a second take in an already-live session
    // (`viewedRecordingId === null`, nothing being "viewed") must append to
    // `segments`, not wipe them -- see "Existing segments are kept" below.
    if (get().viewedRecordingId !== null) resetToBlankSession(set, get);
    // Frozen for the whole take -- see `recordingRecordOnly`.
    const recordOnly = get().recordingMode.recordOnly;
    recordingRecordOnly = recordOnly;
    try {
      // Transcribe on the fly: the recorder streams PCM frames into the streaming
      // transcriber, which commits transcript segments while recording continues.
      // Record-only mode is exactly the absence of this -- no streamer means no
      // inference, which is the entire cost being avoided.
      const streamer = recordOnly
        ? null
        : new StreamingTranscriber(
            (audio) => asrClient.transcribe(audio, get().settings),
            appendStreamingSegment,
          );

      // Live audio-event preview, only when the feature is on -- see
      // events.rs's module doc for why this is a preview the post-hoc pass
      // always overwrites, never the authoritative result. Also inference, so
      // record-only mode skips it regardless of the setting; the post-hoc pass
      // still produces the real events whenever the take is analyzed later.
      const audioEventSettings = get().audioEventSettings;
      const eventStreamer =
        !recordOnly && audioEventSettings.enabled
          ? new AudioEventStreamer(
              (audio, startSec) => asrClient.detectEventsWindow(audio, startSec, get().audioEventSettings),
              appendLiveAudioEvents,
            )
          : null;

      // The same frames also go to disk, for the second pass after stop. If that
      // cannot be started, record anyway: a live-only transcript beats no
      // recording because the cache directory was not writable.
      //
      // Except in record-only mode, where the file *is* the entire output --
      // continuing would produce a take that leaves nothing behind at all, so
      // this becomes fatal and the catch below reports it instead.
      const capture = new RecordingCapture();
      let captureStarted = true;
      try {
        await capture.start();
      } catch (err) {
        if (recordOnly) throw err;
        captureStarted = false;
        console.warn("[capture] disabled for this recording:", err);
      }

      // App audio (Teams/Zoom/...) is optional and additive: if it fails to
      // start, or no target was picked, recording proceeds mic-only exactly
      // as before -- the mixer is simply never engaged.
      const { appAudioTargetPid } = get();
      const mixer = new AudioMixer();
      appAudioActive = false;
      let appAudioNotice: string | null = null;
      if (appAudioTargetPid != null) {
        try {
          await appAudioClient.startCapture(
            appAudioTargetPid,
            // Gated by the same pause flag as the mic. The Rust side is
            // wall-clock driven (see `capture_loop` in appaudio.rs) and keeps
            // emitting chunks -- silence-padded when the app is quiet -- for
            // the whole pause, so without this the mixer's queue would fill
            // with audio captured *while paused*. On resume the mixer would
            // then serve that stale audio first and stay that far behind the
            // mic for the rest of the take. `dropOverflow` caps the queue, so
            // this failure is silent: no error, no memory growth, just
            // misaligned audio and a few leaked seconds of the other app.
            (frame) => {
              if (!recordingPaused) mixer.pushAppAudio(frame);
            },
            (message) => {
              // Fires if capture dies mid-recording (most commonly: the
              // target app closed). Recording keeps going mic-only; the
              // mixer just stops receiving app-audio frames and pads with
              // silence for the rest of the take (see AudioMixer's own doc).
              useAppStore.setState({
                refineNotice: `アプリ音声の取得が中断されたため、以降はマイクのみで録音しています: ${message}`,
              });
            },
          );
          appAudioActive = true;
        } catch (err) {
          appAudioNotice = `アプリ音声の取得を開始できなかったため、マイクのみで録音します: ${toErrorMessage(err)}`;
          console.warn("[app-audio] failed to start, continuing mic-only:", err);
        }
      }

      const controller = await startPcmRecording((frame) => {
        const mixed = appAudioActive ? mixer.mix(frame) : frame;
        streamer?.pushFrame(mixed);
        eventStreamer?.pushFrame(mixed);
        if (captureStarted) capture.push(mixed);
      }, get().settings.inputDeviceId || undefined);
      activeRecorder = controller;
      activeStreamer = streamer;
      activeEventStreamer = eventStreamer;
      activeCapture = captureStarted ? capture : null;
      recordingPaused = false;
      setRecordingBaseSec(getTimelineBaseSec());
      setSegmentsBeforeRecording(get().segments.length);
      const levelMeter = createAudioLevelMeter(controller.stream);
      // getUserMedia grants permission (if not already granted), which is also
      // when real device labels first become available -- refresh so the
      // settings dropdown stops showing "マイク N" placeholders.
      void get().refreshAudioInputDevices();
      const notices = [
        captureStarted ? null : "録音を保存できないため、停止後の精度向上パスは行われません。",
        controller.usedFallbackDevice
          ? "選択したマイクが見つからないため、既定のマイクで録音しています。"
          : null,
        appAudioNotice,
      ].filter((n): n is string => n !== null);
      // Existing segments are kept: a new recording appends to the transcript.
      // `viewedRecordingId` is set to null again here even though the reset
      // above already did it: `browseHistory` stays true (it only checks
      // `recordingPhase`, still "stopped" until this very `set()`) for the
      // whole async setup this take just went through, so the user picking
      // a *different* history entry in that window is reachable -- this is
      // what makes sure a take actually starting always wins that race.
      set({
        recordingPhase: "recording",
        errorMessage: null,
        refineNotice: notices.length > 0 ? notices.join(" ") : null,
        levelMeter,
        viewedRecordingId: null,
      });
    } catch (err) {
      activeRecorder = null;
      activeStreamer = null;
      activeEventStreamer = null;
      activeCapture = null;
      recordingPaused = false;
      recordingRecordOnly = false;
      if (appAudioActive) {
        appAudioActive = false;
        void appAudioClient.stopCapture();
      }
      set({ recordingPhase: "stopped", errorMessage: toErrorMessage(err) });
    }
  },

  pauseRecording: async () => {
    if (!capabilitiesOf(get()).pause) return;
    const streamer = activeStreamer;
    recordingPaused = true;
    activeRecorder?.setPaused(true);
    set({ recordingPhase: "paused" });

    // Flush the live pass so the transcript is complete up to the pause. The
    // point of pausing is to be able to read back what was just said, and
    // without this up to a full 15s window would still be sitting unprocessed.
    // The event streamer is deliberately *not* flushed: its model is trained
    // on 10s clips (see events.rs's WINDOW_SEC), so a short partial window
    // would produce a low-quality tag, and its output is only ever a preview
    // the post-hoc pass overwrites anyway.
    try {
      await streamer?.finish();
    } catch (err) {
      // Purely a display convenience -- the audio is still captured and the
      // post-hoc pass re-reads all of it, so a failed flush costs nothing but
      // a slightly stale transcript while paused.
      console.warn("[asr] failed to flush the transcript on pause:", err);
    }
  },

  resumeRecording: () => {
    if (!capabilitiesOf(get()).resume) return;
    // Nothing to drain: both callbacks were gated for the whole pause, so the
    // mixer's queue is exactly where it was and mic/app audio line back up.
    recordingPaused = false;
    activeRecorder?.setPaused(false);
    set({ recordingPhase: "recording" });
  },

  stopRecording: async () => {
    const controller = activeRecorder;
    const streamer = activeStreamer;
    const eventStreamer = activeEventStreamer;
    const capture = activeCapture;
    // Not `|| !streamer`: a record-only take never had one.
    if (!controller) return;
    const recordOnly = recordingRecordOnly;
    activeRecorder = null;
    activeStreamer = null;
    activeEventStreamer = null;
    activeCapture = null;
    recordingPaused = false;
    recordingRecordOnly = false;
    get().levelMeter?.dispose();
    if (appAudioActive) {
      appAudioActive = false;
      await appAudioClient.stopCapture();
    }
    // "saving" rather than "transcribing" for a record-only take: there is no
    // live window to flush, only the WAV to close and its sidecar to write.
    // Still non-null, so the guard below on starting a new take still holds.
    set({
      recordingPhase: "stopped",
      processing: recordOnly ? "saving" : "transcribing",
      levelMeter: null,
    });

    try {
      const totalSamples = await controller.stop();
      // Flush any audio not yet committed by the streaming pass.
      await streamer?.finish();
      // Best-effort: a live preview window failing to flush must never hold
      // up the recording finishing, or (worse) block the post-hoc pass that
      // is about to supersede it anyway.
      await eventStreamer?.finish().catch((err) => {
        console.warn("[audio-events] failed to flush the final live window:", err);
      });
      setTimelineBaseSec(getRecordingBaseSec() + totalSamples / WHISPER_SAMPLE_RATE);
      // Stay in a processing phase if the accuracy pass is about to run:
      // clearing it here first would briefly re-enable "start a new recording"
      // in the gap before `refineRecording` sets "refining", and a take
      // started in that gap would fight the pass for the model.
      if (!capture) set({ processing: null });
    } catch (err) {
      // The capture file is left open here on purpose: it is valid on disk at
      // every moment (see wav::Writer), and the backend closes it when the next
      // recording starts. Nothing is lost by not finishing it.
      set({ processing: null, errorMessage: toErrorMessage(err) });
      return;
    }

    // Then re-read the whole recording for accuracy, replacing what the live
    // windows produced. Runs after the live result is already on screen, so the
    // user has a transcript throughout. A record-only take has nothing to
    // replace and no model loaded to do it with, so it only gets filed away.
    if (capture) {
      if (recordOnly) await finishRecordOnly(capture);
      else await refineRecording(capture);
    }
  },

  updateSettings: (partial) =>
    set((s) => {
      const settings = { ...s.settings, ...partial };
      saveSettings(settings);
      return { settings };
    }),

  updateDiarizeSettings: (partial) =>
    set((s) => {
      const diarizeSettings = { ...s.diarizeSettings, ...partial };
      saveDiarizeSettings(diarizeSettings);
      return { diarizeSettings };
    }),

  updateVadSettings: (partial) =>
    set((s) => {
      const vadSettings = { ...s.vadSettings, ...partial };
      saveVadSettings(vadSettings);
      return { vadSettings };
    }),

  updateAudioEventSettings: (partial) =>
    set((s) => {
      const audioEventSettings = { ...s.audioEventSettings, ...partial };
      saveAudioEventSettings(audioEventSettings);
      return { audioEventSettings };
    }),

  updateRecordingMode: (partial) => {
    const recordingMode = { ...get().recordingMode, ...partial };
    saveRecordingMode(recordingMode);
    set({ recordingMode });
    // Leaving record-only mode means the next take needs the model, and
    // `startRecording` will not enable itself until it is there. Kick the load
    // off now so the wait happens while the user is still setting up rather
    // than when they press record. Failures surface through `modelStatus`
    // exactly as the startup load's do.
    if (!recordingMode.recordOnly) void ensureModelReady();
  },

  setSidebarWidth: (width) =>
    set((s) => ({ sidebar: { ...s.sidebar, width: clampSidebarWidth(width) } })),

  persistSidebarSettings: () => saveSidebarSettings(get().sidebar),

  toggleSidebar: () =>
    set((s) => {
      const sidebar = { ...s.sidebar, visible: !s.sidebar.visible };
      saveSidebarSettings(sidebar);
      return { sidebar };
    }),

}));

// Dev-only diagnostic: transcribe an audio file from a URL through the exact
// same decode + pipeline path as the mic flow, to isolate model/audio issues
// from microphone capture. Exposed on window in dev via App.
export async function debugTranscribeUrl(
  url: string,
  overrides?: Partial<AsrSettings>,
): Promise<TranscribeResult> {
  const response = await fetch(url);
  const blob = await response.blob();
  const pcm = await decodeAudioToPcm16k(blob);
  const settings = { ...useAppStore.getState().settings, ...overrides };
  const result = await asrClient.transcribe(pcm, settings);
  console.log("[debugTranscribeUrl]", url, settings, "->", result);
  return result;
}

// Dev-only diagnostic: feed an audio file through the *streaming* path (chunk-
// and-commit + real model), simulating a live recording, to exercise the same
// integration the mic flow uses without a microphone. Returns the emitted
// streaming segments.
export async function debugStreamTranscribeUrl(
  url: string,
  overrides?: Partial<AsrSettings>,
): Promise<StreamingSegment[]> {
  const response = await fetch(url);
  const blob = await response.blob();
  const pcm = await decodeAudioToPcm16k(blob);
  const settings = { ...useAppStore.getState().settings, ...overrides };

  const segments: StreamingSegment[] = [];
  const streamer = new StreamingTranscriber(
    (audio) => asrClient.transcribe(audio, settings),
    (seg) => segments.push(seg),
  );
  // Push in ~100ms frames to mimic live capture.
  const frameLen = Math.round(WHISPER_SAMPLE_RATE * 0.1);
  for (let i = 0; i < pcm.length; i += frameLen) {
    streamer.pushFrame(pcm.slice(i, Math.min(i + frameLen, pcm.length)));
    await Promise.resolve();
  }
  await streamer.finish();
  console.log("[debugStreamTranscribeUrl]", url, settings, "->", segments);
  return segments;
}
