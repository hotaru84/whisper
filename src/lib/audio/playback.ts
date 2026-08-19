import { readFile } from "@tauri-apps/plugin-fs";
import { useMockBackend } from "../env";
import { mockDurationSec, mockIdFromPath, silentWavBytes } from "../mock/fixtures";

/**
 * Turns a recording's on-disk WAV path into a URL the webview's `<audio>`
 * element can actually load.
 *
 * The straightforward `<audio src={path}>` doesn't work here: this app's CSP
 * is `default-src 'self'` with no `media-src` (and no asset-protocol scope
 * configured), so a `file://`/`asset://` source is rejected outright. Rather
 * than carve out and audit a new asset-protocol permission just for this,
 * this reads the file through `@tauri-apps/plugin-fs` (`fs:allow-read-file`,
 * scoped to `**` in `capabilities/default.json` -- the recording can live in
 * either the app's own cache dir or a user-configured auto-save folder, see
 * `recordingLocation.ts`) and hands the bytes to the webview as a `blob:`
 * URL, which the CSP's `media-src 'self' blob:` entry does allow.
 *
 * The returned URL is only valid until `URL.revokeObjectURL` is called on it
 * -- callers own that lifecycle (see `createPlaybackController`'s `dispose`).
 */
export async function wavToBlobUrl(path: string): Promise<string> {
  // No file to read outside Tauri: stand in a silent WAV of the right length
  // (see `silentWavBytes`) so the timeline, the slider, the playhead and the
  // transcript's follow-along all behave exactly as they do for a real
  // recording -- there is just no sound. Without this, `readFile` rejected
  // and every finished or selected recording showed a 0:00, unseekable
  // timeline.
  const bytes = useMockBackend
    ? silentWavBytes(mockDurationSec(mockIdFromPath(path)))
    : await readFile(path);
  const blob = new Blob([bytes], { type: "audio/wav" });
  return URL.createObjectURL(blob);
}

export interface PlaybackSnapshot {
  isPlaying: boolean;
  currentTimeSec: number;
  durationSec: number;
}

export interface PlaybackController {
  play(): void;
  pause(): void;
  /** Clamped to `[0, duration]` -- a caller computing a seek target from
   * e.g. "current position + 10s" doesn't have to know the duration itself. */
  seekTo(sec: number): void;
  setRate(rate: number): void;
  dispose(): void;
}

/**
 * Wraps a detached `HTMLAudioElement` (never mounted in the DOM -- playback
 * doesn't need a visual element of its own, every control for it lives in
 * `RecordingTimeline`) and reports its state back through `onUpdate` on every
 * native media event. Mirrors `createAudioLevelMeter`'s shape: a small
 * imperative controller the store holds a reference to, rather than trying to
 * keep a raw DOM element inside Zustand state.
 */
export function createPlaybackController(
  url: string,
  onUpdate: (snapshot: PlaybackSnapshot) => void,
): PlaybackController {
  const audio = new Audio(url);
  audio.preload = "metadata";

  const emit = () => {
    onUpdate({
      isPlaying: !audio.paused && !audio.ended,
      currentTimeSec: audio.currentTime,
      // `duration` is NaN until metadata loads; report 0 until then so
      // callers can treat "no duration yet" and "zero-length" the same way.
      durationSec: Number.isFinite(audio.duration) ? audio.duration : 0,
    });
  };

  const events = ["loadedmetadata", "timeupdate", "play", "pause", "ended", "ratechange"] as const;
  for (const event of events) audio.addEventListener(event, emit);

  return {
    play: () => void audio.play().catch(() => undefined),
    pause: () => audio.pause(),
    seekTo: (sec) => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : Infinity;
      audio.currentTime = Math.min(Math.max(0, sec), duration);
      emit();
    },
    setRate: (rate) => {
      audio.playbackRate = rate;
    },
    dispose: () => {
      audio.pause();
      for (const event of events) audio.removeEventListener(event, emit);
      audio.src = "";
      URL.revokeObjectURL(url);
    },
  };
}
