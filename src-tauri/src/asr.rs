use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
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
        // DTW (per-token timestamps via attention alignment, tighter than
        // whisper's default single-timestamp-token segment boundaries) was
        // tried and removed. whisper.cpp's DTW median filter calls
        // `WHISPER_ASSERT(filter_width < a->ne[2])` (whisper.cpp:8772) --
        // filter_width is hardcoded to 7, and `a->ne[2]` is the segment's own
        // frame count, so any segment whisper times at under ~160ms fails
        // this and calls `abort()`. That is not a catchable Rust error; it
        // kills the whole process. Whisper.cpp's internal seek loop can
        // produce a segment that short (the same seek irregularities
        // `redecode_voiced_gaps` exists to work around), and there is no way
        // to rule that out up front from this side of the FFI boundary.
        // DTW also never changed transcribed text, only cue timing, so the
        // only real loss from removing it is some sharpness in diarization's
        // timestamp-overlap speaker assignment, which falls back to
        // whisper's own (coarser, but crash-proof) segment-level timestamps.
        // See README's "DTW" section for the fuller history.
        let params = WhisperContextParameters::default();
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

#[derive(Serialize, Deserialize)]
pub struct TranscribeChunk {
    pub text: String,
    pub timestamp: (f32, f32),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeResult {
    pub text: String,
    pub chunks: Vec<TranscribeChunk>,
    /// Reference-free structural metrics (gaps, out-of-order cues) computed
    /// over `chunks`. `transcribe_window` leaves this at its all-zero default
    /// since a 30s window is too short for the metrics to mean anything;
    /// `finalize_transcript` fills it in. See `crate::cues` for what each
    /// field catches.
    #[serde(default)]
    pub quality: crate::cues::QualityReport,
    /// Parallel to `chunks` (same index, same length once populated) --
    /// `silence[i]` describes whether `chunks[i]` was judged to hold no
    /// speech by `mark_silent_segments`. Empty from `transcribe_window`,
    /// which never calls it; `finalize_transcript` fills it in. A parallel
    /// array rather than fields on
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
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);
    params.set_print_timestamps(false);
    params
}

