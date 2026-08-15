import { Mic, Cast, FileAudio, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { useAppStore } from "../store/appStore";

const NO_APP_TARGET = "__none__";

/** Icon-only mic picker. The trigger never shows the current device name --
 * only a tooltip does -- so a long device label never has to fight the
 * titlebar for width the way it did as a `Select`. */
function MicPicker() {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const audioInputDevices = useAppStore((s) => s.audioInputDevices);
  const locked = useAppStore((s) => s.recordingPhase) !== "stopped";

  const currentValue = settings.inputDeviceId || "__default__";
  const currentLabel =
    audioInputDevices.find((d) => d.deviceId === settings.inputDeviceId)?.label ?? "既定のマイク";
  const label = `マイク: ${currentLabel}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={locked}>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={label} title={label}>
          <Mic className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-56 max-w-80">
        <DropdownMenuRadioGroup
          value={currentValue}
          onValueChange={(v) => updateSettings({ inputDeviceId: v === "__default__" ? "" : v })}
        >
          <DropdownMenuRadioItem value="__default__">既定のマイク</DropdownMenuRadioItem>
          {audioInputDevices.map((d) => (
            <DropdownMenuRadioItem key={d.deviceId} value={d.deviceId} className="truncate">
              {d.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Icon-only app-audio target picker. Selected state is drawn two ways at
 * once: the trigger swaps to the target app's own icon (falling back to
 * `Cast` when none is picked), and the button face turns `secondary` -- the
 * tooltip carries the name neither of those can. Opening the menu refreshes
 * the list itself, same as the old toolbar `Select`, so there is no separate
 * refresh control to remember. */
function TargetAppPicker() {
  const appAudioApps = useAppStore((s) => s.appAudioApps);
  const appAudioTargetPid = useAppStore((s) => s.appAudioTargetPid);
  const setAppAudioTarget = useAppStore((s) => s.setAppAudioTarget);
  const refreshAppAudioApps = useAppStore((s) => s.refreshAppAudioApps);
  const locked = useAppStore((s) => s.recordingPhase) !== "stopped";

  const currentValue = appAudioTargetPid != null ? String(appAudioTargetPid) : NO_APP_TARGET;
  const currentApp = appAudioApps.find((a) => a.processId === appAudioTargetPid);
  const label = currentApp ? `対象アプリ: ${currentApp.name}` : "対象アプリなし（マイクのみ）";

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) void refreshAppAudioApps();
      }}
    >
      <DropdownMenuTrigger asChild disabled={locked}>
        <Button
          type="button"
          variant={appAudioTargetPid != null ? "secondary" : "ghost"}
          size="icon-sm"
          aria-label={label}
          title={label}
        >
          {currentApp?.icon ? (
            <img src={currentApp.icon} alt="" className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <Cast className="h-3.5 w-3.5" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-56 max-w-80">
        <DropdownMenuRadioGroup
          value={currentValue}
          onValueChange={(v) => setAppAudioTarget(v === NO_APP_TARGET ? null : Number(v))}
        >
          <DropdownMenuRadioItem value={NO_APP_TARGET}>対象アプリなし（マイクのみ）</DropdownMenuRadioItem>
          {appAudioApps.map((a) => (
            <DropdownMenuRadioItem key={a.processId} value={String(a.processId)} className="truncate">
              <span className="flex items-center gap-1.5">
                {a.icon ? (
                  <img src={a.icon} alt="" className="h-4 w-4 shrink-0" />
                ) : (
                  <Cast className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                {a.name}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Left cluster of the titlebar: sidebar visibility, then the three controls
 * that decide what the *next* recording captures. Not draggable -- these sit
 * as plain siblings inside the titlebar's drag region (no
 * `data-tauri-drag-region` of their own), same pattern the window-control
 * buttons on the right already use.
 */
export function TitleBarControls() {
  const sidebarVisible = useAppStore((s) => s.sidebar.visible);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const recordOnly = useAppStore((s) => s.recordingMode.recordOnly);
  const updateRecordingMode = useAppStore((s) => s.updateRecordingMode);
  const processing = useAppStore((s) => s.processing);
  // The mic/app-audio pickers and the record-only toggle only take effect at
  // `startRecording`, so leaving them live mid-take would let the user change
  // a setting that silently does nothing until the next recording.
  const locked = useAppStore((s) => s.recordingPhase) !== "stopped";
  // The mode toggle is held for longer than the pickers: flipping it *off*
  // starts loading the model, which would then contend with a post-stop pass
  // that is still running.
  const modeLocked = locked || processing !== null;
  const sidebarLabel = sidebarVisible ? "履歴パネルを隠す" : "履歴パネルを表示";

  return (
    <div className="flex items-center gap-0.5">
      {/* Outside the recording-locked group on purpose: this only changes
          what is on screen, not what the next recording captures, so it
          stays live at every phase (see StatusBar.tsx's original split). */}
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

      <MicPicker />
      <TargetAppPicker />

      {/* Labelled, not icon-only, unlike the pickers above: their effect is
          their own current value, but this one's effect is an *absence* (no
          live transcript appears) that no icon conveys on its own. The
          tooltip carries the why; the label carries the what. */}
      <Button
        type="button"
        variant={recordOnly ? "secondary" : "ghost"}
        size="sm"
        disabled={modeLocked}
        aria-pressed={recordOnly}
        title="録音のみ：文字起こしはあとでまとめて実行します。録音中は GPU を使わないためバッテリーが長持ちします。"
        onClick={() => updateRecordingMode({ recordOnly: !recordOnly })}
      >
        <FileAudio className="h-3.5 w-3.5" />
        録音のみ
      </Button>
    </div>
  );
}
