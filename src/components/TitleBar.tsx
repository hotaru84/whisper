import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, Copy, X } from "lucide-react";
import { TitleBarControls } from "./TitleBarControls";
import { TitleBarStatus } from "./TitleBarStatus";
import { runningInTauri, useMockBackend } from "../lib/env";
import { MOCK_BADGE_TITLE } from "../lib/mock/fixtures";

// `null` outside Tauri: `getCurrentWindow()` itself reads Tauri-injected
// globals at call time, which don't exist in a plain browser tab -- without
// this guard, `npm run dev` opened outside the Tauri webview crashed on this
// module's very first evaluation (a module-scope call, not deferred into the
// component), taking the whole app down before anything could render.
const appWindow = runningInTauri ? getCurrentWindow() : null;

/**
 * Replaces the OS titlebar (`decorations: false` in `tauri.conf.json`) so it
 * can be themed with the app's own tokens instead of showing up as a
 * mismatched white/system-colored bar above a themed body. The tradeoff:
 * Windows 11's snap-layout flyout (hovering the native maximize button)
 * cannot be reproduced for a custom-drawn button with the window APIs Tauri
 * exposes -- accepted, see the design plan.
 *
 * Doubles as the app's only top bar: there used to be a second strip
 * (StatusBar) below this one carrying every global control and the live
 * "what is the app doing" readout. That duplicated this bar's real estate
 * for no reason a title-only titlebar could explain, so its contents moved
 * up here -- `TitleBarControls` (sidebar toggle, mic, target app, recording
 * mode) on the left, `TitleBarStatus` centered where the app name used to
 * sit. Theme and settings did *not* move here; they live in the sidebar's
 * footer instead, since they're consulted rarely enough not to need a
 * titlebar slot that's otherwise reserved for per-recording controls.
 */
export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!appWindow) return;
    let unlisten: (() => void) | undefined;
    void appWindow.isMaximized().then(setIsMaximized);
    void appWindow.onResized(() => {
      void appWindow.isMaximized().then(setIsMaximized);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  return (
    <div
      data-tauri-drag-region
      // z-60: above both ModelLoadingOverlay's z-40 backdrop and any Dialog's
      // z-50 overlay/content (shadcn's Dialog portals to <body>, appending
      // after this element, so equal z-index would let its fixed, full-
      // viewport overlay intercept clicks meant for these buttons -- verified
      // by hand: without this, opening Settings made minimize/maximize/close
      // silently unclickable, landing on the dialog's backdrop instead). The
      // window controls this replaces were never something web content could
      // cover, dialog or not.
      className="relative z-[60] flex h-9 shrink-0 items-center gap-1 border-b border-border bg-background pl-1 text-foreground select-none"
    >
      <TitleBarControls />
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center justify-center gap-2 px-2">
        <TitleBarStatus />
        {/* Dev-only, and only outside Tauri: without it the browser preview
            is indistinguishable from the real app right up until someone
            reads the fake transcript and believes it. `useMockBackend` is
            itself gated on `import.meta.env.DEV`, so this cannot ship. */}
        {useMockBackend && (
          <span
            title={MOCK_BADGE_TITLE}
            className="shrink-0 rounded-sm border border-signal/60 px-1.5 py-0.5 text-[10px] leading-none font-semibold tracking-wide text-signal"
          >
            MOCK
          </span>
        )}
      </div>
      <div className="flex h-full items-stretch">
        <button
          type="button"
          aria-label="最小化"
          onClick={() => void appWindow?.minimize()}
          className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label={isMaximized ? "元のサイズに戻す" : "最大化"}
          onClick={() => void appWindow?.toggleMaximize()}
          className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {isMaximized ? <Copy className="h-3.5 w-3.5" /> : <Square className="h-3 w-3" />}
        </button>
        <button
          type="button"
          aria-label="閉じる"
          onClick={() => void appWindow?.close()}
          className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-signal hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
