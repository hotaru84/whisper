import { create } from "zustand";
import {
  AsrClient,
  DEFAULT_DIARIZE_SETTINGS,
  DEFAULT_VAD_SETTINGS,
  DEFAULT_AUDIO_EVENT_SETTINGS,
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
  TranscriptionTask,
  TranscribeResult,
  StreamingSegment,
} from "../lib/asr";
import type { TranscriptSegment } from "../lib/transcript";
import { nonBlankChunks, segmentsFromResult } from "../lib/transcript";
import { saveRecordingHistory, listRecordings, loadRecording, deleteRecording, wavPath } from "../lib/history";
import type { RecordingHistoryMeta } from "../lib/history";
import {
  startPcmRecording,
  decodeAudioToPcm16k,
  createAudioLevelMeter,
  listAudioInputDevices,
  onAudioDeviceChange,
  AppAudioClient,
  AudioMixer,
  WHISPER_SAMPLE_RATE,
  wavToBlobUrl,
  createPlaybackController,
} from "../lib/audio";
import type {
  PcmRecorderController,
  AudioLevelMeter,
  AudioInputDevice,
  AudioAppInfo,
  PlaybackController,
} from "../lib/audio";

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
 */
export type ProcessingPhase = "transcribing" | "refining" | null;

export type ModelStatus = "loading" | "ready" | "error";

export interface PlaybackState {
  recordingId: string | null;
  loading: boolean;
  isPlaying: boolean;
  /** Seconds into the *loaded WAV's own* 0-based timeline -- what the
   * `<audio>` element actually reports. */
  currentTimeSec: number;
  durationSec: number;
  rate: number;
  /**
   * Where the loaded WAV's own timeline sits on `segments`' global timeline
   * (see `TranscriptSegment.startOffsetSec`'s doc comment). A single history
   * entry's segments are already 0-based, so this is 0 when browsing history;
   * within an ongoing session with more than one take, a later take's
   * segments are offset by however much came before it, and this is that
   * same offset -- see `refineRecording`'s `baseSec`. Lets `TranscriptPanel`
   * convert between "where a segment is" and "where the loaded audio is"
   * without the two ever being confused.
   */
  timelineOffsetSec: number;
}

const IDLE_PLAYBACK: PlaybackState = {
  recordingId: null,
  loading: false,
  isPlaying: false,
  currentTimeSec: 0,
  durationSec: 0,
  rate: 1,
  timelineOffsetSec: 0,
};

export interface AsrSettings {
  language: string;
  task: TranscriptionTask;
  /**
   * Terminology the model should be primed with: product names, jargon, people —
   * anything it would otherwise mis-hear. Passed to whisper as `initial_prompt`.
   *
   * A soft bias, not a constraint, and a small budget: ~224 tokens, which for
   * Japanese is roughly 200 characters. Text past that is silently dropped.
   */
  glossary: string;
  /** `deviceId` of the microphone to record from. Empty string = system default. */
  inputDeviceId: string;
}

/**
 * Shared shape behind every `settings-key -> localStorage` pair below: read
 * back whatever JSON is there, field-validate it against `defaults` (so a
 * stale/foreign shape can't leak wrong types into state), and never let a
 * corrupt or unavailable `localStorage` stop the app from starting. `sanitize`
 * carries the one part that legitimately differs per settings type -- which
 * fields exist and what counts as valid.
 */
function loadPersistedSettings<T>(key: string, defaults: T, sanitize: (parsed: Partial<T>, defaults: T) => T): T {
  try {
    const stored = globalThis.localStorage?.getItem(key);
    if (!stored) return defaults;
    return sanitize(JSON.parse(stored) as Partial<T>, defaults);
  } catch {
    return defaults;
  }
}

function savePersistedSettings<T>(key: string, settings: T): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(settings));
  } catch {
    // Persistence is a convenience; losing it is not worth surfacing an error.
  }
}

const SETTINGS_KEY = "asr-settings";

/**
 * Settings survive restarts, which matters most for the glossary: retyping it
 * every session would make the feature not worth using.
 */
