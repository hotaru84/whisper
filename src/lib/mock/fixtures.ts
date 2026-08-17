/**
 * Dummy data and synthetic audio for the browser-only dev mode (see
 * `../env.ts`). Nothing here is ever reachable from a real build: every call
 * site is behind a `useMockBackend` branch, which is itself gated on
 * `import.meta.env.DEV` *and* on Tauri being absent.
 *
 * It lives in its own module rather than inline in each mock branch because
 * the branches are meant to stay one-liners -- `asr/client.ts`, `history.ts`
 * and friends are real code that happens to have a fallback, not mock
 * modules, and a seeded transcript is long enough to bury that distinction.
 *
 * The two things worth knowing before adding to this:
 *
 * - Durations are registered here (`rememberMockDuration`), not read back out
 *   of the mock history store, because playback is loaded *before* the take is
 *   filed in history (`fileTakeProvisionally` calls `loadPlayback` before
 *   `persistTake`), so the store is not yet a reliable source at the moment
 *   the WAV is needed.
 * - Fake audio is a real, decodable, silent WAV rather than a fake
 *   `PlaybackController`, so `createPlaybackController` and everything reading
 *   its snapshots run completely unmodified -- seeking, rate changes and
 *   `ended` behave exactly as they do with a real recording. The only
 *   difference the user perceives is that nothing comes out of the speakers.
 */
import type { AudioAppInfo } from "../audio/appAudio";
import type { AudioEvent } from "../asr/client";
import type { TranscriptChunk } from "../asr/types";
import type { StoredRecording } from "../history";
import type { TranscriptSegment } from "../transcript";

// --- Recording durations ------------------------------------------------

/** Fallback for an id nothing ever registered -- long enough that the
 * timeline and its slider are usable rather than a degenerate zero-length
 * bar. */
const FALLBACK_DURATION_SEC = 60;

const durations = new Map<string, number>();

export function rememberMockDuration(id: string, durationSec: number): void {
  durations.set(id, durationSec);
}

export function mockDurationSec(id: string): number {
  return durations.get(id) ?? FALLBACK_DURATION_SEC;
}

/** The recording id out of a mock WAV path (`mock-recordings/<id>.wav`, as
 * built by `asr/capture.ts` and `history.ts`). Deliberately tolerant of both
 * separators, like `idFromWavPath` in `store/recordingPipeline.ts`. */
export function mockIdFromPath(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  return base.replace(/\.wav$/i, "");
}

// --- Synthetic audio ----------------------------------------------------

/** 8 kHz / 8-bit / mono = 8 KB per second, so even an hour-long fake
 * recording stays around 29 MB. Nothing decodes the samples for content --
 * only the duration and the ability to seek matter. */
const MOCK_WAV_RATE = 8000;

/** A playable, completely silent WAV of the requested length. The explicit
 * `ArrayBuffer` argument matches what `@tauri-apps/plugin-fs`'s `readFile`
 * returns, so the two sides of `wavToBlobUrl`'s branch stay one `BlobPart`
 * type rather than widening to `ArrayBufferLike`. */
export function silentWavBytes(durationSec: number): Uint8Array<ArrayBuffer> {
  const samples = Math.max(1, Math.round(durationSec * MOCK_WAV_RATE));
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, MOCK_WAV_RATE, true);
  view.setUint32(28, MOCK_WAV_RATE, true); // byte rate (= rate * block align)
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples, true);
  // 8-bit WAV samples are *unsigned*: 128, not 0, is silence.
  bytes.fill(128, 44);

  return bytes;
}

// --- App audio ----------------------------------------------------------

/** Stand-ins for the WASAPI process-loopback list, so the target-app picker
 * (`RecordStartPanel`) has something to select and clear. No icons: those are
 * extracted from the real executables, and a fake data URI would only make
 * the mock harder to tell apart from the real thing. */
export const MOCK_AUDIO_APPS: AudioAppInfo[] = [
  { processId: 4242, name: "Microsoft Teams (モック)", icon: null },
  { processId: 5150, name: "Zoom Meetings (モック)", icon: null },
];

// --- User-facing copy ---------------------------------------------------

/** Why anything needing a native dialog, file manager, or filesystem access
 * outside the app's own sandbox (the auto-save folder picker, "open folder"
 * links) is disabled in the browser preview. Shown as their `title`. */
export const MOCK_NATIVE_FEATURE_UNAVAILABLE =
  "ブラウザプレビューでは利用できません（ネイティブ機能が必要です）";

/** The mock badge's tooltip, in the titlebar. */
export const MOCK_BADGE_TITLE =
  "バックエンド無しのブラウザプレビューです。文字起こし・再生音・保存は実際には行われません";

// --- Transcription ------------------------------------------------------

const MOCK_REFINED_SENTENCES = [
  "（モック）精度向上パスが完了した想定の文字起こしです。",
  "（モック）バックエンドに接続していないため、実際の音声内容は反映されていません。",
  "（モック）行をクリックすると、その位置に再生がシークします。",
  "（モック）話者分離を有効にすると、行ごとに話者ラベルが付きます。",
];

