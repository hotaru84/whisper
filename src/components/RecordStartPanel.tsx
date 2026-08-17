import { Mic, Cast, FileAudio, Zap } from "lucide-react";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { RecordButton } from "./RecordButton";
import { useAppStore, effectiveRecordOnly } from "../store/appStore";

const NO_APP_TARGET = "__none__";

/** Icon-only mic picker. The trigger never shows the current device name --
 * only a tooltip does -- so a long device label never has to fight the
 * panel for width. Moved here from the titlebar (`TitleBarControls.tsx`):
 * this only ever mounts while `recordingPhase === "stopped"` (it lives
 * inside `RecordStartPanel`, which only renders on the Home screen's
 * nothing-selected state), so unlike its titlebar predecessor it needs no
 * `locked`/`disabled` guard -- there is no live take for it to coexist with. */
function MicPicker() {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const audioInputDevices = useAppStore((s) => s.audioInputDevices);

  const currentValue = settings.inputDeviceId || "__default__";
  const currentLabel =
    audioInputDevices.find((d) => d.deviceId === settings.inputDeviceId)?.label ?? "既定のマイク";
  const label = `マイク: ${currentLabel}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={label} title={label}>
          <Mic className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" collisionPadding={8} className="w-auto min-w-56 max-w-96">
        <DropdownMenuRadioGroup
          value={currentValue}
          onValueChange={(v) => updateSettings({ inputDeviceId: v === "__default__" ? "" : v })}
        >
          <DropdownMenuRadioItem value="__default__">既定のマイク</DropdownMenuRadioItem>
          {/* Wrapped, not truncated: a cut-off device name is exactly the
              ambiguity this menu exists to resolve (which physical mic is
              which), so a long label grows the row instead of hiding its
              own tail behind an ellipsis. */}
          {audioInputDevices.map((d) => (
            <DropdownMenuRadioItem key={d.deviceId} value={d.deviceId} className="whitespace-normal break-words">
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
 * the list itself, so there is no separate refresh control to remember.
 * Same relocation note as `MicPicker` above -- no `locked` guard needed here
 * either. */
function TargetAppPicker() {
  const appAudioApps = useAppStore((s) => s.appAudioApps);
  const appAudioTargetPid = useAppStore((s) => s.appAudioTargetPid);
  const setAppAudioTarget = useAppStore((s) => s.setAppAudioTarget);
  const refreshAppAudioApps = useAppStore((s) => s.refreshAppAudioApps);

  const currentValue = appAudioTargetPid != null ? String(appAudioTargetPid) : NO_APP_TARGET;
  const currentApp = appAudioApps.find((a) => a.processId === appAudioTargetPid);
  const label = currentApp ? `対象アプリ: ${currentApp.name}` : "対象アプリなし（マイクのみ）";

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) void refreshAppAudioApps();
      }}
    >
      <DropdownMenuTrigger asChild>
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
      <DropdownMenuContent align="start" collisionPadding={8} className="w-auto min-w-56 max-w-96">
        <DropdownMenuRadioGroup
          value={currentValue}
          onValueChange={(v) => setAppAudioTarget(v === NO_APP_TARGET ? null : Number(v))}
        >
          <DropdownMenuRadioItem value={NO_APP_TARGET}>対象アプリなし（マイクのみ）</DropdownMenuRadioItem>
          {appAudioApps.map((a) => (
            <DropdownMenuRadioItem key={a.processId} value={String(a.processId)}>
              <span className="flex items-center gap-1.5 whitespace-normal break-words">
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
 * The Home screen's "nothing selected" content -- the record-start CTA plus
 * the three controls that decide what the *next* recording captures (mic,
 * app-audio target, record-only). Moved out of the titlebar
 * (`TitleBarControls.tsx`) as part of the Home/Active screen split: these
 * only ever matter before a take starts, so they now live where that
 * decision is actually made rather than sitting disabled in the titlebar
 * for the entire duration of every take.
 *
 * Only ever mounted while idle (see `App.tsx`'s `showRecordStart`), so
 * nothing here needs its own `recordingPhase`/`processing` guard -- the
 * mount condition already is the guard.
 */
export function RecordStartPanel() {
  const recordingMode = useAppStore((s) => s.recordingMode);
  const powerSource = useAppStore((s) => s.powerSource);
  const updateRecordingMode = useAppStore((s) => s.updateRecordingMode);

  const { auto, recordOnly: manualRecordOnly } = recordingMode;
  // What the *next* take would actually do -- the manual flag while auto is
  // off, the live power reading while it's on. Drives the "録音のみ" button's
  // own display; `updateRecordingMode` still toggles the stored manual flag
  // underneath, which is what auto mode falls back to the moment it's turned
  // back off.
  const recordOnly = effectiveRecordOnly(recordingMode, powerSource);
  const batteryKnown = powerSource !== "unknown";

  const recordOnlyTitle = auto
    ? `自動モードが有効なため、電源状態から自動的に決まります（現在: ${
        recordOnly ? "バッテリー駆動のため録音のみ" : "電源に接続中のため解析"
      }）。手動で切り替えるには「自動」を解除してください。`
    : "録音のみ：文字起こしはあとでまとめて実行します。録音中は GPU を使わないためバッテリーが長持ちします。";
  const autoTitle = batteryKnown
    ? `自動：バッテリー駆動なら録音のみ、電源に接続していれば解析します（現在: ${
        recordOnly ? "バッテリー駆動" : "電源に接続中"
      }）。`
    : "自動：この環境では電源状態を取得できないため、常に解析として扱われます。";

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
      <RecordButton />
      <div className="flex items-center gap-1">
        <MicPicker />
        <TargetAppPicker />
        {/* Labelled, not icon-only, unlike the pickers above: their effect is
            their own current value, but this one's effect is an *absence* (no
            live transcript appears) that no icon conveys on its own. Disabled
            (not hidden) while auto mode drives it, so the stored manual
            preference underneath stays visible rather than looking reset. */}
        <Button
          type="button"
          variant={recordOnly ? "default" : "ghost"}
          size="sm"
          aria-pressed={recordOnly}
          disabled={auto}
          title={recordOnlyTitle}
          onClick={() => updateRecordingMode({ recordOnly: !manualRecordOnly })}
        >
          <FileAudio className="h-3.5 w-3.5" />
          録音のみ
        </Button>
        <Button
          type="button"
          variant={auto ? "default" : "ghost"}
          size="sm"
          aria-pressed={auto}
          title={autoTitle}
          onClick={() => updateRecordingMode({ auto: !auto })}
        >
          <Zap className="h-3.5 w-3.5" />
          自動
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        録音を開始すると、ここに文字起こし結果が表示されます。
      </p>
    </div>
  );
}