/// Normalises a whisper segment's own envelope: clamps a negative start to
/// zero and guarantees the end is never before the start.
///
/// Used to reconcile a DTW-derived token span against this envelope before
/// DTW was removed (see `init_model`'s doc comment); this trivial clamp is
/// what remains of that job now that the envelope -- whisper's own
/// single-timestamp-token segment boundary -- is all there is.
fn sanitize_bounds(envelope: (i64, i64)) -> (i64, i64) {
    let e0 = envelope.0.max(0);
    let e1 = envelope.1.max(e0);
    (e0, e1)
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
        let envelope = (segment.start_timestamp(), segment.end_timestamp());
        let (t0_cs, t1_cs) = sanitize_bounds(envelope);
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

        collect_segments(&whisper_state)
    })
    .await
    .map_err(|e| e.to_string())?
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
/// require a full second of silence on both sides. Coarser still since DTW
/// was removed (see `init_model`'s doc comment) -- no reason to shrink this,
/// only more reason it needs to stay generous.
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
        for c in collect_segments(&state)?.chunks {
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
/// A degenerate run being repaired can itself span more than whisper's own
/// ~30s internal chunk size, in which case the repair decode conditions its
/// own later chunks on its own earlier ones (whisper.cpp's normal
/// context-carrying behavior within one `full()` call): once a chunk decodes
/// into a short repeated phrase, that phrase becomes the next chunk's own
/// context, and self-similar context makes the decoder reproduce it again,
/// filling the rolling context with copies of itself. A fresh `WhisperState`
/// (as `redecode_voiced_gaps` already uses) removes stale context from
/// *outside* the span once, but if a repaired span were long enough
/// to itself span an internal 30s boundary, the same self-reinforcement could
/// restart inside the repair decode. Capping the context budget low (64) keeps
/// too little of any one internal chunk's output alive for it to dominate the
/// next.
///
/// This overrides `n_max_text_ctx` only for this one isolated repair decode.
/// whisper.cpp's own default for the field is `16384` (whisper.cpp:5911,
/// effectively unbounded against a ~448-token text context) -- unrelated to
/// the 224-token figure in `DecodeSettings::prompt`'s doc comment, which is a
/// *different* budget (`min(n_max_text_ctx, n_text_ctx / 2)`, computed only
/// when truncating the user's glossary prompt). `build_full_params` never
/// calls `set_n_max_text_ctx`, so every other decode -- the main pass, the
/// live pass, `redecode_voiced_gaps` -- keeps whisper.cpp's own default
/// unchanged.
const DEGENERATE_LOOP_MAX_CTX: i32 = 64;

/// Padding added on each side of a degenerate-loop span before re-decoding
/// it, in seconds. Mirrors `GAP_REDECODE_MARGIN_SEC`'s rationale: a little
/// context on either side so the repair decode does not start or stop
/// mid-word, with the result always clamped back to the span's own bounds
/// before merging (see `redecode_degenerate_loops`).
const LOOP_REDECODE_MARGIN_SEC: f32 = 0.5;

/// Whether a degenerate-loop repair should replace the run it was decoded
/// for.
///
/// There is no reference transcript to check the replacement's text against,
/// so correctness can never be confirmed here -- only that the replacement is
/// not a continuation of the same failure. Two things fail that minimal bar:
/// an empty replacement is indistinguishable from a redecode that produced
/// nothing at all, and a replacement whose own worst degenerate run
/// ([`find_degenerate_runs`] run again on it) is no shorter than
/// `original_run_len` is no improvement -- possibly the identical loop
/// reproduced by the repair decode itself. Rejecting either keeps the
/// original (looped, but recoverable in the UI via
/// `collapseDegenerateSegments`) chunks instead.
fn accepts_loop_repair(original_run_len: usize, replacement: &[TranscribeChunk]) -> bool {
    if replacement.is_empty() {
        return false;
    }
    let worst_new_run = find_degenerate_runs(replacement).iter().map(|r| r.len()).max().unwrap_or(0);
    worst_new_run < original_run_len
}

/// Splices accepted repairs back into the original chunk sequence.
///
/// `runs` and `repairs` are parallel and must be the same length: `repairs[i]`
/// is `Some(replacement)` when a repair was accepted for `runs[i]`
/// ([`accepts_loop_repair`]), or `None` to keep that run's original chunks
/// unchanged (no repair attempted, or one rejected). `runs` must be sorted,
/// non-overlapping, and each within `chunks`' bounds -- exactly what
/// [`find_degenerate_runs`] returns.
///
/// Kept separate from the decode/repair logic (which needs a `WhisperState`
/// and so cannot be unit-tested directly): this index bookkeeping is what
/// would silently drop or duplicate a chunk on an off-by-one, with nothing
/// downstream positioned to notice, so it gets its own tests instead of only
/// being exercised end-to-end against a real model.
fn splice_repairs(
    chunks: Vec<TranscribeChunk>,
    runs: &[std::ops::Range<usize>],
    repairs: Vec<Option<Vec<TranscribeChunk>>>,
) -> Vec<TranscribeChunk> {
    debug_assert_eq!(runs.len(), repairs.len());

    let mut out = Vec::with_capacity(chunks.len());
    let mut chunks = chunks.into_iter();
    let mut pos = 0usize;

    for (run, repair) in runs.iter().zip(repairs) {
        // Copy through untouched chunks before this run.
        while pos < run.start {
            out.push(chunks.next().expect("pos stays within the original chunk count"));
            pos += 1;
        }
        // Consume the run's own original chunks; kept as the fallback if
        // `repair` is `None`.
        let mut originals = Vec::with_capacity(run.len());
        while pos < run.end {
            originals.push(chunks.next().expect("pos stays within the original chunk count"));
            pos += 1;
        }

        match repair {
            Some(replacement) => out.extend(replacement),
            None => out.extend(originals),
        }
    }

    // Copy through anything after the last run.
    out.extend(chunks);
    out
}

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
/// text-context budget capped at [`DEGENERATE_LOOP_MAX_CTX`] tokens, clamped
/// to the run's own bounds, and kept only if [`accepts_loop_repair`] judges
/// it an improvement; [`splice_repairs`] does the actual replacement.
pub fn redecode_degenerate_loops(
    ctx: &WhisperContext,
    settings: &DecodeSettings,
    cancel: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    chunks: Vec<TranscribeChunk>,
    samples: &[f32],
) -> Result<Vec<TranscribeChunk>, String> {
    let runs = find_degenerate_runs(&chunks);
    if runs.is_empty() {
        return Ok(chunks);
    }

    let sr = crate::wav::SAMPLE_RATE as f32;
    let mut repairs: Vec<Option<Vec<TranscribeChunk>>> = Vec::with_capacity(runs.len());

    for run in &runs {
        let span_start = chunks[run.start].timestamp.0;
        let span_end = chunks[run.end - 1].timestamp.1;

        let padded_from = ((span_start - LOOP_REDECODE_MARGIN_SEC) * sr).max(0.0) as usize;
        let padded_to = (((span_end + LOOP_REDECODE_MARGIN_SEC) * sr) as usize).min(samples.len());
        if padded_from >= padded_to {
            repairs.push(None);
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
        for c in collect_segments(&state)?.chunks {
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

        if accepts_loop_repair(run.len(), &replacement) {
            repairs.push(Some(replacement));
        } else {
            repairs.push(None);
        }
    }

    Ok(splice_repairs(chunks, &runs, repairs))
}

/// Runs the repair/analysis tail over a chunk list already produced by
/// windowed decoding (either the live streaming pass or the post-hoc
/// windowed driver), plus the finished recording's own WAV.
///
/// This used to be the tail end of a single whole-file `full()` call (the old
/// "accuracy pass"). Splitting it out lets it apply identically no matter how
/// `chunks` was decoded -- one call for a whole file, or many independent
/// ~30s windows stitched together -- since none of `redecode_degenerate_loops`,
/// `redecode_voiced_gaps`, or `mark_silent_segments` assume a single
/// contiguous seek loop; they only need `chunks` sorted, non-overlapping, and
/// on the same absolute timeline as `samples`.
///
/// `chunks` must already carry recording-absolute timestamps (0-based on the
/// start of the WAV at `path`), not window-relative ones -- the caller is
/// responsible for that rebasing (see `flattenSegmentsToChunks` on the
/// frontend).
#[tauri::command]
pub async fn finalize_transcript(
    app: AppHandle,
    path: String,
    job_id: String,
    chunks: Vec<TranscribeChunk>,
    language: Option<String>,
    task: Option<String>,
    prompt: Option<String>,
    entropy_thold: f32,
    silence_rms: f32,
) -> Result<TranscribeResult, String> {
    let language = language.filter(|l| !l.is_empty() && l != "auto");
    let translate = task.as_deref() == Some("translate");
    let prompt = prompt.filter(|p| !p.trim().is_empty());
    let cancel = crate::cancel::flag(&app, &job_id);

    tauri::async_runtime::spawn_blocking(move || {
        crate::cancel::check(&cancel)?;
        let samples = crate::wav::read(std::path::Path::new(&path))?;
        if samples.is_empty() {
            return Err(format!("{path} contains no audio"));
        }
        crate::cancel::check(&cancel)?;

        let state = app.state::<AsrState>();
        let guard = state.0.lock().unwrap();
        let ctx = guard
            .as_ref()
            .ok_or_else(|| "model is not initialized".to_string())?;

        let settings = DecodeSettings {
            language,
            translate,
            prompt,
            entropy_thold,
            ..DecodeSettings::default()
        };

        // Loop repair runs before gap fill, not after: gap fill's own inserted
        // cues can split what would have been one longer degenerate run into
        // shorter ones that no longer clear find_degenerate_runs' two-chunk
        // minimum, hiding a loop from repair. Running loop repair first means
        // any gap a *replacement* span leaves behind (its content is genuine
        // speech now, not a stalled loop packed with no real pauses) still
        // gets a chance to be filled by the gap-fill pass that follows.
        let chunks = redecode_degenerate_loops(ctx, &settings, &cancel, chunks, &samples)?;
        let chunks = redecode_voiced_gaps(ctx, &settings, &cancel, chunks, &samples, silence_rms)?;
        let text = chunks.iter().map(|c| c.text.as_str()).collect();

        let result = TranscribeResult {
            text,
            chunks,
            quality: crate::cues::QualityReport::default(),
            silence: Vec::new(),
        };
        let (mut result, silence) = mark_silent_segments(result, &samples, silence_rms);
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
    fn a_normal_envelope_is_returned_unchanged() {
        assert_eq!(sanitize_bounds((100, 300)), (100, 300));
    }

    #[test]
    fn a_negative_envelope_start_is_normalised_to_zero() {
        assert_eq!(sanitize_bounds((-50, 30)), (0, 30));
    }

    #[test]
    fn a_zero_length_envelope_is_returned_unchanged() {
        assert_eq!(sanitize_bounds((150, 150)), (150, 150));
    }

    #[test]
    fn an_end_before_the_start_is_clamped_to_the_start() {
        assert_eq!(sanitize_bounds((150, 100)), (150, 150));
    }

    #[test]
    fn a_negative_end_is_clamped_to_the_normalised_start() {
        assert_eq!(sanitize_bounds((-50, -10)), (0, 0));
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
mod loop_repair_tests {
    use super::{accepts_loop_repair, splice_repairs, TranscribeChunk};

    fn chunk(text: &str, t0: f32, t1: f32) -> TranscribeChunk {
        TranscribeChunk {
            text: text.to_string(),
            timestamp: (t0, t1),
        }
    }

    mod accepts_loop_repair_tests {
        use super::*;

        #[test]
        fn rejects_an_empty_replacement() {
            assert!(!accepts_loop_repair(3, &[]));
        }

        #[test]
        fn accepts_a_replacement_with_no_degenerate_run_of_its_own() {
            let replacement = vec![chunk("こんにちは", 1.0, 2.0), chunk("元気ですか", 2.0, 3.0)];
            assert!(accepts_loop_repair(3, &replacement));
        }

        #[test]
        fn accepts_a_replacement_whose_worst_run_is_shorter_than_the_original() {
            // Original run was 4 chunks long; the repair still loops, but only
            // 2 -- a real improvement even if not a full fix.
            let replacement = vec![
                chunk("えー", 1.0, 1.5),
                chunk("えー", 1.5, 2.0),
                chunk("本題ですが", 2.0, 3.0),
            ];
            assert!(accepts_loop_repair(4, &replacement));
        }

        #[test]
        fn rejects_a_replacement_whose_worst_run_matches_the_original_length() {
            // Same-length loop reproduced by the repair decode itself: no
            // improvement, so the original (also recoverable in the UI) wins.
            let replacement = vec![chunk("えー", 1.0, 1.5), chunk("えー", 1.5, 2.0)];
            assert!(!accepts_loop_repair(2, &replacement));
        }

        #[test]
        fn rejects_a_replacement_whose_worst_run_is_longer_than_the_original() {
            let replacement =
                vec![chunk("えー", 1.0, 1.5), chunk("えー", 1.5, 2.0), chunk("えー", 2.0, 2.5)];
            assert!(!accepts_loop_repair(2, &replacement));
        }
    }

    mod splice_repairs_tests {
        use super::*;

        #[test]
        fn no_repairs_leaves_chunks_unchanged() {
            let chunks = vec![chunk("a", 0.0, 1.0), chunk("b", 1.0, 2.0), chunk("b", 2.0, 3.0)];
            let runs = vec![1..3];
            let out = splice_repairs(chunks, &runs, vec![None]);
            let texts: Vec<_> = out.iter().map(|c| c.text.as_str()).collect();
            assert_eq!(texts, vec!["a", "b", "b"]);
        }

        #[test]
        fn a_repair_replaces_exactly_its_run_and_preserves_neighbours() {
            let chunks = vec![
                chunk("前", 0.0, 1.0),
                chunk("えー", 1.0, 1.5),
                chunk("えー", 1.5, 2.0),
                chunk("後", 2.0, 3.0),
            ];
            let runs = vec![1..3];
            let replacement = vec![chunk("本題ですが", 1.0, 2.0)];
            let out = splice_repairs(chunks, &runs, vec![Some(replacement)]);
            let texts: Vec<_> = out.iter().map(|c| c.text.as_str()).collect();
            assert_eq!(texts, vec!["前", "本題ですが", "後"]);
        }

        #[test]
        fn a_run_at_the_very_start_is_spliced_correctly() {
            let chunks = vec![chunk("えー", 0.0, 0.5), chunk("えー", 0.5, 1.0), chunk("後", 1.0, 2.0)];
            let runs = vec![0..2];
            let replacement = vec![chunk("さて", 0.0, 1.0)];
            let out = splice_repairs(chunks, &runs, vec![Some(replacement)]);
            let texts: Vec<_> = out.iter().map(|c| c.text.as_str()).collect();
            assert_eq!(texts, vec!["さて", "後"]);
        }

        #[test]
        fn a_run_at_the_very_end_is_spliced_correctly() {
            let chunks = vec![chunk("前", 0.0, 1.0), chunk("えー", 1.0, 1.5), chunk("えー", 1.5, 2.0)];
            let runs = vec![1..3];
            let replacement = vec![chunk("以上です", 1.0, 2.0)];
            let out = splice_repairs(chunks, &runs, vec![Some(replacement)]);
            let texts: Vec<_> = out.iter().map(|c| c.text.as_str()).collect();
            assert_eq!(texts, vec!["前", "以上です"]);
        }

        #[test]
        fn a_replacement_shorter_than_its_run_still_preserves_surrounding_chunks() {
            let chunks = vec![
                chunk("前", 0.0, 1.0),
                chunk("えー", 1.0, 1.3),
                chunk("えー", 1.3, 1.6),
                chunk("えー", 1.6, 2.0),
                chunk("後", 2.0, 3.0),
            ];
            let runs = vec![1..4];
            let replacement = vec![chunk("一言だけ", 1.0, 2.0)];
            let out = splice_repairs(chunks, &runs, vec![Some(replacement)]);
            let texts: Vec<_> = out.iter().map(|c| c.text.as_str()).collect();
            assert_eq!(texts, vec!["前", "一言だけ", "後"]);
        }

        #[test]
        fn a_replacement_longer_than_its_run_still_preserves_surrounding_chunks() {
            let chunks = vec![chunk("前", 0.0, 1.0), chunk("えー", 1.0, 1.5), chunk("えー", 1.5, 2.0), chunk("後", 2.0, 3.0)];
            let runs = vec![1..3];
            let replacement = vec![chunk("これは", 1.0, 1.5), chunk("長い返答です", 1.5, 2.0)];
            let out = splice_repairs(chunks, &runs, vec![Some(replacement)]);
            let texts: Vec<_> = out.iter().map(|c| c.text.as_str()).collect();
            assert_eq!(texts, vec!["前", "これは", "長い返答です", "後"]);
        }

        #[test]
        fn multiple_runs_are_each_spliced_independently() {
            let chunks = vec![
                chunk("えー", 0.0, 0.5),
                chunk("えー", 0.5, 1.0),
                chunk("中間", 1.0, 2.0),
                chunk("あの", 2.0, 2.5),
                chunk("あの", 2.5, 3.0),
                chunk("末尾", 3.0, 4.0),
            ];
            let runs = vec![0..2, 3..5];
            let out = splice_repairs(
                chunks,
                &runs,
                vec![Some(vec![chunk("さて", 0.0, 1.0)]), None],
            );
            let texts: Vec<_> = out.iter().map(|c| c.text.as_str()).collect();
            // First run repaired, second (rejected -> None) kept as-is.
            assert_eq!(texts, vec!["さて", "中間", "あの", "あの", "末尾"]);
        }
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
