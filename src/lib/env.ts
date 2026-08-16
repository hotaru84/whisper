import { isTauri } from "@tauri-apps/api/core";

/**
 * True only inside the real Tauri webview -- `@tauri-apps/api/core`'s own
 * check (`globalThis.isTauri`, injected by the Tauri runtime), which a plain
 * browser tab never sees.
 */
export const runningInTauri = isTauri();

/**
 * Whether the mock (no-backend) fallbacks scattered through the ASR/capture/
 * history layer should be active: only outside Tauri, and only in a dev
 * build. `npm run tauri dev`/`tauri build` are unaffected either way (the
 * real webview always has `isTauri() === true`); this exists purely so
 * `npm run dev` opened in a plain browser can exercise the app's screen
 * transitions (record -> starting -> recording -> stop -> home, history
 * browsing, the 解析中止 toggle) without a working Rust backend, model, or
 * GPU -- see the mock branches in `asr/client.ts`, `asr/capture.ts`, and
 * `history.ts` for what each one fakes and why. Gated on `import.meta.env.DEV`
 * so a production build with no Tauri runtime around it fails loudly instead
 * of silently pretending to work.
 */
export const useMockBackend = !runningInTauri && import.meta.env.DEV;

if (useMockBackend) {
  console.info(
    "[env] Tauri backend not detected -- falling back to mock ASR/capture/history so screen transitions can still be exercised in the browser. Real transcription, playback audio, and window controls will not work.",
  );
}
