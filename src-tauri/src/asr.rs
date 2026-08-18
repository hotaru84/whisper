use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Manager};
use whisper_rs::{
    DtwMode, DtwModelPreset, DtwParameters, FullParams, SamplingStrategy, WhisperContext,
    WhisperContextParameters, WhisperVadParams,
};

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

fn resolve_vad_model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    Ok(resource_dir.join("resources/models/vad/ggml-silero-v5.1.2.bin"))
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
    // Already resident: report ready and stop here.
    //
    // The frontend has its own idempotency flag (`AsrClient.init`), but it
    // lives in a JS object the webview throws away whenever the page is
    // reloaded -- which is exactly what WebView2 does when its renderer is
    // recreated after the PC resumes from suspend. The mount effect then runs
    // again and calls this command on a model that never went anywhere.
    //
    // Without this guard that means re-reading the ~574MB GGUF (a minutes-long
    // blocking overlay) *and* holding two contexts at once: the load below
    // finishes before the assignment that drops the old one, so RAM and VRAM
    // both peak at double. On a GPU with little VRAM to spare, that second
    // load is also the one that fails.
    //
    // `is_some()` rather than a separate "loaded" flag, so there is only one
    // source of truth. Read into a bool in its own scope so the guard is
    // provably dropped before the await below -- holding a `MutexGuard` across
    // one would make this future non-Send.
    let already_loaded = { app.state::<AsrState>().0.lock().unwrap().is_some() };
    if already_loaded {
        let _ = app.emit(
            "asr:model-ready",
            ModelReadyPayload {
                device: build_backend(),
            },
        );
        return Ok(());
    }

    configure_native_logging();
    let app_for_load = app.clone();
    // Loading a ~600MB GGUF file is blocking CPU/IO work; keep it off the async runtime.
    let result = tauri::async_runtime::spawn_blocking(move || {
        let model_path = resolve_model_path(&app_for_load)?;
        let mut params = WhisperContextParameters::default();
        // DTW gives per-token timestamps by tracking attention alignment through
        // the decoder, rather than whisper's default of reading them off the
        // single-timestamp tokens it happens to emit -- which is why segment
        // boundaries can land hundreds of ms from the actual speech. This preset
        // is model-specific (its attention heads were selected for
        // large-v3-turbo) and only applies to the model we ship.
        // `collect_segments` reads the resulting per-token `t_dtw` values to
        // tighten segment boundaries, which matters because diarization
        // assigns speakers by overlapping these timestamps against diarizer
        // segments.
        //
        // Safe to enable unconditionally: flash_attn (the one thing DTW
        // conflicts with) and new_segment_callback (whose calls DTW makes
        // inconsistent) are both unused here.
        params.dtw_parameters(DtwParameters {
            mode: DtwMode::ModelPreset {
                model_preset: DtwModelPreset::LargeV3Turbo,
            },
            ..DtwParameters::default()
        });
        WhisperContext::new_with_params(&model_path, params).map_err(|e| e.to_string())
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
#[serde(rename_all = "camelCase")]
pub struct TranscribeResult {
    pub text: String,
    pub chunks: Vec<TranscribeChunk>,
    /// True when the caller asked for VAD but the model file was missing, so
    /// decoding proceeded without it. Always `false` from `transcribe_window`,
    /// which never requests VAD. Kept on the result rather than turned into an
    /// error: VAD is an optional accuracy nudge, and its absence must not take
    /// down the transcription it was supposed to improve.
    #[serde(default)]
    pub vad_unavailable: bool,
    /// Reference-free structural metrics (gaps, out-of-order cues) computed
    /// over `chunks`. `transcribe_window` leaves this at its all-zero default
    /// since a 15s window is too short for the metrics to mean anything;
    /// `transcribe_recording` fills it in. See `crate::cues` for what each
    /// field catches.
    #[serde(default)]
    pub quality: crate::cues::QualityReport,
    /// Parallel to `chunks` (same index, same length once populated) --
    /// `silence[i]` describes whether `chunks[i]` was judged to hold no
    /// speech by `mark_silent_segments`. Empty from `transcribe_window`,
    /// which never calls it. A parallel array rather than fields on
    /// `TranscribeChunk` itself, matching how diarization speakers and
    /// audio-event exclusion also ride alongside `chunks` by index.
    #[serde(default)]
    pub silence: Vec<SilenceMark>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SilenceMark {
    pub silent: bool,
    /// `None` when the chunk's interval (padded by `SILENCE_MARGIN_SEC`)
    /// falls outside the audio -- there was nothing to measure, so nothing
    /// is reported, and `silent` is `false` (see `mark_silent_segments`).
    pub rms: Option<f32>,
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
    /// Path to a Silero VAD ggml model. `None` disables VAD entirely -- and is
    /// the only thing gating it: there is no separate `vad: bool`, because
    /// whisper-rs's `enable_vad(true)` panics if no model path has been set
    /// first, and folding the switch into this `Option` makes that call
    /// impossible to reach.
    ///
    /// Left `None` by default (i.e. for the live pass, `transcribe_window`):
    /// its windows are already gated on the frontend by an RMS silence check
    /// before they ever reach here, so a second, heavier filter adds model-load
    /// cost without much left to catch. The whole-file second pass is the
    /// opposite case -- it cannot skip silence on the way in, since a meeting's
    /// pauses sit in the middle of audio that still has to be decoded as one
    /// piece -- so `transcribe_recording` fills this in by default. See
    /// `mark_silent_segments` for the RMS-based safety net that stays regardless.
    pub vad_model_path: Option<String>,
    pub vad_threshold: f32,
    pub vad_min_speech_duration_ms: i32,
    pub vad_min_silence_duration_ms: i32,
    pub vad_max_speech_duration_s: f32,
    pub vad_speech_pad_ms: i32,
    pub vad_samples_overlap: f32,
    /// whisper.cpp uses this threshold in two places that pull in opposite
    /// directions, both gated jointly with `logprob_thold`:
    ///
    /// - Output suppression (whisper.cpp:7585-7586): a chunk with
    ///   `no_speech_prob > no_speech_thold && avg_logprobs < logprob_thold`
    ///   is dropped outright -- no output, and not even added to the rolling
    ///   context for later chunks.
    /// - Temperature-fallback retry (whisper.cpp:7554-7555): the *same* two
    ///   thresholds, compared the other way (`avg_logprobs < logprob_thold &&
    ///   no_speech_prob < no_speech_thold`), decide whether a decode is
    ///   judged to have failed and gets retried at a higher temperature.
    ///
    /// A chunk with high `no_speech_prob` and bad `avg_logprobs` -- exactly
    /// what a distant mic or overlapping speech produces -- fails neither
    /// check outright: it does not clear the retry condition (`no_speech_prob`
    /// is not `<` the threshold), so it is never retried, yet it does clear
    /// the suppression condition, so its output is thrown away anyway. This
    /// is the leading structural-loss suspect this field exists to let the
    /// CER harness A/B (see README's "精度の測定"). whisper.cpp's own default
    /// is `0.6`; README documents that *lowering* it (toward 0.1) does not
    /// suppress silence hallucinations -- raising it, to stop suppressing
    /// chunks whisper only weakly believes are speechless, is the untested
    /// direction this field opens up.
    pub no_speech_thold: f32,
    /// See `no_speech_thold`'s doc comment for the two whisper.cpp conditions
    /// this jointly gates. whisper.cpp's own default is `-1.0`; lowering it
    /// (more negative) makes `avg_logprobs < logprob_thold` harder to
    /// satisfy, which cuts both ways: fewer chunks get suppressed as
    /// no-speech (the goal), but also fewer genuinely bad decodes become
    /// eligible for a temperature-fallback retry. Change one of `this` or
    /// `no_speech_thold` per run (README's "比較は一度に一項目だけ"), never
    /// both, or a structural-metric delta cannot be attributed to either.
    pub logprob_thold: f32,
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
            vad_model_path: None,
            // Mirrors whisper_rs::WhisperVadParams::default() so a caller that
            // only sets vad_model_path (the common case) gets whisper.cpp's own
            // tuning, not silently different numbers.
            vad_threshold: 0.5,
            vad_min_speech_duration_ms: 250,
            vad_min_silence_duration_ms: 100,
            vad_max_speech_duration_s: f32::MAX,
            vad_speech_pad_ms: 30,
            vad_samples_overlap: 0.1,
            // whisper.cpp's own defaults (whisper.cpp:5955-5956) -- unchanged
            // until a run with a different value is measured to help (see the
            // field doc comments).
            no_speech_thold: 0.6,
            logprob_thold: -1.0,
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
    params.set_no_speech_thold(settings.no_speech_thold);
    params.set_logprob_thold(settings.logprob_thold);
    params.set_n_threads(settings.n_threads);
    // Each streaming window is its own `full()` call over <= 30s of audio, i.e.
    // always whisper's "first chunk", so the prompt conditions every window. That
    // sidesteps needing `carry_initial_prompt`, which whisper-rs does not expose.
    if let Some(prompt) = settings.prompt.as_deref() {
        if !prompt.trim().is_empty() {
            params.set_initial_prompt(prompt);
        }
    }
    // Order matters: enable_vad(true) panics if no model path has been set yet,
    // so the path always goes first. See the field doc on vad_model_path for
    // why absence of a path is the only way VAD gets disabled here.
    if let Some(vad_model_path) = settings.vad_model_path.as_deref() {
        params.set_vad_model_path(Some(vad_model_path));
        params.enable_vad(true);
        let mut vad_params = WhisperVadParams::new();
        vad_params.set_threshold(settings.vad_threshold);
        vad_params.set_min_speech_duration(settings.vad_min_speech_duration_ms);
        vad_params.set_min_silence_duration(settings.vad_min_silence_duration_ms);
        vad_params.set_max_speech_duration(settings.vad_max_speech_duration_s);
        vad_params.set_speech_pad(settings.vad_speech_pad_ms);
        vad_params.set_samples_overlap(settings.vad_samples_overlap);
        params.set_vad_params(vad_params);
    }
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);
    params.set_print_timestamps(false);
    params
}

/// Segment bounds derived from per-token DTW alignment, in centiseconds.
///
/// whisper.cpp only assigns `t_dtw` to text tokens (timestamp tokens are
/// skipped and keep the uncomputed sentinel), so the min/max across a
/// segment's tokens is the DTW-aligned span of the words actually spoken --
/// tighter than the single timestamp token whisper's default reader reads
/// off the segment boundary. Returns `None` when no token in the segment has
/// a computed `t_dtw` (DTW disabled, or nothing but non-text tokens), so the
/// caller can fall back to the segment-level timestamp.
///
/// **Only valid when VAD did not run on this decode.** `t_dtw` comes from
/// `whisper_full_get_token_data_from_state`, which whisper.cpp never maps
/// back off the VAD-compressed sample timeline (whisper.cpp:8041-8043) the
/// way it does for the segment-level `t0`/`t1` (whisper.cpp:7953-7990). See
/// `collect_segments`'s `vad` parameter, which is what actually gates this.
fn dtw_segment_bounds(segment: &whisper_rs::WhisperSegment) -> Option<(i64, i64)> {
    let mut bounds: Option<(i64, i64)> = None;
    for i in 0..segment.n_tokens() {
        let Some(token) = segment.get_token(i) else {
            continue;
        };
        let t_dtw = token.token_data().t_dtw;
        // -1 is whisper.cpp's uncomputed sentinel (whisper_sample_token's
        // default init), not a valid timestamp -- see whisper.h's warning not
        // to use t_dtw "if you haven't computed token-level timestamps with dtw".
        if t_dtw < 0 {
            continue;
        }
        bounds = Some(match bounds {
            None => (t_dtw, t_dtw),
            Some((min, max)) => (min.min(t_dtw), max.max(t_dtw)),
        });
    }
    bounds
}

/// Cue length floor, in centiseconds (200ms).
///
/// A Japanese mora runs roughly 100-150ms, so a one-token cue like "はい" is
/// physically 200-300ms -- this is the shortest span whisper's own timing
/// granularity can be expected to resolve. Below it, treat the bound as an
/// artefact of coarse timestamps rather than a genuine sub-200ms utterance.
const MIN_CUE_SPAN_CS: i64 = 20;

/// Reconciles a DTW-derived token span against whisper's own segment
/// envelope, and enforces [`MIN_CUE_SPAN_CS`].
///
/// DTW's job is to refine *within* the segment whisper already committed to,
/// not contradict it -- so `dtw`, when present, is clamped into `envelope`
/// rather than trusted outright. If DTW disagrees badly with the envelope
/// (a stray token, or the VAD timeline issue documented on
/// `dtw_segment_bounds` resurfacing some other way), the clamp is where that
/// becomes visible as a tightened span instead of silently producing a bound
/// whisper itself never reported.
///
/// No outlier rejection beyond the envelope clamp: whisper.cpp's DTW
/// backtrace is monotonic in both token index and time
/// (whisper.cpp:8677-8760, 8925-8950), so the min/max across a segment's
/// tokens is never a statistical outlier -- it is simply the first and last
/// token whisper assigned to the segment.
///
/// The floor expands the span symmetrically around its midpoint, then slides
/// (never truncates) to stay inside `envelope` if that expansion would
/// spill past it. If `envelope` itself is shorter than `min_span_cs`, it is
/// returned unchanged: this function invents timing precision, never speech
/// whisper didn't claim.
fn sanitize_bounds(dtw: Option<(i64, i64)>, envelope: (i64, i64), min_span_cs: i64) -> (i64, i64) {
    let e0 = envelope.0.max(0);
    let e1 = envelope.1.max(e0);

    let (t0, t1) = match dtw {
        None => (e0, e1),
        Some((d0, d1)) => {
            let (d0, d1) = if d0 <= d1 { (d0, d1) } else { (d1, d0) };
            (d0.clamp(e0, e1), d1.clamp(e0, e1))
        }
    };

    if e1 - e0 < min_span_cs || t1 - t0 >= min_span_cs {
        return (t0, t1);
    }

    let mid = (t0 + t1) / 2;
    let mut new_t0 = mid - min_span_cs / 2;
    let mut new_t1 = new_t0 + min_span_cs;
    if new_t0 < e0 {
        new_t1 += e0 - new_t0;
        new_t0 = e0;
    }
    if new_t1 > e1 {
        new_t0 -= new_t1 - e1;
        new_t1 = e1;
    }
    (new_t0, new_t1)
}

/// Collects whisper's segments into the shape the frontend consumes.
/// Timestamps are converted from whisper's centiseconds to seconds.
///
/// `vad` must reflect whether VAD actually ran on this decode (i.e. whether
/// `DecodeSettings::vad_model_path` was `Some` and resolved), not just
/// whether the caller wanted it. When it did, DTW token bounds are **not**
/// used, even though they were computed: whisper.cpp decodes VAD-enabled
/// audio against a VAD-compressed sample buffer (whisper.cpp:7749-7762), and
/// while `whisper_full_get_segment_t0/t1_from_state` map that back to the
/// original timeline (whisper.cpp:7953-7990, with a 100ms floor),
/// `whisper_full_get_token_data_from_state` -- what `dtw_segment_bounds`
/// reads -- returns the raw, unconverted value (whisper.cpp:8041-8043). Using
/// it under VAD would silently place every DTW-derived boundary on the wrong
/// (compressed) timeline, which matters most for diarization: it assigns
/// speakers by overlapping these timestamps against diarizer segments. With
/// `vad == false`, DTW bounds are safe and preferred -- they track attention
/// alignment through the decoder and land closer to the actual speech
/// boundaries than the single timestamp token whisper's default segmentation
/// emits.
pub fn collect_segments(state: &whisper_rs::WhisperState, vad: bool) -> Result<TranscribeResult, String> {
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
        let envelope = (segment.start_timestamp(), segment.end_timestamp());
        let dtw = if vad { None } else { dtw_segment_bounds(&segment) };
        let (t0_cs, t1_cs) = sanitize_bounds(dtw, envelope, MIN_CUE_SPAN_CS);
        let t0 = t0_cs as f32 / 100.0;
        let t1 = t1_cs as f32 / 100.0;
        text.push_str(&seg_text);
        chunks.push(TranscribeChunk {
            text: seg_text,
            timestamp: (t0, t1),
        });
    }
    Ok(TranscribeResult {
        text,
        chunks,
        vad_unavailable: false,
        quality: crate::cues::QualityReport::default(),
        silence: Vec::new(),
    })
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
    // User-adjustable repetition-loop guard (see DecodeSettings::entropy_thold).
    // Absent or unparseable falls back to DecodeSettings::default()'s 2.8, same
    // as before this header existed.
    let entropy_thold = request
        .headers()
        .get("X-Entropy-Thold")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<f32>().ok());

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
            entropy_thold: entropy_thold.unwrap_or_else(|| DecodeSettings::default().entropy_thold),
            ..DecodeSettings::default()
        };
        let params = build_full_params(&settings);

        whisper_state
            .full(params, &samples)
            .map_err(|e| e.to_string())?;

        // No VAD in the live path -- `settings` never sets `vad_model_path`.
        collect_segments(&whisper_state, false)
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
/// fraction of a second, so judging a segment by its declared interval alone
/// risks measuring the pause *next* to real speech. Padding makes a false drop
/// require a full second of silence on both sides.
///
/// `init_model` now enables DTW token-level timestamps, which should tighten
/// this in practice -- but by how much is unmeasured (no fixtures with known
/// ground-truth timestamps exist yet), so this stays at its original
/// conservative value rather than guessing a smaller one down.
const SILENCE_MARGIN_SEC: f32 = 1.0;

