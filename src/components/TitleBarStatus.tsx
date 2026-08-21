import { useEffect, useRef, useState } from "react";
import { FileAudio } from "lucide-react";
import {
  useAppStore,
  activeRecordedSec,
  effectiveRecordOnly,
  useAnalysisQueueStore,
  type RecordingPhase,
} from "../store/appStore";
import { formatTimestamp, formatDateTime } from "../lib/format";

/**
 * How long the current take has actually been capturing, ticking every half
 * second. Local to this component -- nothing else in the app needs a live
 * clock, so it isn't worth a store field.
 *
 * Read from the recorder's captured-sample count (`activeRecordedSec`) rather
 * than measured here, so the readout is the recording's real length and not an
 * estimate of it. Two things break a clock-based version, and only one of them
 * is fixable by being careful with timestamps:
 *
 * - Paused spans are not recorded, so counting them would make the display
 *   disagree with the WAV and with every segment offset. (Summing active spans
 *   handled this, which is what this used to do.)
 * - A suspended machine records nothing either, but *does* keep the clock
 *   running. There is no arrangement of `Date.now()` readings that can tell how
 *   much of the elapsed time the process was frozen for -- the sample count is
 *   the only thing that knows.
 *
 * The wall-clock sum survives as a fallback for the window between the record
 * button being pressed and the recorder actually existing (`startingRecording`),
 * where there are no samples to read yet.
 */
function useElapsedRecordingSec(recordingPhase: RecordingPhase): number {
  const [elapsed, setElapsed] = useState(0);
  const activeSecRef = useRef(0);

  useEffect(() => {
    if (recordingPhase === "stopped") {
      activeSecRef.current = 0;
      setElapsed(0);
      return;
    }
    if (recordingPhase === "paused") return; // freeze, keeping the accumulated total

    const spanStart = Date.now();
    const base = activeSecRef.current;
    const tick = () => activeRecordedSec() ?? base + (Date.now() - spanStart) / 1000;
    const id = setInterval(() => setElapsed(Math.floor(tick())), 500);
    return () => {
      activeSecRef.current = tick();
      clearInterval(id);
    };
  }, [recordingPhase]);

  return elapsed;
}

/**
 * The one place "what is the app doing right now" lives, always visible
 * regardless of what's in the main content area (the live transcript, or a
 * history entry) -- see the design plan's layout rationale. Sits centered in
 * the titlebar's own drag region: `pointer-events-none` on the root keeps a
 * pointer over any of this text still counted as "drag the window" by Tauri,
 * since nothing here is clickable.
 */
export function TitleBarStatus() {
  const recordingPhase = useAppStore((s) => s.recordingPhase);
  const recordingCloseOutPhase = useAppStore((s) => s.recordingCloseOutPhase);
  const jobs = useAnalysisQueueStore((s) => s.jobs);
  const recordingHistory = useAppStore((s) => s.recordingHistory);
  const recordOnly = useAppStore((s) => effectiveRecordOnly(s.recordingMode, s.powerSource));
  const elapsed = useElapsedRecordingSec(recordingPhase);

  // More than one recording can have analysis in flight at once now (see
  // `src/store/analysisQueue.ts`), so this slot headlines whichever job is
  // actually running the whisper-touching stage -- there is at most one of
  // those app-wide, by construction (see `whisperQueue.ts`) -- falling back
  // to any other job (queued/post-processing/cancelling) so something still
  // shows even when nothing is transcribing right now. The rest, if any, are
  // summarized rather than each getting their own slot.
  const jobList = Object.values(jobs);
  const headlineJob = jobList.find((j) => j.status === "transcribing") ?? jobList[0];
  const otherJobCount = headlineJob ? jobList.length - 1 : 0;

  // Only resolves once the recording being analyzed already has a history
  // entry -- always true by the time a job exists to headline (see
  // `enqueueRefine`'s own doc comment), kept as a fallback rather than an
  // assumption regardless.
  const headlineTarget = headlineJob && recordingHistory.find((r) => r.id === headlineJob.id);
  const headlineTargetTime = headlineTarget && formatDateTime(headlineTarget.createdAt);

  // One slot, several mutually exclusive occupants: the take's own state wins
  // while one exists, then the closeout window right after stop, then
  // whichever job headlines, then the record-only idle chip. There used to be
  // a sixth (a CPU/Vulkan device chip) but which backend loaded the model is
  // an implementation detail with no bearing on anything the user can act on,
  // so it was dropped rather than moved here.
  const idleChip = recordingPhase === "stopped" && recordingCloseOutPhase === null && !headlineJob;

  return (
    <div className="pointer-events-none flex min-w-0 items-center justify-center gap-3 text-xs">
      {recordingPhase === "recording" && (
        <span className="flex items-center gap-1.5 font-medium text-signal">
          <span
            className="h-2 w-2 animate-pulse rounded-full bg-signal motion-reduce:animate-none"
            aria-hidden="true"
          />
          録音中
          <span className="font-mono tabular-nums">
            {formatTimestamp(elapsed)}
          </span>
        </span>
      )}
      {recordingPhase === "paused" && (
        // Same signal red (a take is still open) but a static dot, matching
        // the record button's pulse/no-pulse split for the same two states.
        <span className="flex items-center gap-1.5 font-medium text-signal">
          <span className="h-2 w-2 rounded-full bg-signal" aria-hidden="true" />
          一時停止中
          <span className="font-mono tabular-nums">
            {formatTimestamp(elapsed)}
          </span>
        </span>
      )}
      {recordingCloseOutPhase === "transcribing" && (
        <span className="truncate text-muted-foreground">
          文字起こし処理中…
        </span>
      )}
      {recordingCloseOutPhase === "saving" && (
        <span className="truncate text-muted-foreground">録音を保存中…</span>
      )}
      {headlineJob?.status === "cancelling" && (
        // No progress and no button: the pass has been told to stop and is
        // winding down, which is not instant -- diarization cannot be
        // interrupted mid-call, so this can sit here for a while.
        <span className="truncate text-muted-foreground">
          解析をキャンセル中…
        </span>
      )}
      {headlineJob && headlineJob.status !== "cancelling" && (
        <span className="flex items-center gap-1.5 truncate text-muted-foreground">
          {headlineJob.status === "queued" ? (
            headlineTargetTime ? (
              <>
                履歴（
                <span className="font-mono tabular-nums">
                  {headlineTargetTime.day} {headlineTargetTime.time}
                </span>
                ）の解析待ち…
              </>
            ) : (
              "解析待ち…"
            )
          ) : headlineTargetTime ? (
            <>
              履歴（
              <span className="font-mono tabular-nums">
                {headlineTargetTime.day} {headlineTargetTime.time}
              </span>
              ）を文字起こし処理中…
            </>
          ) : (
            "文字起こし処理中…"
          )}
          {headlineJob.status === "transcribing" && (
            <span className="font-mono tabular-nums">
              {Math.round(headlineJob.progress ?? 0)}%
            </span>
          )}
          {otherJobCount > 0 && (
            <span className="text-muted-foreground/70">（ほか{otherJobCount}件 待機中）</span>
          )}
        </span>
      )}
      {idleChip && recordOnly && (
        <span className="flex items-center gap-1 truncate text-muted-foreground">
          <FileAudio className="h-3 w-3 shrink-0" />
          録音のみ（文字起こしはあとで）
        </span>
      )}
    </div>
  );
}