function loadSettings(): AsrSettings {
  const defaults: AsrSettings = { language: "ja", task: "transcribe", glossary: "", inputDeviceId: "" };
  return loadPersistedSettings(SETTINGS_KEY, defaults, (parsed, d) => ({
    language: typeof parsed.language === "string" ? parsed.language : d.language,
    task: parsed.task === "translate" ? "translate" : "transcribe",
    glossary: typeof parsed.glossary === "string" ? parsed.glossary : d.glossary,
    inputDeviceId: typeof parsed.inputDeviceId === "string" ? parsed.inputDeviceId : d.inputDeviceId,
  }));
}

function saveSettings(settings: AsrSettings): void {
  savePersistedSettings(SETTINGS_KEY, settings);
}

const DIARIZE_SETTINGS_KEY = "diarize-settings";

/** Same persistence shape as `loadSettings`/`saveSettings`, kept separate: this
 * is a different concern (a post-hoc model pass, not a decoding parameter). */
function loadDiarizeSettings(): DiarizeSettings {
  return loadPersistedSettings(DIARIZE_SETTINGS_KEY, DEFAULT_DIARIZE_SETTINGS, (parsed, d) => ({
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : d.enabled,
    threshold: typeof parsed.threshold === "number" ? parsed.threshold : d.threshold,
    numSpeakers: typeof parsed.numSpeakers === "number" ? parsed.numSpeakers : d.numSpeakers,
    minDurationOn: typeof parsed.minDurationOn === "number" ? parsed.minDurationOn : d.minDurationOn,
    minDurationOff: typeof parsed.minDurationOff === "number" ? parsed.minDurationOff : d.minDurationOff,
  }));
}

function saveDiarizeSettings(settings: DiarizeSettings): void {
  savePersistedSettings(DIARIZE_SETTINGS_KEY, settings);
}

const VAD_SETTINGS_KEY = "vad-settings";

function loadVadSettings(): VadSettings {
  return loadPersistedSettings(VAD_SETTINGS_KEY, DEFAULT_VAD_SETTINGS, (parsed, d) => ({
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : d.enabled,
    threshold: typeof parsed.threshold === "number" ? parsed.threshold : d.threshold,
  }));
}

function saveVadSettings(settings: VadSettings): void {
  savePersistedSettings(VAD_SETTINGS_KEY, settings);
}

const AUDIO_EVENT_SETTINGS_KEY = "audio-event-settings";

function loadAudioEventSettings(): AudioEventSettings {
  return loadPersistedSettings(AUDIO_EVENT_SETTINGS_KEY, DEFAULT_AUDIO_EVENT_SETTINGS, (parsed, d) => ({
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : d.enabled,
    threshold: typeof parsed.threshold === "number" ? parsed.threshold : d.threshold,
    topK: typeof parsed.topK === "number" ? parsed.topK : d.topK,
  }));
}

function saveAudioEventSettings(settings: AudioEventSettings): void {
  savePersistedSettings(AUDIO_EVENT_SETTINGS_KEY, settings);
}

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
  /** Settings that feed the live pass must not change mid-take: the streaming
   * transcriber re-reads `settings` on every window, so switching language
   * while paused would silently decode the rest of the recording differently. */
  editSettings: boolean;
}

