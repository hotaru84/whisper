import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, Copy, X } from "lucide-react";

const appWindow = getCurrentWindow();

/**
 * Replaces the OS titlebar (`decorations: false` in `tauri.conf.json`) so it
 * can be themed with the app's own tokens instead of showing up as a
 * mismatched white/system-colored bar above a themed body. The tradeoff:
 * Windows 11's snap-layout flyout (hovering the native maximize button)
 * cannot be reproduced for a custom-drawn button with the window APIs Tauri
 * exposes -- accepted, see the design plan.
 */
export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
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
      className="relative z-[60] flex h-9 shrink-0 items-center justify-between border-b border-border bg-background pl-3 text-foreground select-none"
    >
      <div data-tauri-drag-region className="flex items-center gap-2 text-xs font-medium">
        <span className="h-2 w-2 rounded-full bg-signal" aria-hidden="true" />
        WhisperScribe
      </div>
      <div className="flex h-full items-stretch">
        <button
          type="button"
          aria-label="最小化"
          onClick={() => void appWindow.minimize()}
          className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label={isMaximized ? "元のサイズに戻す" : "最大化"}
          onClick={() => void appWindow.toggleMaximize()}
          className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {isMaximized ? <Copy className="h-3.5 w-3.5" /> : <Square className="h-3 w-3" />}
        </button>
        <button
          type="button"
          aria-label="閉じる"
          onClick={() => void appWindow.close()}
          className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-signal hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
