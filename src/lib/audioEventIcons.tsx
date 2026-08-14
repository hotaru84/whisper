import { Music, Waves, PartyPopper, Mic, Keyboard, Bell, AudioLines, type LucideIcon } from "lucide-react";
import type { AudioEventCategory } from "./audioEvents";

/** One glyph per `AudioEventCategory`, shared by `AudioEventPanel`'s list
 * rows and `RecordingTimeline`'s event band so the same tag reads as the
 * same icon wherever it appears. */
export const AUDIO_EVENT_CATEGORY_ICON: Record<AudioEventCategory, LucideIcon> = {
  music: Music,
  noise: Waves,
  applause: PartyPopper,
  speech: Mic,
  typing: Keyboard,
  alert: Bell,
  other: AudioLines,
};
