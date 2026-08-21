import { Mic, Cast, FileAudio, Zap, Captions } from "lucide-react";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { RecordButton } from "./RecordButton";
import {
  useAppStore,
  effectiveRecordOnly,
  type RecordingModeChoice,
} from "../store/appStore";

const NO_APP_TARGET = "__none__";

/** Trigger icon, button label, and menu description for each of the three
 * `RecordingModeChoice` values, in the order they're offered -- one place so
 * `RecordingModePicker`'s trigger and menu can't drift out of sync with each
 * other. */
const RECORDING_MODE_OPTIONS: {
  value: RecordingModeChoice;
  icon: typeof FileAudio;
  label: string;
  description: string;
}[] = [
  {
    value: "auto",
    icon: Zap,
    label: "自動",
    description: "バッテリー駆動なら録音のみ、電源に接続していれば解析します。",
  },
  {
    value: "recordOnly",
    icon: FileAudio,
    label: "録音のみ",
    description:
      "文字起こしはあとでまとめて実行します。録音中は GPU を使わないためバッテリーが長持ちします。",
  },
  {
    value: "analyze",
    icon: Captions,
    label: "録音と解析",
    description: "録音しながら文字起こしし、停止後に仕上げの解析を行います。",
  },
];

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
    audioInputDevices.find((d) => d.deviceId === settings.inputDeviceId)
      ?.label ?? "既定のマイク";
  const label = `マイク: ${currentLabel}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={label}
          title={label}
        >
          <Mic className="h-3.5 w-3.5" />
          {currentLabel}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        collisionPadding={8}
        className="w-auto min-w-56 max-w-96"
      >
        <DropdownMenuRadioGroup
          value={currentValue}
          onValueChange={(v) =>
            updateSettings({ inputDeviceId: v === "__default__" ? "" : v })
          }
        >
          <DropdownMenuRadioItem value="__default__">
            既定のマイク
          </DropdownMenuRadioItem>
          {/* Wrapped, not truncated: a cut-off device name is exactly the
              ambiguity this menu exists to resolve (which physical mic is
              which), so a long label grows the row instead of hiding its
              own tail behind an ellipsis. */}
          {audioInputDevices.map((d) => (
            <DropdownMenuRadioItem
              key={d.deviceId}
              value={d.deviceId}
              className="whitespace-normal break-words"
            >
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

  const currentValue =
    appAudioTargetPid != null ? String(appAudioTargetPid) : NO_APP_TARGET;
  const currentApp = appAudioApps.find(
    (a) => a.processId === appAudioTargetPid,
  );
  const label = currentApp
    ? `対象アプリ: ${currentApp.name}`
    : "対象アプリなし（マイクのみ）";

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
          size="sm"
          aria-label={label}
          title={label}
        >
          {currentApp?.icon ? (
            <img
              src={currentApp.icon}
              alt=""
              className="h-3.5 w-3.5 shrink-0"
            />
          ) : (
            <Cast className="h-3.5 w-3.5" />
          )}
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        collisionPadding={8}
        className="w-auto min-w-56 max-w-96"
      >
        <DropdownMenuRadioGroup
          value={currentValue}
          onValueChange={(v) =>
            setAppAudioTarget(v === NO_APP_TARGET ? null : Number(v))
          }
        >
          <DropdownMenuRadioItem value={NO_APP_TARGET}>
            対象アプリなし（マイクのみ）
          </DropdownMenuRadioItem>
          {appAudioApps.map((a) => (
            <DropdownMenuRadioItem
              key={a.processId}
              value={String(a.processId)}
            >
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
 * The one control for what the *next* take does: automatic (follow the power
 * source), record-only, or the normal recording-and-analysis take. A dropdown
 * rather than the two separate toggle buttons this replaced (a manual
 * "録音のみ" flag plus an independent "自動" switch) because the three are
 * mutually exclusive outcomes, not two independent settings -- the old pair
 * needed a `disabled` state on one button to represent that, which a single
 * choice doesn't.
 *
 * Labelled, not icon-only, unlike `MicPicker`/`TargetAppPicker` above: their
 * effect is their own current value, but record-only's effect is an
 * *absence* (no live transcript appears) that no icon conveys on its own.
 */
function RecordingModePicker() {
  const recordingMode = useAppStore((s) => s.recordingMode);
  const powerSource = useAppStore((s) => s.powerSource);
  const setRecordingMode = useAppStore((s) => s.setRecordingMode);

  const current =
    RECORDING_MODE_OPTIONS.find((o) => o.value === recordingMode.mode) ??
    RECORDING_MODE_OPTIONS[0];
  const recordOnly = effectiveRecordOnly(recordingMode, powerSource);
  const batteryKnown = powerSource !== "unknown";

  // "自動" alone doesn't say which of the other two it's currently acting as
  // -- the two-button layout this replaced showed that at a glance via which
  // button was filled in, so the live resolution is spelled out here instead.
  const triggerLabel =
    recordingMode.mode === "auto"
      ? `自動（${recordOnly ? "録音のみ" : "解析"}）`
      : current.label;
  const triggerTitle =
    recordingMode.mode === "auto" && !batteryKnown
      ? "自動：この環境では電源状態を取得できないため、常に解析として扱われます。"
      : current.description;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={recordOnly ? "default" : "ghost"}
          size="sm"
          title={triggerTitle}
        >
          <current.icon className="h-3.5 w-3.5" />
          {triggerLabel}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        collisionPadding={8}
        className="w-auto min-w-56 max-w-96"
      >
        <DropdownMenuRadioGroup
          value={recordingMode.mode}
          onValueChange={(v) => setRecordingMode(v as RecordingModeChoice)}
        >
          {RECORDING_MODE_OPTIONS.map((opt) => (
            <DropdownMenuRadioItem
              key={opt.value}
              value={opt.value}
              title={opt.description}
            >
              <opt.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              {opt.label}
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
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8">
      <RecordButton />
      <p className="text-sm text-muted-foreground">
        録音を開始すると、ここに文字起こし結果が表示されます。
      </p>
      <div className="flex flex-col gap-2">
        <MicPicker />
        <TargetAppPicker />
        <RecordingModePicker />
      </div>
    </div>
  );
}
