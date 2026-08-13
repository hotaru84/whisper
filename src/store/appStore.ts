import { create } from "zustand";
import {
  AsrClient,
  DEFAULT_DIARIZE_SETTINGS,
  DEFAULT_VAD_SETTINGS,
  RecordingCapture,
  StreamingTranscriber,
} from "../lib/asr";
import type {
  AsrDevice,
  DiarizeSettings,
  VadSettings,
  TranscriptionTask,
  TranscribeResult,
  StreamingSegment,
} from "../lib/asr";
import type { TranscriptSegment } from "../lib/transcript";
import { nonBlankChunks, segmentsFromResult } from "../lib/transcript";
import {
  startPcmRecording,
  decodeAudioToPcm16k,
  createAudioLevelMeter,
  listAudioInputDevices,
  onAudioDeviceChange,
  AppAudioClient,
  AudioMixer,
  WHISPER_SAMPLE_RATE,
} from "../lib/audio";
import type {
  PcmRecorderController,
  AudioLevelMeter,
  AudioInputDevice,
  AudioAppInfo,
} from "../lib/audio";

/**
 * `processing` flushes the last live window; `refining` is the second pass
 * re-reading the whole recording. They are distinct because they take wildly
 * different amounts of time -- a second or two versus minutes -- and only the
 * second one has progress to report.
 */
export type RecordingStatus = "idle" | "recording" | "processing" | "refining" | "done" | "error";
export type ModelStatus = "loading" | "ready" | "error";

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

const SETTINGS_KEY = "asr-settings";

/**
 * Settings survive restarts, which matters most for the glossary: retyping it
 * every session would make the feature not worth using.
 */
function loadSettings(): AsrSettings {
  const defaults: AsrSettings = { language: "ja", task: "transcribe", glossary: "", inputDeviceId: "" };
  try {
    const stored = globalThis.localStorage?.getItem(SETTINGS_KEY);
    if (!stored) return defaults;
    const parsed = JSON.parse(stored) as Partial<AsrSettings>;
    return {
      language: typeof parsed.language === "string" ? parsed.language : defaults.language,
      task: parsed.task === "translate" ? "translate" : "transcribe",
      glossary: typeof parsed.glossary === "string" ? parsed.glossary : defaults.glossary,
      inputDeviceId: typeof parsed.inputDeviceId === "string" ? parsed.inputDeviceId : defaults.inputDeviceId,
    };
  } catch {
    // Corrupt or unavailable storage must never stop the app from starting.
    return defaults;
  }
}

function saveSettings(settings: AsrSettings): void {
  try {
    globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Persistence is a convenience; losing it is not worth surfacing an error.
  }
}

const DIARIZE_SETTINGS_KEY = "diarize-settings";

/** Same persistence shape as `loadSettings`/`saveSettings`, kept separate: this
 * is a different concern (a post-hoc model pass, not a decoding parameter). */
function loadDiarizeSettings(): DiarizeSettings {
  try {
    const stored = globalThis.localStorage?.getItem(DIARIZE_SETTINGS_KEY);
    if (!stored) return DEFAULT_DIARIZE_SETTINGS;
    const parsed = JSON.parse(stored) as Partial<DiarizeSettings>;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_DIARIZE_SETTINGS.enabled,
      threshold: typeof parsed.threshold === "number" ? parsed.threshold : DEFAULT_DIARIZE_SETTINGS.threshold,
      numSpeakers:
        typeof parsed.numSpeakers === "number" ? parsed.numSpeakers : DEFAULT_DIARIZE_SETTINGS.numSpeakers,
      minDurationOn:
        typeof parsed.minDurationOn === "number" ? parsed.minDurationOn : DEFAULT_DIARIZE_SETTINGS.minDurationOn,
      minDurationOff:
        typeof parsed.minDurationOff === "number" ? parsed.minDurationOff : DEFAULT_DIARIZE_SETTINGS.minDurationOff,
    };
  } catch {
    return DEFAULT_DIARIZE_SETTINGS;
  }
}

function saveDiarizeSettings(settings: DiarizeSettings): void {
  try {
    globalThis.localStorage?.setItem(DIARIZE_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Persistence is a convenience; losing it is not worth surfacing an error.
  }
}

const VAD_SETTINGS_KEY = "vad-settings";

function loadVadSettings(): VadSettings {
  try {
    const stored = globalThis.localStorage?.getItem(VAD_SETTINGS_KEY);
    if (!stored) return DEFAULT_VAD_SETTINGS;
    const parsed = JSON.parse(stored) as Partial<VadSettings>;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_VAD_SETTINGS.enabled,
      threshold: typeof parsed.threshold === "number" ? parsed.threshold : DEFAULT_VAD_SETTINGS.threshold,
    };
  } catch {
    return DEFAULT_VAD_SETTINGS;
  }
}

