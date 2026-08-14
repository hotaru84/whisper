import { useEffect, useRef } from "react";
import { useAppStore } from "../store/appStore";

// Typical speech RMS sits well under 1.0, so scale up for a readable meter.
const LEVEL_SCALE = 400;
const BAR_COUNT = 28;
/** Fraction of the bar's max height above which it reads as "hot" (near
 * clipping) rather than a normal speaking level -- the one place this meter
 * changes color, so it stays meaningful rather than merely decorative. */
const HOT_THRESHOLD = 0.85;
const MIN_HEIGHT_PERCENT = 6;

const idleHistory = () => Array.from({ length: BAR_COUNT }, () => 0);

/**
 * A small live waveform of the microphone signal -- literally what this app
 * listens to, not decoration. Bars scroll from right to left as new samples
 * arrive; a bar crossing `HOT_THRESHOLD` turns `--signal` (the same red used
 * for recording/destructive state) instead of the normal `--trace` green, so
 * a glance tells you both "is it picking anything up" and "is it about to
 * clip" -- the two things a level meter is actually for.
 *
 * Reads `getLevel()` on every animation frame and writes bar heights via
 * direct DOM refs rather than React state, the same approach the single-bar
 * version used -- a waveform redraws every frame while recording, and a
 * `setState` per frame would mean a full React re-render at 60fps for no
 * benefit over mutating a handful of already-mounted `<div>`s.
 */
export function LevelMeter() {
  const recordingPhase = useAppStore((s) => s.recordingPhase);
  const barRefs = useRef<(HTMLDivElement | null)[]>([]);
  const history = useRef<number[]>(idleHistory());

  useEffect(() => {
    const paintIdle = () => {
      history.current = idleHistory();
      for (const bar of barRefs.current) {
        if (!bar) continue;
        bar.style.height = `${MIN_HEIGHT_PERCENT}%`;
        bar.style.backgroundColor = "var(--border)";
      }
    };

    // Paused included: the mic stream is still open and would keep reporting a
    // live level, but nothing is being captured, so animating would claim
    // otherwise.
    if (recordingPhase !== "recording") {
      paintIdle();
      return;
    }

    let raf: number;
    const tick = () => {
      const level = useAppStore.getState().levelMeter?.getLevel() ?? 0;
      const value = Math.min(1, (level * LEVEL_SCALE) / 100);
      history.current = [...history.current.slice(1), value];

      history.current.forEach((v, i) => {
        const bar = barRefs.current[i];
        if (!bar) return;
        bar.style.height = `${Math.max(MIN_HEIGHT_PERCENT, Math.round(v * 100))}%`;
        bar.style.backgroundColor = v >= HOT_THRESHOLD ? "var(--signal)" : "var(--trace)";
      });

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [recordingPhase]);

  return (
    <div className="flex h-8 w-full items-end gap-0.5" role="img" aria-label="音声レベル">
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <div
          // Static-length list that never reorders -- an index key is safe.
          key={i}
          ref={(el) => {
            barRefs.current[i] = el;
          }}
          className="flex-1 rounded-sm transition-[height] duration-75 motion-reduce:transition-none"
          style={{ height: `${MIN_HEIGHT_PERCENT}%`, backgroundColor: "var(--border)" }}
        />
      ))}
    </div>
  );
}
