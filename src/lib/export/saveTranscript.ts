import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useMockBackend } from "../env";
import type { TranscriptSegment } from "../transcript";
import { combinedText, combinedChunks } from "../transcript";
import { chunksToSrt } from "./srt";

export type ExportFormat = "txt" | "srt";

/** Opens a native save dialog and writes the transcript in the requested format. Returns false if the user cancelled. */
export async function saveTranscript(segments: TranscriptSegment[], format: ExportFormat): Promise<boolean> {
  // Both halves of this need a native file dialog and native filesystem
  // access, neither of which a plain browser tab has -- so the browser
  // preview reports "cancelled" rather than letting an unhandled rejection
  // escape into the two call sites that `await` this bare. The menu items
  // themselves are disabled there too (see `TranscriptToolbar`), so this is
  // the backstop, not the user-facing behavior. See ../env.ts.
  if (useMockBackend) {
    console.info("[mock] transcript export is unavailable in the browser preview");
    return false;
  }

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
