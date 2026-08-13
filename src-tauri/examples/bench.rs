//! Encoder-cost benchmark for the whisper.cpp backend.
//!
//! Run with: cargo run --release --example bench
//!
//! Measures `pcm_to_mel` + `encode` only. The encoder always processes the full
//! 30s / 1500-frame audio context regardless of input, so this cost is fixed and
//! independent of both audio content and decoder behaviour (no hallucination or
//! temperature-fallback noise). It is the hard floor for how fast one streaming
//! window can possibly be transcribed.

use std::time::Instant;
use whisper_rs::{WhisperContext, WhisperContextParameters};

const SAMPLE_RATE: usize = 16000;
/// Kept in step with `WINDOW_SEC` in `src/lib/asr/streaming.ts`, so the number
/// this prints is the cost of one real streaming window.
const WINDOW_SEC: usize = 15;

fn main() {
    let model_path = "resources/models/whisper-large-v3-turbo/model.gguf";
    eprintln!("loading {model_path}");
    let load_start = Instant::now();
    let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
        .expect("failed to load model");
    let load_secs = load_start.elapsed().as_secs_f32();

    let audio = vec![0.0f32; SAMPLE_RATE * WINDOW_SEC];

    let logical = std::thread::available_parallelism().map(|v| v.get()).unwrap_or(4);

    println!("### encoder-only benchmark");
    println!("model load: {load_secs:.2}s");
    println!("available_parallelism() = {logical}");
    println!();
    println!("{:<10} {:>10} {:>12} {:>12}", "threads", "mel", "encode", "total");
    println!("{}", "-".repeat(48));

    for &threads in &[logical, 12, 8, 6, 4] {
        let mut state = ctx.create_state().expect("failed to create state");

        let t0 = Instant::now();
        state.pcm_to_mel(&audio, threads).expect("pcm_to_mel failed");
        let mel = t0.elapsed().as_secs_f32();

        let t1 = Instant::now();
        state.encode(0, threads).expect("encode failed");
        let enc = t1.elapsed().as_secs_f32();

        println!(
            "{:<10} {:>9.2}s {:>11.2}s {:>11.2}s",
            threads,
            mel,
            enc,
            mel + enc
        );
    }

    println!();
    println!("Encoder is a fixed cost per {WINDOW_SEC}s window; decoding happens on top.");
    println!("If total approaches or exceeds {WINDOW_SEC}s, live streaming cannot keep up.");
}
