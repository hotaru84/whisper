import { WHISPER_SAMPLE_RATE } from "./resample";

// Served from public/ as a same-origin ('self') script so it satisfies the
// Tauri CSP `script-src 'self'`. It must NOT be bundled/inlined as a data: URL,
// which the CSP would block (AudioWorklet.addModule is governed by script-src).
const WORKLET_URL = "/pcm-capture-worklet.js";

/** Why `onDropout` fired, for the message the user ends up seeing. */
export type MicDropoutReason = "ended" | "stalled";

/**
 * How the watchdog below reads the recorder's vital signs. Pure and exported
 * so the decision -- which is all timing edge cases -- can be unit-tested
 * without a microphone, an AudioContext or a clock.
 *
 * - `"ok"`: frames are arriving (or collection is paused on purpose).
 * - `"probe"`: nothing has arrived recently, but not yet long enough to call
 *   it dead. The caller nudges the context and starts the grace period.
 * - `"dropout"`: the stream is gone.
 *
 * The two-step probe exists specifically for suspend/resume. Both clocks here
 * are wall clock, so a machine that slept for an hour comes back with a
 * frame-gap of an hour no matter how healthy the microphone is -- the first
 * check after a resume can never distinguish "the mic died" from "the whole
 * process was frozen". So the first check only ever probes, and a dropout
 * needs a second check that still sees no frames after `graceMs` of real,
 * running time. A microphone that survived the suspend delivers its next
 * frame within ~100ms and clears the mark long before then.
 *
 * A track that reports `ended` skips the grace period: that state is terminal
 * (the device is gone; it never comes back on its own), so waiting only delays
 * telling the user.
 */
export function evaluateMicHealth(input: {
  paused: boolean;
  trackEnded: boolean;
  /** Since the last captured frame. */
  msSinceFrame: number;
  /** Since the first check that saw no frames, or null if none has yet. */
  msSinceProbe: number | null;
  quietMs: number;
  graceMs: number;
}): "ok" | "probe" | "dropout" {
  // Paused means "stop collecting" (see `setPaused`), so silence is expected
  // and the mark from before the pause must not survive into it.
  if (input.paused) return "ok";
  if (input.trackEnded) return "dropout";
  if (input.msSinceFrame < input.quietMs) return "ok";
  if (input.msSinceProbe === null) return "probe";
  return input.msSinceProbe >= input.graceMs ? "dropout" : "probe";
}

/** How long without a frame before the watchdog starts suspecting trouble.
 * Frames arrive every ~100ms, so this is ~30 missed frames -- far beyond any
 * scheduling hiccup, well short of annoying the user. */
const QUIET_MS = 3_000;
/** How long the suspicion has to persist, in real running time, before it
 * counts as a dropout. See `evaluateMicHealth`. */
const GRACE_MS = 5_000;
/** How often the vitals above are checked. */
const WATCHDOG_INTERVAL_MS = 2_000;

export interface PcmRecorderController {
  /** Stops recording and resolves with the total number of samples captured. */
  stop: () => Promise<number>;
  /**
   * Samples captured so far -- i.e. what `stop()` would report right now.
   *
   * This, not wall clock, is how long the recording actually is: paused spans
   * are absent from it, and so is any span the machine spent suspended (no
   * frames arrive while the process is frozen). Anything that displays or
   * derives a recording position should read it from here.
   */
  capturedSamples: () => number;
  /**
   * Suspends/resumes frame collection without tearing anything down.
   *
   * While paused, frames are dropped *and not counted*, so the paused span is
   * absent from the recording rather than being captured as silence. Both
   * halves matter: dropping the frames but still counting them would make
   * `stop()`'s sample total exceed what actually reached the WAV, and every
   * downstream timeline (`timelineBaseSec`, segment offsets) is derived from
   * that total.
   *
   * The mic track stays open, so the OS recording indicator does not go off --
   * this is "stop collecting", not "release the microphone".
   */
  setPaused: (paused: boolean) => void;
  /** The live microphone stream, e.g. for driving a level meter. */
  stream: MediaStream;
  /**
   * True when a specific `deviceId` was requested but could not be honored
   * (most commonly: the saved device was unplugged) and recording fell back to
   * the system default instead of failing outright.
   */
  usedFallbackDevice: boolean;
}

