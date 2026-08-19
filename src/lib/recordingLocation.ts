import { invoke } from "@tauri-apps/api/core";
import { useMockBackend } from "./env";

/**
 * Where the recording currently in progress (or about to start) is written,
 * mirroring `AutoSaveSettings.directory` from `store/persistedSettings.ts`.
 * Empty string means "no user-configured folder" -- `capture.ts`/`history.ts`
 * fall back to the app's own cache directory in that case.
 *
 * A standalone module rather than reading straight from `appStore.ts`: both
 * `capture.ts` and `history.ts` are imported *by* the store, so importing the
 * store back from either would be circular. `appStore.ts` keeps this in sync
 * whenever `autoSaveSettings` loads or changes (see `updateAutoSaveSettings`).
 */
let currentDirectory = "";

/**
 * Also grants the fs plugin's runtime scope access to `dir` (see
 * `allow_recording_directory` in `capture.rs`), so `history.ts`'s
 * list/read/delete and `playback.ts`'s `readFile` can actually reach a
 * custom auto-save folder -- `capabilities/default.json` intentionally does
 * not pre-declare one, since it can be anywhere on disk and a wildcard scope
 * there would open the whole filesystem to the webview for the sake of this
 * one folder. Best-effort and fire-and-forget: a failure here surfaces the
 * same way any other unreadable/unwritable folder would, the next time
 * something actually tries to use it (a `refineNotice`, never a hard crash).
 */
export function setRecordingDirectory(dir: string): void {
  currentDirectory = dir;
  if (!useMockBackend) {
    void invoke("allow_recording_directory", { directory: dir }).catch((err) => {
      console.warn("[recording-location] failed to extend fs scope for", dir, err);
    });
  }
}

export function getRecordingDirectory(): string {
  return currentDirectory;
}
