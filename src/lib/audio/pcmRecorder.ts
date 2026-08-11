import { WHISPER_SAMPLE_RATE } from "./resample";

// Served from public/ as a same-origin ('self') script so it satisfies the
// Tauri CSP `script-src 'self'`. It must NOT be bundled/inlined as a data: URL,
// which the CSP would block (AudioWorklet.addModule is governed by script-src).
const WORKLET_URL = "/pcm-capture-worklet.js";

export interface PcmRecorderController {
  /** Stops recording and resolves with the total number of samples captured. */
  stop: () => Promise<number>;
  /** Stops recording and discards the result. */
  cancel: () => void;
  /** The live microphone stream, e.g. for driving a level meter. */
  stream: MediaStream;
}

/**
 * Captures microphone audio as raw 16 kHz mono PCM via an AudioWorklet, instead
 * of encoding to WebM/Opus with MediaRecorder. Frames are handed to `onFrame` as
 * they arrive and are not retained here, so the recorder itself uses ~no memory
 * regardless of recording length; the streaming transcriber owns buffering. Only
 * the captured sample count is tracked, so `stop()` can report the duration.
 */
export async function startPcmRecording(
  onFrame: (frame: Float32Array) => void,
): Promise<PcmRecorderController> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  // Forcing the context rate makes the browser resample the mic to 16 kHz for us.
  const audioCtx = new AudioContext({ sampleRate: WHISPER_SAMPLE_RATE });
  await audioCtx.audioWorklet.addModule(WORKLET_URL);

  const source = audioCtx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(audioCtx, "pcm-capture");

  let totalSamples = 0;
  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
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
    stop: async () => {
      teardown();
      return totalSamples;
    },
    cancel: () => {
      teardown();
    },
  };
}