export function selectCapabilities(s: {
  recordingPhase: RecordingPhase;
  processing: ProcessingPhase;
  modelStatus: ModelStatus;
}): Capabilities {
  const stopped = s.recordingPhase === "stopped";
  const idle = stopped && s.processing === null;
  return {
    startRecording: idle && s.modelStatus === "ready",
    pause: s.recordingPhase === "recording",
    resume: s.recordingPhase === "paused",
    stop: !stopped,
    browseHistory: stopped,
    playback: stopped,
    reanalyze: idle,
    editSettings: stopped,
  };
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
// Monotonic segment id and the running timeline position where the *next*
// recording's audio begins, so appended segments keep a continuous timeline.
let nextSegmentId = 1;
let timelineBaseSec = 0;
// Where the current recording starts, on the timeline and in the segment list.
// The second pass replaces everything this recording produced, so it needs both.
let recordingBaseSec = 0;
let segmentsBeforeRecording = 0;
// The live `<audio>` wrapper backing `playback` state, if anything is loaded.
// Not part of Zustand state itself -- see `createPlaybackController`'s doc
// comment, same reasoning as `levelMeter` already being a class instance
// rather than plain data.
let playbackController: PlaybackController | null = null;

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The filename stem `capture.rs` uses for both the WAV and (once
 * `history.ts` writes it) its sidecar JSON, extracted from the full path
 * `capture.finish()` returns. Handles both path separator styles since the
 * Rust side reports a native (backslash, on Windows) path. */
function idFromWavPath(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  return base.replace(/\.wav$/i, "");
}

// Appends a streaming segment (offset relative to the current recording) onto the
// global transcript timeline.
function appendStreamingSegment(seg: StreamingSegment) {
  const segment: TranscriptSegment = {
    id: nextSegmentId++,
    startOffsetSec: timelineBaseSec + seg.offsetSec,
    text: seg.text,
    chunks: seg.chunks,
  };
  useAppStore.setState((s) => ({ segments: [...s.segments, segment] }));
}

// Appends a live window's audio-tagging results (on the current recording's
// own 0-based timeline) onto the global audioEvents timeline. Mirrors
// refineRecording's own rebase of the post-hoc pass's events -- see
// PlaybackState.timelineOffsetSec's doc comment for the same "own timeline
// vs. global timeline" distinction.
function appendLiveAudioEvents(events: AudioEvent[]) {
  const rebased = events.map((e) => ({ ...e, start: e.start + recordingBaseSec, end: e.end + recordingBaseSec }));
  useAppStore.setState((s) => ({ audioEvents: [...s.audioEvents, ...rebased] }));
}

// One instance shared by the app-list refresh and the actual capture start/stop:
// listing apps touches neither the Channel nor the error listener the capture
// methods manage, so the two uses never interfere with each other.
const appAudioClient = new AppAudioClient();

const asrClient = new AsrClient({
  onDeviceInfo: (device) => useAppStore.setState({ modelDevice: device }),
  onModelReady: () => useAppStore.setState({ modelStatus: "ready" }),
  onError: (message) => useAppStore.setState({ modelStatus: "error", errorMessage: message }),
  onRefineProgress: (percent) => useAppStore.setState({ refineProgress: percent }),
});

// Keeps the settings dropdown in sync when a microphone is plugged or
// unplugged, without the UI needing to poll for it.
onAudioDeviceChange(() => {
  void useAppStore.getState().refreshAudioInputDevices();
});

/** What `runAccuracyPipeline` produces: the re-transcription, plus whatever
 * diarization/audio-tagging managed to add, plus any user-facing notices
 * about the parts that did not go perfectly (never a hard failure -- see the
 * function's own doc). */
interface AccuracyPipelineResult {
  result: TranscribeResult;
  speakers?: Array<number | null>;
  excluded?: boolean[];
  newEvents: AudioEvent[];
  notices: string[];
}

/**
 * The re-transcribe/diarize/audio-tag sequence shared by `refineRecording`
 * (a just-finished live recording) and `rerunHistoryEntry` (any past one,
 * typically after the user changed a setting). Everything here operates on
 * `path`'s own 0-based timeline; rebasing onto a session's global timeline
 * (if the caller even has one -- `rerunHistoryEntry` does not) is the
 * caller's job, same as `nonBlankChunks`' doc comment already describes.
 *
 * Diarization/audio-tagging failures are collected as notices rather than
 * thrown: a transcript without speaker labels or event filtering is still
 * the whole point of this pass, so losing the transcript over either would
 * be a much worse trade than just not having that one extra.
 */
async function runAccuracyPipeline(
  path: string,
  settings: AsrSettings,
  vadSettings: VadSettings,
  diarizeSettings: DiarizeSettings,
  audioEventSettings: AudioEventSettings,
): Promise<AccuracyPipelineResult> {
  const notices: string[] = [];
  const result = await asrClient.transcribeRecording(path, settings, vadSettings);
  if (result.vadUnavailable) {
    notices.push(
      "VAD 用のモデルファイルが見つからないため、VAD 無しで実行しました。README の手順でモデルを配置すると有効になります。",
    );
  }

  // Diarization and audio tagging both read the same WAV on its own 0-based
  // timeline, so they have to run on result.chunks *before* segmentsFromResult
  // rebases anything -- see nonBlankChunks' doc comment.
  const targets = nonBlankChunks(result).map((c) => c.timestamp);

  let speakers: Array<number | null> | undefined;
  if (diarizeSettings.enabled && targets.length > 0) {
    try {
      speakers = await asrClient.diarizeRecording(path, targets, diarizeSettings);
    } catch (err) {
      notices.push(`話者分離に失敗したため、話者ラベルは付きません（文字起こし自体はそのまま使えます）: ${toErrorMessage(err)}`);
    }
  }

  let excluded: boolean[] | undefined;
  let newEvents: AudioEvent[] = [];
  if (audioEventSettings.enabled && targets.length > 0) {
    try {
      const eventResult = await asrClient.detectAudioEvents(path, targets, audioEventSettings);
      excluded = eventResult.exclude;
      newEvents = eventResult.events;
    } catch (err) {
      notices.push(`音響イベント検出に失敗しました（文字起こし自体はそのまま使えます）: ${toErrorMessage(err)}`);
    }
  }

  return { result, speakers, excluded, newEvents, notices };
}

/**
 * Re-transcribes the finished recording as one continuous piece and swaps the
 * result in for the segments the live pass produced.
 *
 * Every failure path here keeps the live transcript. The second pass is an
 * improvement on something the user already has; losing it costs accuracy, while
 * discarding the live result would cost them the meeting.
 */
async function refineRecording(capture: RecordingCapture): Promise<void> {
  const keptSegments = segmentsBeforeRecording;
  const baseSec = recordingBaseSec;

  let path: string;
  let recordingDurationSec: number;
  try {
    const info = await capture.finish();
    path = info.path;
    recordingDurationSec = info.durationSec;
  } catch (err) {
    // `stopRecording` handed over still in a processing phase (so the gap
    // before "refining" could not be mistaken for idle), so this bail-out has
    // to be the one to clear it.
    useAppStore.setState({
      processing: null,
      refineNotice: `録音ファイルの保存に失敗したため、精度向上パスは省略しました（表示中の文字起こしはそのまま使えます）: ${toErrorMessage(err)}`,
    });
    return;
  }

  // The WAV is fully written at this point regardless of how the accuracy
  // pass below goes, so playback becomes available immediately rather than
  // waiting on (possibly minutes of) diarization/audio-tagging. `baseSec` is
  // where this take's segments start on the session's global timeline (see
  // `PlaybackState.timelineOffsetSec`'s doc comment) -- the WAV itself is
  // always 0-based, only the segments referring to it are shifted.
  void useAppStore.getState().loadPlayback(idFromWavPath(path), path, baseSec);

  useAppStore.setState({ processing: "refining", refineProgress: 0 });
  try {
    const { settings, vadSettings, diarizeSettings, audioEventSettings } = useAppStore.getState();
    const { result, speakers, excluded, newEvents, notices } = await runAccuracyPipeline(
      path,
      settings,
      vadSettings,
      diarizeSettings,
      audioEventSettings,
    );
    if (notices.length > 0) {
      useAppStore.setState({ refineNotice: notices.join(" ") });
    }

    const targets = nonBlankChunks(result).map((c) => c.timestamp);
    const rebasedEvents = newEvents.map((e) => ({ ...e, start: e.start + baseSec, end: e.end + baseSec }));
    useAppStore.setState((s) => ({
      audioEvents: [...s.audioEvents.filter((e) => e.start < baseSec), ...rebasedEvents],
    }));

    const refined = segmentsFromResult(result, baseSec, nextSegmentId, speakers, excluded, newEvents);
    // One segment per non-blank chunk, always -- an excluded chunk becomes a
    // blank placeholder rather than being dropped (see
    // TranscriptSegment.excludedReason), so refined.length === targets.length
    // whenever there were any chunks to begin with.
    if (targets.length > 0) {
      nextSegmentId += targets.length;
    } else if (refined.length > 0) {
      nextSegmentId += refined.length;
    }
    // An empty (or all-excluded-placeholder) second pass means something went
    // wrong upstream, not that the meeting was silent -- the live pass
    // already found speech in this audio. Checked by actual text rather than
    // refined.length, since a recording audio-tagging excluded *everything*
    // from now produces only placeholders, not an empty array.
    if (refined.some((s) => s.text.trim() !== "")) {
      useAppStore.setState((s) => ({
        segments: [...s.segments.slice(0, keptSegments), ...refined],
      }));

      // Persisted on the recording's own 0-based timeline (not the session's
      // global one) and with freshly sequential ids, so a history entry looks
      // identical whether it was the first or the fifth recording of its
      // original session -- see history.ts's module doc.
      const localSegments = refined.map((s, i) => ({
        ...s,
        id: i + 1,
        startOffsetSec: s.startOffsetSec - baseSec,
      }));
      try {
        await saveRecordingHistory(idFromWavPath(path), {
          durationSec: recordingDurationSec,
          language: settings.language,
          usedDiarize: diarizeSettings.enabled,
          usedVad: vadSettings.enabled,
          usedAudioEvents: audioEventSettings.enabled,
          segments: localSegments,
          audioEvents: newEvents,
        });
        void useAppStore.getState().refreshRecordingHistory();
      } catch (err) {
        // The transcript on screen (and its place in this session) is
        // unaffected -- only future browsing of it from the history sidebar
        // is lost, which is a much smaller loss than any other failure path
        // in this function.
        useAppStore.setState({
          refineNotice: `録音履歴への保存に失敗しました（今の文字起こしはそのまま使えます）: ${toErrorMessage(err)}`,
        });
      }
    }
  } catch (err) {
    useAppStore.setState({
      refineNotice: `精度向上パスに失敗しました（表示中の文字起こしはそのまま使えます）: ${toErrorMessage(err)}`,
    });
  } finally {
    useAppStore.setState({ processing: null, refineProgress: null });
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  recordingPhase: "stopped",
  processing: null,
  modelStatus: "loading",
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
  levelMeter: null,
  audioInputDevices: [],
  appAudioApps: [],
  appAudioTargetPid: null,
  playback: IDLE_PLAYBACK,

  initModel: async () => {
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
    if (!selectCapabilities(get()).browseHistory) return;
    try {
      const entry = await loadRecording(id);
      // Replaces what's on screen the same way starting fresh does, except the
      // fresh state is the loaded history entry instead of an empty transcript.
      // Continuing ids/timeline from the loaded entry (rather than resetting to
      // zero) means a recording started right after viewing history appends
      // after it instead of risking an id collision with it.
      nextSegmentId = entry.segments.length + 1;
      timelineBaseSec = entry.durationSec;
      recordingBaseSec = entry.durationSec;
      segmentsBeforeRecording = entry.segments.length;
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
    if (!selectCapabilities(get()).browseHistory) return;
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
    if (!selectCapabilities(get()).reanalyze) return;

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
        usedDiarize: diarizeSettings.enabled,
        usedVad: vadSettings.enabled,
        usedAudioEvents: audioEventSettings.enabled,
        segments: localSegments,
        audioEvents: newEvents,
      });
      await get().refreshRecordingHistory();

      // Refresh what's on screen too, if this is the entry currently shown.
      if (get().selectedHistoryId === id) {
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

  loadPlayback: async (recordingId, path, timelineOffsetSec = 0) => {
    if (get().playback.recordingId === recordingId) return;
    playbackController?.dispose();
    playbackController = null;
    set({ playback: { ...IDLE_PLAYBACK, recordingId, timelineOffsetSec, loading: true } });
    try {
      const url = await wavToBlobUrl(path);
      // The user may have switched away (a new recording, a different
      // history entry) while the file was being read -- don't let a slow
      // load clobber whatever is current by the time it resolves.
      if (get().playback.recordingId !== recordingId) {
        URL.revokeObjectURL(url);
        return;
      }
      playbackController = createPlaybackController(url, (snapshot) => {
        set((s) => (s.playback.recordingId === recordingId ? { playback: { ...s.playback, ...snapshot } } : {}));
      });
      set((s) => (s.playback.recordingId === recordingId ? { playback: { ...s.playback, loading: false } } : {}));
    } catch (err) {
      console.warn("[playback] failed to load recording audio:", err);
      set((s) => (s.playback.recordingId === recordingId ? { playback: IDLE_PLAYBACK } : {}));
    }
  },

  unloadPlayback: () => {
    playbackController?.dispose();
    playbackController = null;
    set({ playback: IDLE_PLAYBACK });
  },

  togglePlayback: () => {
    if (!playbackController) return;
    if (get().playback.isPlaying) playbackController.pause();
    else playbackController.play();
  },

  seekTo: (sec) => playbackController?.seekTo(sec),

  skip: (deltaSec) => {
    const { currentTimeSec } = get().playback;
    playbackController?.seekTo(currentTimeSec + deltaSec);
  },

  setPlaybackRate: (rate) => {
    playbackController?.setRate(rate);
    set((s) => ({ playback: { ...s.playback, rate } }));
  },

  startRecording: async () => {
    // Without this, a second call while a take is live would overwrite
    // `activeRecorder`/`activeStreamer`/`activeCapture` and orphan the running
    // one -- its frames would keep arriving forever, and `capture.start()`
    // would drop the old WAV writer out from under it.
    if (!selectCapabilities(get()).startRecording) return;
    // Whatever was loaded for playback (a past recording, or the previous
    // take) no longer corresponds to what's about to be on screen.
    get().unloadPlayback();
    try {
      // Transcribe on the fly: the recorder streams PCM frames into the streaming
      // transcriber, which commits transcript segments while recording continues.
      const streamer = new StreamingTranscriber(
        (audio) => asrClient.transcribe(audio, get().settings),
        appendStreamingSegment,
      );

      // Live audio-event preview, only when the feature is on -- see
      // events.rs's module doc for why this is a preview the post-hoc pass
      // always overwrites, never the authoritative result.
      const audioEventSettings = get().audioEventSettings;
      const eventStreamer = audioEventSettings.enabled
        ? new AudioEventStreamer(
            (audio, startSec) => asrClient.detectEventsWindow(audio, startSec, get().audioEventSettings),
            appendLiveAudioEvents,
          )
        : null;

      // The same frames also go to disk, for the second pass after stop. If that
      // cannot be started, record anyway: a live-only transcript beats no
      // recording because the cache directory was not writable.
      const capture = new RecordingCapture();
      let captureStarted = true;
      try {
        await capture.start();
      } catch (err) {
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
        streamer.pushFrame(mixed);
        eventStreamer?.pushFrame(mixed);
        if (captureStarted) capture.push(mixed);
      }, get().settings.inputDeviceId || undefined);
      activeRecorder = controller;
      activeStreamer = streamer;
      activeEventStreamer = eventStreamer;
      activeCapture = captureStarted ? capture : null;
      recordingPaused = false;
      recordingBaseSec = timelineBaseSec;
      segmentsBeforeRecording = get().segments.length;
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
      if (appAudioActive) {
        appAudioActive = false;
        void appAudioClient.stopCapture();
      }
      set({ recordingPhase: "stopped", errorMessage: toErrorMessage(err) });
    }
  },

  pauseRecording: async () => {
    if (!selectCapabilities(get()).pause) return;
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
    if (!selectCapabilities(get()).resume) return;
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
    if (!controller || !streamer) return;
    activeRecorder = null;
    activeStreamer = null;
    activeEventStreamer = null;
    activeCapture = null;
    recordingPaused = false;
    get().levelMeter?.dispose();
    if (appAudioActive) {
      appAudioActive = false;
      await appAudioClient.stopCapture();
    }
    set({ recordingPhase: "stopped", processing: "transcribing", levelMeter: null });

    try {
      const totalSamples = await controller.stop();
      // Flush any audio not yet committed by the streaming pass.
      await streamer.finish();
      // Best-effort: a live preview window failing to flush must never hold
      // up the recording finishing, or (worse) block the post-hoc pass that
      // is about to supersede it anyway.
      await eventStreamer?.finish().catch((err) => {
        console.warn("[audio-events] failed to flush the final live window:", err);
      });
      timelineBaseSec = recordingBaseSec + totalSamples / WHISPER_SAMPLE_RATE;
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
    // user has a transcript throughout.
    if (capture) await refineRecording(capture);
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
