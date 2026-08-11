import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { TranscriptSegment } from "../transcript";
import { combinedText, combinedChunks } from "../transcript";
import { chunksToSrt } from "./srt";

export type ExportFormat = "txt" | "srt";

/** Opens a native save dialog and writes the transcript in the requested format. Returns false if the user cancelled. */
export async function saveTranscript(segments: TranscriptSegment[], format: ExportFormat): Promise<boolean> {
  const path = await save({
    defaultPath: `transcript.${format}`,
    filters: [
      format === "srt"
        ? { name: "SubRip Subtitle", extensions: ["srt"] }
        : { name: "Text File", extensions: ["txt"] },
    ],
  });
  if (!path) return false;

  const content = format === "srt" ? chunksToSrt(combinedChunks(segments)) : combinedText(segments);
  await writeTextFile(path, content);
  return true;
}