/// Shared with `cues::analyze`, which needs the same RMS definition to decide
/// whether a gap between cues held speech that was lost rather than silence
/// that was correctly skipped.
pub(crate) fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f64 = samples.iter().map(|s| (*s as f64) * (*s as f64)).sum();
    (sum_sq / samples.len() as f64).sqrt() as f32
}

/// Flags segments whose own audio contains no speech, without removing them.
///
/// Handed silence, whisper does not return nothing -- it confidently invents a
/// stock phrase (「ご視聴ありがとうございました」) or loops a few characters, and
/// its own repetition guard cannot catch those because it only evaluates
/// sequences longer than 32 tokens. The live pass avoids this by never sending a
/// silent window; the whole-file pass cannot, because a meeting's pauses are in
/// the middle of the audio it has to decode as one piece.
///
/// The test is the audio, never the text: a segment is flagged only when the
/// recording is silent across its interval *and* a second either side. Text-based
/// filtering would eventually delete a real sentence for resembling a stock
/// phrase; this cannot, because silent audio provably has no speech in it.
///
/// Named `mark_` rather than `drop_`: this used to filter chunks out
/// entirely, which left a silent gap in the transcript indistinguishable from
/// a decode that simply produced nothing there -- neither the user nor
/// `cues::QualityReport` could tell those two cases apart. Marking instead of
/// dropping lets the frontend render a placeholder
/// (`TranscriptSegment.excludedReason`, the same mechanism
/// `events::classify_chunks` already uses for non-speech audio events) so a
/// listener can tell why a gap exists, while `chunks` -- and therefore
/// `cues::analyze`'s view of the decode -- stays exactly what whisper
/// produced.
pub fn mark_silent_segments(
    result: TranscribeResult,
    samples: &[f32],
    silence_rms: f32,
) -> (TranscribeResult, Vec<SilenceMark>) {
    let sr = crate::wav::SAMPLE_RATE as f32;
    let marks: Vec<SilenceMark> = result
        .chunks
        .iter()
        .map(|chunk| {
            let from = ((chunk.timestamp.0 - SILENCE_MARGIN_SEC) * sr).max(0.0) as usize;
            let to = (((chunk.timestamp.1 + SILENCE_MARGIN_SEC) * sr) as usize).min(samples.len());
            // An interval that lands outside the audio tells us nothing about
            // whether it holds speech, so it is not flagged.
            if from >= to {
                return SilenceMark { silent: false, rms: None };
            }
            let measured = rms(&samples[from..to]);
            SilenceMark { silent: measured < silence_rms, rms: Some(measured) }
        })
        .collect();

    (result, marks)
}

