// Captures another application's rendered audio (Teams/Zoom/...) via WASAPI
// process-loopback, for mixing with the microphone on the frontend.
pub mod appaudio;
// Public so the accuracy harness (`examples/cer.rs`) can decode with exactly the
// same settings the app uses.
pub mod asr;
// Cooperative cancellation shared by the three post-stop analysis commands.
pub mod cancel;
// Retains the whole recording so a second pass (and diarization) can see
// more than one streaming window at a time.
pub mod capture;
// The CER metric lives here rather than in the example so `cargo test` covers it.
pub mod cer;
// Reference-free structural quality metrics (gaps, out-of-order cues) shared
// by the app and the accuracy harness.
pub mod cues;
// Speaker diarization (sherpa-onnx) and merging its output onto whisper's
// transcript segments.
pub mod diarize;
// Audio event detection (sherpa-onnx audio tagging): a standalone timeline,
// and a non-speech exclusion filter over whisper's transcript chunks.
pub mod events;
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
        .manage(appaudio::AppAudioState::default())
        .manage(events::AudioTaggingState::default())
        .manage(cancel::CancelState::default())
        .invoke_handler(tauri::generate_handler![
            asr::init_model,
            asr::transcribe_window,
            asr::transcribe_recording,
            capture::start_capture,
            capture::append_capture,
            capture::finish_capture,
            capture::recording_duration_sec,
            diarize::diarize_recording,
            events::detect_audio_events,
            events::detect_events_window,
            appaudio::list_audio_apps,
            appaudio::start_app_audio_capture,
            appaudio::stop_app_audio_capture,
            cancel::begin_analysis,
            cancel::cancel_analysis,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
