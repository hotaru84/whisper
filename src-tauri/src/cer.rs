//! Character error rate, the accuracy metric for Japanese transcription.
//!
//! Word error rate needs word boundaries, which Japanese does not mark. Running a
//! tokenizer to invent them would fold the tokenizer's own mistakes into the
//! score, so this measures edit distance over characters instead.
//!
//! Lives in the library rather than in `examples/cer.rs` so the metric itself is
//! covered by `cargo test`. A silently wrong distance or normalisation would make
//! every measurement built on top of it meaningless.

/// Punctuation removed before comparison unless punctuation is being scored.
///
/// Whisper's punctuation is stylistic and unstable between runs, so leaving it in
/// drowns out real mis-recognitions. Note what is deliberately absent: `ー`
/// (chōonpu) and `々` are lexical characters, not punctuation -- stripping them
/// would corrupt ordinary words like ラーメン and 人々.
const PUNCT: &[char] = &[
    '、', '。', '，', '．', ',', '.', '!', '?', '！', '？', '「', '」', '『', '』', '（', '）',
    '(', ')', '〔', '〕', '[', ']', '{', '}', '《', '》', '〈', '〉', '…', '‥', '・', ':', '：',
    ';', '；', '"', '\'', '“', '”', '‘', '’', '―', '—', '－', '~', '〜', '♪',
];

/// Normalises text for comparison.
///
/// Always: drops whitespace (Japanese output has essentially none, and where it
/// appears it is an artefact), and folds full-width ASCII to half-width so
/// "ＡＢＣ１２３" and "ABC123" are not counted as errors against each other.
/// Optionally keeps punctuation.
pub fn normalize(text: &str, keep_punct: bool) -> Vec<char> {
    text.chars()
        .filter(|c| !c.is_whitespace() && *c != '\u{3000}')
        .map(|c| {
            if ('\u{FF01}'..='\u{FF5E}').contains(&c) {
                char::from_u32(c as u32 - 0xFEE0).unwrap_or(c)
            } else {
                c
            }
        })
        .filter(|c| keep_punct || !PUNCT.contains(c))
        .collect()
}

/// Levenshtein distance over characters, two-row DP.
///
/// A full matrix is O(n*m) memory, which for two 5000-character meeting
/// transcripts is ~100 MB; only the previous row is ever needed.
pub fn edit_distance(a: &[char], b: &[char]) -> usize {
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }

    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];

    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let substitution = prev[j] + usize::from(ca != cb);
            let deletion = prev[j + 1] + 1;
            let insertion = cur[j] + 1;
            cur[j + 1] = substitution.min(deletion).min(insertion);
        }
        std::mem::swap(&mut prev, &mut cur);
    }

    prev[b.len()]
}

/// Errors and reference length for one hypothesis/reference pair.
///
/// Returns the raw counts rather than a ratio so a fixture set can be
/// micro-averaged (total errors over total reference characters). Averaging the
/// per-fixture rates instead would let a 10-second clip weigh as much as a
/// 5-minute one.
pub fn score(reference: &str, hypothesis: &str, keep_punct: bool) -> (usize, usize, usize) {
    let r = normalize(reference, keep_punct);
    let h = normalize(hypothesis, keep_punct);
    (edit_distance(&r, &h), r.len(), h.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chars(s: &str) -> Vec<char> {
        s.chars().collect()
    }

    #[test]
    fn identical_text_has_no_errors() {
        assert_eq!(edit_distance(&chars("今日はいい天気"), &chars("今日はいい天気")), 0);
    }

    #[test]
    fn counts_substitution_insertion_and_deletion_as_one_each() {
        assert_eq!(edit_distance(&chars("あいう"), &chars("あいえ")), 1); // substitute
        assert_eq!(edit_distance(&chars("あいう"), &chars("あいうえ")), 1); // insert
        assert_eq!(edit_distance(&chars("あいう"), &chars("あい")), 1); // delete
    }

    #[test]
    fn empty_sides_cost_the_other_length() {
        assert_eq!(edit_distance(&[], &chars("あいう")), 3);
        assert_eq!(edit_distance(&chars("あいう"), &[]), 3);
        assert_eq!(edit_distance(&[], &[]), 0);
    }

    #[test]
    fn distance_is_measured_in_characters_not_bytes() {
        // Each of these is 3 UTF-8 bytes; a byte-wise implementation would report 3.
        assert_eq!(edit_distance(&chars("あ"), &chars("い")), 1);
    }

    #[test]
    fn normalization_drops_whitespace_including_ideographic_space() {
        assert_eq!(normalize("今日 は\u{3000}晴れ", false), chars("今日は晴れ"));
    }

    #[test]
    fn normalization_folds_full_width_ascii() {
        assert_eq!(normalize("ＡＢＣ１２３", false), chars("ABC123"));
        // So a full-width/half-width difference costs nothing.
        let (errors, _, _) = score("ABC123", "ＡＢＣ１２３", false);
        assert_eq!(errors, 0);
    }

    #[test]
    fn punctuation_is_stripped_by_default_and_kept_on_request() {
        assert_eq!(normalize("こんにちは、元気？", false), chars("こんにちは元気"));
        // Kept -- but still folded, so the full-width ？ arrives as ?. That is
        // intended: a reference written with ？ and output using ? describe the
        // same utterance and should not score as an error. 、 (U+3001) is outside
        // the full-width ASCII block, so it passes through unchanged.
        assert_eq!(normalize("こんにちは、元気？", true), chars("こんにちは、元気?"));
        let (errors, _, _) = score("元気？", "元気?", true);
        assert_eq!(errors, 0);

        // Differing only in punctuation scores clean by default...
        let (errors, _, _) = score("はい。そうです。", "はい、そうです", false);
        assert_eq!(errors, 0);
        // ...and is penalised when punctuation is being scored.
        let (errors, _, _) = score("はい。そうです。", "はい、そうです", true);
        assert!(errors > 0);
    }

    #[test]
    fn lexical_marks_are_never_treated_as_punctuation() {
        // ー and 々 look punctuation-ish but carry meaning; stripping them would
        // corrupt real words.
        assert_eq!(normalize("ラーメン", false), chars("ラーメン"));
        assert_eq!(normalize("人々", false), chars("人々"));
    }

    #[test]
    fn score_reports_reference_length_after_normalisation() {
        // The denominator must match what was actually compared, or the rate is
        // computed against characters that were never scored.
        let (_, ref_len, hyp_len) = score("こんにちは、", "こんにちは", false);
        assert_eq!(ref_len, 5);
        assert_eq!(hyp_len, 5);
    }

    #[test]
    fn a_wholly_wrong_hypothesis_can_exceed_the_reference_length() {
        // CER is not capped at 100%: inserting a long hallucination costs more
        // errors than there are reference characters. Worth knowing when reading
        // the report.
        let (errors, ref_len, _) = score("はい", "まったく違う長い文章です", false);
        assert!(errors > ref_len);
    }
}
