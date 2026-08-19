/**
 * Serializes every call that touches the Rust-side whisper model
 * (`AsrState`'s `Mutex<Option<WhisperContext>>` in `asr.rs`, held for the
 * entire duration of a `full()` decode) behind a single, priority-aware,
 * frontend-side queue.
 *
 * The Rust mutex already guarantees at most one decode runs at a time; what
 * it does not guarantee is fairness or ordering (`std::sync::Mutex` makes no
 * promise about which waiter wins). This queue supplies that: a live
 * recording's streaming windows (`WHISPER_PRIORITY_LIVE`) always jump ahead
 * of queued background work (refine passes, history re-analysis --
 * `WHISPER_PRIORITY_BACKGROUND`), so a live window's wait is bounded by
 * whichever single job happens to be executing, never by a backlog of
 * background jobs. Nothing here preempts a job that has already started --
 * whisper decode can't be paused mid-flight without losing the work -- which
 * is fine now that streaming windows no longer need sub-second turnaround.
 *
 * Because this queue guarantees the Rust mutex never actually sees more than
 * one waiter, `AsrState`'s mutex itself needs no changes.
 */

export const WHISPER_PRIORITY_LIVE = 0;
export const WHISPER_PRIORITY_BACKGROUND = 1;

interface QueueEntry<T> {
  readonly priority: number;
  readonly seq: number;
  readonly run: () => Promise<T>;
  readonly onStart?: () => void;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

let nextSeq = 0;
let running = false;
const queue: QueueEntry<unknown>[] = [];

function pickNext(): QueueEntry<unknown> | undefined {
  if (queue.length === 0) return undefined;
  let bestIdx = 0;
  for (let i = 1; i < queue.length; i++) {
    const a = queue[i];
    const b = queue[bestIdx];
    if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) {
      bestIdx = i;
    }
  }
  return queue.splice(bestIdx, 1)[0];
}

function pump(): void {
  if (running) return;
  const entry = pickNext();
  if (!entry) return;
  running = true;
  entry.onStart?.();
  void (async () => {
    try {
      entry.resolve(await entry.run());
    } catch (err) {
      entry.reject(err);
    } finally {
      running = false;
      pump();
    }
  })();
}

/**
 * Submits a whisper-touching call to the shared queue. `priority` decides
 * ordering against everything else currently queued (lower runs first;
 * `WHISPER_PRIORITY_LIVE` vs `WHISPER_PRIORITY_BACKGROUND` above); within the
 * same priority, submission order wins. `onStart` fires right before `run`
 * is invoked, once this task is actually dequeued -- callers use it to flip
 * job status from "queued" to "transcribing" at the right moment rather than
 * at submission time.
 *
 * The returned `cancel()` only succeeds while the task is still waiting in
 * the queue (removes it and rejects its promise); it returns `false` once
 * the task has started running, since whisper decode can't be interrupted
 * from here -- callers fall back to the Rust-side per-job cancel flag
 * (`cancel.rs`) for an in-flight job.
 */
export function runWhisperTask<T>(
  priority: number,
  run: () => Promise<T>,
  onStart?: () => void,
): { promise: Promise<T>; cancel: () => boolean } {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  const entry: QueueEntry<T> = {
    priority,
    seq: nextSeq++,
    run,
    onStart,
    resolve: resolveFn,
    reject: rejectFn,
  };
  queue.push(entry as QueueEntry<unknown>);
  pump();

  const cancel = (): boolean => {
    const idx = queue.indexOf(entry as QueueEntry<unknown>);
    if (idx === -1) return false;
    queue.splice(idx, 1);
    entry.reject(new Error("Task cancelled before it started running"));
    return true;
  };

  return { promise, cancel };
}
