/**
 * Formats a duration/timestamp in seconds as `m:ss`, switching to `h:mm:ss`
 * once it reaches an hour. Shared by every place in the app that shows a
 * timestamp, elapsed time, or a recording's duration (`TitleBarStatus`,
 * `HistorySidebar`, `RecordingTimeline`, `TranscriptPanel`, `TimeRangeChip`),
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

/** A recording's `createdAt` as the short `month/day` + `HH:MM` pair the
 * sidebar row and the titlebar's "which recording" status both need --
 * shared so the two can never format the same timestamp differently. */
export function formatDateTime(date: Date): { day: string; time: string } {
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    day: `${date.getMonth() + 1}/${date.getDate()}`,
    time: `${p(date.getHours())}:${p(date.getMinutes())}`,
  };
}
