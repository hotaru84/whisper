//! Speaker diarization via sherpa-onnx, and merging its output onto whisper's
//! transcript segments.
//!
//! Diarization cannot run per-window the way live transcription does: telling
//! the voice at minute 1 and the voice at minute 30 apart from each other, or
//! recognizing they're the same speaker, needs a view of the whole recording.
//! So like the second transcription pass (`asr::transcribe_recording`), this
//! only ever runs on the finished recording's WAV file after the user stops.

use std::path::PathBuf;

use serde::Serialize;
use sherpa_onnx::{
    FastClusteringConfig, OfflineSpeakerDiarization, OfflineSpeakerDiarizationConfig,
    OfflineSpeakerSegmentationModelConfig, OfflineSpeakerSegmentationPyannoteModelConfig,
    SpeakerEmbeddingExtractorConfig,
};
use tauri::{AppHandle, Manager};

/// User-facing diarization knobs. Mirrors `asr::DecodeSettings` in spirit: one
/// place, exposed to the settings UI, with the actual sherpa-onnx config types
/// kept as an implementation detail behind [`diarize`].
#[derive(Debug, Clone)]
pub struct DiarizeSettings {
    /// Off by default: diarization adds a second model-loading + inference pass
    /// after every recording, which is not free, and most recordings are one
    /// speaker (dictation) where it has nothing to contribute.
    pub enabled: bool,
    /// Clustering distance threshold: lower splits speakers more readily,
    /// higher merges more readily. Matches sherpa-onnx's own default of 0.5.
    pub threshold: f32,
    /// -1 lets sherpa-onnx estimate the speaker count from the audio itself,
    /// via the same threshold. Meetings vary in attendance, so a fixed count is
    /// the exception, not the rule; pass a positive number only when the caller
    /// knows exactly how many people are on the recording.
    pub num_speakers: i32,
    /// Segments shorter than this (seconds) are not treated as a speaker turn.
    /// Guards against a short "ん" or throat-clear becoming its own speaker.
    pub min_duration_on: f32,
    /// Gaps shorter than this (seconds) do not split a speaker turn in two.
    pub min_duration_off: f32,
}

impl Default for DiarizeSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            threshold: 0.5,
            num_speakers: -1,
            min_duration_on: 0.3,
            min_duration_off: 0.5,
        }
    }
}

/// One speaker turn, in seconds on the recording's own timeline.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct SpeakerSegment {
    pub start: f32,
    pub end: f32,
    /// A cluster index (0, 1, 2, ...), not a stable identity across recordings.
    /// The same speaker in two different meetings will not share a number.
    pub speaker: i32,
}

/// Runs offline speaker diarization over a whole recording.
///
/// `samples` must be 16 kHz mono, the same audio `transcribe_recording` reads
/// via `wav::read`. `segmentation_model` and `embedding_model` are paths to the
/// pyannote segmentation ONNX file and the speaker embedding ONNX file
/// respectively (see README for where to obtain them).
pub fn diarize(
    samples: &[f32],
    settings: &DiarizeSettings,
    segmentation_model: &str,
    embedding_model: &str,
) -> Result<Vec<SpeakerSegment>, String> {
    let config = OfflineSpeakerDiarizationConfig {
        segmentation: OfflineSpeakerSegmentationModelConfig {
            pyannote: OfflineSpeakerSegmentationPyannoteModelConfig {
                model: Some(segmentation_model.to_string()),
            },
            ..Default::default()
        },
        embedding: SpeakerEmbeddingExtractorConfig {
            model: Some(embedding_model.to_string()),
            ..Default::default()
        },
        clustering: FastClusteringConfig {
            num_clusters: settings.num_speakers,
            threshold: settings.threshold,
        },
        min_duration_on: settings.min_duration_on,
        min_duration_off: settings.min_duration_off,
    };

    // `create` returning None means the C++ side rejected the config (most
    // commonly: a model path that does not exist), not "no speech found" --
    // that case is an empty segment list from a successful `process`.
    let diarizer = OfflineSpeakerDiarization::create(&config).ok_or_else(|| {
        format!(
            "failed to create the speaker diarizer -- check that both model files exist: \
             segmentation={segmentation_model:?} embedding={embedding_model:?}"
        )
    })?;

    let result = diarizer
        .process(samples)
        .ok_or_else(|| "speaker diarization failed while processing the recording".to_string())?;

    Ok(result
        .sort_by_start_time()
        .into_iter()
        .map(|s| SpeakerSegment {
            start: s.start,
            end: s.end,
            speaker: s.speaker,
        })
        .collect())
}

