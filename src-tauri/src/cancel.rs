//! Cooperative cancellation for the post-stop analysis pipeline
//! (`transcribe_recording` -> `diarize_recording` -> `detect_audio_events`).
//!
//! One shared `Arc<AtomicBool>` in Tauri's managed state, which each of those
//! commands polls wherever it happens to be able to. Same shape as
//! `appaudio.rs`'s `CaptureHandle.stop`, which is the app's only other
//! stop-a-running-thing mechanism -- there is nothing to join here, though,
//! since the work runs on `spawn_blocking` rather than a thread we own.
//!
//! **A single flag is enough** because at most one analysis pass can ever be
//! in flight: `selectCapabilities` (`src/store/capabilities.ts`) gates both
//! `reanalyze` and `startRecording` on `processing === null`, so the frontend
//! cannot start a second pass until the first one has finished unwinding.
//! `begin_analysis` clears the flag at the head of every pass, so a cancel
//! that arrives too late to stop anything cannot leak into the next one.
//!
//! **Nothing here may touch `AsrState`.** Its mutex is held for the entire
//! duration of a `full()` call (`asr.rs`), so a cancel command that locked it
//! would block behind the very work it is trying to stop.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

/// The error string every analysis command returns when it stops early
/// because the user cancelled, rather than because anything went wrong.
///
/// The frontend matches on this exact value (`ANALYSIS_CANCELLED` in
/// `src/lib/asr/client.ts`) to tell a deliberate cancellation apart from a
/// failure -- without it, one cancel would surface as a stack of "diarization
/// failed" / "audio tagging failed" notices.
pub const CANCELLED: &str = "__analysis_cancelled__";

#[derive(Default)]
pub struct CancelState(pub Arc<AtomicBool>);

/// The shared flag, cloned out of managed state. Take this *before* entering
/// `spawn_blocking` so the closure owns an `Arc` rather than an `AppHandle`
/// borrow.
pub fn flag(app: &AppHandle) -> Arc<AtomicBool> {
    Arc::clone(&app.state::<CancelState>().0)
}

/// The polling primitive: `cancel::check(&flag)?` at any point a command can
/// usefully give up. Deliberately takes the flag rather than an `AppHandle`,
/// so it is a plain function the unit tests below can exercise.
pub fn check(flag: &AtomicBool) -> Result<(), String> {
    if flag.load(Ordering::Relaxed) {
        Err(CANCELLED.to_string())
    } else {
        Ok(())
    }
}

/// Clears any leftover cancellation before a new analysis pass starts. Called
/// by the frontend at the head of `runAccuracyPipeline`, which is the single
/// entry point shared by the post-stop second pass and history re-analysis.
#[tauri::command]
pub async fn begin_analysis(app: AppHandle) {
    app.state::<CancelState>().0.store(false, Ordering::Relaxed);
}

/// Asks the running analysis pass to stop. Returns as soon as the flag is
/// set; how long the pass actually takes to notice depends on which stage it
/// is in (sub-second inside whisper, up to the remaining diarization time
/// inside sherpa's opaque `process()` call).
#[tauri::command]
pub async fn cancel_analysis(app: AppHandle) {
    app.state::<CancelState>().0.store(true, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_passes_while_clear_and_fails_once_set() {
        let flag = AtomicBool::new(false);
        assert!(check(&flag).is_ok());

        flag.store(true, Ordering::Relaxed);
        assert_eq!(check(&flag), Err(CANCELLED.to_string()));
    }

    #[test]
    fn clearing_the_flag_makes_a_later_pass_runnable_again() {
        // What `begin_analysis` buys: a cancel that arrived too late to stop
        // the previous pass must not immediately kill the next one.
        let flag = AtomicBool::new(true);
        flag.store(false, Ordering::Relaxed);
        assert!(check(&flag).is_ok());
    }
}
