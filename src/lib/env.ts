import { isTauri } from "@tauri-apps/api/core";

/**
 * True only inside the real Tauri webview -- `@tauri-apps/api/core`'s own
 * check (`globalThis.isTauri`, injected by the Tauri runtime), which a plain
 * browser tab never sees.
 */
export const runningInTauri = isTauri();

/**
 * Whether the mock (no-backend) fallbacks scattered through the app should be
 * active: only outside Tauri, and only in a dev build.
 *
 * This exists so `npm run dev` opened in a plain browser is a usable way to
 * review the frontend on its own -- no Rust backend, no 574MB model, no
 * Vulkan, no Windows. Everything the UI can reach is faked, and every fake
 * lives in a `useMockBackend` branch next to the real call it stands in for:
 *
 * - `asr/client.ts` -- model load, live windows, post-hoc PCM streaming and
 *   the finalize/repair pass, diarization, audio events
 * - `asr/capture.ts` -- the WAV writer; there is no file, only a duration
 * - `history.ts` -- an in-memory store, seeded with two sample recordings so
 *   the sidebar is not empty on first load; `openRecordingFolder` also
 *   refuses (no native file manager)
 * - `audio/playback.ts` -- a synthesized *silent* WAV, so the timeline,
 *   seeking and follow-along all work; nothing is audible
 * - `audio/appAudio.ts` -- a fake WASAPI process list, capture is a no-op
 * - `export/autoSave.ts` -- the folder picker and the transcript auto-write
 *   both refuse (no native dialog / no filesystem access outside the
 *   sandbox); the settings panel's folder-picker button is disabled to match
 *
 * Window controls are the one thing with no stand-in at all: they are simply
 * inert outside Tauri (see `TitleBar.tsx`). `npm run tauri dev`/`tauri build`
 * are unaffected either way, since the real webview always has
 * `isTauri() === true`. Gated on `import.meta.env.DEV` as well, so a
 * production build with no Tauri runtime around it fails loudly instead of
 * silently pretending to work.
 */
export const useMockBackend = !runningInTauri && import.meta.env.DEV;

if (useMockBackend) {
  console.info(
    "[env] Tauri backend not detected -- falling back to mock ASR/capture/history/playback so the frontend can be reviewed in a plain browser. Real transcription, playback audio, app-audio capture, auto-save, and window controls will not work.",
  );
}
