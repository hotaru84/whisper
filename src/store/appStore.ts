import { create } from "zustand";
import {
  RecordingCapture,
  StreamingTranscriber,
  AudioEventStreamer,
} from "../lib/asr";
import type {
  AsrDevice,
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
import type { RecordingHistoryMeta } from "../lib/history";
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
  modelDevice: AsrDevice | null;
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
  /** The history entry currently shown in `segments`/`audioEvents`, if any.
   * `null` means the live/current session, not "no recordings exist". */
  selectedHistoryId: string | null;
  errorMessage: string | null;
  /**
   * Why the second pass did not happen, when the live transcript is still good.
   * Kept apart from `errorMessage` because nothing is broken: the user has a
   * transcript, it just did not get the accuracy pass.
   */
  refineNotice: string | null;
  /** 0-100 while `processing` is "refining", otherwise null. */
  refineProgress: number | null;
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
  modelDevice: null,
  segments: [],
  audioEvents: [],
  recordingHistory: [],
  selectedHistoryId: null,
  errorMessage: null,
  refineNotice: null,
  refineProgress: null,
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
    // Loading an entry rewrites `segments` and every timeline counter below,
    // so doing it mid-take would leave the running recorder writing against
    // the history entry's offsets -- the transcript would then be truncated
    // at the wrong point when the take stops.
    if (!capabilitiesOf(get()).browseHistory) return;
    try {
      const entry = await loadRecording(id);
      // Replaces what's on screen the same way starting fresh does, except the
      // fresh state is the loaded history entry instead of an empty transcript.
      // These counters matter only while merely browsing -- if the user goes on
      // to press record, `startRecording` resets them (and clears `segments`)
      // to start a genuinely new session rather than appending after this entry.
      setNextSegmentId(entry.segments.length + 1);
      setTimelineBaseSec(entry.durationSec);
      setRecordingBaseSec(entry.durationSec);
      setSegmentsBeforeRecording(entry.segments.length);
      set({
        segments: entry.segments,
        audioEvents: entry.audioEvents,
        selectedHistoryId: id,
        refineNotice: null,
        // The banner is now driven by `errorMessage` alone, so a previous
        // failure has to be cleared by the next thing that succeeds -- it
        // would otherwise sit there describing something already recovered from.
        errorMessage: null,
      });
      void get().loadPlayback(id, await wavPath(id));
    } catch (err) {
      set({ errorMessage: toErrorMessage(err) });
    }
  },

  deleteHistoryEntry: async (id) => {
    if (!capabilitiesOf(get()).browseHistory) return;
    try {
      await deleteRecording(id);
      if (get().playback.recordingId === id) get().unloadPlayback();
      set((s) => ({
        recordingHistory: s.recordingHistory.filter((r) => r.id !== id),
        // Deleting the entry currently being viewed leaves its content on
        // screen (nothing forces the user back to a blank state), but it no
        // longer corresponds to anything on disk -- clear the selection so a
        // later reload doesn't try to fetch a file that is gone.
        selectedHistoryId: s.selectedHistoryId === id ? null : s.selectedHistoryId,
        errorMessage: null,
      }));
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

    set({ processing: "refining", refineProgress: 0, refineNotice: null });
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
      // shown. Deliberately `playback.recordingId`, not `selectedHistoryId`:
      // a take just finished (record-only or not) loads its own playback via
      // `loadPlayback` without ever setting `selectedHistoryId` -- that field
      // means "browsing a *past* entry from the sidebar", which this isn't.
      // Checking it here left the transcript panel stuck showing nothing
      // (or stale content) after running 解析/詳細解析 on a take that had
      // never been opened from history -- the primary way this feature is
      // used in record-only mode, where it's the very first analysis pass.
      if (get().playback.recordingId === id) {
        set({ segments: localSegments, audioEvents: newEvents });
      }
      if (notices.length > 0) {
        set({ refineNotice: notices.join(" ") });
      }
    } catch (err) {
      set({ refineNotice: `再実行に失敗しました（既存の履歴はそのまま残っています）: ${toErrorMessage(err)}` });
    } finally {
      set({ processing: null, refineProgress: null });
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
    // Whatever was loaded for playback (a past recording, or the previous
    // take) no longer corresponds to what's about to be on screen.
    get().unloadPlayback();
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
      // A recording started while browsing a past entry begins a new,
      // unrelated session, not a continuation of what's on screen -- without
      // this, that entry's old transcript would keep sitting there (with the
      // new take's segments silently appended after it, per its stale
      // timeline) until the live pass produced its first result. The
      // segments themselves are safe either way: they're already durable in
      // that entry's own sidecar JSON, this only clears what's displayed.
      if (get().selectedHistoryId !== null) {
        resetTimeline();
        set({ segments: [], audioEvents: [] });
      }
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
      // Once real new content starts accumulating, this is no longer "viewing
      // a history entry" even if it started from one -- see loadHistoryEntry.
      set({
        recordingPhase: "recording",
        errorMessage: null,
        refineNotice: notices.length > 0 ? notices.join(" ") : null,
        levelMeter,
        selectedHistoryId: null,
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
