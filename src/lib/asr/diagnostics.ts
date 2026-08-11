// Cheap health logging so a future regression (garbled/repeated output, silent
// audio) is diagnosable from the console without re-instrumenting.

export function logPcmStats(audio: Float32Array, language: string | undefined, task: string | undefined): void {
  const n = audio.length;
  let min = Infinity;
  let max = -Infinity;
  let sumSq = 0;
  let clipped = 0;
  for (let i = 0; i < n; i++) {
    const v = audio[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sumSq += v * v;
    if (v > 1 || v < -1) clipped++;
  }
  const rms = n ? Math.sqrt(sumSq / n) : 0;
  console.info(
    "[asr] PCM: samples=%d dur=%ss min=%s max=%s rms=%s clipped=%d | language=%o task=%o",
    n,
    (n / 16000).toFixed(2),
    min.toFixed(4),
    max.toFixed(4),
    rms.toFixed(4),
    clipped,
    language,
    task,
  );
  if (n === 0) console.warn("[asr] PCM is EMPTY — decode/resample produced no samples");
  else if (rms < 1e-3) console.warn("[asr] PCM looks like near-SILENCE (rms<0.001) — mic/capture issue likely");
  else if (clipped > 0) console.warn("[asr] PCM has %d out-of-range samples — normalization issue", clipped);
}

/** Rough repetition detector: fraction of the most-repeated token among words. */
export function logResultHealth(text: string): void {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    console.warn("[asr] result text is EMPTY");
    return;
  }
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  let topWord = "";
  let topCount = 0;
  for (const [w, c] of counts) if (c > topCount) [topWord, topCount] = [w, c];
  const ratio = topCount / words.length;
  console.info(
    "[asr] result: chars=%d words=%d topWord=%o x%d (%.0f%%) preview=%o",
    text.length,
    words.length,
    topWord,
    topCount,
    ratio * 100,
    text.slice(0, 120),
  );
  if (ratio > 0.3 && topCount > 3) {
    console.warn("[asr] result looks REPETITIVE (%s repeated %d×) — model degradation likely", topWord, topCount);
  }
}
