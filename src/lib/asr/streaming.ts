import type { TranscriptChunk } from "./types";
import type { TranscribeResult } from "./client";
import { isNearSilent, SILENCE_RMS } from "./diagnostics";
import { WHISPER_SAMPLE_RATE as SR } from "../audio/resample";

// How much audio to accumulate before transcribing.
//
// Whisper always encodes a fixed 30s context and pads anything shorter with
// silence, so a 30s window costs the same GPU time as a 15s one -- roughly 2s
// on the Vulkan backend (see WHISPER_PRIORITY_LIVE's own doc comment in
// whisperQueue.ts). This used to be 15s specifically to halve the wait before
// the first text appears, back when the live pass had to be responsive on its
// own; now that windows are submitted through that priority queue instead of
// called directly, sub-second turnaround is no longer a requirement (a window
// may sit behind whatever single background job is currently using the
// model), so there is nothing left to trade away by using the full 30s: fewer,
// larger windows mean fewer sentences get cut at a window boundary, for free.
const WINDOW_SEC = 30;

// Upper bound on audio carried into the next window when whisper transcribes
// less than the whole window.
//
// Without a bound, a window whose chunk ends early would advance by only that
// much, and a model that keeps ending early would make the transcriber re-run on
// almost the same audio indefinitely. With it, every window advances at least
// WINDOW_SEC - MAX_CARRY_SEC, so throughput is capped at ~1.5x windows per unit
// of audio -- comfortable at ~2s of GPU time per window.
const MAX_CARRY_SEC = 5;

// How many times in a row a window may fail to transcribe before its audio is
// dropped from the live pass.
//
// Failures here are not the transcript's problem to solve: the same audio is on
// disk, and the post-stop pass re-reads all of it. What matters is that a
// backend which has stopped working -- the realistic case being a GPU device
// lost across a suspend/resume, after which every whisper call fails -- cannot
// make the recording itself worse. Holding the failed window would grow the
// buffer without bound for the rest of the meeting (nothing else ever frees
// it), so after a few honest attempts the window is dropped and the cursor
// advances past it, exactly as a silent window is dropped.
const MAX_WINDOW_FAILURES = 3;

// How long to wait after a failure before trying again.
//
// Without it the retry cadence is "every incoming frame", i.e. ~10 hopeless
// calls a second into a backend that is already failing.
const RETRY_BACKOFF_MS = 2_000;

/** A chunk of transcript emitted mid-recording, with its offset from recording start. */
export interface StreamingSegment {
  offsetSec: number;
  text: string;
  chunks: TranscriptChunk[];
}

/**
 * Turns a live stream of 16 kHz PCM frames into committed transcript segments
 * while recording continues (chunk-and-commit):
 *
 * - Audio accumulates until ~WINDOW_SEC of *uncommitted* audio exists, then that
 *   window is transcribed.
 * - All chunks except the last are committed; only the last chunk's audio is
 *   carried into the next window (it may still be mid-word). Committing "all but
 *   the last" guarantees the window always advances, so the model is never handed
 *   the same already-transcribed audio again without progress.
 * - Committed audio is dropped from memory, so only ~one window is ever retained.
 *
 * Transcription is serialized: the model pipeline is not re-entrant, so at most
 * one `transcribe` call is in flight at a time.
 *
 * A failing backend degrades rather than derails: windows are retried with a
 * backoff and eventually dropped (see `MAX_WINDOW_FAILURES`), so the live
 * transcript thins out or stops while the recording itself carries on
 * untouched.
 */
export class StreamingTranscriber {
  private frames: Float32Array[] = [];
  private pendingSamples = 0; // samples held in `frames` (uncommitted)
  private committedSamples = 0; // samples committed so far (recording start = 0)
  private processing = false;
  private failures = 0;
  /** Wall-clock time before which no new attempt is made (see RETRY_BACKOFF_MS). */
  private retryAfter = 0;