/// Assigns each transcript chunk to the speaker segment it overlaps the most.
///
/// A pure function over plain tuples and [`SpeakerSegment`] -- no sherpa-onnx
/// object, no I/O -- so it is unit-testable without a model or audio, and so a
/// future audio-event or DTW pass could reuse the same overlap logic.
///
/// `chunks` are `(start, end)` in seconds on the same timeline as `speakers`
/// (both must already be on the recording's absolute timeline, not a segment-
/// relative one -- see `transcript::segmentsFromResult`'s rebasing on the
/// frontend for the analogous concern there).
///
/// Returns `None` for a chunk with no overlapping speaker segment at all: a
/// gap diarization did not assign to anyone, or diarization found nothing
/// there while whisper still transcribed something (disagreement between the
/// two models, which does happen). A wrong guess would misattribute a line to
/// the wrong person, which is worse than leaving it unlabeled.
pub fn assign_speakers(chunks: &[(f32, f32)], speakers: &[SpeakerSegment]) -> Vec<Option<i32>> {
    chunks
        .iter()
        .map(|&(start, end)| assign_one(start, end, speakers))
        .collect()
}

fn assign_one(start: f32, end: f32, speakers: &[SpeakerSegment]) -> Option<i32> {
    if start < end {
        return speakers
            .iter()
            .map(|s| (overlap(start, end, s.start, s.end), s.speaker))
            .filter(|(ov, _)| *ov > 0.0)
            .max_by(|(a, _), (b, _)| a.total_cmp(b))
            .map(|(_, speaker)| speaker);
    }

    // A zero-length chunk (whisper occasionally emits one at a token boundary)
    // has no interval to measure overlap against -- the area is always zero
    // even when the point sits inside a speaker segment. Test containment
    // instead, and if the point falls in more than one segment (segments
    // touching exactly at that boundary), prefer the shorter one as the more
    // specific match.
    speakers
        .iter()
        .filter(|s| s.start <= start && start <= s.end)
        .min_by(|a, b| (a.end - a.start).total_cmp(&(b.end - b.start)))
        .map(|s| s.speaker)
}

fn overlap(a_start: f32, a_end: f32, b_start: f32, b_end: f32) -> f32 {
    (a_end.min(b_end) - a_start.max(b_start)).max(0.0)
}

fn resolve_segmentation_model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    Ok(resource_dir.join("resources/models/diarization/segmentation.onnx"))
}

fn resolve_embedding_model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    Ok(resource_dir.join("resources/models/diarization/embedding.onnx"))
}

