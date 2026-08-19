import { describe, it, expect, vi } from "vitest";
import { runWhisperTask, WHISPER_PRIORITY_LIVE, WHISPER_PRIORITY_BACKGROUND } from "./whisperQueue";

/** Resolves once all pending microtasks/timers have had a chance to run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A task that stays pending until its returned `resolve` is called, so tests
 * can control exactly when a "currently executing" task finishes. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("runWhisperTask", () => {
  it("runs a single task immediately", async () => {
    const order: number[] = [];
    const { promise } = runWhisperTask(WHISPER_PRIORITY_BACKGROUND, async () => {
      order.push(1);
      return "done";
    });
    await expect(promise).resolves.toBe("done");
    expect(order).toEqual([1]);
  });

  it("runs same-priority tasks in FIFO submission order", async () => {
    const order: number[] = [];
    const blocker = deferred<void>();
    // Occupy the queue with a currently-running task so the next three all
    // queue up behind it in submission order.
    runWhisperTask(WHISPER_PRIORITY_BACKGROUND, () => blocker.promise);
    await tick();

    const p1 = runWhisperTask(WHISPER_PRIORITY_BACKGROUND, async () => {
      order.push(1);
    }).promise;
    const p2 = runWhisperTask(WHISPER_PRIORITY_BACKGROUND, async () => {
      order.push(2);
    }).promise;
    const p3 = runWhisperTask(WHISPER_PRIORITY_BACKGROUND, async () => {
      order.push(3);
    }).promise;

    blocker.resolve();
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("lets a live-priority task jump ahead of queued (not yet started) background tasks", async () => {
    const order: string[] = [];
    const blocker = deferred<void>();
    runWhisperTask(WHISPER_PRIORITY_BACKGROUND, () => blocker.promise);
    await tick();

    const bgP = runWhisperTask(WHISPER_PRIORITY_BACKGROUND, async () => {
      order.push("bg");
    }).promise;
    const liveP = runWhisperTask(WHISPER_PRIORITY_LIVE, async () => {
      order.push("live");
    }).promise;

    blocker.resolve();
    await Promise.all([bgP, liveP]);
    expect(order).toEqual(["live", "bg"]);
  });

  it("does not preempt a task that has already started running", async () => {
    const order: string[] = [];
    const blocker = deferred<void>();
    const runningTask = runWhisperTask(WHISPER_PRIORITY_BACKGROUND, async () => {
      order.push("bg-start");
      await blocker.promise;
      order.push("bg-end");
    }).promise;
    await tick(); // let the background task actually start

    const liveP = runWhisperTask(WHISPER_PRIORITY_LIVE, async () => {
      order.push("live");
    }).promise;

    // The background task must finish before the live one, even though live
    // has higher priority -- it was already executing when live arrived.
    await tick();
    expect(order).toEqual(["bg-start"]);

    blocker.resolve();
    await Promise.all([runningTask, liveP]);
    expect(order).toEqual(["bg-start", "bg-end", "live"]);
  });

  it("cancel() removes a not-yet-started task and rejects its promise", async () => {
    const blocker = deferred<void>();
    runWhisperTask(WHISPER_PRIORITY_BACKGROUND, () => blocker.promise);
    await tick();

    const ran = vi.fn();
    const queued = runWhisperTask(WHISPER_PRIORITY_BACKGROUND, async () => {
      ran();
    });

    expect(queued.cancel()).toBe(true);
    await expect(queued.promise).rejects.toThrow();

    blocker.resolve();
    await tick();
    expect(ran).not.toHaveBeenCalled();
  });

  it("cancel() returns false once the task has already started", async () => {
    const blocker = deferred<void>();
    const running = runWhisperTask(WHISPER_PRIORITY_BACKGROUND, () => blocker.promise);
    await tick();

    expect(running.cancel()).toBe(false);
    blocker.resolve();
    await expect(running.promise).resolves.toBeUndefined();
  });

  it("a rejecting task does not stall the pump", async () => {
    const { promise: p1 } = runWhisperTask(WHISPER_PRIORITY_BACKGROUND, async () => {
      throw new Error("boom");
    });
    const { promise: p2 } = runWhisperTask(WHISPER_PRIORITY_BACKGROUND, async () => "ok");

    await expect(p1).rejects.toThrow("boom");
    await expect(p2).resolves.toBe("ok");
  });

  it("a task that throws synchronously does not stall the pump", async () => {
    const { promise: p1 } = runWhisperTask(WHISPER_PRIORITY_BACKGROUND, () => {
      throw new Error("sync boom");
    });
    const { promise: p2 } = runWhisperTask(WHISPER_PRIORITY_BACKGROUND, async () => "ok");

    await expect(p1).rejects.toThrow("sync boom");
    await expect(p2).resolves.toBe("ok");
  });
});
