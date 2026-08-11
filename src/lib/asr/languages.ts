/** Curated subset of Whisper's supported languages for the language picker UI. */
export const SUPPORTED_LANGUAGES = [
  { code: "ja", label: "日本語" },
  { code: "en", label: "英語" },
  { code: "zh", label: "中国語" },
  { code: "ko", label: "韓国語" },
  { code: "es", label: "スペイン語" },
  { code: "fr", label: "フランス語" },
  { code: "de", label: "ドイツ語" },
  { code: "auto", label: "自動検出" },
] as const;
