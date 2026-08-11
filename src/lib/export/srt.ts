import type { TranscriptChunk } from "../asr";

function formatSrtTimestamp(seconds: number): string {
  const clamped = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalMs = Math.round(clamped * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);

  const pad2 = (n: number) => n.toString().padStart(2, "0");
  const pad3 = (n: number) => n.toString().padStart(3, "0");
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(ms)}`;
}

/** Converts ASR timestamped chunks into an SRT subtitle file's text content. */
export function chunksToSrt(chunks: TranscriptChunk[]): string {
  return chunks
    .map((chunk, index) => {
      const [start, end] = chunk.timestamp;
      const endSeconds = end ?? start;
      return [
        `${index + 1}`,
        `${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(endSeconds)}`,
        chunk.text.trim(),
        "",
      ].join("\n");
    })
    .join("\n");
}
