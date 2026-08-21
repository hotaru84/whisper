//! Audio event detection (audio tagging) via sherpa-onnx.
//!
//! Two entry points share the same underlying 10-second-window inference
//! (`tag_window`), on two different footings:
//!
//! - `detect_events`/`detect_audio_events`: the authoritative, whole-recording
//!   pass, run post-hoc after the user stops recording (like diarization in
//!   `diarize.rs`). This is what `classify_chunks`' transcript-exclusion
//!   decision and the recording's *saved* event history are always based on
//!   -- it sees the whole recording at once and is what gets persisted.
//! - `detect_events_window`: a live per-window pass during an active
//!   recording, mirroring the ASR streaming pipeline's own chunk-and-commit
//!   windowing (`streaming.ts`). Its results are a preview only -- see
//!   `refineRecording` on the frontend, which always overwrites whatever the
//!   live pass produced with the post-hoc pass's output once the recording
//!   stops. This two-layer "live preview, post-hoc authoritative" split keeps
//!   the live path from ever needing to reconcile with or invalidate the
//!   post-hoc one; it only ever gets replaced wholesale, the same relationship
//!   whisper's own live/refined transcript segments already have.
//!
//! Unlike whisper's model (`asr::AsrState`, loaded once at startup), the
//! audio tagger (`AudioTaggingState`) loads lazily on first use -- audio-event
//! detection is off by default and many recordings never touch it, so it
//! would be wasted startup cost for most sessions.
//!
//! Detected events are deliberately never inserted into the transcript body --
//! a false positive there would corrupt text a reader has no easy way to
//! distinguish from what was actually said. Instead they feed two narrower,
//! reversible uses: a standalone timeline (the frontend's `AudioEventPanel`
//! and `RecordingTimeline`, built directly from `AudioEvent`), and a
//! same-timeline "exclude" flag per whisper chunk (`classify_chunks`) for
//! windows audio tagging is confident are not speech at all.

use std::sync::Mutex;

use serde::Serialize;
use sherpa_onnx::{
    AudioTagging, AudioTaggingConfig, AudioTaggingModelConfig,
    OfflineZipformerAudioTaggingModelConfig,
};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager};

/// AudioSet clips (and so these models) are trained on 10-second windows; a
/// shorter window would be feeding the model something it never saw in
/// training, and a longer one would just average multiple distinct sounds
/// into one weaker prediction.
const WINDOW_SEC: f32 = 10.0;

#[derive(Debug, Clone)]
pub struct AudioEventSettings {
    /// Off by default: like diarization, this is a second model-loading pass
    /// after every recording that most recordings (a quiet room, one speaker)
    /// have nothing for it to find.
    pub enabled: bool,
    /// Minimum probability (0-1) for a tag to be reported at all. sherpa-onnx's
    /// own top_k already limits how many tags come back per window; this
    /// additionally drops low-confidence ones among them.
    pub threshold: f32,
    /// Max number of tags kept per 10-second window.
    pub top_k: i32,
}

impl Default for AudioEventSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            threshold: 0.3,
            top_k: 3,
        }
    }
}

/// Holds the lazily-loaded audio tagger for the lifetime of the app, so a
/// live recording's per-window calls (`detect_events_window`) don't reload a
/// fresh model from disk on every single 10-second window the way calling
/// `AudioTagging::create` per-call (what the post-hoc `detect_events` still
/// does, since it only ever runs once per whole recording) would. `None`
/// until the first call that needs it.
pub struct AudioTaggingState(Mutex<Option<AudioTagging>>);

impl Default for AudioTaggingState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

/// One detected tag on a `[start, end)` window of the recording.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioEvent {
    pub start: f32,
    pub end: f32,
    pub name: String,
    pub index: i32,
    pub prob: f32,
}

