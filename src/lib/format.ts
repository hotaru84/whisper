/**
 * Formats a duration/timestamp in seconds as `m:ss`, switching to `h:mm:ss`
 * once it reaches an hour. Shared by every place in the app that shows a
 * timestamp, elapsed time, or a recording's duration (`StatusBar`,
 * `HistorySidebar`, `AudioEventPanel`, `TranscriptPanel`, `TimeRangeChip`),
 * so they can never drift into disagreeing about when the hours digit
 * appears or how minutes/seconds are padded.
 */
export function formatTimestamp(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
