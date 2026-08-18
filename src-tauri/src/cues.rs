//! Reference-free structural quality metrics for a transcription result.
//!
//! These catch *structural* damage -- speech that never made it into a cue, or
//! cues whose timestamps have come apart from the audio -- without needing a
//! reference transcript. They cannot tell a correct word from a wrong one: a
//! hypothesis with perfect timing and completely wrong vocabulary would still
//! score cleanly here. Treat this as a regression gate on decode-setting
//! changes (did this change lose or reorder audio?), not as an accuracy score.
//!
//! Kept model- and I/O-free on purpose: everything here operates on
//! [`TranscribeChunk`] and raw samples, so `cargo test --lib` exercises it
//! against synthetic data without loading whisper.cpp. `asr::collect_segments`
//! and `examples/cer.rs` both feed this the same way, so the app and the
//! accuracy harness can never silently disagree about these numbers.

use serde::Serialize;

use crate::asr::{rms, TranscribeChunk, SILENCE_RMS};

/// A cue's duration below this is treated as a collapsed-bounds artefact
/// rather than a genuine (if very short) utterance -- no whisper token is
/// this brief.
const ZERO_LENGTH_THRESHOLD_SEC: f32 = 0.01;

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityReport {
    /// Cues whose span is under [`ZERO_LENGTH_THRESHOLD_SEC`]. Whisper never
    /// legitimately produces one; a nonzero count means whisper itself
    /// reported a collapsed segment envelope (`start_timestamp() ==
    /// end_timestamp()`, or close to it) -- `asr::sanitize_bounds` only
    /// normalises a negative start, it does not invent a span whisper never
    /// claimed.
    pub zero_length_cues: usize,
    /// Adjacent cues where the later one's end time is earlier than the
    /// former's. Cue order should track audio order monotonically; this
    /// catches accumulated timeline drift in one comparison rather than
    /// needing to reconstruct a whole timeline to notice it.
    pub out_of_order_pairs: usize,
    /// Seconds of audio after the last cue's end. A whole-recording decode
    /// that stops early (whisper.cpp's single-timestamp-ending seek jump, or
    /// a no-speech-gated chunk right at the end) leaves this positive.
    pub tail_gap_sec: f32,
    /// Total seconds sitting in the gaps between cues, whatever they hold.
    pub gap_total_sec: f32,
    /// The portion of `gap_total_sec` whose underlying audio is not silence
    /// by the same RMS test the app already uses to drop silent segments.
    /// This is the direct measure of audio that should have produced a cue
    /// and did not -- gaps over genuinely silent audio are gaps working as
    /// intended, and are excluded.
    pub voiced_gap_sec: f32,
}

