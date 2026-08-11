export interface AudioLevelMeter {
  /** Current audio level as an RMS value in the 0-1 range. */
  getLevel: () => number;
  dispose: () => void;
}

/**
 * Creates a lightweight RMS level meter for a live MediaStream, for driving
 * a volume indicator while recording. Call dispose() when the stream stops.
 */
export function createAudioLevelMeter(stream: MediaStream): AudioLevelMeter {
  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.8;
  source.connect(analyser);

  const buffer = new Float32Array(analyser.fftSize);

  return {
    getLevel: () => {
      analyser.getFloatTimeDomainData(buffer);
      let sumSquares = 0;
      for (const sample of buffer) sumSquares += sample * sample;
      return Math.sqrt(sumSquares / buffer.length);
    },
    dispose: () => {
      source.disconnect();
      analyser.disconnect();
      void audioCtx.close();
    },
  };
}
