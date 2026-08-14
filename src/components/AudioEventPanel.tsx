import { ScrollArea } from "./ui/scroll-area";
import { TimeRangeChip } from "./TimeRangeChip";
import { useAppStore } from "../store/appStore";
import { audioEventLabelJa, audioEventCategory, isNoiseOrMusicEvent } from "../lib/audioEvents";
import { AUDIO_EVENT_CATEGORY_ICON } from "../lib/audioEventIcons";

/**
 * Detected audio events (music, noise, applause, ...), shown on its own tab
 * (see `TranscriptTabs`). Deliberately separate from `TranscriptPanel`: audio
 * tagging is never inserted into the transcript body -- see `events.rs`'s
 * module doc for why -- so this is the only place its output is shown at all.
 * Noise/music entries are additionally marked "聞き直し推奨" here, which is
 * where use case 3 (the "worth a re-listen" marker) lives; there is no
 * separate per-segment flag on the transcript itself.
 *
 * Always renders its content area rather than returning null when disabled or
 * empty: doing that used to cause layout shift every time detection toggled
 * state, and gave the feature no discoverability path (a user who never
 * happened to trigger a detection would never see it exists at all).
 */
export function AudioEventPanel() {
  const audioEvents = useAppStore((s) => s.audioEvents);
  const audioEventSettings = useAppStore((s) => s.audioEventSettings);
  const recordingPhase = useAppStore((s) => s.recordingPhase);
  const processing = useAppStore((s) => s.processing);
  const segments = useAppStore((s) => s.segments);

  const hasEvents = audioEvents.length > 0;

  return (
    <div className="flex w-full flex-1 flex-col gap-2">
      {!audioEventSettings.enabled ? (
        <p className="text-xs text-muted-foreground">音響イベント検出は無効です — 設定から有効にできます。</p>
      ) : hasEvents ? (
        <ScrollArea className="max-h-40">
          <ul className="flex flex-col gap-1 pr-3 text-sm">
            {audioEvents.map((e, i) => {
              const noisy = isNoiseOrMusicEvent(e.name);
              const Icon = AUDIO_EVENT_CATEGORY_ICON[audioEventCategory(e.name)];
              return (
                // Events are not stably identified across renders (no id from
                // the backend), and this list is append-only, so position is
                // a safe key.
                <li key={i} className="flex items-center gap-2 text-foreground">
                  <TimeRangeChip start={e.start} end={e.end} className="w-24" />
                  <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span>{audioEventLabelJa(e.name)}</span>
                  <span className="font-mono text-xs text-muted-foreground">{Math.round(e.prob * 100)}%</span>
                  {noisy && (
                    <span className="rounded bg-amber/15 px-1.5 py-0.5 text-xs text-amber">聞き直し推奨</span>
                  )}
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      ) : recordingPhase === "recording" ? (
        <p className="text-xs text-muted-foreground">検出中…（10秒ごとに結果が追加されます）</p>
      ) : recordingPhase === "paused" ? (
        <p className="text-xs text-muted-foreground">一時停止中です。再開すると検出を続けます。</p>
      ) : processing !== null ? (
        <p className="text-xs text-muted-foreground">精度向上パスを実行中です…</p>
      ) : segments.length > 0 ? (
        <p className="text-xs text-muted-foreground">このパスでは音響イベントは検出されませんでした。</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          録音を開始し、停止後の精度向上パスが完了すると、ここに結果が表示されます。
        </p>
      )}
    </div>
  );
}
