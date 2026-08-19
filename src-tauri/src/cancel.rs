//! Cooperative cancellation for the post-stop analysis pipeline
//! (`transcribe_recording` -> `diarize_recording` -> `detect_audio_events`).
//!
//! One `Arc<AtomicBool>` per job (keyed by recording id) in Tauri's managed
//! state, which each of those commands polls wherever it happens to be able
//! to. Same shape as `appaudio.rs`'s `CaptureHandle.stop`, which is the
//! app's only other stop-a-running-thing mechanism -- there is nothing to
//! join here, though, since the work runs on `spawn_blocking` rather than a
//! thread we own.
//!
//! **Per job, not a single shared flag**, because the frontend queue
//! (`src/lib/asr/whisperQueue.ts`) now lets one recording's diarization/
//! audio-tagging run concurrently with a *different* recording's
//! transcription -- more than one analysis pass can be in flight at once. A
//! single flag would make cancelling one recording's pass also cancel
//! whichever other pass happened to be running at the same moment. Each
//! `job_id` (a recording id) gets its own flag instead. `begin_analysis`
//! resets a job's flag at the head of every pass, so a cancel that arrived
//! too late to stop the previous pass for that job cannot leak into the next
//! one; `end_analysis` removes the entry once a job is done, so the map does
//! not grow for the life of the app.
//!
//! **Nothing here may touch `AsrState`.** Its mutex is held for the entire
//! duration of a `full()` call (`asr.rs`), so a cancel command that locked it
//! would block behind the very work it is trying to stop.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
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
pub struct CancelState(Mutex<HashMap<String, Arc<AtomicBool>>>);

fn flag_in(state: &CancelState, job_id: &str) -> Arc<AtomicBool> {
    let mut map = state.0.lock().unwrap();
    Arc::clone(
        map.entry(job_id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false))),
    )
}

fn begin_in(state: &CancelState, job_id: &str) {
    state
        .0
        .lock()
        .unwrap()
        .insert(job_id.to_string(), Arc::new(AtomicBool::new(false)));
}

fn cancel_in(state: &CancelState, job_id: &str) {
    if let Some(flag) = state.0.lock().unwrap().get(job_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

fn end_in(state: &CancelState, job_id: &str) {
    state.0.lock().unwrap().remove(job_id);
}

/// The shared flag for one job, cloned out of managed state. Take this
/// *before* entering `spawn_blocking` so the closure owns an `Arc` rather
/// than an `AppHandle` borrow. Get-or-inserts, so a command can call this
/// even if `begin_analysis` for this `job_id` has not (yet) run.
pub fn flag(app: &AppHandle, job_id: &str) -> Arc<AtomicBool> {
    flag_in(app.state::<CancelState>().inner(), job_id)
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

/// Clears any leftover cancellation before a new analysis pass starts for
/// `job_id`. Called by the frontend at the head of `runAccuracyPipeline`,
/// which is the single entry point shared by the post-stop second pass and
/// history re-analysis.
#[tauri::command]
pub async fn begin_analysis(app: AppHandle, job_id: String) {
    begin_in(app.state::<CancelState>().inner(), &job_id);
}

/// Asks `job_id`'s running analysis pass to stop. Returns as soon as the
/// flag is set; how long the pass actually takes to notice depends on which
/// stage it is in (sub-second inside whisper, up to the remaining
/// diarization time inside sherpa's opaque `process()` call). Other jobs'
/// flags are untouched.
#[tauri::command]
pub async fn cancel_analysis(app: AppHandle, job_id: String) {
    cancel_in(app.state::<CancelState>().inner(), &job_id);
}

/// Removes `job_id`'s flag once its analysis pass has fully wound down
/// (success, failure, or cancellation) -- hygiene so the map does not grow
/// for every recording ever analyzed over the app's lifetime.
#[tauri::command]
pub async fn end_analysis(app: AppHandle, job_id: String) {
    end_in(app.state::<CancelState>().inner(), &job_id);
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

    #[test]
    fn cancelling_one_job_does_not_affect_another() {
        let state = CancelState::default();
        let a = flag_in(&state, "a");
        let b = flag_in(&state, "b");

        cancel_in(&state, "a");

        assert!(a.load(Ordering::Relaxed));
        assert!(!b.load(Ordering::Relaxed));
    }

    #[test]
    fn begin_analysis_for_one_job_does_not_touch_another() {
        let state = CancelState::default();
        let a = flag_in(&state, "a");
        let b = flag_in(&state, "b");
        cancel_in(&state, "a");
        cancel_in(&state, "b");
        assert!(a.load(Ordering::Relaxed));
        assert!(b.load(Ordering::Relaxed));

        begin_in(&state, "a");

        // "a" got a fresh flag; the Arc held by this test still points at
        // the *old* flag, which stays cancelled -- what matters is that a
        // *new* `flag_in("a", ...)` call now sees a clean one, and "b" was
        // never touched.
        assert!(a.load(Ordering::Relaxed));
        assert!(b.load(Ordering::Relaxed));
        let fresh_a = flag_in(&state, "a");
        assert!(!fresh_a.load(Ordering::Relaxed));
    }

    #[test]
    fn end_analysis_removes_the_map_entry() {
        let state = CancelState::default();
        let first = flag_in(&state, "a");
        end_in(&state, "a");
        let second = flag_in(&state, "a");

        // A fresh flag was inserted on the next `flag_in`, not the same Arc.
        assert!(!Arc::ptr_eq(&first, &second));
    }
}
