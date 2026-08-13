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

/// Decodes an `encodeURIComponent`-encoded header value back into UTF-8.
///
/// Header values are restricted to visible ASCII, so the (Japanese) glossary has
/// to travel percent-encoded.
///
/// Malformed escapes pass through verbatim rather than failing the request: a
/// mangled glossary should cost some accuracy, never a transcription. NUL bytes
/// are dropped because the result reaches a `CString` via
/// `FullParams::set_initial_prompt`, which panics on interior NULs.
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 3 <= bytes.len() {
            if let Some(byte) = std::str::from_utf8(&bytes[i + 1..i + 3])
                .ok()
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
            {
                if byte != 0 {
                    out.push(byte);
                }
                i += 3;
                continue;
            }
        }
        if bytes[i] != 0 {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Which backend the binary was built to run inference on.
///
/// This reports the *build* configuration, not a runtime probe: whisper.cpp
/// decides at load time whether a Vulkan device actually bound and only says so
/// in a log line, with no API to ask afterwards. So a Vulkan build that fell back
/// to CPU still reports "vulkan" here. That is still strictly better than the
/// hardcoded "cpu" this replaced, which was wrong on every GPU build. Run with
/// `WHISPER_VERBOSE=1` and look for `whisper_backend_init_gpu: using Vulkan0
/// backend` to confirm what actually bound.
fn build_backend() -> &'static str {
    if cfg!(feature = "vulkan") {
        "vulkan"
    } else {
        "cpu"
    }
}

fn resolve_model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    Ok(resource_dir.join("resources/models/whisper-large-v3-turbo/model.gguf"))
}

/// Silences whisper.cpp's and ggml's own stdout/stderr logging.
///
/// Left alone, they print a model dump on load plus ~7 lines of `whisper_init_state:`
/// for *every* transcription window, which buries anything useful. The hooks route
/// those messages into the `log`/`tracing` facades instead, and since neither
/// backend feature is enabled on whisper-rs they are simply dropped.
///
/// Set `WHISPER_VERBOSE=1` to keep the native logging when diagnosing model or
/// GPU-backend problems.
fn configure_native_logging() {
    let verbose = std::env::var("WHISPER_VERBOSE").is_ok_and(|v| v != "0" && !v.is_empty());
    if !verbose {
        whisper_rs::install_logging_hooks();
    }
}

