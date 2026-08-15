/**
 * Every `settings-key -> localStorage` pair the app persists: decoding
 * settings, diarization, VAD, audio-event tagging, record-only mode, and the
 * history sidebar's width/visibility. Each
 * one used to be its own copy-pasted `loadX`/`saveX` pair in `appStore.ts`;
 * `definePersistedSettings` is the one place that shape lives now, so a new
 * settings group is one factory call instead of two functions.
 */
import {
  DEFAULT_DIARIZE_SETTINGS,
  DEFAULT_VAD_SETTINGS,
  DEFAULT_AUDIO_EVENT_SETTINGS,
} from "../lib/asr";
import type { DiarizeSettings, VadSettings, AudioEventSettings, TranscriptionTask } from "../lib/asr";

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

export interface RecordingModeSettings {
  /**
   * Record the audio and nothing else: no model load, no live transcription,
   * no audio tagging. The WAV still lands on disk exactly as it always does,
   * and the take shows up in history as an unanalyzed entry the user can
   * transcribe later (`rerunHistoryEntry`, which loads the model on demand).
   *
   * Named for what it *does* rather than for its effect: "power saving"
   * describes the outcome, but what the user needs to know before flipping it
   * is that transcription will not run.
   */
  recordOnly: boolean;
}

export const DEFAULT_RECORDING_MODE: RecordingModeSettings = { recordOnly: false };

export interface SidebarSettings {
  /** Width of the history sidebar in CSS pixels, always within [MIN, MAX]. */
  width: number;
  /** Whether the history sidebar is shown at all. */
  visible: boolean;
}

export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 420;

export const DEFAULT_SIDEBAR_SETTINGS: SidebarSettings = { width: 224, visible: true };

export function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

/**
 * Reads back whatever JSON is at `key`, field-validates it against `defaults`
 * (so a stale/foreign shape can't leak wrong types into state), and never
 * lets a corrupt or unavailable `localStorage` stop the app from starting.
 * `sanitize` carries the one part that legitimately differs per settings
 * type -- which fields exist and what counts as valid.
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

function definePersistedSettings<T>(
  key: string,
  defaults: T,
  sanitize: (parsed: Partial<T>, defaults: T) => T,
): { load: () => T; save: (settings: T) => void } {
  return {
    load: () => loadPersistedSettings(key, defaults, sanitize),
    save: (settings: T) => savePersistedSettings(key, settings),
  };
}

/**
 * Settings survive restarts, which matters most for the glossary: retyping it
 * every session would make the feature not worth using.
 */
const asrSettings = definePersistedSettings<AsrSettings>(
  "asr-settings",
  { language: "ja", task: "transcribe", glossary: "", inputDeviceId: "" },
  (parsed, d) => ({
    language: typeof parsed.language === "string" ? parsed.language : d.language,
    task: parsed.task === "translate" ? "translate" : "transcribe",
    glossary: typeof parsed.glossary === "string" ? parsed.glossary : d.glossary,
    inputDeviceId: typeof parsed.inputDeviceId === "string" ? parsed.inputDeviceId : d.inputDeviceId,
  }),
);
export const loadSettings = asrSettings.load;
export const saveSettings = asrSettings.save;

/** Same persistence shape as `asrSettings`, kept separate: this is a
 * different concern (a post-hoc model pass, not a decoding parameter). */
const diarizeSettings = definePersistedSettings<DiarizeSettings>(
  "diarize-settings",
  DEFAULT_DIARIZE_SETTINGS,
  (parsed, d) => ({
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : d.enabled,
    threshold: typeof parsed.threshold === "number" ? parsed.threshold : d.threshold,
    numSpeakers: typeof parsed.numSpeakers === "number" ? parsed.numSpeakers : d.numSpeakers,
    minDurationOn: typeof parsed.minDurationOn === "number" ? parsed.minDurationOn : d.minDurationOn,
    minDurationOff: typeof parsed.minDurationOff === "number" ? parsed.minDurationOff : d.minDurationOff,
  }),
);
export const loadDiarizeSettings = diarizeSettings.load;
export const saveDiarizeSettings = diarizeSettings.save;

const vadSettings = definePersistedSettings<VadSettings>("vad-settings", DEFAULT_VAD_SETTINGS, (parsed, d) => ({
  enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : d.enabled,
  threshold: typeof parsed.threshold === "number" ? parsed.threshold : d.threshold,
}));
export const loadVadSettings = vadSettings.load;
export const saveVadSettings = vadSettings.save;

const audioEventSettings = definePersistedSettings<AudioEventSettings>(
  "audio-event-settings",
  DEFAULT_AUDIO_EVENT_SETTINGS,
  (parsed, d) => ({
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : d.enabled,
    threshold: typeof parsed.threshold === "number" ? parsed.threshold : d.threshold,
    topK: typeof parsed.topK === "number" ? parsed.topK : d.topK,
  }),
);
export const loadAudioEventSettings = audioEventSettings.load;
export const saveAudioEventSettings = audioEventSettings.save;

/** Same persistence shape as the settings above. Worth persisting because the
 * whole point is that a session started in this mode never loads the model at
 * all -- a setting that reset on launch would load it before the user could
 * say otherwise, which is exactly the cost being avoided. */
const recordingMode = definePersistedSettings<RecordingModeSettings>(
  "recording-mode-settings",
  DEFAULT_RECORDING_MODE,
  (parsed, d) => ({
    recordOnly: typeof parsed.recordOnly === "boolean" ? parsed.recordOnly : d.recordOnly,
  }),
);
export const loadRecordingMode = recordingMode.load;
export const saveRecordingMode = recordingMode.save;

/**
 * Layout rather than behaviour, but persisted for the same reason as the rest:
 * a pane the user deliberately narrowed (or closed) reopening at its default
 * on every launch is a setting that undoes itself.
 *
 * Width is clamped on the way *in* as well as on the way out, so a hand-edited
 * or stale value can't produce a sidebar that is unusably narrow or eats the
 * whole window.
 */
const sidebarSettings = definePersistedSettings<SidebarSettings>(
  "sidebar-settings",
  DEFAULT_SIDEBAR_SETTINGS,
  (parsed, d) => ({
    width:
      typeof parsed.width === "number" && Number.isFinite(parsed.width) ? clampSidebarWidth(parsed.width) : d.width,
    visible: typeof parsed.visible === "boolean" ? parsed.visible : d.visible,
  }),
);
export const loadSidebarSettings = sidebarSettings.load;
export const saveSidebarSettings = sidebarSettings.save;
