import { open } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { useMockBackend } from "../env";
import type { TranscriptSegment } from "../transcript";
import { combinedText, combinedChunks, collapseDegenerateSegments } from "../transcript";
import { chunksToSrt, prepareCues } from "./srt";

export type TranscriptFormat = "txt" | "srt";

/** Opens a native folder-selection dialog for `AutoSaveSettings.directory`.
 * Returns `null` if the user cancelled -- or always, in the browser preview,
 * which has no native dialog to show (see ../env.ts). */
export async function pickAutoSaveDirectory(): Promise<string | null> {
  if (useMockBackend) {
    console.info("[mock] folder picker is unavailable in the browser preview");
    return null;
  }
  return (await open({ directory: true })) ?? null;
}

/**
 * Writes a take's transcript into the configured auto-save folder as
 * `<id>.<format>`, alongside the WAV and sidecar JSON `recordingsDir()`
 * already puts there (see history.ts). A no-op with nothing to configure --
 * `directory` empty, or the browser preview, which can't write outside its
 * sandbox -- rather than an error, since this is always called opportunistically
 * after a take is already safely filed in history.
 */
export async function autoSaveTranscript(
  segments: TranscriptSegment[],
  id: string,
  directory: string,
  format: TranscriptFormat,
): Promise<void> {
  if (useMockBackend || !directory) return;

  // Same collapsing/repair as the transcript view and SRT cue prep, so an
  // auto-saved file never shows a stalled decode's repeated cues or raw
  // SRT timing artefacts that the on-screen transcript itself doesn't show.
  const displaySegments = collapseDegenerateSegments(segments);
  const content =
    format === "srt"
      ? chunksToSrt(prepareCues(combinedChunks(displaySegments)))
      : combinedText(displaySegments);
  await writeTextFile(await join(directory, `${id}.${format}`), content);
}