#[tauri::command]
pub async fn init_model(app: AppHandle) -> Result<(), String> {
    configure_native_logging();
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
            let _ = app.emit(
                "asr:model-ready",
                ModelReadyPayload {
                    device: build_backend(),
                },
            );
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

/// Every decoding knob that affects transcription quality, in one place.
///
/// This exists so the accuracy harness (`examples/cer.rs`) decodes with exactly
/// the same settings the app uses. If the two drifted apart, a measured CER
/// would say nothing about what users actually get.
#[derive(Debug, Clone)]
pub struct DecodeSettings {
    /// ISO 639-1 code. `None` lets whisper auto-detect, which is a common
    /// accuracy loss on short clips -- pass `Some("ja")` when the language is known.
    pub language: Option<String>,
    pub translate: bool,
    pub beam_size: i32,
    /// Repetition guard: whisper re-decodes at a higher temperature when
    /// `result_len > 32 && entropy < entropy_thold`. Raised above whisper.cpp's
    /// 2.4 default because an observed loop measured 2.60 and sailed through.
    pub entropy_thold: f32,
    /// Drops non-speech tokens.
    ///
    /// Left at whisper.cpp's own default of `false`. It was briefly enabled here
    /// to suppress `(音楽)`-style artefacts, but whisper.cpp's non-speech list
    /// includes 「」『』 (whisper.cpp:6095-6100), so it silently removed
    /// legitimate Japanese quotation marks -- and it does nothing about the
    /// hallucination actually observed on silence (「ご視聴ありがとうございました」),
    /// which is ordinary speech tokens. Absent measurements, the upstream default
    /// is the more defensible choice; flip it with `--suppress-nst true` in the
    /// CER harness once there are fixtures to judge it on.
    pub suppress_nst: bool,
    pub n_threads: i32,
    /// Glossary text fed to the decoder as `initial_prompt`, biasing it toward
    /// terminology it would otherwise mis-hear (product names, jargon, people).
    ///
    /// This is a *soft* bias, not a constraint: whisper may still get a term
    /// wrong, and it can occasionally echo the prompt into the transcript.
    ///
    /// Critically, this must only ever carry text the **user wrote**. Feeding the
    /// model's own output back in was tried and reverted: it turns a single
    /// stumble into a self-amplifying repetition loop. Static text cannot compound
    /// that way.
    ///
    /// Budget is `min(n_max_text_ctx, n_text_ctx / 2)` = 224 tokens for
    /// large-v3-turbo, and Japanese runs about one token per character, so roughly
    /// 200 characters. whisper.cpp keeps the tail and silently drops the rest.
    /// It is also ignored once temperature fallback passes 0.5
    /// (WHISPER_HISTORY_CONDITIONING_TEMP_CUTOFF), so it stops helping exactly
    /// when decoding is already struggling.
    pub prompt: Option<String>,
}

impl Default for DecodeSettings {
    fn default() -> Self {
        Self {
            language: Some("ja".to_string()),
            translate: false,
            beam_size: 5,
            entropy_thold: 2.8,
            suppress_nst: false,
            n_threads: default_n_threads(),
            prompt: None,
        }
    }
}

/// ggml splits each op evenly across threads and barriers between them, so on
/// hybrid CPUs (P/E cores) the slowest core gates every step and oversubscribing
/// hurts. Measured on a Core Ultra 7 155H (22 logical), CPU backend: 12 threads
/// 27.3s vs 22 threads 33.6s per encoder pass. With Vulkan carrying the encoder
/// this mostly governs mel and CPU-side ops.
pub fn default_n_threads() -> i32 {
    std::thread::available_parallelism()
        .map(|n| n.get().min(8) as i32)
        .unwrap_or(4)
}

/// Builds whisper's parameter struct from [`DecodeSettings`].
///
/// The returned value borrows the language string out of `settings`, so keep
/// `settings` alive for as long as the params are in use.
pub fn build_full_params(settings: &DecodeSettings) -> FullParams<'_, '_> {
    // Beam search rather than greedy: whisper.cpp's own CLI defaults to
    // beam_size 5, and with temperature at its 0.0 default greedy's `best_of`
    // does nothing, making it a plain argmax. Only the 4-layer decoder pays for
    // this; the 32-layer encoder dominates runtime and is unaffected.
    //
    // Caveat worth knowing: whisper-rs offers no way to set `best_of` alongside
    // `beam_size`, so it stays at whisper.cpp's -1 and every temperature-fallback
    // pass after the first decodes with a single greedy decoder.
    let mut params = FullParams::new(SamplingStrategy::BeamSearch {
        beam_size: settings.beam_size,
        patience: -1.0,
    });
    params.set_language(settings.language.as_deref());
    params.set_translate(settings.translate);
    params.set_suppress_nst(settings.suppress_nst);
    params.set_entropy_thold(settings.entropy_thold);
    params.set_n_threads(settings.n_threads);
    // Each streaming window is its own `full()` call over <= 30s of audio, i.e.
    // always whisper's "first chunk", so the prompt conditions every window. That
    // sidesteps needing `carry_initial_prompt`, which whisper-rs does not expose.
    if let Some(prompt) = settings.prompt.as_deref() {
        if !prompt.trim().is_empty() {
            params.set_initial_prompt(prompt);
        }
    }
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);
    params.set_print_timestamps(false);
    params
}