  constructor(
    private readonly transcribe: (audio: Float32Array) => Promise<TranscribeResult>,
    private readonly onSegment: (seg: StreamingSegment) => void,
    private readonly options: {
      /** Reports that a window's audio was given up on, for a user-facing
       * notice. The recording is unaffected -- see `MAX_WINDOW_FAILURES`. */
      onWindowDropped?: (err: unknown) => void;
      /** Test seam; production uses RETRY_BACKOFF_MS. */
      retryBackoffMs?: number;
      /** RMS floor below which a window is skipped as silence -- see
       * `isNearSilent`. Defaults to `SILENCE_RMS`; overridable so this
       * mirrors the user's `HallucinationSettings.silenceRms`. */
      silenceRms?: number;
      /** Checked between windows inside `drain`'s loop; once it returns
       * `true`, no further window starts decoding (a window already in
       * flight still finishes and commits). Unused by the live mic path,
       * which is naturally paced by real-time audio arrival and rarely has
       * more than one window buffered at a time -- it exists for
       * `postHocTranscriber.ts`'s post-hoc driver, whose PCM can arrive from
       * `read_wav_pcm` far faster than decoding can keep up, so without this
       * hook a cancel request would have no point to actually interrupt the
       * loop at. */
      shouldStop?: () => boolean;
    } = {},
  ) {}

  /** Feed one captured PCM frame (called from the recorder's onFrame). */
  pushFrame(frame: Float32Array): void {
    this.frames.push(frame);
    this.pendingSamples += frame.length;
    void this.maybeProcess();
  }

  /**
   * Flush all remaining audio into final segments. Await after stopping the
   * recorder.
   *
   * Returns whether draining actually reached the end (`exhausted: true`) or
   * was cut short by `shouldStop`/an unrecoverable non-progress case
   * (`exhausted: false`) -- callers that treat "finished flushing" as "fully
   * analyzed" (`postHocTranscriber.ts`) must check this rather than assuming
   * every call reaches the end.
   */
  async finish(): Promise<{ exhausted: boolean }> {
    while (this.processing) await delay(50);
    this.processing = true;
    try {
      return { exhausted: await this.drain(true) };
    } finally {
      this.processing = false;
    }
  }

  private async maybeProcess(): Promise<void> {
    if (this.processing) return;
    if (this.pendingSamples < WINDOW_SEC * SR) return;
    if (Date.now() < this.retryAfter) return;
    this.processing = true;
    try {
      await this.drain(false);
    } finally {
      this.processing = false;
    }
  }

  /**
   * Process windows until drained (final) or below the window size
   * (streaming). Returns whether the loop reached its natural end.
   *
   * A transient per-window failure normally relies on a *future* `pushFrame`
   * call to retry (see `processWindow`) -- true for the live mic path, but
   * `final` drains (`finish()`) never get another `pushFrame`: all audio was
   * already pushed before `finish()` was called (see `postHocTranscriber.ts`).
   * So for `final` drains, a failure that left the retry budget
   * (`MAX_WINDOW_FAILURES`) unexhausted is retried right here, synchronously,
   * honoring the same backoff `maybeProcess` would have waited out.
   */
  private async drain(final: boolean): Promise<boolean> {
    while (true) {
      if (this.options.shouldStop?.() ?? false) return false;
      if (final ? this.pendingSamples === 0 : this.pendingSamples < WINDOW_SEC * SR) return true;
      const before = this.pendingSamples;
      await this.processWindow(final);
      if (this.pendingSamples >= before) {
        if (final && this.failures > 0) {
          await delay(this.options.retryBackoffMs ?? RETRY_BACKOFF_MS);
          continue;
        }
        // Not a retriable failure and no progress was made: nothing further
        // this loop can do (mirrors the old guard against spinning forever).
        return false;
      }
    }
  }

  private concatPending(maxSamples: number): Float32Array {
    const n = Math.min(maxSamples, this.pendingSamples);
    const out = new Float32Array(n);
    let offset = 0;
    for (const frame of this.frames) {
      if (offset >= n) break;
      const take = Math.min(frame.length, n - offset);
      out.set(frame.subarray(0, take), offset);
      offset += take;
    }
    return out;
  }

