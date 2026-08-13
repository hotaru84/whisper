//! Accuracy harness: measures character error rate (CER) on a fixture set.
//!
//! Run from `src-tauri/` via the build wrapper:
//!
//! ```text
//! scripts\win-build-env.bat cargo run --release --example cer
//! ```
//!
//! Why CER and not WER: Japanese has no word boundaries, so word error rate is
//! meaningless without a tokenizer whose own mistakes would pollute the metric.
//! CER is edit distance over characters, divided by the reference length.
//!
//! Decoding goes through `whisper_scribe_lib::asr::{DecodeSettings,
//! build_full_params, collect_segments}` -- the same code the Tauri command uses
//! -- so a number measured here reflects what the app actually produces.
//!
//! Fixtures live in `fixtures/` as pairs: `<name>.wav` (16 kHz mono) plus
//! `<name>.txt` (the reference transcript, UTF-8). They are gitignored.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Instant;

use whisper_rs::{WhisperContext, WhisperContextParameters};
use whisper_scribe_lib::asr::{build_full_params, collect_segments, DecodeSettings};
use whisper_scribe_lib::cer::score;
use whisper_scribe_lib::wav::{self, SAMPLE_RATE};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

struct Args {
    fixtures: PathBuf,
    model: PathBuf,
    keep_punct: bool,
    json: Option<PathBuf>,
    settings: DecodeSettings,
}

fn parse_bool(v: &str) -> Result<bool, String> {
    match v {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        other => Err(format!("expected a boolean, got {other:?}")),
    }
}

const USAGE: &str = "\
Usage: cargo run --release --example cer [options]

  --fixtures <dir>        fixture directory        (default: fixtures)
  --model <path>          model file               (default: resources/models/whisper-large-v3-turbo/model.gguf)
  --language <code>       ISO 639-1, or 'auto'     (default: ja)
  --beam <n>              beam size                (default: 5)
  --entropy-thold <f>     repetition guard         (default: 2.8)
  --suppress-nst <bool>   drop non-speech tokens   (default: false)
  --threads <n>           CPU thread cap
  --prompt <text>         glossary fed as initial_prompt (~224 token budget)
  --prompt-file <path>    same, read from a file
  --vad-model <path>      Silero VAD ggml model; filters non-speech before decoding
  --vad-threshold <f>     VAD speech probability threshold (default: 0.5)
  --keep-punct            compare punctuation instead of stripping it
  --json <path>           also write results as JSON
  -h, --help

Every decode option overrides the app default for this run only, so an A/B can
be measured without editing source or rebuilding.";

fn parse_args() -> Result<Args, String> {
    let mut args = Args {
        fixtures: PathBuf::from("fixtures"),
        model: PathBuf::from("resources/models/whisper-large-v3-turbo/model.gguf"),
        keep_punct: false,
        json: None,
        settings: DecodeSettings::default(),
    };

    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut value = || {
            it.next()
                .ok_or_else(|| format!("{arg} requires a value"))
        };
        match arg.as_str() {
            "-h" | "--help" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            "--fixtures" => args.fixtures = PathBuf::from(value()?),
            "--model" => args.model = PathBuf::from(value()?),
            "--json" => args.json = Some(PathBuf::from(value()?)),
            "--keep-punct" => args.keep_punct = true,
            "--language" => {
                let v = value()?;
                args.settings.language = if v == "auto" { None } else { Some(v) };
            }
            "--beam" => args.settings.beam_size = value()?.parse().map_err(|e| format!("{e}"))?,
            "--entropy-thold" => {
                args.settings.entropy_thold = value()?.parse().map_err(|e| format!("{e}"))?
            }
            "--suppress-nst" => args.settings.suppress_nst = parse_bool(&value()?)?,
            "--prompt" => args.settings.prompt = Some(value()?),
            "--prompt-file" => {
                let path = value()?;
                args.settings.prompt =
                    Some(std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?);
            }
            "--threads" => args.settings.n_threads = value()?.parse().map_err(|e| format!("{e}"))?,
            "--vad-model" => args.settings.vad_model_path = Some(value()?),
            "--vad-threshold" => {
                args.settings.vad_threshold = value()?.parse().map_err(|e| format!("{e}"))?
            }
            other => return Err(format!("unknown option {other:?}\n\n{USAGE}")),
        }
    }
    Ok(args)
}

