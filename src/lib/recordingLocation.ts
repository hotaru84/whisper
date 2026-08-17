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

export function setRecordingDirectory(dir: string): void {
  currentDirectory = dir;
}

export function getRecordingDirectory(): string {
  return currentDirectory;
}
