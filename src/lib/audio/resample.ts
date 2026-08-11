export const WHISPER_SAMPLE_RATE = 16000;

/**
 * Decodes a recorded audio Blob and resamples it to mono Float32 PCM at
 * WHISPER_SAMPLE_RATE, matching the input format expected by the Whisper ASR pipeline.
 */
export async function decodeAudioToPcm16k(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  } finally {
    await decodeCtx.close();
  }

  if (decoded.sampleRate === WHISPER_SAMPLE_RATE && decoded.numberOfChannels === 1) {
    return decoded.getChannelData(0);
  }

  const targetLength = Math.ceil(decoded.duration * WHISPER_SAMPLE_RATE);
  const offlineCtx = new OfflineAudioContext(1, targetLength, WHISPER_SAMPLE_RATE);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  // OfflineAudioContext downmixes to the destination's channel count per the
  // Web Audio spec, so a multi-channel source connected here is handled automatically.
  source.connect(offlineCtx.destination);
  source.start(0);

  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
}
