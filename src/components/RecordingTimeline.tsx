import { useEffect } from "react";
import { Play, Pause, Rewind, FastForward } from "lucide-react";
import { Button } from "./ui/button";
import { Slider } from "./ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { TimeRangeChip } from "./TimeRangeChip";
import { useAppStore, type PlaybackState } from "../store/appStore";
import type { AudioEvent } from "../lib/asr";
import { audioEventLabelJa, audioEventCategory, isNoiseOrMusicEvent } from "../lib/audioEvents";
import { AUDIO_EVENT_CATEGORY_ICON } from "../lib/audioEventIcons";
import { formatTimestamp } from "../lib/format";
import { cn } from "../lib/utils";

/** Matches the spec's `←`/`→` seek amount (5s) and `Ctrl+S`-adjacent 10s
 * skip buttons -- both conventions from the reference recorder spec, kept as
 * two different amounts since a keyboard nudge and a deliberate button press
 * serve different granularities of "go back a bit". */
const ARROW_SKIP_SEC = 5;
const BUTTON_SKIP_SEC = 10;
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

/** Narrowest a segment is ever drawn, in percent of the track's width -- a
 * single confident tag in a 30-minute recording would otherwise round to
 * nothing and be invisible/unclickable. */
const MIN_SEGMENT_WIDTH_PCT = 1.5;
/** Below this width there's no room to draw the category icon without it
 * overflowing the segment. */
const ICON_MIN_WIDTH_PCT = 4;

/**
 * The proportional-width event track sharing the seek bar's time axis below
 * it, so an audio event's position visually lines up with where it is in the
 * recording -- the "closer to a real timeline" half of the design plan's
 * `AudioEventPanel` rework (the detail list itself stays in
 * `AudioEventPanel`; this is the at-a-glance overview). Always rendered once
 * something is loaded for playback, even with zero events -- an empty muted
 * track still carries the playhead, so the axis stays legible whether or not
 * this recording had anything worth tagging.
 */
function EventBand({ events, playback }: { events: AudioEvent[]; playback: PlaybackState }) {
  const duration = Math.max(playback.durationSec, 0.01);
  // Only events overlapping the recording currently loaded -- see
  // PlaybackState.timelineOffsetSec's doc comment for why an event from an
  // earlier take in the same session must not be drawn on this axis.
  const visible = events.filter(
    (e) => e.end > playback.timelineOffsetSec && e.start < playback.timelineOffsetSec + duration,
  );
  const playheadPct = Math.min(100, Math.max(0, (playback.currentTimeSec / duration) * 100));

  return (
    <div className="relative h-6 w-full overflow-hidden rounded-sm bg-muted">
      {visible.map((e, i) => {
        const localStart = Math.max(0, e.start - playback.timelineOffsetSec);
        const localEnd = Math.min(duration, e.end - playback.timelineOffsetSec);
        const left = (localStart / duration) * 100;
        const width = Math.max(((localEnd - localStart) / duration) * 100, MIN_SEGMENT_WIDTH_PCT);
        const noisy = isNoiseOrMusicEvent(e.name);
        const Icon = AUDIO_EVENT_CATEGORY_ICON[audioEventCategory(e.name)];
        return (
          <Tooltip key={i}>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  "absolute inset-y-0 flex items-center justify-center overflow-hidden rounded-[2px] border",
                  // `--graphite` isn't exposed as a Tailwind color token (only
                  // used via CSS var elsewhere), so the neutral category color
                  // reuses one of the chart tokens instead, same as the
                  // transcript's speaker strips do.
                  noisy ? "border-amber/50 bg-amber/25" : "border-chart-3/40 bg-chart-3/25",
                )}
                style={{ left: `${left}%`, width: `${width}%` }}
              >
                {width >= ICON_MIN_WIDTH_PCT && (
                  <Icon className="h-3 w-3 shrink-0 text-foreground/70" aria-hidden="true" />
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent>
              {audioEventLabelJa(e.name)} ({formatTimestamp(e.start)}–{formatTimestamp(e.end)})
            </TooltipContent>
          </Tooltip>
        );
      })}
      <div
        className="pointer-events-none absolute inset-y-0 w-px bg-foreground"
        style={{ left: `${playheadPct}%` }}
        aria-hidden="true"
      />
    </div>
  );
}

