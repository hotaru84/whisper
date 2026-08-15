import { useEffect, useRef, useState } from "react";
import { FileAudio } from "lucide-react";
import { useAppStore, type RecordingPhase } from "../store/appStore";
import { formatTimestamp } from "../lib/format";

/**
 * How long the current take has actually been capturing, ticking every half
 * second. Local to this component -- nothing else in the app needs a live
 * clock, so it isn't worth a store field.
 *
 * Sums only the *active* spans rather than measuring from a single start
 * timestamp: paused time is not recorded, so counting it would make the
 * display disagree with the WAV's real duration and with every segment offset.
 * Accumulating across spans is also what keeps a resume from resetting the
 * readout to 0:00, which a plain `Date.now() - startedAt` keyed on the phase
 * would do every time.
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
    const id = setInterval(() => setElapsed(Math.floor(base + (Date.now() - spanStart) / 1000)), 500);
    return () => {
      activeSecRef.current = base + (Date.now() - spanStart) / 1000;
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
  const processing = useAppStore((s) => s.processing);
  const refineProgress = useAppStore((s) => s.refineProgress);
  const recordOnly = useAppStore((s) => s.recordingMode.recordOnly);
  const elapsed = useElapsedRecordingSec(recordingPhase);

  // One slot, four mutually exclusive occupants: the take's own state wins
  // while one exists, then the post-stop pipeline, then the record-only idle
  // chip. There used to be a fifth (a CPU/Vulkan device chip) but which
  // backend loaded the model is an implementation detail with no bearing on
  // anything the user can act on, so it was dropped rather than moved here.
  const idleChip = recordingPhase === "stopped" && processing === null;

  return (
    <div className="pointer-events-none flex min-w-0 items-center justify-center gap-3 text-xs">
      {recordingPhase === "recording" && (
        <span className="flex items-center gap-1.5 font-medium text-signal">
          <span className="h-2 w-2 animate-pulse rounded-full bg-signal motion-reduce:animate-none" aria-hidden="true" />
          録音中
          <span className="font-mono tabular-nums">{formatTimestamp(elapsed)}</span>
        </span>
      )}
      {recordingPhase === "paused" && (
        // Same signal red (a take is still open) but a static dot, matching
        // the record button's pulse/no-pulse split for the same two states.
        <span className="flex items-center gap-1.5 font-medium text-signal">
          <span className="h-2 w-2 rounded-full bg-signal" aria-hidden="true" />
          一時停止中
          <span className="font-mono tabular-nums">{formatTimestamp(elapsed)}</span>
        </span>
      )}
      {processing === "transcribing" && <span className="truncate text-muted-foreground">文字起こし処理中…</span>}
      {processing === "saving" && <span className="truncate text-muted-foreground">録音を保存中…</span>}
      {processing === "refining" && (
        <span className="flex items-center gap-1.5 truncate text-muted-foreground">
          精度向上パス実行中…
          <span className="font-mono tabular-nums">{Math.round(refineProgress ?? 0)}%</span>
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
