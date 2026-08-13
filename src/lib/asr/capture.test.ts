import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { RecordingCapture } = await import("./capture");
const { WHISPER_SAMPLE_RATE } = await import("../audio/resample");

const FLUSH_SAMPLES = 5 * WHISPER_SAMPLE_RATE;

/** A frame whose samples are all `value`, so a batch's provenance is readable. */
function frame(length: number, value: number): Float32Array {
  return new Float32Array(length).fill(value);
}

/** The f32 values of every append_capture call, in the order the backend saw them. */
function appendedValues(): number[][] {
  return invoke.mock.calls
    .filter((c) => c[0] === "append_capture")
    .map((c) => Array.from(new Float32Array((c[1] as Uint8Array).buffer)));
}

/**
 * Lets the queued flush actually reach the backend.
 *
 * `push()` only appends to the serializing promise chain, so the `invoke` call
 * happens a microtask later; a macrotask boundary drains all of them.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "start_capture") return Promise.resolve("C:/cache/recordings/rec.wav");
    if (cmd === "finish_capture")
      return Promise.resolve({ path: "C:/cache/recordings/rec.wav", durationSec: 12.5 });
    return Promise.resolve();
  });
});

describe("RecordingCapture", () => {
  it("holds frames until a flush window has accumulated", async () => {
    const capture = new RecordingCapture();
    await capture.start();

    capture.push(frame(FLUSH_SAMPLES - 1, 0.1));
    await tick();
    expect(appendedValues()).toHaveLength(0);

    capture.push(frame(1, 0.2));
    await tick();
    expect(appendedValues()).toHaveLength(1);
    // One flush carrying the whole window, not one call per frame.
    expect(appendedValues()[0]).toHaveLength(FLUSH_SAMPLES);
  });

  it("flushes the remainder and closes the file on finish", async () => {
    const capture = new RecordingCapture();
    await capture.start();
    capture.push(frame(3, 0.5));

    const info = await capture.finish();

    expect(appendedValues()).toEqual([[0.5, 0.5, 0.5]]);
    const calls = invoke.mock.calls;
    expect(calls[calls.length - 1]?.[0]).toBe("finish_capture");
    expect(info).toEqual({ path: "C:/cache/recordings/rec.wav", durationSec: 12.5 });
  });

  it("appends in capture order even when the backend resolves out of order", async () => {
    // The failure this guards against is silent: out-of-order appends splice the
    // meeting's audio together wrongly, and the WAV still looks perfectly valid.
    const pending: Array<() => void> = [];
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "start_capture") return Promise.resolve("p");
      if (cmd === "finish_capture") return Promise.resolve({ path: "p", durationSec: 0 });
      // Resolve appends only when released, newest first.
      return new Promise<void>((resolve) => pending.push(resolve));
    });

    const capture = new RecordingCapture();
    await capture.start();
    capture.push(frame(FLUSH_SAMPLES, 0.1));
    capture.push(frame(FLUSH_SAMPLES, 0.2));
    capture.push(frame(FLUSH_SAMPLES, 0.3));

    // Exactly one append may be in flight at a time; the rest wait their turn.
    for (let i = 0; i < 3; i++) {
      await tick();
      expect(pending).toHaveLength(1);
      pending.shift()!();
    }
    await tick();
    await capture.finish();

    // fround because the values made the round trip through a Float32Array.
    expect(appendedValues().map((v) => v[0])).toEqual([0.1, 0.2, 0.3].map(Math.fround));
  });

  it("keeps recording when a write fails, and reports it at finish", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "start_capture") return Promise.resolve("p");
      if (cmd === "finish_capture") return Promise.resolve({ path: "p", durationSec: 0 });
      return Promise.reject(new Error("disk full"));
    });

    const capture = new RecordingCapture();
    await capture.start();
    // push() must never throw: it runs inside the recorder's onFrame callback, and
    // taking that down would end the live transcription too.
    expect(() => capture.push(frame(FLUSH_SAMPLES, 0.1))).not.toThrow();
    await expect(capture.finish()).rejects.toThrow("disk full");
  });

  it("stops attempting writes after the first failure", async () => {
    let appends = 0;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "start_capture") return Promise.resolve("p");
      if (cmd === "finish_capture") return Promise.resolve({ path: "p", durationSec: 0 });
      appends += 1;
      return Promise.reject(new Error("disk full"));
    });

    const capture = new RecordingCapture();
    await capture.start();
    capture.push(frame(FLUSH_SAMPLES, 0.1));
    // Let the first append fail before queueing more.
    await new Promise((r) => setTimeout(r, 0));
    capture.push(frame(FLUSH_SAMPLES, 0.2));
    capture.push(frame(FLUSH_SAMPLES, 0.3));
    await capture.finish().catch(() => {});

    // A full disk must not produce one error per flush for the rest of the meeting.
    expect(appends).toBe(1);
  });

  it("names recordings by local time so the file is findable", async () => {
    const capture = new RecordingCapture();
    await capture.start();
    expect(invoke).toHaveBeenCalledWith(
      "start_capture",
      expect.objectContaining({ name: expect.stringMatching(/^rec-\d{8}-\d{6}$/) }),
    );
  });
});