/**
 * The one shared time axis for a finished recording: a seek bar now, and
 * (once live audio-event detection lands) the event timeline drawn on the
 * same axis above it -- see the design plan's rationale for why these two
 * belong in one component rather than two unrelated panels each reinventing
 * "where in the recording is this". Hidden entirely until something is
 * loaded (`playback.recordingId`); there is nothing to scrub during a live
 * recording; that's what the transcript's own "still arriving" indicator is
 * for (see `TranscriptPanel`).
 */
export function RecordingTimeline() {
  const playback = useAppStore((s) => s.playback);
  const audioEvents = useAppStore((s) => s.audioEvents);
  const togglePlayback = useAppStore((s) => s.togglePlayback);
  const seekTo = useAppStore((s) => s.seekTo);
  const skip = useAppStore((s) => s.skip);
  const setPlaybackRate = useAppStore((s) => s.setPlaybackRate);
  // Playback is a stopped-only capability. `startRecording` also unloads
  // whatever was loaded, so this is belt-and-braces -- but relying on that
  // side effect alone is what previously left the Space/arrow shortcuts live
  // during a take.
  const stopped = useAppStore((s) => s.recordingPhase) === "stopped";

  const loaded = stopped && playback.recordingId != null && !playback.loading;

  // Space / ←→ per the reference spec's keyboard shortcut table, scoped to
  // whenever a recording is actually loaded for playback so these keys don't
  // steal focus from, say, typing in the glossary field.
  useEffect(() => {
    if (!loaded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.key === " ") {
        e.preventDefault();
        togglePlayback();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        skip(-ARROW_SKIP_SEC);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        skip(ARROW_SKIP_SEC);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [loaded, togglePlayback, skip]);

  if (!stopped || playback.recordingId == null) return null;

  return (
    <div className="flex w-full flex-col gap-2 rounded-lg border border-border p-4">
      <EventBand events={audioEvents} playback={playback} />

      <div className="flex items-center gap-3">
        <TimeRangeChip start={playback.currentTimeSec} className="w-12" />
        <Slider
          min={0}
          max={Math.max(playback.durationSec, 0.01)}
          step={0.1}
          value={[Math.min(playback.currentTimeSec, playback.durationSec)]}
          onValueChange={([v]) => v !== undefined && seekTo(v)}
          disabled={playback.loading}
          aria-label="再生位置"
          className="flex-1"
        />
        <TimeRangeChip start={playback.durationSec} className="w-12 text-right" />
      </div>

      <div className="flex items-center justify-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title={`${BUTTON_SKIP_SEC}秒戻る`}
          aria-label={`${BUTTON_SKIP_SEC}秒戻る`}
          onClick={() => skip(-BUTTON_SKIP_SEC)}
          disabled={playback.loading}
        >
          <Rewind className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          title={playback.isPlaying ? "一時停止 (Space)" : "再生 (Space)"}
          aria-label={playback.isPlaying ? "一時停止" : "再生"}
          onClick={togglePlayback}
          disabled={playback.loading}
        >
          {playback.isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title={`${BUTTON_SKIP_SEC}秒進む`}
          aria-label={`${BUTTON_SKIP_SEC}秒進む`}
          onClick={() => skip(BUTTON_SKIP_SEC)}
          disabled={playback.loading}
        >
          <FastForward className="h-4 w-4" />
        </Button>

        <Select value={String(playback.rate)} onValueChange={(v) => setPlaybackRate(Number(v))}>
          <SelectTrigger size="sm" className="ml-2 w-20" aria-label="再生速度">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RATES.map((rate) => (
              <SelectItem key={rate} value={String(rate)}>
                {rate}x
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
