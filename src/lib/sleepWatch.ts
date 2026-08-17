/**
 * Detects that the machine was suspended (or the app was otherwise frozen)
 * while it was supposed to be running.
 *
 * Windows sends no signal a webview can subscribe to, so this uses the oldest
 * trick available: a short interval that compares wall clock against how much
 * time it *should* have taken. A timer scheduled for one second that comes back
 * an hour later did not run slowly -- nothing ran at all.
 *
 * Why the app cares at all: a suspend mid-recording is silently lossy. No
 * frames are captured while the process is frozen, so the audio either side of
 * the gap is spliced together with nothing in between and no indication that
 * anything is missing. The recording is otherwise fine -- the WAV, the sample
 * counts and every timeline derived from them all stay consistent (see
 * `pcmRecorder.ts`'s `capturedSamples`) -- which is exactly why the user has to
 * be told: nothing else about the finished take will ever look wrong.
 *
 * Deliberately generous: a gap is only reported when it is far larger than any
 * amount of GC, tab throttling or a busy machine could explain, so this never
 * cries wolf at the cost of missing very short suspends (which lose very
 * little audio anyway).
 */

/** How often the clock is checked. */
const TICK_MS = 1_000;

/**
 * How far behind schedule a tick has to be before it counts as a suspend.
 *
 * Ten seconds of drift is not something a running process produces: even a
 * badly starved main thread recovers within a second or two, and a background
 * webview's throttled timers stay in the same order of magnitude. A real
 * suspend is minutes to hours.
 */
const GAP_THRESHOLD_MS = 10_000;

/**
 * Calls `onGap` with the length of the gap, in seconds, whenever wall clock
 * jumps further than a running timer could account for. Returns a disposer.
 *
 * `now` is injectable purely for the tests; production callers pass nothing.
 */
export function startSleepWatch(
  onGap: (gapSec: number) => void,
  options: { tickMs?: number; thresholdMs?: number; now?: () => number } = {},
): () => void {
  const tickMs = options.tickMs ?? TICK_MS;
  const thresholdMs = options.thresholdMs ?? GAP_THRESHOLD_MS;
  const now = options.now ?? Date.now;

  let expectedAt = now() + tickMs;
  const id = setInterval(() => {
    const at = now();
    const drift = at - expectedAt;
    expectedAt = at + tickMs;
    if (drift >= thresholdMs) {
      // Reported as the whole gap (drift plus the tick that was owed), which
      // is what the user experienced as "the machine was away".
      onGap((drift + tickMs) / 1000);
    }
  }, tickMs);

  return () => clearInterval(id);
}