/// Padding added on each side of a gap before re-decoding it, in seconds.
///
/// Just enough to give the decoder a little context on either side rather
/// than a hard cut mid-word; not meant to recover surrounding audio -- the
/// chunks returned from a padded decode are always clamped back to the gap's
/// own bounds before merging (see `redecode_voiced_gaps`), so widening this
/// only changes how much context whisper sees, never how much of the
/// neighboring, already-transcribed audio can leak into the result.
const GAP_REDECODE_MARGIN_SEC: f32 = 0.5;

/// Gap length floor, in seconds, below which a redecode is not attempted.
///
/// Every redecode costs roughly the same ~2s of GPU time as the main pass's
/// own 30-second windows regardless of how little audio the gap actually
/// holds -- whisper.cpp always encodes a full 30s window and silence-pads
/// anything shorter (see README's "GPU コストは同じ約2秒"). Without a floor,
/// ordinary inter-sentence pauses (breath, hesitation, room tone) that clear
/// `SILENCE_RMS` each pay that full cost even though they hold nothing
/// whisper actually dropped, and a real recording has many of them -- this
/// was measured to multiply the whole-file pass's runtime several times over.
///
/// The failure mode this function exists to catch -- whisper.cpp abandoning
/// a whole 30s chunk on a lone timestamp token -- only ever produces gaps on
/// that same order, so a short pause clearing this floor is not the case
/// this function is for. `cues::analyze`'s `voiced_gap_sec` is a cheap way
/// to check the trade-off on a real recording (`examples/reanalyze.rs`) if
/// this needs re-tuning.
const MIN_GAP_REDECODE_SEC: f32 = 1.5;

