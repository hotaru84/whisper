import type { TranscriptChunk } from "./types";
import type { TranscribeResult } from "./client";
import { WHISPER_SAMPLE_RATE as SR } from "../audio/resample";

// Whisper always encodes a fixed 30s context, padding anything shorter with
// silence, so a smaller window costs exactly the same as a 30s one while giving
// the model less to work with. Match the native window instead of wasting it.
const WINDOW_SEC = 30;

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
 */
export class StreamingTranscriber {
  private frames: Float32Array[] = [];
  private pendingSamples = 0; // samples held in `frames` (uncommitted)
  private committedSamples = 0; // samples committed so far (recording start = 0)
  private processing = false;

  constructor(
    private readonly transcribe: (audio: Float32Array) => Promise<TranscribeResult>,
    private readonly onSegment: (seg: StreamingSegment) => void,
  ) {}

  /** Feed one captured PCM frame (called from the recorder's onFrame). */
  pushFrame(frame: Float32Array): void {
    this.frames.push(frame);
    this.pendingSamples += frame.length;
    void this.maybeProcess();
  }

  /** Flush all remaining audio into final segments. Await after stopping the recorder. */
  async finish(): Promise<void> {
    while (this.processing) await delay(50);
    this.processing = true;
    try {
      await this.drain(true);
    } finally {
      this.processing = false;
    }
  }

  private async maybeProcess(): Promise<void> {
    if (this.processing) return;
    if (this.pendingSamples < WINDOW_SEC * SR) return;
    this.processing = true;
    try {
      await this.drain(false);
    } finally {
      this.processing = false;
    }
  }

  /** Process windows until drained (final) or below the window size (streaming). */
  private async drain(final: boolean): Promise<void> {
    while (final ? this.pendingSamples > 0 : this.pendingSamples >= WINDOW_SEC * SR) {
      const before = this.pendingSamples;
      await this.processWindow(final);
      // Guard against any no-progress path: stop rather than re-transcribe the
      // same audio forever (the next pushFrame will retry once more audio lands).
      if (this.pendingSamples >= before) break;
    }
  }

  private concatPending(): Float32Array {
    const out = new Float32Array(this.pendingSamples);
    let offset = 0;
    for (const frame of this.frames) {
      out.set(frame, offset);
      offset += frame.length;
    }
    return out;
  }

  private async processWindow(final: boolean): Promise<void> {
    const windowLen = this.pendingSamples;
    if (windowLen === 0) return;

    const audio = this.concatPending();
    const windowSec = windowLen / SR;
    const result = await this.transcribe(audio);
    const chunks = result.chunks ?? [];

    // Decide how much to commit. On the final flush, or when the window can't be
    // split (0 or 1 chunk), commit the whole window. Otherwise commit every chunk
    // but the last and carry only the last chunk's audio.
    let committed: TranscriptChunk[];
    let commitSec: number;
    const head = chunks.slice(0, -1);
    const lastHeadEnd = head.length > 0 ? (head[head.length - 1].timestamp[1] ?? 0) : 0;
    if (final || chunks.length <= 1 || lastHeadEnd <= 0) {
      committed = chunks;
      commitSec = windowSec; // drop the entire window
    } else {
      committed = head;
      commitSec = lastHeadEnd;
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
