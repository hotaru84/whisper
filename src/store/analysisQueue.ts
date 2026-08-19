/**
 * Per-recording analysis job tracking: *when* a background analysis pass
 * (post-stop refine, or a history re-analysis) runs, as opposed to
 * `recordingPipeline.ts`, which owns *what* a pass's steps are.
 *
 * Split into its own store (same reasoning as `capabilities.ts`) so it stays
 * independently testable. This is also the layer recording/analysis
 * concurrency lives at: unlike the old single global `processing` field
 * (removed from `AppState` -- see `capabilities.ts`'s doc comment), more than
 * one recording can have a job here at once, and none of them block starting
 * a new recording. Actual model access is still serialized, just one layer
 * down in `src/lib/asr/whisperQueue.ts` -- this store only tracks status for
 * the UI and cancellation, it does not itself decide execution order.
 *
 * `useAppStore` is only ever read/written via `.getState()`/`.setState()`
 * inside function bodies here, never at module top level -- same reasoning as
 * `recordingPipeline.ts`'s own doc comment: this module ends up in an import
 * cycle with `appStore.ts` (which re-exports it) and with `clients.ts`
 * (`cancelJob` below needs `asrClient`), and deferring every access to inside
 * a closure is what makes that safe.
 */
import { asrClient } from "./clients";
import { useAppStore } from "./appStore";
import { toErrorMessage } from "../lib/errors";
import {
  refineRecording,
  runPostHocAnalysis,
  type TakeFiling,
  type AnalysisPipelineStatus,
} from "./recordingPipeline";
import { create } from "zustand";

export type AnalysisJobKind = "refine" | "reanalyze";

/** `queued`/`transcribing`/`post-processing`/`cancelling` are the states a
 * job can actually be observed in -- `done`/`error`/`cancelled` are the three
 * ways a job ends, included for documentation even though in practice the
 * entry is removed from `jobs` in the same tick it would enter one of them
 * (see `runJob`), so a consumer never actually reads them off the store. */
export type AnalysisJobStatus =
  | "queued"
  | "transcribing"
  | "post-processing"
  | "cancelling"
  | "done"
  | "error"
  | "cancelled";

export interface AnalysisJob {
  /** === the recording id this job is analyzing. */
  id: string;
  kind: AnalysisJobKind;
  status: AnalysisJobStatus;
  /** 0-100 while `status === "transcribing"`, otherwise `null` -- mirrors
   * `AnalysisPipelineStatus`'s own scope: only the whisper-touching stage has
   * a meaningful percentage. */
  progress: number | null;
}

interface AnalysisQueueState {
  /** Keyed by recording id. A recording with no entry has no analysis
   * queued or running. */
  jobs: Record<string, AnalysisJob>;
}

export const useAnalysisQueueStore = create<AnalysisQueueState>(() => ({ jobs: {} }));

function upsertJob(job: AnalysisJob): void {
  useAnalysisQueueStore.setState((s) => ({ jobs: { ...s.jobs, [job.id]: job } }));
}

function updateJob(recordingId: string, patch: Partial<Omit<AnalysisJob, "id">>): void {
  useAnalysisQueueStore.setState((s) => {
    const existing = s.jobs[recordingId];
    if (!existing) return s;
    return { jobs: { ...s.jobs, [recordingId]: { ...existing, ...patch } } };
  });
}

function removeJob(recordingId: string): void {
  useAnalysisQueueStore.setState((s) => {
    if (!(recordingId in s.jobs)) return s;
    const jobs = { ...s.jobs };
    delete jobs[recordingId];
    return { jobs };
  });
}

/** Whether `recordingId` already has a job queued or running -- the
 * per-recording de-duplication guard that replaces the old global
 * `processing !== null` check (which, being a single scalar, could only ever
 * describe one recording at a time app-wide). */
export function hasActiveJob(recordingId: string): boolean {
  return recordingId in useAnalysisQueueStore.getState().jobs;
}

/** Whether a cancel request can still usefully be made for `job` -- excludes
 * `undefined` (nothing to cancel) and `cancelling` (already asked), so a
 * cancel button can disable itself the instant it's pressed without any
 * consumer having to track "already asked" separately. */
export function canCancelJob(job: AnalysisJob | undefined): boolean {
  return job !== undefined && job.status !== "cancelling";
}

/**
 * A job that was `"queued"` when `cancelJob` marked it `"cancelling"` can
 * still be sitting in `whisperQueue.ts`'s own queue at that moment -- when it
 * eventually gets dequeued and actually starts, `finalizeAndEnrich`'s
 * `onStart` fires this with `"transcribing"` regardless, since the pipeline
 * itself has no idea a cancel was already requested (that's `wasCancelled`'s
 * job, checked only after the pass finishes). Guarded here so that a status
 * update arriving after cancellation cannot resurrect "still running" over
 * "winding down" -- once `"cancelling"`, a job's status only ever changes by
 * being removed (`runJob`'s `finally`), never overwritten.
 *
 * Does *not* touch `progress` on a transition into `"transcribing"`.
 * `runPostHocAnalysis` re-enters `"transcribing"` twice per run (once for its
 * own windowed decode, again for `finalizeAndEnrich`'s repair call once
 * decoding finishes) -- resetting to 0 here would snap a resumed job's bar
 * back to 0% the instant it starts, and again once decoding reaches 100% and
 * finalize begins. `progress` is written only by `setProgress`/`onProgress`
 * above, keyed on `analyzedThroughSec`, never on `status` transitions.
 */
