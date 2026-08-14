import { WHISPER_SAMPLE_RATE } from "./resample";

// Served from public/ as a same-origin ('self') script so it satisfies the
// Tauri CSP `script-src 'self'`. It must NOT be bundled/inlined as a data: URL,
// which the CSP would block (AudioWorklet.addModule is governed by script-src).
const WORKLET_URL = "/pcm-capture-worklet.js";

export interface PcmRecorderController {
  /** Stops recording and resolves with the total number of samples captured. */
  stop: () => Promise<number>;
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
 */
export async function startPcmRecording(
  onFrame: (frame: Float32Array) => void,
  deviceId?: string,
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
  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (paused) return;
    const frame = event.data;
    totalSamples += frame.length;
    onFrame(frame);
  };

  source.connect(node);
  // process() is only pulled when the node reaches the destination. The processor
  // writes no output, so this connection produces no audible sound (no feedback).
  node.connect(audioCtx.destination);

  const teardown = () => {
    node.port.onmessage = null;
    source.disconnect();
    node.disconnect();
    for (const track of stream.getTracks()) track.stop();
    void audioCtx.close();
  };

  return {
    stream,
    usedFallbackDevice,
    setPaused: (next: boolean) => {
      paused = next;
    },
    stop: async () => {
      teardown();
      return totalSamples;
    },
  };
}
