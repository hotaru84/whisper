// Cheap health logging so a future regression (garbled/repeated output, silent
// audio) is diagnosable from the console without re-instrumenting.

/**
 * RMS amplitude below which a window is treated as containing no speech.
 *
 * Deliberately conservative. Being too low only costs us some of the benefit
 * (silence still reaches the model); being too high would discard quiet but real
 * speech, which is far worse. A live mic never reaches digital silence, and with
 * Chromium's automatic gain control on by default its noise floor can sit well
 * above this — so if silence-driven hallucinations persist, read the `rms=` value
 * `logPcmStats` prints for a genuinely quiet window and raise this to just under
 * it rather than guessing.
 */
export const SILENCE_RMS = 1e-3;

/** Root-mean-square amplitude of a PCM buffer. */
export function rms(audio: Float32Array): number {
  if (audio.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < audio.length; i++) sumSq += audio[i] * audio[i];
  return Math.sqrt(sumSq / audio.length);
}

/**
 * Whether a window holds no speech worth transcribing.
 *
 * Handing whisper silence is the classic way to get a hallucination: it will
 * confidently invent a stock phrase (「ご視聴ありがとうございました」) or fall
 * into a repetition loop. whisper.cpp's own repetition guard cannot save us
 * there — it only evaluates sequences longer than 32 tokens
 * (whisper.cpp:7527), so the short loops that silence produces are never
 * checked. Gating on the input side avoids the problem entirely, and unlike
 * filtering the output afterwards it cannot delete real speech.
 */
export function isNearSilent(audio: Float32Array): boolean {
  return rms(audio) < SILENCE_RMS;
}

export function logPcmStats(audio: Float32Array, language: string | undefined, task: string | undefined): void {
  const n = audio.length;
  let min = Infinity;
  let max = -Infinity;
  let clipped = 0;
  for (let i = 0; i < n; i++) {
    const v = audio[i];
    if (v < min) min = v;
    if (v > max) max = v;
    if (v > 1 || v < -1) clipped++;
  }
  const level = rms(audio);
  console.info(
    "[asr] PCM: samples=%d dur=%ss min=%s max=%s rms=%s clipped=%d | language=%o task=%o",
    n,
    (n / 16000).toFixed(2),
    min.toFixed(4),
    max.toFixed(4),
    level.toFixed(4),
    clipped,
    language,
    task,
  );
  if (n === 0) console.warn("[asr] PCM is EMPTY — decode/resample produced no samples");
  else if (level < SILENCE_RMS)
    console.warn("[asr] PCM looks like near-SILENCE (rms<%s) — mic/capture issue likely", SILENCE_RMS);
  else if (clipped > 0) console.warn("[asr] PCM has %d out-of-range samples — normalization issue", clipped);
}

/** Length of the character n-gram used to detect repetition loops. */
const NGRAM = 4;

/**
 * Finds the most-repeated character n-gram and how often it occurs.
 *
 * Character n-grams rather than whitespace-delimited words: Japanese output has
 * essentially no spaces, so a word-based counter sees the whole window as a
 * single token and can never fire. Exported for testing.
 */
export function topRepeatedNgram(text: string, n = NGRAM): { gram: string; count: number; total: number } {
  const chars = Array.from(text);
  if (chars.length < n) return { gram: "", count: 0, total: 0 };

  const counts = new Map<string, number>();
  for (let i = 0; i + n <= chars.length; i++) {
    const gram = chars.slice(i, i + n).join("");
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }

  let gram = "";
  let count = 0;
  for (const [g, c] of counts) {
    if (c > count) {
      gram = g;
      count = c;
    }
  }
  return { gram, count, total: counts.size ? chars.length - n + 1 : 0 };
}

/**
 * Flags the degenerate repetition loops whisper falls into, where one phrase is
 * emitted over and over.
 *
 * The transformers.js pipeline this replaced suppressed those with
 * `no_repeat_ngram_size: 3`; whisper.cpp has no equivalent, so the best we can do
 * at this layer is notice and say so.
 */
export function logResultHealth(text: string): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    console.warn("[asr] result text is EMPTY");
    return;
  }

  const { gram, count, total } = topRepeatedNgram(trimmed);
  const ratio = total > 0 ? count / total : 0;
  console.info(
    "[asr] result: chars=%d top%dgram=%o x%d (%.0f%%) preview=%o",
    Array.from(trimmed).length,
    NGRAM,
    gram,
    count,
    ratio * 100,
    trimmed.slice(0, 120),
  );
  // A 4-gram recurring this often is not natural repetition; ordinary Japanese
  // reuses short sequences, but not for a fifth of a window.
  if (count >= 5 && ratio > 0.2) {
    console.warn(
      "[asr] result looks REPETITIVE (%o repeated %d×) — degenerate decode likely",
      gram,
      count,
    );
  }
}
