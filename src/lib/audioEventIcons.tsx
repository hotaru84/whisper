import { Music, Waves, PartyPopper, Mic, Keyboard, Bell, AudioLines, type LucideIcon } from "lucide-react";
import type { AudioEventCategory } from "./audioEvents";

/** One glyph per `AudioEventCategory`, used by `RecordingTimeline`'s event
 * band -- the only place a detected event's category is shown. */
export const AUDIO_EVENT_CATEGORY_ICON: Record<AudioEventCategory, LucideIcon> = {
  music: Music,
  noise: Waves,
  applause: PartyPopper,
  speech: Mic,
  typing: Keyboard,
  alert: Bell,
  other: AudioLines,
};