  private async processWindow(final: boolean): Promise<void> {
    // Capped at WINDOW_SEC: whisper's encoder context is a fixed 30s, and
    // without this cap a backlog (post-hoc PCM can arrive faster than
    // decoding keeps up) would hand whisper more audio than it can use, and
    // would block `shouldStop` from being checked until an arbitrarily large
    // window finishes decoding.
    const windowLen = Math.min(this.pendingSamples, WINDOW_SEC * SR);
    if (windowLen === 0) return;

    const audio = this.concatPending(windowLen);
    const windowSec = windowLen / SR;

    // Never hand whisper a window with no speech in it. Doing so is the main way
    // this app produces garbage: the model invents a stock phrase or falls into a
    // repetition loop ("なぜなぜなぜ..."), and whisper.cpp's own repetition guard
    // cannot catch the short ones because it only evaluates sequences longer than
    // 32 tokens. This bites hardest on the final flush after the user stops, where
    // the leftover fragment is usually just the pause before they clicked.
    if (isNearSilent(audio, this.options.silenceRms ?? SILENCE_RMS)) {
      this.dropFromFront(windowLen);
      this.committedSamples += windowLen;
      return;
    }

    let result: TranscribeResult;
    try {
      result = await this.transcribe(audio);
      this.failures = 0;
    } catch (err) {
      this.failures += 1;
      this.retryAfter = Date.now() + (this.options.retryBackoffMs ?? RETRY_BACKOFF_MS);
      if (this.failures < MAX_WINDOW_FAILURES) {
        // Keep the audio and try again later. Returning without advancing the
        // cursor is also what stops `drain`'s loop (its no-progress guard), so
        // this cannot spin.
        console.warn("[asr] streaming window failed, will retry:", err);
        return;
      }
      // Given up on: drop the window so the buffer cannot grow for the rest of
      // the recording, and let the caller say so. The audio is still on disk
      // and the post-stop pass covers it.
      console.warn("[asr] giving up on a streaming window after repeated failures:", err);
      this.failures = 0;
      this.dropFromFront(windowLen);
      this.committedSamples += windowLen;
      this.options.onWindowDropped?.(err);
      return;
    }
    const chunks = result.chunks ?? [];

    // Decide how much to commit, and how far to advance the audio cursor.
    let committed: TranscriptChunk[];
    let commitSec: number;
    const head = chunks.slice(0, -1);
    const lastHeadEnd = head.length > 0 ? (head[head.length - 1].timestamp[1] ?? 0) : 0;

    if (!final && head.length > 0 && lastHeadEnd > 0) {
      // Normal path: commit every chunk but the last and carry the last chunk's
      // audio, since it may be mid-sentence.
      committed = head;
      commitSec = lastHeadEnd;
    } else {
      // Nothing can be held back: the final flush, a single coarse chunk (common
      // for continuous Japanese), or unusable timestamps. Commit what we have.
      committed = chunks;
      const lastEnd = chunks.length > 0 ? (chunks[chunks.length - 1].timestamp[1] ?? 0) : 0;
      if (final || lastEnd <= 0) {
        // Final flush drains everything; a window with no usable timestamp (e.g.
        // pure silence, which yields no chunks) is dropped whole so it can't spin.
        commitSec = windowSec;
      } else {
        // Advance only as far as whisper actually transcribed, rather than
        // discarding the rest of the window. whisper.cpp deliberately abandons
        // the tail of a chunk when a decode ends on a lone timestamp ("single
        // timestamp ending - skip entire chunk"), and that audio deserves another
        // pass with fresh context instead of being thrown away. Floored so a
        // model that keeps stopping early cannot stall the cursor.
        commitSec = Math.max(lastEnd, windowSec - MAX_CARRY_SEC);
      }
    }

    if (committed.length > 0) {
      this.onSegment({
        offsetSec: this.committedSamples / SR,
        text: committed.map((c) => c.text).join(""),
        chunks: committed,
      });
    }

    // Always advance past what we committed so the same audio is never handed to
    // the model again; carried audio is strictly the uncommitted tail.
    const advance = Math.min(windowLen, Math.max(1, Math.round(commitSec * SR)));
    this.dropFromFront(advance);
    this.committedSamples += advance;
  }

  private dropFromFront(n: number): void {
    let removed = 0;
    while (this.frames.length > 0 && removed + this.frames[0].length <= n) {
      removed += this.frames[0].length;
      this.frames.shift();
    }
    if (removed < n && this.frames.length > 0) {
      this.frames[0] = this.frames[0].subarray(n - removed);
      removed = n;
    }
    this.pendingSamples -= removed;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
