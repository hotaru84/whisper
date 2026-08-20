/**
 * Every `settings-key -> localStorage` pair the app persists: decoding
 * settings, diarization, audio-event tagging, record-only mode, and the
 * history sidebar's width/visibility. Each
 * one used to be its own copy-pasted `loadX`/`saveX` pair in `appStore.ts`;
 * `definePersistedSettings` is the one place that shape lives now, so a new
 * settings group is one factory call instead of two functions.
 */
import {
  DEFAULT_DIARIZE_SETTINGS,
  DEFAULT_AUDIO_EVENT_SETTINGS,
  DEFAULT_HALLUCINATION_SETTINGS,
} from "../lib/asr";
import type {
  DiarizeSettings,
  AudioEventSettings,
  HallucinationSettings,
  TranscriptionTask,
} from "../lib/asr";

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
 * What the *next* take does, picked from one dropdown in `RecordStartPanel`
 * (`RecordingModePicker`) -- the three choices are mutually exclusive, so this
 * is a single tag rather than the two independent booleans (`recordOnly`,
 * `auto`) it used to be.
 */
export type RecordingModeChoice =
  /** Record the audio and nothing else: no model load, no live transcription,
   * no audio tagging. The WAV still lands on disk exactly as it always does,
   * and the take shows up in history as an unanalyzed entry the user can
   * transcribe later (`rerunHistoryEntry`, which loads the model on demand). */
  | "recordOnly"
  /** The normal take: live transcription while recording, then the full
   * refine/diarize/audio-tag pass once it stops. */
  | "analyze"
  /** Decide between the two above fresh at the start of every take, from the
   * machine's current power source: `recordOnly` on battery, `analyze` on
   * mains power. See `capabilities.ts`'s `effectiveRecordOnly`, the one
   * function that actually resolves this. */
  | "auto";

export interface RecordingModeSettings {
  mode: RecordingModeChoice;
}

export const DEFAULT_RECORDING_MODE: RecordingModeSettings = { mode: "analyze" };

export interface SidebarSettings {
  /** Width of the history sidebar in CSS pixels, always within [MIN, MAX]. */
  width: number;
}

export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 420;

export const DEFAULT_SIDEBAR_SETTINGS: SidebarSettings = { width: 224 };

export function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

/**
 * Where recordings and their transcripts get written -- always, since a
 * configured folder is required before a recording can start (see
 * `capabilities.ts`'s `directoryConfigured`). No more "save inside the app's
 * own cache directory" fallback for new takes; see `recordingLocation.ts`.
 */
export interface AutoSaveSettings {
  /** Absolute path chosen via the native folder picker. Empty = not set. */
  directory: string;
}

export const DEFAULT_AUTO_SAVE_SETTINGS: AutoSaveSettings = {
  directory: "",
};

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

/** Same persistence shape as the settings above. Ranges are sanity-clamped
 * rather than type-checked alone: a stray negative or zero value read back
 * from a hand-edited localStorage entry would otherwise flow straight into
 * `asr::DecodeSettings`/the RMS silence gate and misbehave silently. */
const hallucinationSettings = definePersistedSettings<HallucinationSettings>(
  "hallucination-settings",
  DEFAULT_HALLUCINATION_SETTINGS,
  (parsed, d) => ({
    silenceRms:
      typeof parsed.silenceRms === "number" && Number.isFinite(parsed.silenceRms) && parsed.silenceRms >= 0
        ? parsed.silenceRms
        : d.silenceRms,
    entropyThold:
      typeof parsed.entropyThold === "number" && Number.isFinite(parsed.entropyThold) && parsed.entropyThold > 0
        ? parsed.entropyThold
        : d.entropyThold,
  }),
);
export const loadHallucinationSettings = hallucinationSettings.load;
export const saveHallucinationSettings = hallucinationSettings.save;

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
  (parsed, d) => {
    if (parsed.mode === "recordOnly" || parsed.mode === "analyze" || parsed.mode === "auto") {
      return { mode: parsed.mode };
    }
    // Migrates the shape this setting had before the three choices became one
    // dropdown (independent `recordOnly`/`auto` booleans), so upgrading the
    // app does not silently reset a preference someone already set. `parsed`
    // is only *typed* as `Partial<RecordingModeSettings>` -- the object
    // JSON.parse actually produced from an older version's localStorage entry
    // still has the old fields at runtime, just not in the new type, hence
    // the cast to read them.
    const legacy = parsed as unknown as { recordOnly?: unknown; auto?: unknown };
    if (legacy.auto === true) return { mode: "auto" };
    if (typeof legacy.recordOnly === "boolean") return { mode: legacy.recordOnly ? "recordOnly" : "analyze" };
    return d;
  },
);
export const loadRecordingMode = recordingMode.load;
export const saveRecordingMode = recordingMode.save;

/**
 * Layout rather than behaviour, but persisted for the same reason as the rest:
 * a pane the user deliberately narrowed reopening at its default width on
 * every launch is a setting that undoes itself.
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
  }),
);
export const loadSidebarSettings = sidebarSettings.load;
export const saveSidebarSettings = sidebarSettings.save;

const autoSaveSettings = definePersistedSettings<AutoSaveSettings>(
  "autosave-settings",
  DEFAULT_AUTO_SAVE_SETTINGS,
  (parsed, d) => ({
    directory: typeof parsed.directory === "string" ? parsed.directory : d.directory,
  }),
);
export const loadAutoSaveSettings = autoSaveSettings.load;
export const saveAutoSaveSettings = autoSaveSettings.save;
