mod asr;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(asr::AsrState::default())
        .invoke_handler(tauri::generate_handler![asr::init_model, asr::transcribe_window])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