/// Diarizes a finished recording and returns, for each `chunks` interval, the
/// speaker it overlaps most (or `null` if none). One entry per input chunk, in
/// the same order, so the frontend can zip the result directly onto the
/// transcript segments it built from the same recording.
///
/// `chunks` must be on the recording's own timeline (seconds from its start),
/// matching what `transcribe_recording` returns and *before* the frontend
/// rebases them onto the session's global timeline
/// (`transcript::segmentsFromResult`) -- diarization runs on that same 0-based
/// WAV file, so mixing timelines here would silently misassign every speaker.
#[tauri::command]
pub async fn diarize_recording(
    app: AppHandle,
    path: String,
    chunks: Vec<(f32, f32)>,
    threshold: f32,
    num_speakers: i32,
    min_duration_on: f32,
    min_duration_off: f32,
) -> Result<Vec<Option<i32>>, String> {
    let cancel = crate::cancel::flag(&app);

    tauri::async_runtime::spawn_blocking(move || {
        crate::cancel::check(&cancel)?;
        let samples = crate::wav::read(std::path::Path::new(&path))?;
        let segmentation_model = resolve_segmentation_model_path(&app)?;
        let embedding_model = resolve_embedding_model_path(&app)?;
        crate::cancel::check(&cancel)?;

        let settings = DiarizeSettings {
            enabled: true,
            threshold,
            num_speakers,
            min_duration_on,
            min_duration_off,
        };
        let speakers = diarize(
            &samples,
            &settings,
            &segmentation_model.display().to_string(),
            &embedding_model.display().to_string(),
        )?;
        // The only cancellation point diarization has after it starts.
        // `diarize` is one opaque `OfflineSpeakerDiarization::process` call --
        // sherpa-onnx's C API has a progress-callback variant of it, but the
        // 1.13.5 Rust binding does not expose one, so there is nowhere to poll
        // from inside. Cancelling therefore lets the pass run to completion
        // and throws the result away; if a `process_with_callback` binding
        // ever lands, this is the check that becomes a real interrupt.
        crate::cancel::check(&cancel)?;

        Ok(assign_speakers(&chunks, &speakers))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start: f32, end: f32, speaker: i32) -> SpeakerSegment {
        SpeakerSegment { start, end, speaker }
    }

    #[test]
    fn assigns_a_chunk_wholly_inside_one_speaker_segment() {
        let speakers = [seg(0.0, 10.0, 0), seg(10.0, 20.0, 1)];
        let out = assign_speakers(&[(2.0, 5.0)], &speakers);
        assert_eq!(out, vec![Some(0)]);
    }

    #[test]
    fn picks_the_speaker_with_more_overlap_when_a_chunk_straddles_a_boundary() {
        // Chunk 8-13 overlaps speaker 0 for 2s (8-10) and speaker 1 for 3s (10-13).
        let speakers = [seg(0.0, 10.0, 0), seg(10.0, 20.0, 1)];
        let out = assign_speakers(&[(8.0, 13.0)], &speakers);
        assert_eq!(out, vec![Some(1)]);
    }

    #[test]
    fn returns_none_when_there_are_no_speaker_segments() {
        // Diarization disabled, or it found nothing on this recording at all.
        let out = assign_speakers(&[(0.0, 5.0), (5.0, 10.0)], &[]);
        assert_eq!(out, vec![None, None]);
    }

    #[test]
    fn returns_none_for_a_chunk_that_overlaps_nothing() {
        // A gap between two speaker segments -- e.g. diarization dropped a
        // stretch as too short to be a turn, but whisper still transcribed it.
        let speakers = [seg(0.0, 5.0, 0), seg(15.0, 20.0, 1)];
        let out = assign_speakers(&[(8.0, 10.0)], &speakers);
        assert_eq!(out, vec![None]);
    }

    #[test]
    fn assigns_a_zero_length_chunk_by_containment() {
        let speakers = [seg(0.0, 10.0, 0), seg(10.0, 20.0, 1)];
        assert_eq!(assign_speakers(&[(4.0, 4.0)], &speakers), vec![Some(0)]);
        // Outside every segment.
        assert_eq!(assign_speakers(&[(25.0, 25.0)], &speakers), vec![None]);
    }

    #[test]
    fn a_zero_length_chunk_at_a_shared_boundary_prefers_the_shorter_segment() {
        // t=10 sits in both [0,10] and [10,20]; pick the more specific (here,
        // tied length, so the first via stable min_by) rather than panicking or
        // silently picking whichever the iterator order happens to favor.
        let speakers = [seg(0.0, 10.0, 0), seg(10.0, 12.0, 1)];
        assert_eq!(assign_speakers(&[(10.0, 10.0)], &speakers), vec![Some(1)]);
    }

    #[test]
    fn touching_but_non_overlapping_intervals_score_zero_not_negative() {
        // Adjacent segments (end of one == start of the next): a chunk that
        // exactly spans the boundary should not be treated as overlapping either
        // by a hair via floating point error.
        let speakers = [seg(0.0, 5.0, 0)];
        let out = assign_speakers(&[(5.0, 8.0)], &speakers);
        assert_eq!(out, vec![None]);
    }

    #[test]
    fn handles_an_empty_chunk_list() {
        assert_eq!(assign_speakers(&[], &[seg(0.0, 5.0, 0)]), Vec::<Option<i32>>::new());
    }

    #[test]
    fn default_settings_favor_auto_speaker_count_and_are_disabled_by_default() {
        let settings = DiarizeSettings::default();
        assert!(!settings.enabled);
        assert_eq!(settings.num_speakers, -1);
    }
}