/// Runs offline audio tagging over a whole recording, in consecutive 10s
/// windows (the last one truncated, not padded).
///
/// `samples` must be 16 kHz mono, matching `wav::read` and `diarize::diarize`.
/// `model_path`/`labels_path` point at the zipformer audio-tagging int8 ONNX
/// model and its `class_labels_indices.csv` (see README for where to obtain
/// them; Apache-2.0, unlike the CED alternative sherpa-onnx also ships, which
/// is a GPL-3.0 conversion of RicherMans/CED and was rejected for that reason).
///
/// `cancelled` is polled once per window, which is this pass's cancellation
/// granularity: `WINDOW_SEC` of audio, and the tagger is fast enough that one
/// window is imperceptible.
pub fn detect_events(
    samples: &[f32],
    settings: &AudioEventSettings,
    model_path: &str,
    labels_path: &str,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<Vec<AudioEvent>, String> {
    if samples.is_empty() {
        return Ok(Vec::new());
    }

    // This is the offline, whole-recording pass -- it runs once, after the
    // user stops, with nothing else competing for the CPU or GPU (unlike the
    // live per-window path below, which shares both with streaming whisper
    // inference and stays on sherpa-onnx's single-threaded CPU default).
    let tagger = create_tagger(
        model_path,
        labels_path,
        settings.top_k.max(1),
        crate::asr::default_n_threads(),
        "directml",
    )?;

    let window_samples = (WINDOW_SEC * crate::wav::SAMPLE_RATE as f32).round() as usize;
    let mut events = Vec::new();
    for (start, end) in window_bounds(samples.len(), window_samples) {
        crate::cancel::check(cancelled)?;
        let start_sec = start as f32 / crate::wav::SAMPLE_RATE as f32;
        let end_sec = end as f32 / crate::wav::SAMPLE_RATE as f32;
        events.extend(tag_window(
            &tagger,
            &samples[start..end],
            settings.top_k,
            settings.threshold,
            start_sec,
            end_sec,
        ));
    }
    Ok(events)
}

/// Builds and creates a tagger from a model/labels path pair. Shared by the
/// offline pass's per-call creation and `AudioTaggingState`'s lazy
/// first-use creation, so the two never end up constructing the config
/// differently. `top_k` here is only a creation-time fallback -- `tag_window`
/// always passes its own `top_k` to `compute()`, which takes precedence.
///
/// `num_threads` and `provider` are caller-chosen rather than fixed constants
/// precisely because the two callers have opposite constraints: the offline
/// pass has the CPU and GPU to itself and should use both, while the live
/// pass runs alongside streaming whisper inference and must not take
/// resources away from it -- it passes `"cpu"` and 1 thread, matching
/// sherpa-onnx's own defaults.
///
/// `"directml"` is the exact provider string sherpa-onnx's C++ session setup
/// matches; if the shipped DLLs weren't built with DirectML support, or no
/// compatible GPU is available, sherpa-onnx's own session setup already falls
/// back to CPU and keeps working (logging "Fallback to cpu" to stderr), so
/// there is no CPU fallback to implement here.
fn create_tagger(
    model_path: &str,
    labels_path: &str,
    top_k: i32,
    num_threads: i32,
    provider: &str,
) -> Result<AudioTagging, String> {
    let config = AudioTaggingConfig {
        model: AudioTaggingModelConfig {
            zipformer: OfflineZipformerAudioTaggingModelConfig {
                model: Some(model_path.to_string()),
            },
            num_threads,
            provider: Some(provider.to_string()),
            ..Default::default()
        },
        labels: Some(labels_path.to_string()),
        top_k: top_k.max(1),
    };

    // `create` returning None means the C++ side rejected the config (most
    // commonly: a model or labels path that does not exist), the same
    // convention `OfflineSpeakerDiarization::create` uses in diarize.rs.
    AudioTagging::create(&config).ok_or_else(|| {
        format!(
            "failed to create the audio tagger -- check that both files exist: \
             model={model_path:?} labels={labels_path:?}"
        )
    })
}

/// Runs one window of audio tagging against an already-created tagger,
/// producing timestamped, threshold-filtered events for `[start_sec,
/// end_sec)`. Shared by the offline whole-recording pass (`detect_events`)
/// and the live per-window command (`detect_events_window`) so the two can
/// never drift in how a window's raw model output turns into `AudioEvent`s.
fn tag_window(
    tagger: &AudioTagging,
    samples: &[f32],
    top_k: i32,
    threshold: f32,
    start_sec: f32,
    end_sec: f32,
) -> Vec<AudioEvent> {
    let stream = tagger.create_stream();
    stream.accept_waveform(crate::wav::SAMPLE_RATE as i32, samples);
    tagger
        .compute(&stream, top_k.max(1))
        .into_iter()
        .filter(|e| e.prob >= threshold)
        .map(|e| AudioEvent {
            start: start_sec,
            end: end_sec,
            name: e.name,
            index: e.index,
            prob: e.prob,
        })
        .collect()
}

/// Splits `total_samples` into consecutive `[start, end)` windows of
/// `window_samples`, the last one truncated instead of padded or dropped. A
/// pure function so the windowing boundary math -- the part most likely to
/// hide an off-by-one -- is unit-testable without a model.
fn window_bounds(total_samples: usize, window_samples: usize) -> Vec<(usize, usize)> {
    if total_samples == 0 || window_samples == 0 {
        return Vec::new();
    }
    let mut bounds = Vec::new();
    let mut start = 0;
    while start < total_samples {
        let end = (start + window_samples).min(total_samples);
        bounds.push((start, end));
        start = end;
    }
    bounds
}

/// AudioSet label families this app recognizes as "spoken language", kept
/// deliberately generous: `classify_chunks` only excludes a transcript chunk
/// when *none* of these match, so a borderline or unrecognized label errs
/// toward keeping the chunk rather than dropping real speech.
fn is_speech_label(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("speech") || n.contains("conversation") || n.contains("narration") || n.contains("babbling")
}

/// AudioSet label families treated as "not speech, and worth excluding for
/// it". Deliberately narrow (just "music"/"noise") rather than an attempt to
/// enumerate AudioSet's ~130 music-instrument and environmental-sound
/// subclasses: a generic "Music" or "Noise" tag is what a 10s window
/// dominated by either actually surfaces in practice, and a narrower net
/// means fewer accidental exclusions from an unrelated label that happens to
/// contain neither word.
fn is_noise_or_music_label(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("music") || n.contains("noise")
}

fn overlap(a_start: f32, a_end: f32, b_start: f32, b_end: f32) -> f32 {
    (a_end.min(b_end) - a_start.max(b_start)).max(0.0)
}

/// For each `chunks` interval, whether it should be dropped from the
/// transcript: audio tagging found no speech-family tag overlapping it, but
/// did find a music/noise-family one. A chunk with no overlapping events at
/// all (audio tagging found nothing confident either way, or it sits in a gap
/// between windows) is never excluded -- unlike `diarize::assign_speakers`,
/// this is a destructive decision, so absence of evidence has to default to
/// leaving the chunk alone rather than guessing.
///
/// `chunks` are `(start, end)` in seconds on the same 0-based recording
/// timeline as `events` (see `diarize::assign_speakers`'s doc comment for why
/// this matters: mixing timelines here would exclude the wrong lines).
pub fn classify_chunks(chunks: &[(f32, f32)], events: &[AudioEvent]) -> Vec<bool> {
    chunks
        .iter()
        .map(|&(start, end)| {
            let mut has_speech = false;
            let mut has_noise = false;
            for e in events {
                if overlap(start, end, e.start, e.end) <= 0.0 {
                    continue;
                }
                has_speech |= is_speech_label(&e.name);
                has_noise |= is_noise_or_music_label(&e.name);
            }
            !has_speech && has_noise
        })
        .collect()
}

fn resolve_model_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    Ok(resource_dir.join("resources/models/audio-tagging/model.int8.onnx"))
}