function onStatus(recordingId: string): (status: AnalysisPipelineStatus) => void {
  return (status) => {
    if (useAnalysisQueueStore.getState().jobs[recordingId]?.status === "cancelling") return;
    updateJob(recordingId, { status });
  };
}

function wasCancelled(recordingId: string): () => boolean {
  return () => useAnalysisQueueStore.getState().jobs[recordingId]?.status === "cancelling";
}

/** Runs `run` to completion (however it ends) and always removes `recordingId`'s
 * job entry afterward -- `refineRecording`/`runPostHocAnalysis` already
 * report their own outcome as a `refineNotice`, so there is nothing left for
 * this wrapper to do but clean up the queue's own bookkeeping. */
async function runJob(recordingId: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } finally {
    removeJob(recordingId);
  }
}

/**
 * Queues the post-stop accuracy pass for a just-finished recording. Called
 * from `appStore.ts`'s `stopRecording` right after `fileTakeProvisionally`
 * resolves; fire-and-forget by design -- starting a new recording must never
 * wait on this.
 */
export function enqueueRefine(filing: TakeFiling, baseSec: number, keptSegments: number): void {
  const { recordingId } = filing;
  upsertJob({ id: recordingId, kind: "refine", status: "queued", progress: null });
  void runJob(recordingId, () =>
    refineRecording(filing, baseSec, keptSegments, onStatus(recordingId), wasCancelled(recordingId)),
  );
}

/**
 * Queues a re-analysis of a past recording. A no-op if `recordingId` already
 * has a job (queued or running) -- the caller (`appStore.ts`'s
 * `rerunHistoryEntry`) is expected to check `hasActiveJob` first for its own
 * button-disabling purposes, but this guard is what actually prevents a
 * double-click from enqueueing the same recording twice.
 */
export function enqueueReanalyze(recordingId: string): void {
  if (hasActiveJob(recordingId)) return;
  upsertJob({ id: recordingId, kind: "reanalyze", status: "queued", progress: null });
  void runJob(recordingId, () =>
    runPostHocAnalysis(recordingId, onStatus(recordingId), onProgress(recordingId), wasCancelled(recordingId)),
  );
}

/**
 * Asks `recordingId`'s job to stop, if it has one. Returns as soon as the
 * backend has been told; the pass itself finishes unwinding on its own (see
 * `runJob`, which removes the job entry once it does). Other recordings'
 * jobs are completely unaffected -- see `cancel.rs`'s per-job flag map.
 */
export async function cancelJob(recordingId: string): Promise<void> {
  const job = useAnalysisQueueStore.getState().jobs[recordingId];
  if (!canCancelJob(job)) return;
  // Moves off "transcribing"/"post-processing" (the status readout would
  // otherwise keep claiming the pass is running) but the entry stays present
  // until `runJob`'s `finally` removes it -- clearing it here instead would
  // let a new job for the same recording start into a pass that is still
  // winding down (diarization cannot be interrupted mid-call).
  updateJob(recordingId, { status: "cancelling", progress: null });
  try {
    await asrClient.cancelAnalysis(recordingId);
  } catch (err) {
    // The pass just runs to completion, and `runJob`'s `finally` still
    // removes the job entry, so this costs the user time rather than data.
    useAppStore.setState({
      refineNotice: `キャンセルを要求できませんでした（解析はそのまま続行します）: ${toErrorMessage(err)}`,
    });
  }
}

/**
 * Applies a windowed-decode progress update from `transcribeWavPostHoc`
 * (`postHocTranscriber.ts`), routed through `runPostHocAnalysis`'s own
 * `onProgress` callback. Ignored unless `recordingId` currently has a job in
 * the `"transcribing"` state -- a late or stray update must not resurrect
 * progress on a job that has since moved on (or been removed).
 */
export function setProgress(recordingId: string, percent: number): void {
  const job = useAnalysisQueueStore.getState().jobs[recordingId];
  if (!job || job.status !== "transcribing") return;
  updateJob(recordingId, { progress: percent });
}

/**
 * Converts `transcribeWavPostHoc`'s `(analyzedThroughSec, totalSec)` shape
 * into the percentage `setProgress` stores. Passed as `runPostHocAnalysis`'s
 * `onProgress` argument -- the one place `AnalysisJob.progress` is ever
 * written for the resumable post-hoc path, so a job resumed partway through
 * reports its starting percentage immediately rather than snapping to 0%
 * (see `postHocTranscriber.ts`'s own doc comment on why this matters).
 */
function onProgress(recordingId: string): (analyzedThroughSec: number, totalSec: number) => void {
  return (analyzedThroughSec, totalSec) => {
    const percent = totalSec > 0 ? Math.round((analyzedThroughSec / totalSec) * 100) : 0;
    setProgress(recordingId, percent);
  };
}
