import { useAppStore } from "../store/appStore";
import { audioEventLabelJa, isNoiseOrMusicEvent } from "../lib/audioEvents";

function formatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Standalone timeline of detected audio events (music, noise, applause, ...).
 * Deliberately separate from `TranscriptPanel`: audio tagging is never
 * inserted into the transcript body -- see `events.rs`'s module doc for why
 * -- so this is the only place its output is shown at all. Noise/music
 * entries are additionally marked "聞き直し推奨" here, which is where use
 * case 3 (the "worth a re-listen" marker) lives; there is no separate
 * per-segment flag on the transcript itself.
 */
export function AudioEventPanel() {
  const audioEvents = useAppStore((s) => s.audioEvents);
  const audioEventSettings = useAppStore((s) => s.audioEventSettings);

  if (!audioEventSettings.enabled || audioEvents.length === 0) return null;

  return (
    <div className="flex w-full flex-col gap-2 rounded-lg border border-neutral-200 p-4">
      <h2 className="text-sm font-semibold text-neutral-700">音響イベント</h2>
      <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto text-sm">
        {audioEvents.map((e, i) => {
          const noisy = isNoiseOrMusicEvent(e.name);
          return (
            // Events are not stably identified across renders (no id from the
            // backend), and this list is append-only, so position is a safe key.
            <li key={i} className="flex items-center gap-2 text-neutral-700">
              <span className="w-24 shrink-0 font-mono text-xs text-neutral-400">
                {formatTimestamp(e.start)}–{formatTimestamp(e.end)}
              </span>
              <span>{audioEventLabelJa(e.name)}</span>
              <span className="text-xs text-neutral-400">{Math.round(e.prob * 100)}%</span>
              {noisy && (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700">
                  聞き直し推奨
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
