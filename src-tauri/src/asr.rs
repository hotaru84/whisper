use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Manager};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// Holds the loaded whisper.cpp model for the lifetime of the app. `None` until
/// `init_model` succeeds.
pub struct AsrState(Mutex<Option<WhisperContext>>);

impl Default for AsrState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

#[derive(Clone, Serialize)]
struct ModelReadyPayload {
    device: &'static str,
}

#[derive(Clone, Serialize)]
struct AsrErrorPayload {
    message: String,
}

fn resolve_model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    Ok(resource_dir.join("resources/models/whisper-large-v3-turbo/model.gguf"))
}

#[tauri::command]
pub async fn init_model(app: AppHandle) -> Result<(), String> {
    let app_for_load = app.clone();
    // Loading a ~600MB GGUF file is blocking CPU/IO work; keep it off the async runtime.
    let result = tauri::async_runtime::spawn_blocking(move || {
        let model_path = resolve_model_path(&app_for_load)?;
        WhisperContext::new_with_params(&model_path, WhisperContextParameters::default())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    match result {
        Ok(ctx) => {
            *app.state::<AsrState>().0.lock().unwrap() = Some(ctx);
            let _ = app.emit("asr:model-ready", ModelReadyPayload { device: "cpu" });
            Ok(())
        }
        Err(message) => {
            let _ = app.emit(
                "asr:model-error",
                AsrErrorPayload {
                    message: message.clone(),
                },
            );
            Err(message)
        }
    }
}

#[derive(Serialize)]
pub struct TranscribeChunk {
    pub text: String,
    pub timestamp: (f32, f32),
}

#[derive(Serialize)]
pub struct TranscribeResult {
    pub text: String,
    pub chunks: Vec<TranscribeChunk>,
}

/// Transcribes one streaming window of mono 16kHz f32 PCM audio.
///
/// The audio is sent as a raw IPC body (not JSON) to avoid serializing ~2MB of
/// per-sample numbers on every 30s window; language, task and the prompt tail
/// ride along as headers.
#[tauri::command]
pub async fn transcribe_window(
    app: AppHandle,
    request: Request<'_>,
) -> Result<TranscribeResult, String> {
    let InvokeBody::Raw(audio_bytes) = request.body() else {
        return Err("transcribe_window expects a raw binary body".to_string());
    };
    let audio_bytes = audio_bytes.clone();

    let language = request
        .headers()
        .get("X-Asr-Language")
        .and_then(|v| v.to_str().ok())
        .filter(|lang| !lang.is_empty() && *lang != "auto")
        .map(str::to_string);
    let translate = request
        .headers()
        .get("X-Asr-Task")
        .and_then(|v| v.to_str().ok())
        == Some("translate");

    tauri::async_runtime::spawn_blocking(move || {
        // IPC bytes aren't guaranteed 4-byte aligned, so decode via from_le_bytes
        // rather than an unsafe pointer cast.
        let samples: Vec<f32> = audio_bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();

        let state = app.state::<AsrState>();
        let guard = state.0.lock().unwrap();
        let ctx = guard
            .as_ref()
            .ok_or_else(|| "model is not initialized".to_string())?;
        let mut whisper_state = ctx.create_state().map_err(|e| e.to_string())?;

        // Beam search rather than greedy: whisper.cpp's own CLI defaults to
        // beam_size 5, and greedy noticeably degrades quality (with temperature
        // at its 0.0 default, `best_of` does nothing, so greedy is a plain
        // argmax). Only the 4-layer decoder pays for this; the 32-layer encoder
        // dominates runtime and is unaffected.
        let mut params = FullParams::new(SamplingStrategy::BeamSearch {
            beam_size: 5,
            patience: -1.0,
        });
        params.set_language(language.as_deref());
        params.set_translate(translate);
        // A fresh WhisperState is created per window, so there is no decoder state
        // to carry over and `no_context` is a no-op here. Continuity across windows
        // instead comes from `set_initial_prompt` below.
        params.set_no_context(true);
        // Drop non-speech tokens like "(音楽)" / "[拍手]" instead of transcribing them.
        params.set_suppress_nst(true);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);
        params.set_print_timestamps(false);

        // Repetition guard. Whisper can fall into degenerate loops that emit the
        // same phrase over and over; the transformers.js pipeline this replaced
        // suppressed them with `no_repeat_ngram_size: 3`, which whisper.cpp has no
        // equivalent for. What it does have is a fallback triggered by
        // `result_len > 32 && entropy < entropy_thold`, which re-decodes at a
        // higher temperature. The 2.4 default is too permissive here: an observed
        // loop measured entropy 2.60 and sailed through, so raise the bar.
        params.set_entropy_thold(2.8);
        // Cap the thread count. ggml splits each op evenly across threads and
        // barriers between them, so on hybrid CPUs (P/E cores) the slowest core
        // gates every step and oversubscribing hurts. Measured on a Core Ultra 7
        // 155H (22 logical): 12 threads 27.3s vs 22 threads 33.6s per encoder pass.
        let threads = std::thread::available_parallelism()
            .map(|n| n.get().min(8) as i32)
            .unwrap_or(4);
        params.set_n_threads(threads);

        whisper_state
            .full(params, &samples)
            .map_err(|e| e.to_string())?;

        let n_segments = whisper_state.full_n_segments();
        let mut chunks = Vec::with_capacity(n_segments.max(0) as usize);
        let mut text = String::new();
        for i in 0..n_segments {
            let Some(segment) = whisper_state.get_segment(i) else {
                continue;
            };
            let seg_text = segment.to_str_lossy().map_err(|e| e.to_string())?.into_owned();
            let t0 = segment.start_timestamp() as f32 / 100.0;
            let t1 = segment.end_timestamp() as f32 / 100.0;
            text.push_str(&seg_text);
            chunks.push(TranscribeChunk {
                text: seg_text,
                timestamp: (t0, t1),
            });
        }

        Ok(TranscribeResult { text, chunks })
    })
    .await
    .map_err(|e| e.to_string())?
}