/// Collects whisper's segments into the shape the frontend consumes.
/// Timestamps are converted from whisper's centiseconds to seconds.
pub fn collect_segments(state: &whisper_rs::WhisperState) -> Result<TranscribeResult, String> {
    let n_segments = state.full_n_segments();
    let mut chunks = Vec::with_capacity(n_segments.max(0) as usize);
    let mut text = String::new();
    for i in 0..n_segments {
        let Some(segment) = state.get_segment(i) else {
            continue;
        };
        // Lossy on purpose: whisper's BPE can split a Japanese character across
        // tokens, and segment boundaries can land mid-UTF-8, which the strict
        // accessor rejects outright.
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
}

/// Transcribes one streaming window of mono 16kHz f32 PCM audio.
///
/// The audio is sent as a raw IPC body (not JSON) to avoid serializing ~2MB of
/// per-sample numbers on every window; language and task ride along as headers.
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
    // The user's glossary, percent-encoded by the frontend because header values
    // must be visible ASCII.
    let prompt = request
        .headers()
        .get("X-Asr-Prompt")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .filter(|s| !s.trim().is_empty());

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

        let settings = DecodeSettings {
            language,
            translate,
            prompt,
            ..DecodeSettings::default()
        };
        let params = build_full_params(&settings);

        whisper_state
            .full(params, &samples)
            .map_err(|e| e.to_string())?;

        collect_segments(&whisper_state)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Clone, Serialize)]
struct RefineProgressPayload {
    percent: i32,
}

/// RMS amplitude below which audio is treated as holding no speech.
///
/// Mirrors `SILENCE_RMS` in `src/lib/asr/diagnostics.ts`, which gates the live
/// pass. The two passes must agree, or the second one would reintroduce exactly
/// the hallucinations the first one suppressed.
pub const SILENCE_RMS: f32 = 1e-3;

/// How far either side of a segment to look before calling it silent.
///
/// whisper's segment timestamps are coarse enough to be off by a noticeable
/// fraction of a second (precisely why DTW exists), so judging a segment by its
/// declared interval alone risks measuring the pause *next* to real speech.
/// Padding makes a false drop require a full second of silence on both sides.
const SILENCE_MARGIN_SEC: f32 = 1.0;

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f64 = samples.iter().map(|s| (*s as f64) * (*s as f64)).sum();
    (sum_sq / samples.len() as f64).sqrt() as f32
}

/// Removes segments whose own audio contains no speech.
///
/// Handed silence, whisper does not return nothing -- it confidently invents a
/// stock phrase (「ご視聴ありがとうございました」) or loops a few characters, and
/// its own repetition guard cannot catch those because it only evaluates
/// sequences longer than 32 tokens. The live pass avoids this by never sending a
/// silent window; the whole-file pass cannot, because a meeting's pauses are in
/// the middle of the audio it has to decode as one piece.
///
/// The test is the audio, never the text: a segment is dropped only when the
/// recording is silent across its interval *and* a second either side. Text-based
/// filtering would eventually delete a real sentence for resembling a stock
/// phrase; this cannot, because silent audio provably has no speech in it.
pub fn drop_silent_segments(result: TranscribeResult, samples: &[f32]) -> TranscribeResult {
    let sr = crate::wav::SAMPLE_RATE as f32;
    let kept: Vec<TranscribeChunk> = result
        .chunks
        .into_iter()
        .filter(|chunk| {
            let from = ((chunk.timestamp.0 - SILENCE_MARGIN_SEC) * sr).max(0.0) as usize;
            let to = (((chunk.timestamp.1 + SILENCE_MARGIN_SEC) * sr) as usize).min(samples.len());
            // An interval that lands outside the audio tells us nothing about
            // whether it holds speech, so keep the segment.
            if from >= to {
                return true;
            }
            rms(&samples[from..to]) >= SILENCE_RMS
        })
        .collect();

    TranscribeResult {
        text: kept.iter().map(|c| c.text.as_str()).collect(),
        chunks: kept,
    }
}