/// Re-decodes gaps between cues whose underlying audio is not silent.
///
/// Mitigates whisper.cpp's "single timestamp ending" behavior
/// (whisper.cpp:7725-7731): a decode that ends on a lone timestamp token
/// jumps `seek` forward by a full 30-second chunk without ever decoding the
/// audio in between. The main pass has no way to notice this from the
/// inside -- `full()` owns its seek loop end to end -- so this runs
/// afterward, over exactly the gaps `cues::analyze` would report as
/// `voiced_gap_sec`, longer than [`MIN_GAP_REDECODE_SEC`].
///
/// Each gap is decoded in total isolation via a fresh `WhisperState`, with no
/// token context carried in from the chunks on either side. That is a real
/// cost -- context is the main pass's whole advantage over the live pass --
/// so this is deliberately narrow: it can only help a gap that whisper simply
/// never attempted, not one it attempted badly. A gap decode's own output is
/// clamped to the gap's exact bounds before merging, so it can only add
/// cues inside the gap, never touch or duplicate what is already on either
/// side of it. Does nothing, and costs nothing beyond one comparison per gap,
/// when there are no voiced gaps to begin with.
pub fn redecode_voiced_gaps(
    ctx: &WhisperContext,
    settings: &DecodeSettings,
    vad: bool,
    cancel: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    chunks: Vec<TranscribeChunk>,
    samples: &[f32],
    silence_rms: f32,
) -> Result<Vec<TranscribeChunk>, String> {
    let sr = crate::wav::SAMPLE_RATE as f32;
    let mut inserted: Vec<TranscribeChunk> = Vec::new();

    for pair in chunks.windows(2) {
        let gap_start = pair[0].timestamp.1;
        let gap_end = pair[1].timestamp.0;
        if gap_end - gap_start < MIN_GAP_REDECODE_SEC {
            continue;
        }

        let padded_from = ((gap_start - GAP_REDECODE_MARGIN_SEC) * sr).max(0.0) as usize;
        let padded_to = (((gap_end + GAP_REDECODE_MARGIN_SEC) * sr) as usize).min(samples.len());
        if padded_from >= padded_to || rms(&samples[padded_from..padded_to]) < silence_rms {
            continue;
        }

        crate::cancel::check(cancel)?;

        let mut state = ctx.create_state().map_err(|e| e.to_string())?;
        let mut params = build_full_params(settings);
        let abort_flag = std::sync::Arc::clone(cancel);
        let abort: Box<dyn FnMut() -> bool> =
            Box::new(move || abort_flag.load(std::sync::atomic::Ordering::Relaxed));
        params.set_abort_callback_safe(abort);
        if let Err(e) = state.full(params, &samples[padded_from..padded_to]) {
            crate::cancel::check(cancel)?;
            return Err(e.to_string());
        }

        let offset_sec = padded_from as f32 / sr;
        for c in collect_segments(&state, vad)?.chunks {
            // Clamp to the gap's own bounds: a decode given padded context can
            // legitimately place a token in the padding, but that padding
            // overlaps audio the main pass already transcribed, so anything
            // outside [gap_start, gap_end) would duplicate an existing cue
            // rather than fill the gap.
            let t0 = (c.timestamp.0 + offset_sec).max(gap_start);
            let t1 = (c.timestamp.1 + offset_sec).min(gap_end);
            if t1 > t0 {
                inserted.push(TranscribeChunk { text: c.text, timestamp: (t0, t1) });
            }
        }
    }

    if inserted.is_empty() {
        return Ok(chunks);
    }
    let mut merged = chunks;
    merged.extend(inserted);
    merged.sort_by(|a, b| {
        a.timestamp
            .0
            .partial_cmp(&b.timestamp.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(merged)
}

/// Adjacent cues within this of each other are treated as the same stalled
/// utterance repeating, not two separate ones.
///
/// Mirrors `COLLAPSE_TOLERANCE_SEC` in `src/lib/transcript.ts`, which applies
/// the identical check to decide whether to fold two *display* segments into
/// one -- kept in sync (same value, same comment cross-reference as
/// `SILENCE_RMS`'s) so a run this function repairs is exactly a run the
/// frontend would otherwise have had to silently collapse for display.
const LOOP_COLLAPSE_TOLERANCE_SEC: f32 = 0.05;

/// Finds maximal runs of two or more adjacent chunks that look like a
/// stalled decode repeating itself: matching text under `cer::normalize`
/// (whitespace dropped, full-width ASCII folded, punctuation stripped) and a
/// start that has not advanced past the previous chunk's end by more than
/// [`LOOP_COLLAPSE_TOLERANCE_SEC`] -- the shape whisper.cpp's
/// context-conditioning failure actually takes (see
/// [`redecode_degenerate_loops`]'s doc comment), not a genuine repeated
/// utterance like "はい、はい" (whose start genuinely advances).
///
/// Uses `cer::normalize(text, false)` rather than the plain `trim` that
/// `normalizeForCollapse` (`src/lib/transcript.ts`) uses for the equivalent
/// *display* collapse: a stalled loop's repeats often drift in exactly what
/// that normalisation is built to ignore (a trailing 「。」 on one repeat and
/// not the next, full- vs half-width digits), and here a miss costs a real
/// GPU redecode's worth of accuracy, not just a slightly-less-tidy render.
///
/// Blank-text chunks never participate on either side of a match: an empty
/// decode is a different situation (silence or an excluded audio event,
/// decided elsewhere) and must not be folded into a repetition run just
/// because two empty normalisations are trivially equal.
///
/// Returns half-open `[start, end)` index ranges into `chunks`, each
/// spanning at least two elements, in ascending non-overlapping order.
fn find_degenerate_runs(chunks: &[TranscribeChunk]) -> Vec<std::ops::Range<usize>> {
    let normalized: Vec<Vec<char>> = chunks.iter().map(|c| crate::cer::normalize(&c.text, false)).collect();

    let mut runs = Vec::new();
    let mut run_start: Option<usize> = None;

    for i in 1..chunks.len() {
        let matches = !normalized[i - 1].is_empty()
            && normalized[i - 1] == normalized[i]
            && chunks[i].timestamp.0 <= chunks[i - 1].timestamp.1 + LOOP_COLLAPSE_TOLERANCE_SEC;

        if matches {
            run_start.get_or_insert(i - 1);
        } else if let Some(start) = run_start.take() {
            runs.push(start..i);
        }
    }
    if let Some(start) = run_start {
        runs.push(start..chunks.len());
    }
    runs
}

/// Text-context budget for a degenerate-loop repair decode, in tokens
/// (`whisper_full_params.n_max_text_ctx`).
///
/// whisper.cpp's whole-file pass conditions each ~30s chunk on the previous
/// chunk's decoded tokens (see `transcribe_recording`'s doc comment) --
/// ordinarily the pass's whole advantage over the live pass, but its failure
/// mode too: once a chunk decodes into a short repeated phrase, that phrase
/// becomes the next chunk's own context, and self-similar context makes the
/// decoder reproduce it again, filling the rolling context with copies of
/// itself. A fresh `WhisperState` (as `redecode_voiced_gaps` already uses)
/// removes that stale context once, but if a repaired span were long enough
/// to itself span an internal 30s boundary, the same self-reinforcement could
/// restart inside the repair decode. Capping the context budget low (64,
/// versus whisper.cpp's default of `min(n_max_text_ctx, n_text_ctx / 2)` =
/// 224 for large-v3-turbo, see `DecodeSettings::prompt`'s doc comment) keeps
/// too little of any one internal chunk's output alive for it to dominate the
/// next.
const DEGENERATE_LOOP_MAX_CTX: i32 = 64;

/// Padding added on each side of a degenerate-loop span before re-decoding
/// it, in seconds. Mirrors `GAP_REDECODE_MARGIN_SEC`'s rationale: a little
/// context on either side so the repair decode does not start or stop
/// mid-word, with the result always clamped back to the span's own bounds
/// before merging (see `redecode_degenerate_loops`).
const LOOP_REDECODE_MARGIN_SEC: f32 = 0.5;

/// Repairs whisper.cpp's context-conditioning failure mode: a chunk that
/// decodes into a short stock phrase or a looped fragment feeds that same
/// text back into the next chunk's rolling context, which makes the decoder
/// reproduce it again -- and again, since each repeat re-poisons the next
/// chunk's context in turn. [`find_degenerate_runs`] recognizes the resulting
/// shape (many adjacent cues, identical text, barely-advancing timestamps --
/// the same criteria `collapseDegenerateSegments` in `src/lib/transcript.ts`
/// uses to fold these for *display*); this function instead repairs the
/// decode itself, so the loop does not have to be hidden on every future
/// render.
///
/// Each detected run is re-decoded from a fresh `WhisperState` (no carried
/// context, exactly as `redecode_voiced_gaps` does for gaps) with the
/// text-context budget capped at [`DEGENERATE_LOOP_MAX_CTX`] tokens. The new
/// chunks are clamped to the run's own bounds before replacing it, so a
/// repair can only change what is inside the run's span, never touch or
/// duplicate audio on either side of it. If a repair decode produces nothing
/// usable, the original (looped) chunks are kept rather than erasing the span
/// from the transcript entirely -- a stalled loop is recoverable in the UI
/// (`collapseDegenerateSegments`), a silently vanished span is not.
pub fn redecode_degenerate_loops(
    ctx: &WhisperContext,
    settings: &DecodeSettings,
    vad: bool,
    cancel: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    chunks: Vec<TranscribeChunk>,
    samples: &[f32],
) -> Result<Vec<TranscribeChunk>, String> {
    let runs = find_degenerate_runs(&chunks);
    if runs.is_empty() {
        return Ok(chunks);
    }

    let sr = crate::wav::SAMPLE_RATE as f32;
    // Spans are read off the original chunks up front, before `chunks` is
    // consumed by the splice below.
    let spans: Vec<(f32, f32)> = runs
        .iter()
        .map(|run| (chunks[run.start].timestamp.0, chunks[run.end - 1].timestamp.1))
        .collect();

    let mut out: Vec<TranscribeChunk> = Vec::with_capacity(chunks.len());
    let mut chunks = chunks.into_iter();
    let mut pos = 0usize;

    for (run, (span_start, span_end)) in runs.into_iter().zip(spans) {
        // Copy through untouched chunks before this run.
        while pos < run.start {
            out.push(chunks.next().expect("pos stays within the original chunk count"));
            pos += 1;
        }
        // Consume the run's own original chunks; kept as the fallback if the
        // repair below cannot run or produces nothing.
        let mut originals = Vec::with_capacity(run.len());
        while pos < run.end {
            originals.push(chunks.next().expect("pos stays within the original chunk count"));
            pos += 1;
        }

        let padded_from = ((span_start - LOOP_REDECODE_MARGIN_SEC) * sr).max(0.0) as usize;
        let padded_to = (((span_end + LOOP_REDECODE_MARGIN_SEC) * sr) as usize).min(samples.len());
        if padded_from >= padded_to {
            out.extend(originals);
            continue;
        }

        crate::cancel::check(cancel)?;

        let mut state = ctx.create_state().map_err(|e| e.to_string())?;
        let mut params = build_full_params(settings);
        params.set_n_max_text_ctx(DEGENERATE_LOOP_MAX_CTX);
        let abort_flag = std::sync::Arc::clone(cancel);
        let abort: Box<dyn FnMut() -> bool> =
            Box::new(move || abort_flag.load(std::sync::atomic::Ordering::Relaxed));
        params.set_abort_callback_safe(abort);
        if let Err(e) = state.full(params, &samples[padded_from..padded_to]) {
            crate::cancel::check(cancel)?;
            return Err(e.to_string());
        }

        let offset_sec = padded_from as f32 / sr;
        let mut replacement = Vec::new();
        for c in collect_segments(&state, vad)?.chunks {
            // Clamp to the run's own bounds, exactly as `redecode_voiced_gaps`
            // does for gaps: padding can legitimately place a token in audio
            // already covered by a neighboring cue, and only what falls
            // inside the run's own span is a genuine replacement for it.
            let t0 = (c.timestamp.0 + offset_sec).max(span_start);
            let t1 = (c.timestamp.1 + offset_sec).min(span_end);
            if t1 > t0 {
                replacement.push(TranscribeChunk { text: c.text, timestamp: (t0, t1) });
            }
        }

        if replacement.is_empty() {
            out.extend(originals);
        } else {
            out.extend(replacement);
        }
    }

    // Copy through anything after the last run.
    out.extend(chunks);
    Ok(out)
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
    vad: bool,
    vad_threshold: f32,
    entropy_thold: f32,
    silence_rms: f32,
) -> Result<TranscribeResult, String> {
    let language = language.filter(|l| !l.is_empty() && l != "auto");
    let translate = task.as_deref() == Some("translate");
    let prompt = prompt.filter(|p| !p.trim().is_empty());
    let app_for_progress = app.clone();
    let cancel = crate::cancel::flag(&app);

    tauri::async_runtime::spawn_blocking(move || {
        crate::cancel::check(&cancel)?;
        let samples = crate::wav::read(std::path::Path::new(&path))?;
        if samples.is_empty() {
            return Err(format!("{path} contains no audio"));
        }
        // Reading an hour of WAV is not instant, and the lock below is not
        // taken yet, so this is the cheapest possible place to give up.
        crate::cancel::check(&cancel)?;

        let state = app.state::<AsrState>();
        let guard = state.0.lock().unwrap();
        let ctx = guard
            .as_ref()
            .ok_or_else(|| "model is not initialized".to_string())?;
        let mut whisper_state = ctx.create_state().map_err(|e| e.to_string())?;

        // Unlike diarization (a separate command call that can fail without
        // touching the transcript already produced), VAD runs inside this same
        // decode -- an error here would take the whole pass down. So a missing
        // model degrades to "proceed without VAD" rather than failing outright;
        // `vad_unavailable` on the result tells the frontend to say so.
        let mut vad_unavailable = false;
        let vad_model_path = if vad {
            let path = resolve_vad_model_path(&app)?;
            if path.exists() {
                Some(path.display().to_string())
            } else {
                vad_unavailable = true;
                None
            }
        } else {
            None
        };

        let settings = DecodeSettings {
            language,
            translate,
            prompt,
            vad_model_path,
            vad_threshold,
            entropy_thold,
            ..DecodeSettings::default()
        };
        // Whether VAD actually ran, not just whether it was requested -- a
        // missing model file above falls back to `None` and still has to
        // decode (and collect segments) as if VAD were off.
        let vad_active = settings.vad_model_path.is_some();
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

        // whisper.cpp evaluates this after every encode and every decode step
        // (whisper.cpp:7020/7146/7458), so a cancel lands in well under a
        // second even on a long recording.
        //
        // The `Box<dyn FnMut() -> bool>` annotation is load-bearing, not
        // stylistic: whisper-rs 0.16.0's `set_abort_callback_safe` stores a
        // `*mut Box<dyn FnMut() -> bool>` as the user data but instantiates
        // its trampoline as `trampoline::<F>` (whisper_params.rs:637-647).
        // Handing it a bare closure would have the trampoline reinterpret the
        // box's data/vtable words as that closure's captures. Type-erasing
        // here makes `F` *be* the box type, so the two line up -- which is
        // what the (correctly written) progress path above hardcodes.
        let abort_flag = std::sync::Arc::clone(&cancel);
        let abort: Box<dyn FnMut() -> bool> =
            Box::new(move || abort_flag.load(std::sync::atomic::Ordering::Relaxed));
        params.set_abort_callback_safe(abort);

        if let Err(e) = whisper_state.full(params, &samples) {
            // An abort surfaces as an ordinary decode failure (-6 from the
            // encoder, -8 from the decoder), so without this the user's own
            // cancel would be reported back to them as a crash.
            crate::cancel::check(&cancel)?;
            return Err(e.to_string());
        }

        let mut result = collect_segments(&whisper_state, vad_active)?;
        result.chunks =
            redecode_voiced_gaps(ctx, &settings, vad_active, &cancel, result.chunks, &samples, silence_rms)?;
        result.chunks = redecode_degenerate_loops(ctx, &settings, vad_active, &cancel, result.chunks, &samples)?;
        result.text = result.chunks.iter().map(|c| c.text.as_str()).collect();

        let (mut result, silence) = mark_silent_segments(result, &samples, silence_rms);
        result.vad_unavailable = vad_unavailable;
        result.silence = silence;
        let duration_sec = samples.len() as f32 / crate::wav::SAMPLE_RATE as f32;
        result.quality = crate::cues::analyze(&result.chunks, duration_sec, &samples);
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod sanitize_bounds_tests {
    use super::sanitize_bounds;

    #[test]
    fn no_dtw_returns_the_envelope_unchanged_when_it_already_meets_the_floor() {
        assert_eq!(sanitize_bounds(None, (100, 300), 20), (100, 300));
    }

    #[test]
    fn dtw_within_the_envelope_is_kept_as_is() {
        assert_eq!(sanitize_bounds(Some((110, 290)), (100, 300), 20), (110, 290));
    }

    #[test]
    fn dtw_spilling_past_the_envelope_is_clamped_into_it() {
        // A stray token (or the VAD timeline issue) pushing DTW outside what
        // whisper itself reported must never widen the cue past the envelope.
        assert_eq!(sanitize_bounds(Some((50, 400)), (100, 300), 20), (100, 300));
    }

    #[test]
    fn a_swapped_dtw_pair_is_normalised_before_clamping() {
        assert_eq!(sanitize_bounds(Some((290, 110)), (100, 300), 20), (110, 290));
    }

    #[test]
    fn a_short_span_is_expanded_symmetrically_around_its_midpoint() {
        // dtw=(145,155): midpoint 150, floored to a 20cs span -> (140, 160).
        assert_eq!(sanitize_bounds(Some((145, 155)), (0, 1000), 20), (140, 160));
    }

    #[test]
    fn expansion_slides_rather_than_truncates_at_the_envelope_start() {
        // Midpoint 5 wants (-5, 15), but the envelope starts at 0: slide the
        // whole window right instead of clipping it to (0, 15) (a 15cs span).
        assert_eq!(sanitize_bounds(Some((0, 10)), (0, 1000), 20), (0, 20));
    }

    #[test]
    fn expansion_slides_rather_than_truncates_at_the_envelope_end() {
        assert_eq!(sanitize_bounds(Some((990, 1000)), (0, 1000), 20), (980, 1000));
    }

    #[test]
    fn an_envelope_shorter_than_the_floor_is_returned_unchanged() {
        // Nothing to expand into: whisper only claimed 100-110, and 10cs of
        // silence-filling time must not be invented on either side of it.
        assert_eq!(sanitize_bounds(None, (100, 110), 20), (100, 110));
        assert_eq!(sanitize_bounds(Some((102, 108)), (100, 110), 20), (102, 108));
    }

    #[test]
    fn a_zero_length_envelope_is_returned_unchanged() {
        assert_eq!(sanitize_bounds(None, (150, 150), 20), (150, 150));
    }

    #[test]
    fn a_negative_envelope_is_normalised_to_zero() {
        assert_eq!(sanitize_bounds(None, (-50, 30), 20), (0, 30));
    }
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
            vad_unavailable: false,
            quality: crate::cues::QualityReport::default(),
            silence: Vec::new(),
        }
    }

    #[test]
    fn flags_a_hallucination_sitting_in_a_silent_stretch() {
        // 10s of silence: whatever whisper claims is there, is not -- but the
        // chunk stays, and the transcript's own text is untouched.
        let audio = tone(10.0, 0.0);
        let (out, marks) = mark_silent_segments(
            result(vec![chunk("ご視聴ありがとうございました", 3.0, 6.0)]),
            &audio,
            SILENCE_RMS,
        );
        assert_eq!(out.chunks.len(), 1);
        assert_eq!(out.text, "ご視聴ありがとうございました");
        assert_eq!(marks.len(), 1);
        assert!(marks[0].silent);
        assert!(marks[0].rms.unwrap() < SILENCE_RMS);
    }

    #[test]
    fn does_not_flag_segments_backed_by_audible_audio() {
        let (out, marks) = mark_silent_segments(
            result(vec![chunk("おはようございます", 1.0, 4.0)]),
            &tone(10.0, 0.2),
            SILENCE_RMS,
        );
        assert_eq!(out.chunks.len(), 1);
        assert_eq!(out.text, "おはようございます");
        assert!(!marks[0].silent);
    }

    #[test]
    fn flags_only_the_silent_pause_between_two_speech_segments() {
        // speech | silence | speech, 10s each.
        let mut audio = tone(10.0, 0.2);
        audio.extend(tone(10.0, 0.0));
        audio.extend(tone(10.0, 0.2));

        let (out, marks) = mark_silent_segments(
            result(vec![
                chunk("前半です", 1.0, 8.0),
                chunk("ご視聴ありがとうございました", 12.0, 18.0),
                chunk("後半です", 21.0, 28.0),
            ]),
            &audio,
            SILENCE_RMS,
        );
        // Nothing is removed: all three chunks and their text survive.
        assert_eq!(
            out.chunks.iter().map(|c| c.text.as_str()).collect::<Vec<_>>(),
            vec!["前半です", "ご視聴ありがとうございました", "後半です"]
        );
        assert_eq!(marks.iter().map(|m| m.silent).collect::<Vec<_>>(), vec![false, true, false]);
    }

    #[test]
    fn a_timestamp_off_by_under_a_second_still_reads_as_real_speech() {
        // The reason for the margin: whisper's timestamps are coarse, so a segment
        // can point just past the speech it transcribed. Flagging that as silent
        // would mislabel a real sentence, which is far worse than a false negative
        // on a hallucination.
        let mut audio = tone(5.0, 0.2);
        audio.extend(tone(10.0, 0.0));
        // Claims 5.3-6.0, which is silent; the speech ends at 5.0.
        let (_, marks) = mark_silent_segments(result(vec![chunk("実際の発話", 5.3, 6.0)]), &audio, SILENCE_RMS);
        assert!(!marks[0].silent);
    }

    #[test]
    fn quiet_speech_just_above_the_threshold_is_not_flagged() {
        let (_, marks) = mark_silent_segments(
            result(vec![chunk("小さな声", 1.0, 4.0)]),
            &tone(10.0, SILENCE_RMS * 2.0),
            SILENCE_RMS,
        );
        assert!(!marks[0].silent);
    }

    #[test]
    fn segments_whose_timestamps_fall_outside_the_audio_are_not_flagged() {
        // Nothing to measure means no evidence to flag on.
        let (_, marks) = mark_silent_segments(result(vec![chunk("末尾", 30.0, 32.0)]), &tone(5.0, 0.2), SILENCE_RMS);
        assert!(!marks[0].silent);
        assert_eq!(marks[0].rms, None);
    }

    #[test]
    fn handles_an_empty_result_and_empty_audio() {
        let (out, marks) = mark_silent_segments(result(vec![]), &tone(5.0, 0.2), SILENCE_RMS);
        assert!(out.chunks.is_empty());
        assert!(marks.is_empty());
        // No audio at all: keep the text rather than silently erasing a transcript.
        let (out, marks) = mark_silent_segments(result(vec![chunk("a", 0.0, 1.0)]), &[], SILENCE_RMS);
        assert_eq!(out.chunks.len(), 1);
        assert!(!marks[0].silent);
    }

    #[test]
    fn rms_matches_the_frontend_definition() {
        assert_eq!(rms(&[]), 0.0);
        assert_eq!(rms(&[1.0, -1.0]), 1.0);
        assert!((rms(&[0.5, -0.5, 0.5, -0.5]) - 0.5).abs() < 1e-6);
    }
}

#[cfg(test)]
mod degenerate_loop_tests {
    use super::{find_degenerate_runs, TranscribeChunk};

    fn chunk(text: &str, t0: f32, t1: f32) -> TranscribeChunk {
        TranscribeChunk {
            text: text.to_string(),
            timestamp: (t0, t1),
        }
    }

    #[test]
    fn finds_a_run_of_identical_text_with_barely_advancing_timestamps() {
        let chunks = vec![
            chunk("いい感じですね", 1.0, 2.0),
            chunk("いい感じですね", 2.02, 3.02),
            chunk("いい感じですね", 3.03, 4.03),
        ];
        let runs = find_degenerate_runs(&chunks);
        assert_eq!(runs, vec![0..3]);
    }

    #[test]
    fn does_not_flag_a_repeated_utterance_whose_start_genuinely_advances() {
        // "はい、はい" said twice with a real pause between: the second
        // chunk's start sits well past the first's end plus the tolerance.
        let chunks = vec![chunk("はい", 1.0, 1.5), chunk("はい", 4.0, 4.5)];
        assert!(find_degenerate_runs(&chunks).is_empty());
    }

    #[test]
    fn a_single_chunk_is_never_a_run() {
        let chunks = vec![chunk("こんにちは", 1.0, 2.0)];
        assert!(find_degenerate_runs(&chunks).is_empty());
    }

    #[test]
    fn a_placeholder_chunk_breaks_a_run_rather_than_extending_it() {
        // Two blank (excluded/silent) chunks are not "the same text repeating"
        // -- they must never be folded into a repetition run.
        let chunks = vec![chunk("", 1.0, 2.0), chunk("", 2.0, 3.0)];
        assert!(find_degenerate_runs(&chunks).is_empty());
    }

    #[test]
    fn a_placeholder_between_two_matching_runs_splits_them() {
        let chunks = vec![
            chunk("ご視聴ありがとうございました", 1.0, 2.0),
            chunk("ご視聴ありがとうございました", 2.0, 3.0),
            chunk("", 3.0, 4.0),
            chunk("ご視聴ありがとうございました", 4.0, 5.0),
            chunk("ご視聴ありがとうございました", 5.0, 6.0),
        ];
        assert_eq!(find_degenerate_runs(&chunks), vec![0..2, 3..5]);
    }

    #[test]
    fn distinct_adjacent_text_is_never_a_run() {
        let chunks = vec![chunk("前半です", 1.0, 2.0), chunk("後半です", 2.0, 3.0)];
        assert!(find_degenerate_runs(&chunks).is_empty());
    }

    #[test]
    fn a_start_just_inside_the_tolerance_still_counts() {
        // prev ends at 2.0; cur starts at 2.05, exactly LOOP_COLLAPSE_TOLERANCE_SEC.
        let chunks = vec![chunk("えー", 1.0, 2.0), chunk("えー", 2.05, 3.0)];
        assert_eq!(find_degenerate_runs(&chunks), vec![0..2]);
    }

    #[test]
    fn a_start_just_outside_the_tolerance_does_not_count() {
        let chunks = vec![chunk("えー", 1.0, 2.0), chunk("えー", 2.06, 3.0)];
        assert!(find_degenerate_runs(&chunks).is_empty());
    }

    #[test]
    fn repeats_differing_only_in_trailing_punctuation_still_match() {
        // A stalled loop's repeats commonly drift in exactly what
        // cer::normalize ignores -- here, a trailing 「。」 present on one
        // repeat and not the next.
        let chunks = vec![
            chunk("ご視聴ありがとうございました。", 1.0, 2.0),
            chunk("ご視聴ありがとうございました", 2.02, 3.02),
        ];
        assert_eq!(find_degenerate_runs(&chunks), vec![0..2]);
    }

    #[test]
    fn repeats_differing_only_in_full_width_digits_still_match() {
        let chunks = vec![chunk("１２３", 1.0, 2.0), chunk("123", 2.02, 3.02)];
        assert_eq!(find_degenerate_runs(&chunks), vec![0..2]);
    }

    #[test]
    fn punctuation_only_text_never_matches_as_a_run() {
        // Normalizes to empty, same as a placeholder -- must not match even
        // another punctuation-only chunk.
        let chunks = vec![chunk("。", 1.0, 2.0), chunk("、", 2.0, 3.0)];
        assert!(find_degenerate_runs(&chunks).is_empty());
    }
}

#[cfg(test)]
mod vad_default_tests {
    use super::DecodeSettings;

    #[test]
    fn vad_is_disabled_by_default() {
        // The live pass (transcribe_window) always uses DecodeSettings::default()
        // unmodified, so this is what governs whether VAD runs there.
        assert!(DecodeSettings::default().vad_model_path.is_none());
    }

    #[test]
    fn vad_defaults_mirror_whisper_rs_own_tuning() {
        // Pinned to whisper_rs::WhisperVadParams::default() (private fields, so
        // this can't cross-check against it directly) -- if a future whisper-rs
        // upgrade changes those defaults, this test won't catch it, but it does
        // catch an accidental edit here silently drifting from what's documented.
        let d = DecodeSettings::default();
        assert_eq!(d.vad_threshold, 0.5);
        assert_eq!(d.vad_min_speech_duration_ms, 250);
        assert_eq!(d.vad_min_silence_duration_ms, 100);
        assert_eq!(d.vad_max_speech_duration_s, f32::MAX);
        assert_eq!(d.vad_speech_pad_ms, 30);
        assert_eq!(d.vad_samples_overlap, 0.1);
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
