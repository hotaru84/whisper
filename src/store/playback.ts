/**
 * Playback of a finished recording's WAV, independent of everything else the
 * store tracks -- the recording lifecycle, the accuracy pipeline, and history
 * browsing all just call into this (via `loadPlayback`/`unloadPlayback`) when
 * they have a WAV ready to show, and otherwise never touch `playbackController`.
 */
import { wavToBlobUrl, createPlaybackController } from "../lib/audio";
import type { PlaybackController } from "../lib/audio";
import { useAppStore } from "./appStore";

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
  /**
   * Bumped by every explicit seek (`seekTo`, `skip`) -- never by the ordinary
   * ticking of `currentTimeSec` during playback. `TranscriptPanel` watches
   * this to jump the transcript to the seeked-to segment unconditionally,
   * distinct from its "follow the playhead while playing" effect, which
   * deliberately backs off once the user has scrolled away to read something
   * else. An explicit seek -- the timeline slider, a segment's own timestamp,
   * an audio-event block -- is a "take me there" action that should win over
   * that escape hatch; a `currentTimeSec` change from a tick should not.
   */
  seekSeq: number;
}

export const IDLE_PLAYBACK: PlaybackState = {
  recordingId: null,
  loading: false,
  isPlaying: false,
  currentTimeSec: 0,
  durationSec: 0,
  rate: 1,
  timelineOffsetSec: 0,
  seekSeq: 0,
};

// The live `<audio>` wrapper backing `playback` state, if anything is loaded.
// Not part of Zustand state itself -- see `createPlaybackController`'s doc
// comment, same reasoning as `levelMeter` (in `appStore.ts`) already being a
// class instance rather than plain data.
let playbackController: PlaybackController | null = null;

/** Loads `path`'s audio for playback, tagged with `recordingId` so the UI can
 * tell it apart from whatever was loaded before. Replaces (and disposes) any
 * previously loaded audio; a no-op if `recordingId` is already the one loaded. */
export async function loadPlayback(recordingId: string, path: string, timelineOffsetSec = 0): Promise<void> {
  const { getState, setState } = useAppStore;
  if (getState().playback.recordingId === recordingId) return;
  playbackController?.dispose();
  playbackController = null;
  setState({ playback: { ...IDLE_PLAYBACK, recordingId, timelineOffsetSec, loading: true } });
  try {
    const url = await wavToBlobUrl(path);
    // The user may have switched away (a new recording, a different
    // history entry) while the file was being read -- don't let a slow
    // load clobber whatever is current by the time it resolves.
    if (getState().playback.recordingId !== recordingId) {
      URL.revokeObjectURL(url);
      return;
    }
    playbackController = createPlaybackController(url, (snapshot) => {
      setState((s) => (s.playback.recordingId === recordingId ? { playback: { ...s.playback, ...snapshot } } : {}));
    });
    setState((s) => (s.playback.recordingId === recordingId ? { playback: { ...s.playback, loading: false } } : {}));
  } catch (err) {
    console.warn("[playback] failed to load recording audio:", err);
    setState((s) => (s.playback.recordingId === recordingId ? { playback: IDLE_PLAYBACK } : {}));
  }
}

export function unloadPlayback(): void {
  playbackController?.dispose();
  playbackController = null;
  useAppStore.setState({ playback: IDLE_PLAYBACK });
}

export function togglePlayback(): void {
  if (!playbackController) return;
  if (useAppStore.getState().playback.isPlaying) playbackController.pause();
  else playbackController.play();
}

// Bumps `seekSeq` so `TranscriptPanel` can jump to the seeked-to segment --
// see `PlaybackState.seekSeq`'s doc comment. `playbackController.seekTo`
// already updates `currentTimeSec` synchronously (through its own `emit()`),
// so by the time this second `setState` runs, `activeSegmentId` derived from
// it is already correct for whichever row the effect ends up scrolling to.
export function seekTo(sec: number): void {
  playbackController?.seekTo(sec);
  useAppStore.setState((s) => ({ playback: { ...s.playback, seekSeq: s.playback.seekSeq + 1 } }));
}

// Routed through `seekTo` itself (rather than calling
// `playbackController.seekTo` directly, as this used to) so a skip bumps
// `seekSeq` exactly like any other seek -- the ←/→ keys and the 10s buttons
// are just as much a "take me there" action as dragging the slider.
export function skip(deltaSec: number): void {
  const { currentTimeSec } = useAppStore.getState().playback;
  seekTo(currentTimeSec + deltaSec);
}

export function setPlaybackRate(rate: number): void {
  playbackController?.setRate(rate);
  useAppStore.setState((s) => ({ playback: { ...s.playback, rate } }));
}
