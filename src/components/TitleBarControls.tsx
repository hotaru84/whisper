import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "./ui/button";
import { useAppStore } from "../store/appStore";

/**
 * Left cluster of the titlebar. Used to also carry the mic/app-audio/
 * record-only controls, but those moved to `RecordStartPanel.tsx` as part of
 * the Home/Active screen split -- they only ever mattered before a take
 * started, so they now live on the Home screen where that decision is made,
 * rather than sitting disabled here for the whole duration of every take.
 * What's left is just the sidebar visibility toggle, which (unlike those
 * three) has nothing to do with what the *next* recording captures, so it
 * stays live -- but only while there's a Home screen for it to affect at
 * all: the Active screen has no sidebar slot, not even a hidden one (see
 * `App.tsx`), so this renders nothing rather than a disabled button pointing
 * at a panel that doesn't exist right now.
 */
export function TitleBarControls() {
  const sidebarVisible = useAppStore((s) => s.sidebar.visible);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const recordingPhase = useAppStore((s) => s.recordingPhase);
  const sidebarLabel = sidebarVisible ? "履歴パネルを隠す" : "履歴パネルを表示";

  if (recordingPhase !== "stopped") return null;

  return (
    <div className="flex items-center gap-0.5">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={sidebarLabel}
        aria-pressed={sidebarVisible}
        title={sidebarLabel}
        onClick={toggleSidebar}
      >
        {sidebarVisible ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
      </Button>
    </div>
  );
}
