//! Counts how many whisper tokens a piece of text costs.
//!
//! ```text
//! scripts\win-build-env.bat cargo run --release --example tokens -- "議事録 稟議 与信"
//! ```
//!
//! Useful when writing a glossary for `initial_prompt`, which is capped at
//! `min(n_max_text_ctx, n_text_ctx / 2)` tokens -- 224 for large-v3-turbo, whose
//! n_text_ctx is 448. Anything past that is silently dropped, and Japanese
//! tokenises far less efficiently than English, so the budget is easy to blow
//! without noticing.

use whisper_rs::{WhisperContext, WhisperContextParameters};

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let model = std::env::var("WHISPER_MODEL")
        .unwrap_or_else(|_| "resources/models/whisper-large-v3-turbo/model.gguf".to_string());

    let ctx = WhisperContext::new_with_params(&model, WhisperContextParameters::default())
        .map_err(|e| format!("failed to load {model}: {e}"))?;

    let budget = ctx.n_text_ctx() / 2;
    println!("n_text_ctx = {}, prompt budget = {budget} tokens\n", ctx.n_text_ctx());

    let samples: Vec<String> = if args.is_empty() {
        vec![
            "議事録".into(),
            "稟議書".into(),
            "与信管理".into(),
            "四半期決算".into(),
            "アジェンダ".into(),
            "以下は日本語の会議の音声です。".into(),
            "固有名詞: 東京海上日動、三菱UFJ、リクルートホールディングス".into(),
        ]
    } else {
        args
    };

    println!("{:>7}  {:>6}  {}", "tokens", "chars", "text");
    println!("{}", "-".repeat(60));
    let mut total = 0;
    for s in &samples {
        let tokens = ctx.tokenize(s, 512).map_err(|e| e.to_string())?;
        total += tokens.len();
        println!(
            "{:>7}  {:>6}  {}",
            tokens.len(),
            s.chars().count(),
            s
        );
    }
    println!("{}", "-".repeat(60));
    println!("{total:>7} tokens total ({} of the {budget}-token budget)", total);

    Ok(())
}
