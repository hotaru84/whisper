import { describe, it, expect, vi } from "vitest";
import { AudioEventStreamer } from "./eventStreaming";
import type { AudioEvent } from "./client";

const SR = 16000;
const FRAME = 128;
const WINDOW_SEC = 10;

/** Feeds `seconds` of audio in small frames, yielding periodically so the
 * streamer's async processing can interleave, the same shape `feed` takes in
 * streaming.test.ts. */
async function feed(streamer: AudioEventStreamer, seconds: number): Promise<void> {
  let remaining = Math.round(seconds * SR);
  while (remaining > 0) {
    const len = Math.min(FRAME, remaining);
    streamer.pushFrame(new Float32Array(len));
    remaining -= len;
    await Promise.resolve();
  }
}

function ev(name: string): AudioEvent {
  return { start: 0, end: 0, name, index: 0, prob: 0.9 };
}

describe("AudioEventStreamer", () => {
  it("tags fixed-size windows in order, with correctly advancing start times", async () => {
    const calls: { audioLen: number; startSec: number }[] = [];
    const detect = vi.fn((audio: Float32Array, startSec: number) => {
      calls.push({ audioLen: audio.length, startSec });
      return Promise.resolve<AudioEvent[]>([]);
    });
    const streamer = new AudioEventStreamer(detect, () => {});

    await feed(streamer, 35);
    await streamer.finish();

    // 35s of audio at a 10s window is three full windows plus a 5s flush.
    expect(calls).toHaveLength(4);
    expect(calls[0]).toEqual({ audioLen: WINDOW_SEC * SR, startSec: 0 });
    expect(calls[1]).toEqual({ audioLen: WINDOW_SEC * SR, startSec: 10 });
    expect(calls[2]).toEqual({ audioLen: WINDOW_SEC * SR, startSec: 20 });
    expect(calls[3]).toEqual({ audioLen: 5 * SR, startSec: 30 });
  });

  it("never hands a window more than WINDOW_SEC of audio, even when frames back up behind a slow detect call", async () => {
    const lens: number[] = [];
    let resolveFirst: (() => void) | undefined;
    const detect = vi.fn((audio: Float32Array) => {
      lens.push(audio.length);
      if (lens.length === 1) {
        // Block the first window's resolution until well after more than a
        // second window's worth of audio has already been pushed, so any bug
        // that hands "everything pending" to one call would be caught here.
        return new Promise<AudioEvent[]>((resolve) => {
          resolveFirst = () => resolve([]);
        });
      }
      return Promise.resolve<AudioEvent[]>([]);
    });
    const streamer = new AudioEventStreamer(detect, () => {});

    void feed(streamer, 25);
    // Let the first window's call fire and start blocking.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    resolveFirst?.();
    await streamer.finish();

    for (const len of lens) expect(len).toBeLessThanOrEqual(WINDOW_SEC * SR);
  });

  it("forwards detected events to onEvents, but only when a window found any", async () => {
    const detect = vi
      .fn()
      .mockResolvedValueOnce([ev("Music")])
      .mockResolvedValueOnce([]);
    const received: AudioEvent[][] = [];
    const streamer = new AudioEventStreamer(detect, (events) => received.push(events));

    await feed(streamer, 20);
    await streamer.finish();

    expect(received).toEqual([[ev("Music")]]);
  });

  it("keeps processing later windows after one window's detect call rejects", async () => {
    const detect = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce([ev("Applause")]);
    const received: AudioEvent[][] = [];
    const streamer = new AudioEventStreamer(detect, (events) => received.push(events));

    await feed(streamer, 20);
    await streamer.finish();

    expect(received).toEqual([[ev("Applause")]]);
  });
});