/// Computes a [`QualityReport`] for one transcription result.
///
/// `chunks` is taken in the order the decoder produced it, not re-sorted --
/// `out_of_order_pairs` exists specifically to notice when that order stops
/// tracking time. `samples` is the same mono 16kHz f32 PCM the chunks were
/// decoded from, needed only for `voiced_gap_sec`'s RMS check.
pub fn analyze(chunks: &[TranscribeChunk], duration_sec: f32, samples: &[f32]) -> QualityReport {
    let zero_length_cues = chunks
        .iter()
        .filter(|c| (c.timestamp.1 - c.timestamp.0) < ZERO_LENGTH_THRESHOLD_SEC)
        .count();

    let out_of_order_pairs = chunks
        .windows(2)
        .filter(|pair| pair[1].timestamp.1 < pair[0].timestamp.1)
        .count();

    let last_end = chunks.last().map(|c| c.timestamp.1).unwrap_or(0.0);
    let tail_gap_sec = (duration_sec - last_end).max(0.0);

    let sr = crate::wav::SAMPLE_RATE as f32;
    let mut gap_total_sec = 0.0f32;
    let mut voiced_gap_sec = 0.0f32;
    for pair in chunks.windows(2) {
        let gap = pair[1].timestamp.0 - pair[0].timestamp.1;
        if gap <= 0.0 {
            continue;
        }
        gap_total_sec += gap;

        let from = (pair[0].timestamp.1 * sr).max(0.0) as usize;
        let to = ((pair[1].timestamp.0 * sr) as usize).min(samples.len());
        if from < to && rms(&samples[from..to]) >= SILENCE_RMS {
            voiced_gap_sec += gap;
        }
    }

    QualityReport { zero_length_cues, out_of_order_pairs, tail_gap_sec, gap_total_sec, voiced_gap_sec }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(start: f32, end: f32) -> TranscribeChunk {
        TranscribeChunk { text: "x".to_string(), timestamp: (start, end) }
    }

    fn tone(len: usize, amplitude: f32) -> Vec<f32> {
        vec![amplitude; len]
    }

    #[test]
    fn empty_result_reports_the_whole_recording_as_tail_gap() {
        let report = analyze(&[], 10.0, &[]);
        assert_eq!(report, QualityReport { tail_gap_sec: 10.0, ..Default::default() });
    }

    #[test]
    fn back_to_back_cues_report_no_gaps_or_tail() {
        let sr = crate::wav::SAMPLE_RATE as usize;
        let chunks = vec![chunk(0.0, 1.0), chunk(1.0, 2.0)];
        let samples = tone(sr * 2, 0.5);
        let report = analyze(&chunks, 2.0, &samples);
        assert_eq!(report.tail_gap_sec, 0.0);
        assert_eq!(report.gap_total_sec, 0.0);
        assert_eq!(report.voiced_gap_sec, 0.0);
    }

    #[test]
    fn zero_length_cue_is_counted() {
        let chunks = vec![chunk(1.0, 1.005), chunk(2.0, 3.0)];
        let report = analyze(&chunks, 5.0, &[]);
        assert_eq!(report.zero_length_cues, 1);
    }

    #[test]
    fn a_short_span_just_above_the_threshold_is_not_zero_length() {
        let chunks = vec![chunk(1.0, 1.02)];
        let report = analyze(&chunks, 5.0, &[]);
        assert_eq!(report.zero_length_cues, 0);
    }

    #[test]
    fn later_cue_ending_before_an_earlier_one_is_out_of_order() {
        let chunks = vec![chunk(0.0, 5.0), chunk(5.0, 3.0)];
        let report = analyze(&chunks, 10.0, &[]);
        assert_eq!(report.out_of_order_pairs, 1);
    }

    #[test]
    fn a_silent_gap_does_not_count_toward_voiced_gap_sec() {
        let sr = crate::wav::SAMPLE_RATE as usize;
        // 1s speech, 2s silence, 1s speech: the silent middle should not be
        // reported as lost audio.
        let mut samples = tone(sr, 0.5);
        samples.extend(tone(sr * 2, 0.0));
        samples.extend(tone(sr, 0.5));
        let chunks = vec![chunk(0.0, 1.0), chunk(3.0, 4.0)];
        let report = analyze(&chunks, 4.0, &samples);
        assert_eq!(report.gap_total_sec, 2.0);
        assert_eq!(report.voiced_gap_sec, 0.0);
    }

    #[test]
    fn a_voiced_gap_is_reported_as_lost_audio() {
        let sr = crate::wav::SAMPLE_RATE as usize;
        // Continuous speech-level audio, but the decoder produced two cues
        // with a gap between them -- exactly the shape of a dropped chunk.
        let samples = tone(sr * 4, 0.5);
        let chunks = vec![chunk(0.0, 1.0), chunk(3.0, 4.0)];
        let report = analyze(&chunks, 4.0, &samples);
        assert_eq!(report.gap_total_sec, 2.0);
        assert_eq!(report.voiced_gap_sec, 2.0);
    }

    #[test]
    fn overlapping_cues_contribute_no_negative_gap() {
        let chunks = vec![chunk(0.0, 2.0), chunk(1.0, 3.0)];
        let report = analyze(&chunks, 3.0, &[]);
        assert_eq!(report.gap_total_sec, 0.0);
        assert_eq!(report.voiced_gap_sec, 0.0);
    }
}
