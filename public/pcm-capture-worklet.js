/* eslint-disable no-undef */
// AudioWorklet processor that forwards captured microphone audio to the main
// thread as raw mono Float32 frames. It runs inside an AudioContext created with
// { sampleRate: 16000 }, so the frames are already at Whisper's expected rate and
// no manual resampling is needed. It writes nothing to its outputs, so wiring the
// node to the destination (required for process() to be pulled) stays silent.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    const ch0 = input && input[0];
    if (!ch0) return true;

    let frame;
    if (input.length > 1) {
      // Downmix to mono by averaging channels.
      frame = new Float32Array(ch0.length);
      for (let c = 0; c < input.length; c++) {
        const ch = input[c];
        for (let i = 0; i < ch0.length; i++) frame[i] += ch[i];
      }
      for (let i = 0; i < frame.length; i++) frame[i] /= input.length;
    } else {
      frame = ch0.slice();
    }

    this.port.postMessage(frame, [frame.buffer]);
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
