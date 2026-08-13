// Public so the accuracy harness (`examples/cer.rs`) can decode with exactly the
// same settings the app uses.
pub mod asr;
// Retains the whole recording so a second pass (and, later, diarization) can see
// more than one streaming window at a time.
pub mod capture;
// The CER metric lives here rather than in the example so `cargo test` covers it.
pub mod cer;
// Shared by the capture writer, the second pass, and the harness, so a fixture
// is read by exactly the code that reads a real recording.
pub mod wav;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(asr::AsrState::default())
        .manage(capture::CaptureState::default())
        .invoke_handler(tauri::generate_handler![
            asr::init_model,
            asr::transcribe_window,
            asr::transcribe_recording,
            capture::start_capture,
            capture::append_capture,
            capture::finish_capture,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