fn resolve_labels_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    Ok(resource_dir.join("resources/models/audio-tagging/class_labels_indices.csv"))
}

/// Result shape for the frontend: raw events for the timeline panel, plus one
/// `exclude` flag per entry of the `chunks` argument, in the same order (the
/// same positional-correspondence contract `diarize_recording` uses).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioEventResult {
    pub events: Vec<AudioEvent>,
    pub exclude: Vec<bool>,
}

/// Detects audio events on a finished recording and classifies each of
/// `chunks` for exclusion. `chunks` must be on the recording's own timeline,
/// matching what `finalize_transcript` returns and *before* the frontend
/// rebases them onto the session's global timeline -- see
/// `diarize::diarize_recording`'s doc comment for the same concern.
#[tauri::command]
pub async fn detect_audio_events(
    app: AppHandle,
    path: String,
    job_id: String,
    chunks: Vec<(f32, f32)>,
    threshold: f32,
    top_k: i32,
) -> Result<AudioEventResult, String> {
    let cancel = crate::cancel::flag(&app, &job_id);

    tauri::async_runtime::spawn_blocking(move || {
        crate::cancel::check(&cancel)?;
        let samples = crate::wav::read(std::path::Path::new(&path))?;
        let model_path = resolve_model_path(&app)?;
        let labels_path = resolve_labels_path(&app)?;
        crate::cancel::check(&cancel)?;

        let settings = AudioEventSettings {
            enabled: true,
            threshold,
            top_k,
        };
        let events = detect_events(
            &samples,
            &settings,
            &model_path.display().to_string(),
            &labels_path.display().to_string(),
            &cancel,
        )?;
        let exclude = classify_chunks(&chunks, &events);

        Ok(AudioEventResult { events, exclude })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Live counterpart to `detect_audio_events`, used while a recording is
/// still in progress: tags exactly the one window of audio the frontend
/// hands it (its own `AudioEventStreamer` accumulates ~10s at a time,
/// mirroring `StreamingTranscriber`'s windowing) using the lazily-loaded
/// resident tagger in `AudioTaggingState`, rather than reloading the model
/// from disk on every window the way the offline pass's per-call
/// `AudioTagging::create` would.
///
/// Its result is a preview only -- see this module's doc comment. `start_sec`
/// is where this window sits on the *recording's own* 0-based timeline; the
/// frontend is responsible for that bookkeeping, same as `transcribe_window`
/// leaves window offsets to `StreamingTranscriber`.
///
/// Audio arrives as a raw IPC body rather than a JSON array, the same
/// reasoning `transcribe_window`'s doc comment gives: a 10s window is 160k
/// samples, and serializing that many numbers as JSON text on every window
/// would be needless overhead compared to sending the raw bytes.
#[tauri::command]
pub async fn detect_events_window(
    app: AppHandle,
    request: Request<'_>,
) -> Result<Vec<AudioEvent>, String> {
    let InvokeBody::Raw(audio_bytes) = request.body() else {
        return Err("detect_events_window expects a raw binary body".to_string());
    };
    let audio_bytes = audio_bytes.clone();

    let header_f32 = |name: &str, default: f32| -> f32 {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<f32>().ok())
            .unwrap_or(default)
    };
    let threshold = header_f32("X-Threshold", 0.3);
    let top_k = header_f32("X-Top-K", 3.0).round() as i32;
    let start_sec = header_f32("X-Start-Sec", 0.0);

    tauri::async_runtime::spawn_blocking(move || {
        if audio_bytes.is_empty() {
            return Ok(Vec::new());
        }
        // IPC bytes aren't guaranteed 4-byte aligned, so decode via
        // from_le_bytes rather than an unsafe pointer cast (same as
        // `transcribe_window`).
        let samples: Vec<f32> = audio_bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();

        let state = app.state::<AudioTaggingState>();
        let mut guard = state.0.lock().unwrap();
        if guard.is_none() {
            let model_path = resolve_model_path(&app)?;
            let labels_path = resolve_labels_path(&app)?;
            // Single-threaded CPU on purpose: this runs during an active
            // recording, concurrently with streaming whisper inference on the
            // same machine's CPU and GPU, and must not compete with it the
            // way the offline pass's higher thread count and DirectML
            // provider would.
            *guard = Some(create_tagger(
                &model_path.display().to_string(),
                &labels_path.display().to_string(),
                top_k,
                1,
                "cpu",
            )?);
        }
        let tagger = guard.as_ref().unwrap();
        let end_sec = start_sec + samples.len() as f32 / crate::wav::SAMPLE_RATE as f32;
        Ok(tag_window(tagger, &samples, top_k, threshold, start_sec, end_sec))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(start: f32, end: f32, name: &str) -> AudioEvent {
        AudioEvent {
            start,
            end,
            name: name.to_string(),
            index: 0,
            prob: 0.9,
        }
    }

    #[test]
    fn window_bounds_splits_exact_multiples_evenly() {
        assert_eq!(window_bounds(30, 10), vec![(0, 10), (10, 20), (20, 30)]);
    }

    #[test]
    fn window_bounds_truncates_the_last_window_instead_of_padding() {
        assert_eq!(window_bounds(25, 10), vec![(0, 10), (10, 20), (20, 25)]);
    }

    #[test]
    fn window_bounds_handles_less_than_one_window() {
        assert_eq!(window_bounds(5, 10), vec![(0, 5)]);
    }

    #[test]
    fn window_bounds_is_empty_for_no_samples() {
        assert_eq!(window_bounds(0, 10), Vec::<(usize, usize)>::new());
        assert_eq!(window_bounds(10, 0), Vec::<(usize, usize)>::new());
    }

    #[test]
    fn excludes_a_chunk_that_overlaps_only_a_music_window() {
        let events = [ev(0.0, 10.0, "Music")];
        assert_eq!(classify_chunks(&[(2.0, 5.0)], &events), vec![true]);
    }

    #[test]
    fn keeps_a_chunk_that_overlaps_only_speech() {
        let events = [ev(0.0, 10.0, "Speech")];
        assert_eq!(classify_chunks(&[(2.0, 5.0)], &events), vec![false]);
    }

    #[test]
    fn keeps_a_chunk_with_both_speech_and_music_in_the_same_window() {
        // Someone talking over background music -- the exclusion bar is "no
        // speech detected at all", not "any noise detected".
        let events = [ev(0.0, 10.0, "Speech"), ev(0.0, 10.0, "Music")];
        assert_eq!(classify_chunks(&[(2.0, 5.0)], &events), vec![false]);
    }

    #[test]
    fn keeps_a_chunk_with_no_overlapping_events() {
        // No audio tagging coverage here at all (e.g. detection disabled, or a
        // gap between windows) -- absence of evidence must not exclude.
        assert_eq!(classify_chunks(&[(2.0, 5.0)], &[]), vec![false]);
    }

    #[test]
    fn keeps_a_chunk_overlapping_a_window_with_neither_speech_nor_noise_tags() {
        let events = [ev(0.0, 10.0, "Applause")];
        assert_eq!(classify_chunks(&[(2.0, 5.0)], &events), vec![false]);
    }

    #[test]
    fn a_zero_length_chunk_is_never_excluded() {
        // Mirrors overlap()'s zero-area behavior: a point never overlaps an
        // interval by this measure, so it always falls through to "keep".
        let events = [ev(0.0, 10.0, "Music")];
        assert_eq!(classify_chunks(&[(4.0, 4.0)], &events), vec![false]);
    }

    #[test]
    fn touching_but_non_overlapping_windows_do_not_count() {
        let events = [ev(0.0, 5.0, "Music")];
        assert_eq!(classify_chunks(&[(5.0, 8.0)], &events), vec![false]);
    }

    #[test]
    fn handles_an_empty_chunk_list() {
        assert_eq!(classify_chunks(&[], &[ev(0.0, 5.0, "Music")]), Vec::<bool>::new());
    }

    #[test]
    fn default_settings_are_disabled_and_moderately_selective() {
        let settings = AudioEventSettings::default();
        assert!(!settings.enabled);
        assert_eq!(settings.top_k, 3);
    }

    #[test]
    fn speech_label_matching_covers_the_common_audioset_speech_family() {
        for name in [
            "Speech",
            "Male speech, man speaking",
            "Female speech, woman speaking",
            "Child speech, kid speaking",
            "Conversation",
            "Narration, monologue",
            "Babbling",
            "Speech synthesizer",
        ] {
            assert!(is_speech_label(name), "{name} should be speech-family");
        }
        assert!(!is_speech_label("Music"));
        assert!(!is_speech_label("Applause"));
    }

    #[test]
    fn noise_or_music_label_matching_is_narrow_by_design() {
        assert!(is_noise_or_music_label("Music"));
        assert!(is_noise_or_music_label("Environmental noise"));
        assert!(is_noise_or_music_label("White noise"));
        assert!(!is_noise_or_music_label("Speech"));
        // Documents the known gap rather than hiding it: instrument-specific
        // tags don't contain the word "music", so they are not caught here.
        assert!(!is_noise_or_music_label("Guitar"));
    }
}