// ---------------------------------------------------------------------------

struct Outcome {
    name: String,
    ref_len: usize,
    hyp_len: usize,
    distance: usize,
    audio_sec: f32,
    elapsed_sec: f32,
    hypothesis: String,
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn main() {
    // Print the message rather than returning Err from main, which would Debug-
    // format it and turn every embedded newline into a literal \n.
    if let Err(message) = run() {
        eprintln!("{message}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = parse_args()?;

    // Pair up <name>.wav with <name>.txt. BTreeMap keeps the report order stable
    // between runs so two outputs can be diffed directly.
    let mut pairs: BTreeMap<String, (Option<PathBuf>, Option<PathBuf>)> = BTreeMap::new();
    let entries = std::fs::read_dir(&args.fixtures).map_err(|e| {
        format!(
            "cannot read fixture directory {}: {e}\n\n\
             Create it and add pairs of <name>.wav (16 kHz mono) and <name>.txt\n\
             (the reference transcript). For meeting-style material, 3-5 minute\n\
             recordings work well: one clean, one with background noise or several\n\
             speakers, one dense with proper nouns and jargon.",
            args.fixtures.display()
        )
    })?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else {
            continue;
        };
        match path.extension().and_then(|s| s.to_str()) {
            Some("wav") => pairs.entry(stem).or_default().0 = Some(path),
            Some("txt") => pairs.entry(stem).or_default().1 = Some(path),
            _ => {}
        }
    }

    let fixtures: Vec<(String, PathBuf, PathBuf)> = pairs
        .into_iter()
        .filter_map(|(name, (wav, txt))| match (wav, txt) {
            (Some(w), Some(t)) => Some((name, w, t)),
            (Some(_), None) => {
                eprintln!("skipping {name}: no matching .txt reference");
                None
            }
            (None, Some(_)) => {
                eprintln!("skipping {name}: no matching .wav audio");
                None
            }
            _ => None,
        })
        .collect();

    if fixtures.is_empty() {
        return Err(format!(
            "no fixture pairs found in {}. Each fixture is a <name>.wav plus a\n\
             <name>.txt holding its reference transcript.",
            args.fixtures.display()
        ));
    }

    println!("model        : {}", args.model.display());
    println!(
        "settings     : language={:?} beam={} entropy_thold={} suppress_nst={} threads={}",
        args.settings.language.as_deref().unwrap_or("auto"),
        args.settings.beam_size,
        args.settings.entropy_thold,
        args.settings.suppress_nst,
        args.settings.n_threads,
    );
    println!(
        "normalisation: whitespace stripped, full-width folded, punctuation {}",
        if args.keep_punct { "kept" } else { "stripped" }
    );
    match args.settings.prompt.as_deref() {
        Some(p) => println!("prompt       : {} chars — {:?}", p.chars().count(), p),
        None => println!("prompt       : (none)"),
    }
    match args.settings.vad_model_path.as_deref() {
        Some(p) => println!("vad          : {p} (threshold={})", args.settings.vad_threshold),
        None => println!("vad          : (disabled)"),
    }
    println!();

    let ctx = WhisperContext::new_with_params(&args.model, WhisperContextParameters::default())
        .map_err(|e| format!("failed to load {}: {e}", args.model.display()))?;

    let mut outcomes = Vec::new();
    for (name, wav_path, txt) in &fixtures {
        let audio = wav::read(wav_path)?;
        let reference = std::fs::read_to_string(txt).map_err(|e| format!("{}: {e}", txt.display()))?;

        let started = Instant::now();
        let mut state = ctx.create_state().map_err(|e| e.to_string())?;
        let params = build_full_params(&args.settings);
        state.full(params, &audio).map_err(|e| e.to_string())?;
        let result = collect_segments(&state)?;
        let elapsed_sec = started.elapsed().as_secs_f32();

        let (distance, ref_len, hyp_len) = score(&reference, &result.text, args.keep_punct);

        outcomes.push(Outcome {
            name: name.clone(),
            ref_len,
            hyp_len,
            distance,
            audio_sec: audio.len() as f32 / SAMPLE_RATE as f32,
            elapsed_sec,
            hypothesis: result.text,
        });
    }

    println!(
        "{:<28} {:>7} {:>7} {:>7} {:>9} {:>8}",
        "fixture", "ref", "hyp", "errors", "CER", "RTF"
    );
    println!("{}", "-".repeat(72));
    for o in &outcomes {
        let cer = if o.ref_len == 0 {
            f64::NAN
        } else {
            o.distance as f64 / o.ref_len as f64 * 100.0
        };
        println!(
            "{:<28} {:>7} {:>7} {:>7} {:>8.2}% {:>8.3}",
            o.name,
            o.ref_len,
            o.hyp_len,
            o.distance,
            cer,
            o.elapsed_sec / o.audio_sec.max(f32::EPSILON),
        );
    }

    // Micro-average: total errors over total reference characters. A mean of the
    // per-fixture rates would let a short fixture outweigh a long one.
    let total_ref: usize = outcomes.iter().map(|o| o.ref_len).sum();
    let total_err: usize = outcomes.iter().map(|o| o.distance).sum();
    let total_cer = if total_ref == 0 {
        f64::NAN
    } else {
        total_err as f64 / total_ref as f64 * 100.0
    };
    println!("{}", "-".repeat(72));
    println!(
        "{:<28} {:>7} {:>7} {:>7} {:>8.2}%",
        "TOTAL (micro-average)",
        total_ref,
        outcomes.iter().map(|o| o.hyp_len).sum::<usize>(),
        total_err,
        total_cer
    );

    if let Some(json_path) = &args.json {
        let mut s = String::from("{\n");
        s.push_str(&format!("  \"model\": \"{}\",\n", json_escape(&args.model.display().to_string())));
        s.push_str(&format!(
            "  \"settings\": {{ \"language\": \"{}\", \"beam_size\": {}, \"entropy_thold\": {}, \"suppress_nst\": {}, \"n_threads\": {} }},\n",
            json_escape(args.settings.language.as_deref().unwrap_or("auto")),
            args.settings.beam_size,
            args.settings.entropy_thold,
            args.settings.suppress_nst,
            args.settings.n_threads
        ));
        s.push_str(&format!("  \"keep_punct\": {},\n", args.keep_punct));
        s.push_str(&format!("  \"total_cer_percent\": {total_cer:.4},\n"));
        s.push_str("  \"fixtures\": [\n");
        for (i, o) in outcomes.iter().enumerate() {
            let cer = if o.ref_len == 0 {
                0.0
            } else {
                o.distance as f64 / o.ref_len as f64 * 100.0
            };
            s.push_str(&format!(
                "    {{ \"name\": \"{}\", \"ref_len\": {}, \"hyp_len\": {}, \"errors\": {}, \"cer_percent\": {:.4}, \"audio_sec\": {:.2}, \"elapsed_sec\": {:.2}, \"hypothesis\": \"{}\" }}{}\n",
                json_escape(&o.name),
                o.ref_len,
                o.hyp_len,
                o.distance,
                cer,
                o.audio_sec,
                o.elapsed_sec,
                json_escape(&o.hypothesis),
                if i + 1 == outcomes.len() { "" } else { "," }
            ));
        }
        s.push_str("  ]\n}\n");
        std::fs::write(json_path, s).map_err(|e| format!("{}: {e}", json_path.display()))?;
        println!("\nwrote {}", json_path.display());
    }

    Ok(())
}
