//! Retains the whole recording on disk while it is being made.
//!
//! The live transcription pass only ever keeps ~one 15-second window in memory,
//! which is what makes it cheap but also what caps its accuracy: it can never
//! look at a sentence that straddles a window boundary, and it has no context
//! from a minute ago. Keeping the audio lets a second pass re-read the whole
//! recording once the user stops (see `asr::transcribe_recording`), and speaker
//! diarization needs it too -- deciding that the voice at 00:01 and the voice at
//! 30:00 are the same person is not something a 15-second window can do.
//!
//! Audio goes to a file rather than a `Vec`: an hour of 16 kHz f32 is ~230 MB,
//! and meetings run longer than an hour. Streaming it out keeps memory flat.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager};

use crate::wav;

/// The WAV file currently being written, if a recording is in progress.
#[derive(Default)]
pub struct CaptureState(Mutex<Option<wav::Writer>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureInfo {
    pub path: String,
    pub duration_sec: f32,
}

/// Reduces a caller-supplied name to something that cannot escape the
/// recordings directory.
///
/// The frontend picks the name so it can use a local-time timestamp, which Rust
/// cannot format without pulling in a date crate. That makes it untrusted input
/// reaching a filesystem path, so everything outside `[A-Za-z0-9_-]` goes --
/// which removes `.`, `/` and `\`, and with them any traversal.
fn sanitize_stem(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "recording".to_string()
    } else {
        cleaned
    }
}

/// `directory`, when non-empty, is a user-configured folder (see
/// `AutoSaveSettings` on the frontend) that the recording is written to
/// directly, in place of the app's own cache directory -- so no
/// `"recordings"` subfolder is appended in that case, unlike the default.
fn recording_path(app: &AppHandle, name: &str, directory: Option<&str>) -> Result<PathBuf, String> {
    let dir = match directory {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => app
            .path()
            .app_cache_dir()
            .map_err(|e| format!("cannot resolve the cache directory: {e}"))?
            .join("recordings"),
    };
    Ok(dir.join(format!("{}.wav", sanitize_stem(name))))
}

/// Opens a WAV file for the recording that is about to start, returning its path.
///
/// Any file already open is dropped, which closes it. Its data stays on disk:
/// discarding a previous recording is the user's call, not ours.
#[tauri::command]
pub async fn start_capture(app: AppHandle, name: String, directory: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = recording_path(&app, &name, directory.as_deref())?;
        let writer = wav::Writer::create(&path)?;
        let display = writer.path().display().to_string();
        *app.state::<CaptureState>().0.lock().unwrap() = Some(writer);
        Ok(display)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Appends captured PCM to the open recording.
///
/// The body is raw little-endian f32, the same wire format `transcribe_window`
/// uses, because JSON-encoding a few seconds of samples per call would cost more
/// than the transcription.
#[tauri::command]
pub async fn append_capture(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("append_capture expects a raw binary body".to_string());
    };
    let bytes = bytes.clone();

    tauri::async_runtime::spawn_blocking(move || {
        // IPC bytes aren't guaranteed 4-byte aligned, so decode via from_le_bytes
        // rather than an unsafe pointer cast.
        let samples: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();

        let state = app.state::<CaptureState>();
        let mut guard = state.0.lock().unwrap();
        let writer = guard
            .as_mut()
            .ok_or_else(|| "no recording is being captured".to_string())?;
        writer.append(&samples)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// How long an existing recording runs, without opening it for playback.
///
/// Exists for the interrupted-take recovery in `history.ts`: a take whose
/// frontend was reloaded mid-recording (WebView2 recreating its renderer after
/// a resume from suspend, say) never reached `finish_capture`, so its duration
/// was never reported to anyone and no sidecar was written. The WAV itself is
/// intact -- [`wav::Writer`] keeps the header current after every append -- so
/// the duration can be recovered from it and the take filed in history after
/// the fact.
///
/// Takes a name rather than a path, and resolves it through the same
/// `recording_path` the writer uses, so this cannot be pointed at an arbitrary
/// file on disk.
#[tauri::command]
pub async fn recording_duration_sec(app: AppHandle, name: String, directory: Option<String>) -> Result<f32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = recording_path(&app, &name, directory.as_deref())?;
        wav::duration_sec(&path)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Closes the recording and reports where it landed and how long it runs.
#[tauri::command]
pub async fn finish_capture(app: AppHandle) -> Result<CaptureInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let writer = app
            .state::<CaptureState>()
            .0
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| "no recording is being captured".to_string())?;
        let duration_sec = writer.duration_sec();
        let path = writer.finish()?;
        Ok(CaptureInfo {
            path: path.display().to_string(),
            duration_sec,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::sanitize_stem;

    #[test]
    fn keeps_the_timestamp_names_the_frontend_generates() {
        assert_eq!(sanitize_stem("rec-20260813-084500"), "rec-20260813-084500");
        assert_eq!(sanitize_stem("meeting_01"), "meeting_01");
    }

    #[test]
    fn strips_path_separators_and_traversal() {
        assert_eq!(sanitize_stem("../../etc/passwd"), "etcpasswd");
        assert_eq!(sanitize_stem("..\\..\\windows\\system32"), "windowssystem32");
        assert_eq!(sanitize_stem("a/b"), "ab");
        // A name that is nothing but traversal must not collapse to an empty
        // filename, which would make the path a directory.
        assert_eq!(sanitize_stem("../.."), "recording");
        assert_eq!(sanitize_stem(""), "recording");
    }

    #[test]
    fn drops_non_ascii_and_shell_metacharacters() {
        assert_eq!(sanitize_stem("会議 2026"), "2026");
        assert_eq!(sanitize_stem("a b:c*d?e\"f"), "abcdef");
        assert_eq!(sanitize_stem("rec\0name"), "recname");
    }

    #[test]
    fn caps_the_length() {
        assert_eq!(sanitize_stem(&"a".repeat(200)).len(), 64);
    }
}
