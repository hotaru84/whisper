//! One-off verification tool: runs the exact pipeline `asr::transcribe_recording`
//! runs (DTW-safe timeline selection, cue sanitization, voiced-gap re-decode,
//! silence marking, structural quality metrics) plus diarization, against a
//! saved WAV -- without going through Tauri -- so the result can be diffed
//! against an existing history sidecar JSON from before this pipeline changed.
//!
//! Not wired into any npm/cargo script; run directly via the build wrapper
//! from `src-tauri/`:
//!
//! ```text
//! scripts\win-build-env.bat cargo run --release --example reanalyze -- <wav-path> [--json <path>]
//! ```

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use whisper_rs::{DtwMode, DtwModelPreset, DtwParameters, WhisperContext, WhisperContextParameters};
use whisper_scribe_lib::asr::{build_full_params, collect_segments, mark_silent_segments, redecode_voiced_gaps, DecodeSettings};
use whisper_scribe_lib::diarize::{self, DiarizeSettings};
use whisper_scribe_lib::wav::{self, SAMPLE_RATE};

fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

fn json_escape(s: &str) -> String {
    s.chars()
        .flat_map(|c| match c {
            '"' => "\\\"".chars().collect::<Vec<_>>(),
            '\\' => "\\\\".chars().collect(),
            '\n' => "\\n".chars().collect(),
            c => vec![c],
        })
        .collect()
}

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let mut wav_path: Option<PathBuf> = None;
    let mut json_out: Option<PathBuf> = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--json" => json_out = Some(PathBuf::from(args.next().ok_or("--json requires a value")?)),
            other => wav_path = Some(PathBuf::from(other)),
        }
    }
    let wav_path = wav_path.ok_or("usage: reanalyze <wav-path> [--json <path>]")?;

    let model_path = PathBuf::from("resources/models/whisper-large-v3-turbo/model.gguf");
    let vad_model_path = PathBuf::from("resources/models/vad/ggml-silero-v5.1.2.bin");
    let segmentation_model = PathBuf::from("resources/models/diarization/segmentation.onnx");
    let embedding_model = PathBuf::from("resources/models/diarization/embedding.onnx");

    let samples = wav::read(&wav_path)?;
    let duration_sec = samples.len() as f32 / SAMPLE_RATE as f32;
    println!("wav          : {} ({:.2}s, {} samples)", wav_path.display(), duration_sec, samples.len());

    // Mirrors asr::init_model exactly: DTW enabled with the large-v3-turbo preset.
    let mut ctx_params = WhisperContextParameters::default();
    ctx_params.dtw_parameters(DtwParameters {
        mode: DtwMode::ModelPreset { model_preset: DtwModelPreset::LargeV3Turbo },
        ..DtwParameters::default()
    });
    let ctx = WhisperContext::new_with_params(&model_path.display().to_string(), ctx_params)
        .map_err(|e| format!("failed to load {}: {e}", model_path.display()))?;

    let vad_active = vad_model_path.exists();
    println!("vad          : {}", if vad_active { "enabled" } else { "unavailable (model file missing)" });

    let settings = DecodeSettings {
        language: Some("ja".to_string()),
        vad_model_path: if vad_active { Some(vad_model_path.display().to_string()) } else { None },
        ..DecodeSettings::default()
    };

    let started = Instant::now();
    let mut state = ctx.create_state().map_err(|e| e.to_string())?;
    let params = build_full_params(&settings);
    state.full(params, &samples).map_err(|e| e.to_string())?;

    let mut result = collect_segments(&state, vad_active)?;
    let cancel: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
    result.chunks = redecode_voiced_gaps(&ctx, &settings, vad_active, &cancel, result.chunks, &samples)?;
    result.text = result.chunks.iter().map(|c| c.text.as_str()).collect();

    let (mut result, silence) = mark_silent_segments(result, &samples);
    result.silence = silence;
    result.quality = whisper_scribe_lib::cues::analyze(&result.chunks, duration_sec, &samples);
    let elapsed_sec = started.elapsed().as_secs_f32();

    println!("elapsed      : {elapsed_sec:.2}s ({:.2}x realtime)", elapsed_sec / duration_sec.max(f32::EPSILON));
    println!("chars        : {}", result.text.chars().count());
    println!("chunks       : {}", result.chunks.len());
    println!(
        "quality      : zero_len={} reordered={} tail_gap={:.2}s gap_total={:.2}s voiced_gap={:.2}s",
        result.quality.zero_length_cues,
        result.quality.out_of_order_pairs,
        result.quality.tail_gap_sec,
        result.quality.gap_total_sec,
        result.quality.voiced_gap_sec,
    );
    let silent_count = result.silence.iter().filter(|m| m.silent).count();
    println!("silence      : {silent_count} of {} chunks flagged", result.silence.len());

    let speakers = if segmentation_model.exists() && embedding_model.exists() {
        let diarize_settings = DiarizeSettings { enabled: true, ..DiarizeSettings::default() };
        let segs = diarize::diarize(
            &samples,
            &diarize_settings,
            &segmentation_model.display().to_string(),
            &embedding_model.display().to_string(),
        )?;
        let targets: Vec<(f32, f32)> = result.chunks.iter().map(|c| c.timestamp).collect();
        let assigned = diarize::assign_speakers(&targets, &segs);
        println!("diarization  : {} speaker segments", segs.len());
        Some(assigned)
    } else {
        println!("diarization  : unavailable (model files missing)");
        None
    };

    println!();
    for (i, c) in result.chunks.iter().enumerate() {
        let mark = &result.silence[i];
        let speaker = speakers.as_ref().and_then(|s| s[i]);
        let flags = match (mark.silent, speaker) {
            (true, _) => " [SILENT]".to_string(),
            (false, Some(sp)) => format!(" [spk{sp}]"),
            (false, None) => String::new(),
        };
        println!("[{:7.2}-{:7.2}]{flags} {}", c.timestamp.0, c.timestamp.1, c.text);
    }

    if let Some(json_path) = json_out {
        let mut s = String::from("{\n");
        s.push_str(&format!("  \"durationSec\": {duration_sec:.3},\n"));
        s.push_str(&format!("  \"text\": \"{}\",\n", json_escape(&result.text)));
        s.push_str(&format!(
            "  \"quality\": {{ \"zeroLengthCues\": {}, \"outOfOrderPairs\": {}, \"tailGapSec\": {:.3}, \"gapTotalSec\": {:.3}, \"voicedGapSec\": {:.3} }},\n",
            result.quality.zero_length_cues,
            result.quality.out_of_order_pairs,
            result.quality.tail_gap_sec,
            result.quality.gap_total_sec,
            result.quality.voiced_gap_sec,
        ));
        s.push_str("  \"chunks\": [\n");
        for (i, c) in result.chunks.iter().enumerate() {
            let mark = &result.silence[i];
            let speaker = speakers.as_ref().and_then(|s| s[i]);
            s.push_str(&format!(
                "    {{ \"start\": {:.3}, \"end\": {:.3}, \"silent\": {}, \"speaker\": {}, \"text\": \"{}\" }}{}\n",
                c.timestamp.0,
                c.timestamp.1,
                mark.silent,
                speaker.map(|s| s.to_string()).unwrap_or_else(|| "null".to_string()),
                json_escape(&c.text),
                if i + 1 == result.chunks.len() { "" } else { "," }
            ));
        }
        s.push_str("  ]\n}\n");
        std::fs::write(&json_path, s).map_err(|e| format!("{}: {e}", json_path.display()))?;
        println!("\nwrote {}", json_path.display());
    }

    Ok(())
}