/**
 * Captures microphone audio as raw 16 kHz mono PCM via an AudioWorklet, instead
 * of encoding to WebM/Opus with MediaRecorder. Frames are handed to `onFrame` as
 * they arrive and are not retained here, so the recorder itself uses ~no memory
 * regardless of recording length; the streaming transcriber owns buffering. Only
 * the captured sample count is tracked, so `stop()` can report the duration.
 *
 * `deviceId` selects a specific microphone (from `devices.ts`); omit it, or
 * pass the empty string, for the system default. A saved device that has since
 * been unplugged raises `OverconstrainedError` under `{ exact: ... }` -- rather
 * than fail the recording outright, this falls back to the default device and
 * reports that via `usedFallbackDevice` so the caller can tell the user.
 *
 * `onDropout` fires at most once, when the capture stops delivering frames for
 * reasons of its own -- the device disappearing, or the audio graph coming
 * back from a suspend in a state it cannot be resumed from. Nothing here can
 * fix that (a dead `MediaStreamTrack` never revives; a new `getUserMedia` call
 * would be a different stream mid-recording), so the recorder reports it and
 * leaves the response to the caller. Without it a dropout is silent: frames
 * simply stop, and the app goes on claiming to record for as long as the user
 * lets it.
 */
export async function startPcmRecording(
  onFrame: (frame: Float32Array) => void,
  deviceId?: string,
  onDropout?: (reason: MicDropoutReason) => void,
): Promise<PcmRecorderController> {
  let stream: MediaStream;
  let usedFallbackDevice = false;
  if (deviceId) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
    } catch (err) {
      if (err instanceof DOMException && err.name === "OverconstrainedError") {
        usedFallbackDevice = true;
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } else {
        throw err;
      }
    }
  } else {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }
  // Forcing the context rate makes the browser resample the mic to 16 kHz for us.
  const audioCtx = new AudioContext({ sampleRate: WHISPER_SAMPLE_RATE });
  await audioCtx.audioWorklet.addModule(WORKLET_URL);

  const source = audioCtx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(audioCtx, "pcm-capture");

  let totalSamples = 0;
  let paused = false;
  let lastFrameAt = Date.now();
  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (paused) return;
    const frame = event.data;
    totalSamples += frame.length;
    lastFrameAt = Date.now();
    onFrame(frame);
  };

  source.connect(node);
  // process() is only pulled when the node reaches the destination. The processor
  // writes no output, so this connection produces no audible sound (no feedback).
  node.connect(audioCtx.destination);

  let stopped = false;
  let reportedDropout = false;
  let probeStartedAt: number | null = null;
  // Guarded against the empty case on purpose: `[].every(...)` is `true`, which
  // would otherwise read as "every track ended" and fire a dropout on the first
  // check. A stream with no audio track at all is a different (impossible here,
  // since getUserMedia asked for audio) problem, not a device that died.
  const allTracksEnded = () => {
    const tracks = stream.getAudioTracks();
    return tracks.length > 0 && tracks.every((t) => t.readyState === "ended");
  };
  const reportDropout = (reason: MicDropoutReason) => {
    if (stopped || reportedDropout) return;
    reportedDropout = true;
    onDropout?.(reason);
  };

  // Polled rather than purely event-driven: `ended` covers an unplugged or
  // removed device, but an audio graph that comes back from a suspend without
  // its render thread fires no event at all -- it just goes quiet, which only
  // a watchdog can see.
  const watchdog = setInterval(() => {
    if (stopped) return;
    const verdict = evaluateMicHealth({
      paused,
      trackEnded: allTracksEnded(),
      msSinceFrame: Date.now() - lastFrameAt,
      msSinceProbe: probeStartedAt === null ? null : Date.now() - probeStartedAt,
      quietMs: QUIET_MS,
      graceMs: GRACE_MS,
    });
    if (verdict === "ok") {
      probeStartedAt = null;
      return;
    }
    if (verdict === "probe") {
      if (probeStartedAt === null) {
        probeStartedAt = Date.now();
        // The one recovery worth attempting: a context the browser suspended
        // on its own (a resume commonly lands here) restarts from this, and
        // frames resume before the grace period is up. A rejection is not
        // itself the verdict -- the next check makes that call.
        if (audioCtx.state !== "running") void audioCtx.resume().catch(() => {});
      }
      return;
    }
    reportDropout(allTracksEnded() ? "ended" : "stalled");
  }, WATCHDOG_INTERVAL_MS);

  // The direct signal, when the device itself goes away: terminal and
  // immediate, so there is nothing for the watchdog's grace period to add.
  for (const track of stream.getAudioTracks()) {
    track.addEventListener("ended", () => reportDropout("ended"));
  }

  const teardown = () => {
    stopped = true;
    clearInterval(watchdog);
    node.port.onmessage = null;
    source.disconnect();
    node.disconnect();
    for (const track of stream.getTracks()) track.stop();
    void audioCtx.close();
  };

  return {
    stream,
    usedFallbackDevice,
    capturedSamples: () => totalSamples,
    setPaused: (next: boolean) => {
      paused = next;
      // Nothing has been missed while paused, so the pause must not count
      // toward the quiet window the moment collection resumes.
      if (!next) {
        lastFrameAt = Date.now();
        probeStartedAt = null;
      }
    },
    stop: async () => {
      teardown();
      return totalSamples;
    },
  };
}