function saveVadSettings(settings: VadSettings): void {
  try {
    globalThis.localStorage?.setItem(VAD_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Persistence is a convenience; losing it is not worth surfacing an error.
  }
}

export interface AppAudioSettings {
  enabled: boolean;
}

const DEFAULT_APP_AUDIO_SETTINGS: AppAudioSettings = { enabled: false };
const APP_AUDIO_SETTINGS_KEY = "app-audio-settings";

/**
 * Only `enabled` is persisted. The target app (a PID) is never persisted: a
 * PID from a previous session almost certainly does not refer to the same
 * process next time, so the picker always starts unselected and the user
 * re-picks from a freshly listed set of currently-active sessions.
 */
function loadAppAudioSettings(): AppAudioSettings {
  try {
    const stored = globalThis.localStorage?.getItem(APP_AUDIO_SETTINGS_KEY);
    if (!stored) return DEFAULT_APP_AUDIO_SETTINGS;
    const parsed = JSON.parse(stored) as Partial<AppAudioSettings>;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_APP_AUDIO_SETTINGS.enabled,
    };
  } catch {
    return DEFAULT_APP_AUDIO_SETTINGS;
  }
}

function saveAppAudioSettings(settings: AppAudioSettings): void {
  try {
    globalThis.localStorage?.setItem(APP_AUDIO_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Persistence is a convenience; losing it is not worth surfacing an error.
  }
}

interface AppState {
  recordingStatus: RecordingStatus;
  modelStatus: ModelStatus;
  modelDevice: AsrDevice | null;
  /** Accumulated transcript. Grows across start/stop cycles; cleared via clearTranscript(). */
  segments: TranscriptSegment[];
  errorMessage: string | null;
  /**
   * Why the second pass did not happen, when the live transcript is still good.
   * Kept apart from `errorMessage` because nothing is broken: the user has a
   * transcript, it just did not get the accuracy pass.
   */
  refineNotice: string | null;
  /** 0-100 while `recordingStatus` is "refining", otherwise null. */
  refineProgress: number | null;
  settings: AsrSettings;
  diarizeSettings: DiarizeSettings;
  vadSettings: VadSettings;
  appAudioSettings: AppAudioSettings;
  levelMeter: AudioLevelMeter | null;
  /** Available microphones, for the settings dropdown. Labels are placeholders
   * ("マイク N") until the first successful getUserMedia call in this session. */
  audioInputDevices: AudioInputDevice[];
  /** Apps with an active audio session right now, for the app-audio target
   * picker. Only ever populated by an explicit refresh (see its doc comment
   * on why this can't just be kept fresh automatically). */
  appAudioApps: AudioAppInfo[];
  /** The app-audio target picked for the *next* recording. Not persisted
   * (see `loadAppAudioSettings`) and unrelated to whether a recording is
   * currently capturing it -- that is internal to `startRecording`. */
  appAudioTargetPid: number | null;

  initModel: () => Promise<void>;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  updateSettings: (partial: Partial<AsrSettings>) => void;
  updateDiarizeSettings: (partial: Partial<DiarizeSettings>) => void;
  updateVadSettings: (partial: Partial<VadSettings>) => void;
  updateAppAudioSettings: (partial: Partial<AppAudioSettings>) => void;
  setAppAudioTarget: (processId: number | null) => void;
  refreshAudioInputDevices: () => Promise<void>;
  refreshAppAudioApps: () => Promise<void>;
  clearTranscript: () => void;
  reset: () => void;
}

let activeRecorder: PcmRecorderController | null = null;
let activeStreamer: StreamingTranscriber | null = null;
let activeCapture: RecordingCapture | null = null;
// Whether the current recording has app-audio capture running, so
// startRecording's frame callback knows whether to mix or pass mic frames
// through untouched.
let appAudioActive = false;
// Monotonic segment id and the running timeline position where the *next*
// recording's audio begins, so appended segments keep a continuous timeline.
let nextSegmentId = 1;
let timelineBaseSec = 0;
// Where the current recording starts, on the timeline and in the segment list.
// The second pass replaces everything this recording produced, so it needs both.
let recordingBaseSec = 0;
let segmentsBeforeRecording = 0;

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  try {
    path = (await capture.finish()).path;
  } catch (err) {
    useAppStore.setState({
      refineNotice: `録音ファイルの保存に失敗したため、精度向上パスは省略しました（表示中の文字起こしはそのまま使えます）: ${toErrorMessage(err)}`,
    });
    return;
  }

  useAppStore.setState({ recordingStatus: "refining", refineProgress: 0 });
  try {
    const result = await asrClient.transcribeRecording(
      path,
      useAppStore.getState().settings,
      useAppStore.getState().vadSettings,
    );

    if (result.vadUnavailable) {
      useAppStore.setState({
        refineNotice:
          "VAD 用のモデルファイルが見つからないため、VAD 無しで精度向上パスを実行しました。README の手順でモデルを配置すると有効になります。",
      });
    }

    // Diarization reads the same WAV on its own 0-based timeline, so it has to
    // run on result.chunks *before* segmentsFromResult rebases anything onto
    // the session's global timeline -- see nonBlankChunks' doc comment.
    let speakers: Array<number | null> | undefined;
    const diarizeSettings = useAppStore.getState().diarizeSettings;
    if (diarizeSettings.enabled) {
      const targets = nonBlankChunks(result).map((c) => c.timestamp);
      if (targets.length > 0) {
        try {
          speakers = await asrClient.diarizeRecording(path, targets, diarizeSettings);
        } catch (err) {
          // A transcript without speaker labels is still the whole point of
          // this pass; losing it over diarization would be a bad trade.
          useAppStore.setState({
            refineNotice: `話者分離に失敗したため、話者ラベルは付きません（文字起こし自体はそのまま使えます）: ${toErrorMessage(err)}`,
          });
        }
      }
    }

    const refined = segmentsFromResult(result, baseSec, nextSegmentId, speakers);
    // An empty second pass means something went wrong upstream, not that the
    // meeting was silent -- the live pass already found speech in this audio.
    if (refined.length > 0) {
      nextSegmentId += refined.length;
      useAppStore.setState((s) => ({
        segments: [...s.segments.slice(0, keptSegments), ...refined],
      }));
    }
  } catch (err) {
    useAppStore.setState({
      refineNotice: `精度向上パスに失敗しました（表示中の文字起こしはそのまま使えます）: ${toErrorMessage(err)}`,
    });
  } finally {
    useAppStore.setState({ recordingStatus: "done", refineProgress: null });
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  recordingStatus: "idle",
  modelStatus: "loading",
  modelDevice: null,
  segments: [],
  errorMessage: null,
  refineNotice: null,
  refineProgress: null,
  settings: loadSettings(),
  diarizeSettings: loadDiarizeSettings(),
  vadSettings: loadVadSettings(),
  appAudioSettings: loadAppAudioSettings(),
  levelMeter: null,
  audioInputDevices: [],
  appAudioApps: [],
  appAudioTargetPid: null,

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

  startRecording: async () => {
    try {
      // Transcribe on the fly: the recorder streams PCM frames into the streaming
      // transcriber, which commits transcript segments while recording continues.
      const streamer = new StreamingTranscriber(
        (audio) => asrClient.transcribe(audio, get().settings),
        appendStreamingSegment,
      );

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
      // start, or was never enabled, recording proceeds mic-only exactly as
      // before -- the mixer is simply never engaged.
      const { appAudioSettings, appAudioTargetPid } = get();
      const mixer = new AudioMixer();
      appAudioActive = false;
      let appAudioNotice: string | null = null;
      if (appAudioSettings.enabled && appAudioTargetPid != null) {
        try {
          await appAudioClient.startCapture(
            appAudioTargetPid,
            (frame) => mixer.pushAppAudio(frame),
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
        if (captureStarted) capture.push(mixed);
      }, get().settings.inputDeviceId || undefined);
      activeRecorder = controller;
      activeStreamer = streamer;
      activeCapture = captureStarted ? capture : null;
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
      set({
        recordingStatus: "recording",
        errorMessage: null,
        refineNotice: notices.length > 0 ? notices.join(" ") : null,
        levelMeter,
      });
    } catch (err) {
      activeRecorder = null;
      activeStreamer = null;
      activeCapture = null;
      if (appAudioActive) {
        appAudioActive = false;
        void appAudioClient.stopCapture();
      }
      set({ recordingStatus: "error", errorMessage: toErrorMessage(err) });
    }
  },

  stopRecording: async () => {
    const controller = activeRecorder;
    const streamer = activeStreamer;
    const capture = activeCapture;
    if (!controller || !streamer) return;
    activeRecorder = null;
    activeStreamer = null;
    activeCapture = null;
    get().levelMeter?.dispose();
    if (appAudioActive) {
      appAudioActive = false;
      await appAudioClient.stopCapture();
    }
    set({ recordingStatus: "processing", levelMeter: null });

    try {
      const totalSamples = await controller.stop();
      // Flush any audio not yet committed by the streaming pass.
      await streamer.finish();
      timelineBaseSec = recordingBaseSec + totalSamples / WHISPER_SAMPLE_RATE;
      set({ recordingStatus: "done" });
    } catch (err) {
      // The capture file is left open here on purpose: it is valid on disk at
      // every moment (see wav::Writer), and the backend closes it when the next
      // recording starts. Nothing is lost by not finishing it.
      set({ recordingStatus: "error", errorMessage: toErrorMessage(err) });
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

  updateAppAudioSettings: (partial) =>
    set((s) => {
      const appAudioSettings = { ...s.appAudioSettings, ...partial };
      saveAppAudioSettings(appAudioSettings);
      return { appAudioSettings };
    }),

  clearTranscript: () => {
    nextSegmentId = 1;
    timelineBaseSec = 0;
    recordingBaseSec = 0;
    segmentsBeforeRecording = 0;
    set({
      segments: [],
      recordingStatus: "idle",
      errorMessage: null,
      refineNotice: null,
      refineProgress: null,
    });
  },

  reset: () => set({ recordingStatus: "idle", errorMessage: null, refineNotice: null }),
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