/**
 * A whole-recording result spread across `durationSec`, one chunk per
 * sentence.
 *
 * The single `[0, 3]` chunk this replaced made every take collapse to one
 * transcript line no matter how long it was, which left the parts of the UI
 * that key off chunk timestamps -- seeking from a line, the active-line
 * highlight, per-line speaker labels, SRT output -- with nothing to exercise.
 */
export function mockRefinedResult(durationSec: number): { text: string; chunks: TranscriptChunk[] } {
  const span = Math.max(1, durationSec) / MOCK_REFINED_SENTENCES.length;
  const chunks = MOCK_REFINED_SENTENCES.map((text, i): TranscriptChunk => ({
    text,
    timestamp: [i * span, (i + 1) * span],
  }));
  return { text: MOCK_REFINED_SENTENCES.join(""), chunks };
}

// --- Audio events -------------------------------------------------------

const MOCK_EVENT_NAMES = ["Speech", "Applause", "Typing", "Laughter"];

/** One tag every ~10 seconds, cycling through a few plausible AudioSet
 * labels, so the audio-event track on the timeline is populated instead of
 * permanently empty. `index` is the AudioSet class index in the real backend;
 * the position in the list above stands in for it here. */
export function mockAudioEvents(spanSec: number, baseSec = 0): AudioEvent[] {
  const events: AudioEvent[] = [];
  const step = 10;
  for (let i = 0; i * step < Math.max(step, spanSec); i += 1) {
    const start = baseSec + i * step;
    events.push({
      start,
      end: Math.min(start + 2, baseSec + Math.max(step, spanSec)),
      name: MOCK_EVENT_NAMES[i % MOCK_EVENT_NAMES.length],
      index: i % MOCK_EVENT_NAMES.length,
      prob: 0.55 + ((i % 4) * 0.1),
    });
  }
  return events;
}

// --- Seeded history -----------------------------------------------------

/** `rec-20260813-084500`, the stem shape `parseCreatedAt` in `history.ts`
 * parses back. Mirrors `defaultName` in `asr/capture.ts` -- kept as its own
 * copy rather than exporting that one, so the mock cannot drag a helper into
 * the real capture module's public surface. */
function idAt(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `rec-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(
    date.getHours(),
  )}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function segment(
  id: number,
  startOffsetSec: number,
  durationSec: number,
  text: string,
  speaker?: number | null,
): TranscriptSegment {
  return {
    id,
    startOffsetSec,
    text,
    chunks: [{ text, timestamp: [0, durationSec] }],
    ...(speaker === undefined ? {} : { speaker }),
  };
}

/**
 * Two ready-made history entries, filed as soon as the module loads.
 *
 * Without these the browser preview opens on an empty sidebar, and the whole
 * history half of the UI -- row badges, selection, playback, re-analysis,
 * deletion -- can only be reached by first making a recording, which needs
 * microphone permission and a real 15+ seconds of waiting. The two entries
 * are deliberately different in kind: one fully analyzed (speakers + audio
 * events, so the transcript renders labels and the timeline has a populated
 * event track), one record-only (`transcribed: false`, which is what puts the
 * 解析 button on its row).
 */
export function seedMockRecordings(): Array<[string, StoredRecording]> {
  const now = Date.now();

  const analyzedId = idAt(new Date(now - 26 * 60 * 60 * 1000));
  const analyzedDurationSec = 184;
  const analyzed: StoredRecording = {
    durationSec: analyzedDurationSec,
    language: "ja",
    transcribed: true,
    usedDiarize: true,
    usedVad: true,
    usedAudioEvents: true,
    segments: [
      segment(1, 0, 12, "（モック）週次定例を始めます。今週の進捗から共有してください。", 0),
      segment(2, 12, 18, "（モック）はい、先週の課題だった読み込み速度は改善済みです。", 1),
      segment(3, 30, 15, "（モック）残っているのは設定画面のレイアウト調整だけですね。", 0),
      segment(4, 45, 22, "（モック）そちらは明日中に対応して、レビュー依頼を出します。", 1),
      segment(5, 67, 20, "（モック）では次の議題、来月のリリース計画に移ります。", 0),
    ],
    audioEvents: mockAudioEvents(analyzedDurationSec),
  };

  const recordOnlyId = idAt(new Date(now - 3 * 60 * 60 * 1000));
  const recordOnlyDurationSec = 47;
  const recordOnly: StoredRecording = {
    durationSec: recordOnlyDurationSec,
    language: "ja",
    // Record-only takes are filed with no transcript at all -- this is what
    // the sidebar's "未解析" badge and its 解析 button key off.
    transcribed: false,
    usedDiarize: false,
    usedVad: false,
    usedAudioEvents: false,
    segments: [],
    audioEvents: [],
  };

  rememberMockDuration(analyzedId, analyzedDurationSec);
  rememberMockDuration(recordOnlyId, recordOnlyDurationSec);

  return [
    [analyzedId, analyzed],
    [recordOnlyId, recordOnly],
  ];
}
