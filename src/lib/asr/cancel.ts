/**
 * The frontend half of the analysis-cancellation contract.
 *
 * Kept in its own import-free module (same reasoning as `store/capabilities.ts`)
 * so it can be unit-tested without pulling in `client.ts` and the whole Tauri
 * IPC surface with it.
 */

/**
 * The exact error string the Rust side returns from `transcribe_recording`,
 * `diarize_recording` and `detect_audio_events` when it stopped because the
 * user cancelled rather than because anything failed.
 *
 * Must stay identical to `cancel::CANCELLED` in `src-tauri/src/cancel.rs` --
 * that string equality is the whole contract, since a cancelled command comes
 * back as an ordinary rejected `invoke()`.
 */
export const ANALYSIS_CANCELLED = "__analysis_cancelled__";

/**
 * Whether a rejected analysis command was cancelled by the user, as opposed to
 * having genuinely failed.
 *
 * Substring rather than equality: Tauri wraps a command's `Err(String)` on the
 * way out, so callers may see the sentinel embedded in a longer message.
 */
export function isCancelledError(err: unknown): boolean {
  return String(err).includes(ANALYSIS_CANCELLED);
}
