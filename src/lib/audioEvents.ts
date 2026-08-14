/**
 * Display-only helpers for `AudioEventPanel`. Separate from the Rust-side
 * exclusion decision (`events::classify_chunks`): that one decides what
 * leaves the transcript and has to be conservative, this one only decides how
 * a tag is labeled and highlighted, so the two are allowed to disagree at the
 * edges without either being "wrong".
 */

/**
 * Japanese labels for the AudioSet classes a meeting recording plausibly
 * produces. Deliberately a small, curated subset rather than a translation of
 * all ~527 classes -- most of AudioSet (dog breeds, vehicle engines, musical
 * instruments) will essentially never appear in an office recording, and
 * translating them all would be upfront work nobody reads.
 */
const LABELS_JA: Record<string, string> = {
  Speech: "発話",
  Conversation: "会話",
  "Male speech, man speaking": "発話（男性）",
  "Female speech, woman speaking": "発話（女性）",
  "Child speech, kid speaking": "発話（子供）",
  Music: "音楽",
  Laughter: "笑い声",
  Chuckle: "笑い声",
  Giggle: "笑い声",
  Applause: "拍手",
  Clapping: "拍手",
  Cheering: "歓声",
  Typing: "タイピング音",
  "Computer keyboard": "キーボード音",
  "Keyboard (musical)": "キーボード音",
  Cough: "咳",
  Sneeze: "くしゃみ",
  Door: "ドア",
  "Door slam": "ドアの音",
  Knock: "ノック",
  Silence: "無音",
  Noise: "ノイズ",
  "Environmental noise": "環境ノイズ",
  "White noise": "ホワイトノイズ",
  Static: "ノイズ（静電）",
  "Telephone bell ringing": "電話の呼び出し音",
  Ringtone: "着信音",
  Alarm: "アラーム音",
};

/** Japanese label for a class, or the original English name when this app
 * has no translation for it. */
export function audioEventLabelJa(name: string): string {
  return LABELS_JA[name] ?? name;
}

/**
 * Whether an event is worth calling out as "worth a re-listen" in the panel
 * -- background music or noise, which can degrade whisper's accuracy even in
 * a window where it did not stay silent. Intentionally narrower than "not
 * speech": e.g. silence, applause, or a door are not something to re-listen
 * to.
 */
export function isNoiseOrMusicEvent(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes("music") || lower.includes("noise") || lower === "static";
}

/**
 * Coarse buckets an `AudioEvent.name` (an AudioSet class) sorts into, purely
 * for picking an icon in `AudioEventPanel`. Deliberately broader/fuzzier than
 * `is_speech_label`/`is_noise_or_music_label` in `events.rs` -- those decide
 * whether a transcript chunk gets dropped and have to be conservative, this
 * one only decides which glyph to draw and can afford to guess.
 */
export type AudioEventCategory = "music" | "noise" | "applause" | "speech" | "typing" | "alert" | "other";

export function audioEventCategory(name: string): AudioEventCategory {
  const n = name.toLowerCase();
  if (n.includes("music")) return "music";
  if (n.includes("noise") || n === "static") return "noise";
  if (n.includes("applause") || n.includes("clap") || n.includes("cheer")) return "applause";
  if (n.includes("speech") || n.includes("conversation") || n.includes("narration") || n.includes("babbl")) {
    return "speech";
  }
  if (n.includes("typ") || n.includes("keyboard")) return "typing";
  if (n.includes("alarm") || n.includes("ring") || n.includes("bell") || n.includes("knock") || n.includes("door")) {
    return "alert";
  }
  return "other";
}