/// Re-transcribes a finished recording in one pass over the whole file.
///
/// This is the accuracy pass. The live pass has to show text while the user is
/// still talking, so it decodes 15-second windows independently and can never
/// see past the edges of one; every window boundary is a place a sentence can be
/// cut in half and both halves guessed wrong. Here the recording is over, so the
/// entire file goes into a single `full()` call: whisper.cpp splits it into its
/// native 30-second chunks and carries the decoded token context from each chunk
/// into the next, which is exactly the context the live pass cannot have.
///
/// Cost is roughly 2 seconds of GPU time per 30 seconds of audio, so about four
/// minutes for a one-hour meeting -- hence the progress events.
///
/// The glossary conditions the first chunk only; from there whisper's own
/// decoded context takes over (whisper.cpp's `carry_initial_prompt` would extend
/// it to every chunk, but whisper-rs does not expose it).
#[tauri::command]
pub async fn transcribe_recording(
    app: AppHandle,
    path: String,
    language: Option<String>,
    task: Option<String>,
    prompt: Option<String>,
) -> Result<TranscribeResult, String> {
    let language = language.filter(|l| !l.is_empty() && l != "auto");
    let translate = task.as_deref() == Some("translate");
    let prompt = prompt.filter(|p| !p.trim().is_empty());
    let app_for_progress = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let samples = crate::wav::read(std::path::Path::new(&path))?;
        if samples.is_empty() {
            return Err(format!("{path} contains no audio"));
        }

        let state = app.state::<AsrState>();
        let guard = state.0.lock().unwrap();
        let ctx = guard
            .as_ref()
            .ok_or_else(|| "model is not initialized".to_string())?;
        let mut whisper_state = ctx.create_state().map_err(|e| e.to_string())?;

        let settings = DecodeSettings {
            language,
            translate,
            prompt,
            ..DecodeSettings::default()
        };
        let mut params = build_full_params(&settings);

        // whisper calls this far more often than once per percent; emitting only
        // on change keeps a one-hour recording to ~100 events instead of thousands.
        let mut last_percent = -1;
        params.set_progress_callback_safe(move |percent: i32| {
            if percent != last_percent {
                last_percent = percent;
                let _ = app_for_progress.emit("asr:refine-progress", RefineProgressPayload { percent });
            }
        });

        whisper_state
            .full(params, &samples)
            .map_err(|e| e.to_string())?;

        Ok(drop_silent_segments(
            collect_segments(&whisper_state)?,
            &samples,
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod silence_tests {
    use super::*;
    use crate::wav::SAMPLE_RATE;

    /// `seconds` of audio at `amplitude`, alternating sign so the RMS is the
    /// amplitude rather than a DC offset.
    fn tone(seconds: f32, amplitude: f32) -> Vec<f32> {
        let n = (seconds * SAMPLE_RATE as f32) as usize;
        (0..n)
            .map(|i| if i % 2 == 0 { amplitude } else { -amplitude })
            .collect()
    }

    fn chunk(text: &str, t0: f32, t1: f32) -> TranscribeChunk {
        TranscribeChunk {
            text: text.to_string(),
            timestamp: (t0, t1),
        }
    }

    fn result(chunks: Vec<TranscribeChunk>) -> TranscribeResult {
        TranscribeResult {
            text: chunks.iter().map(|c| c.text.as_str()).collect(),
            chunks,
        }
    }

    #[test]
    fn drops_a_hallucination_sitting_in_a_silent_stretch() {
        // 10s of silence: whatever whisper claims is there, is not.
        let audio = tone(10.0, 0.0);
        let out = drop_silent_segments(
            result(vec![chunk("ご視聴ありがとうございました", 3.0, 6.0)]),
            &audio,
        );
        assert!(out.chunks.is_empty());
        assert_eq!(out.text, "");
    }

    #[test]
    fn keeps_segments_backed_by_audible_audio() {
        let out = drop_silent_segments(result(vec![chunk("おはようございます", 1.0, 4.0)]), &tone(10.0, 0.2));
        assert_eq!(out.chunks.len(), 1);
        assert_eq!(out.text, "おはようございます");
    }

    #[test]
    fn keeps_speech_and_drops_only_the_silent_pause_between_it() {
        // speech | silence | speech, 10s each.
        let mut audio = tone(10.0, 0.2);
        audio.extend(tone(10.0, 0.0));
        audio.extend(tone(10.0, 0.2));

        let out = drop_silent_segments(
            result(vec![
                chunk("前半です", 1.0, 8.0),
                chunk("ご視聴ありがとうございました", 12.0, 18.0),
                chunk("後半です", 21.0, 28.0),
            ]),
            &audio,
        );
        assert_eq!(
            out.chunks.iter().map(|c| c.text.as_str()).collect::<Vec<_>>(),
            vec!["前半です", "後半です"]
        );
        assert_eq!(out.text, "前半です後半です");
    }

    #[test]
    fn a_timestamp_off_by_under_a_second_still_keeps_real_speech() {
        // The reason for the margin: whisper's timestamps are coarse, so a segment
        // can point just past the speech it transcribed. Dropping that would delete
        // a real sentence, which is far worse than keeping a hallucination.
        let mut audio = tone(5.0, 0.2);
        audio.extend(tone(10.0, 0.0));
        // Claims 5.3-6.0, which is silent; the speech ends at 5.0.
        let out = drop_silent_segments(result(vec![chunk("実際の発話", 5.3, 6.0)]), &audio);
        assert_eq!(out.chunks.len(), 1);
    }

    #[test]
    fn quiet_speech_just_above_the_threshold_survives() {
        let out = drop_silent_segments(
            result(vec![chunk("小さな声", 1.0, 4.0)]),
            &tone(10.0, SILENCE_RMS * 2.0),
        );
        assert_eq!(out.chunks.len(), 1);
    }

    #[test]
    fn keeps_segments_whose_timestamps_fall_outside_the_audio() {
        // Nothing to measure means no evidence to drop on.
        let out = drop_silent_segments(result(vec![chunk("末尾", 30.0, 32.0)]), &tone(5.0, 0.2));
        assert_eq!(out.chunks.len(), 1);
    }

    #[test]
    fn handles_an_empty_result_and_empty_audio() {
        assert!(drop_silent_segments(result(vec![]), &tone(5.0, 0.2)).chunks.is_empty());
        // No audio at all: keep the text rather than silently erasing a transcript.
        let out = drop_silent_segments(result(vec![chunk("a", 0.0, 1.0)]), &[]);
        assert_eq!(out.chunks.len(), 1);
    }

    #[test]
    fn rms_matches_the_frontend_definition() {
        assert_eq!(rms(&[]), 0.0);
        assert_eq!(rms(&[1.0, -1.0]), 1.0);
        assert!((rms(&[0.5, -0.5, 0.5, -0.5]) - 0.5).abs() < 1e-6);
    }
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn passes_through_plain_ascii() {
        assert_eq!(percent_decode("agenda, minutes"), "agenda, minutes");
        assert_eq!(percent_decode(""), "");
    }

    #[test]
    fn decodes_japanese_produced_by_encode_uri_component() {
        // encodeURIComponent("議事録") in the browser
        assert_eq!(percent_decode("%E8%AD%B0%E4%BA%8B%E9%8C%B2"), "議事録");
    }

    #[test]
    fn decodes_mixed_ascii_and_multibyte() {
        assert_eq!(percent_decode("A%E6%97%A5B"), "A日B");
    }

    #[test]
    fn leaves_malformed_escapes_verbatim() {
        // A broken glossary must degrade accuracy, not fail the request.
        assert_eq!(percent_decode("abc%"), "abc%");
        assert_eq!(percent_decode("abc%E"), "abc%E");
        assert_eq!(percent_decode("100%ZZ"), "100%ZZ");
        assert_eq!(percent_decode("50%~"), "50%~");
    }

    #[test]
    fn drops_nul_bytes_so_set_initial_prompt_cannot_panic() {
        // FullParams::set_initial_prompt builds a CString and panics on interior
        // NULs, so none may survive decoding.
        assert_eq!(percent_decode("a%00b"), "ab");
        assert!(!percent_decode("%00%E3%81%82%00").contains('\0'));
        assert_eq!(percent_decode("%00%E3%81%82%00"), "あ");
    }

    #[test]
    fn replaces_invalid_utf8_rather_than_failing() {
        assert!(!percent_decode("%FF").is_empty());
    }
}
