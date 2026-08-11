import { useEffect, useRef } from "react";
import { useAppStore } from "../store/appStore";

// Typical speech RMS sits well under 1.0, so scale up for a readable meter.
const LEVEL_SCALE = 400;

export function LevelMeter() {
  const recordingStatus = useAppStore((s) => s.recordingStatus);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (recordingStatus !== "recording") return;

    let raf: number;
    const tick = () => {
      const level = useAppStore.getState().levelMeter?.getLevel() ?? 0;
      const percent = Math.min(100, Math.round(level * LEVEL_SCALE));
      if (barRef.current) barRef.current.style.width = `${percent}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [recordingStatus]);

  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-200">
      <div ref={barRef} className="h-full bg-red-500 transition-[width] duration-75" style={{ width: "0%" }} />
    </div>
  );
}
