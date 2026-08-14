import { useEffect, useRef, useState } from "react";
import { Moon, Sun, MonitorCog, Cpu, Zap, Mic, Cast, FileAudio } from "lucide-react";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { SettingsDialog } from "./SettingsDialog";
import { useAppStore, type RecordingPhase } from "../store/appStore";
import { useThemeStore, type ThemePreference } from "../store/themeStore";
import { formatTimestamp } from "../lib/format";

const NEXT_THEME: Record<ThemePreference, ThemePreference> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const THEME_LABEL: Record<ThemePreference, string> = {
  system: "テーマ: システムに合わせる",
  light: "テーマ: ライト",
  dark: "テーマ: ダーク",
};

const NO_APP_TARGET = "__none__";

/**
 * How long the current take has actually been capturing, ticking every half
 * second. Local to this component -- nothing else in the app needs a live
 * clock, so it isn't worth a store field.
 *
 * Sums only the *active* spans rather than measuring from a single start
 * timestamp: paused time is not recorded, so counting it would make the
 * display disagree with the WAV's real duration and with every segment offset.
 * Accumulating across spans is also what keeps a resume from resetting the
 * readout to 0:00, which a plain `Date.now() - startedAt` keyed on the phase
 * would do every time.
 */
function useElapsedRecordingSec(recordingPhase: RecordingPhase): number {
  const [elapsed, setElapsed] = useState(0);
  const activeSecRef = useRef(0);

  useEffect(() => {
    if (recordingPhase === "stopped") {
      activeSecRef.current = 0;
      setElapsed(0);
      return;
    }
    if (recordingPhase === "paused") return; // freeze, keeping the accumulated total

    const spanStart = Date.now();
    const base = activeSecRef.current;
    const id = setInterval(() => setElapsed(Math.floor(base + (Date.now() - spanStart) / 1000)), 500);
    return () => {
      activeSecRef.current = base + (Date.now() - spanStart) / 1000;
      clearInterval(id);
    };
  }, [recordingPhase]);

  return elapsed;
}

/**
 * Mic device + app-audio target, front and center in the toolbar rather than
 * behind the settings dialog: unlike the accuracy-pass knobs, these are
 * switched often (a different mic per desk, a different call app per
 * meeting) and benefit from being one click away instead of two. Opening the
 * app-audio dropdown refreshes the list itself -- see `refreshAppAudioApps`'s
 * doc comment on why only currently-active sessions are listable -- so there
 * is no separate "更新" button to remember to press.
 */
function InputControls() {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const audioInputDevices = useAppStore((s) => s.audioInputDevices);
  const appAudioApps = useAppStore((s) => s.appAudioApps);
  const appAudioTargetPid = useAppStore((s) => s.appAudioTargetPid);
  const setAppAudioTarget = useAppStore((s) => s.setAppAudioTarget);
  const refreshAppAudioApps = useAppStore((s) => s.refreshAppAudioApps);
  const recordOnly = useAppStore((s) => s.recordingMode.recordOnly);
  const updateRecordingMode = useAppStore((s) => s.updateRecordingMode);
  const processing = useAppStore((s) => s.processing);
  // All three controls only take effect at `startRecording`, so leaving them
  // live mid-take would let the user change a setting that silently does
  // nothing until the next recording.
  const locked = useAppStore((s) => s.recordingPhase) !== "stopped";
  // The mode toggle is held for longer than the pickers: flipping it *off*
  // starts loading the model, which would then contend with a post-stop pass
  // that is still running.
  const modeLocked = locked || processing !== null;

  return (
    <div className="flex items-center gap-1">
      <Select
        disabled={locked}
        value={settings.inputDeviceId || "__default__"}
        onValueChange={(v) => updateSettings({ inputDeviceId: v === "__default__" ? "" : v })}
      >
        <SelectTrigger size="sm" className="max-w-32 border-none shadow-none" aria-label="マイク">
          <Mic className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__default__">既定のマイク</SelectItem>
          {audioInputDevices.map((d) => (
            <SelectItem key={d.deviceId} value={d.deviceId}>
              {d.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        disabled={locked}
        value={appAudioTargetPid != null ? String(appAudioTargetPid) : NO_APP_TARGET}
        onValueChange={(v) => setAppAudioTarget(v === NO_APP_TARGET ? null : Number(v))}
        onOpenChange={(open) => {
          if (open) void refreshAppAudioApps();
        }}
      >
        <SelectTrigger size="sm" className="max-w-36 border-none shadow-none" aria-label="対象アプリ（相手の音声も録音）">
          <Cast className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <SelectValue placeholder="対象アプリなし" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_APP_TARGET}>対象アプリなし（マイクのみ）</SelectItem>
          {appAudioApps.map((a) => (
            <SelectItem key={a.processId} value={String(a.processId)}>
              <span className="flex items-center gap-1.5">
                {a.icon ? (
                  <img src={a.icon} alt="" className="h-4 w-4 shrink-0" />
                ) : (
                  <Cast className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                {a.name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Labelled, not icon-only, unlike everything else on this strip: the
          mic and app pickers show their own current value, but this one's
          effect is an *absence* (no live transcript appears) that no icon
          conveys on its own. The tooltip carries the why; the label carries
          the what. */}
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

/**
 * The one place "what is the app doing right now" lives, always visible
 * regardless of what's in the main content area (the live transcript, or a
 * history entry) -- see the design plan's layout rationale. Recording state,
 * model device, and the second-pass progress used to be scattered across
 * `ModelLoadingOverlay` and `RecordButton`'s icon; this consolidates the
 * ambient parts of that into one persistent strip.
 */
export function StatusBar() {
  const recordingPhase = useAppStore((s) => s.recordingPhase);
  const processing = useAppStore((s) => s.processing);
  const modelStatus = useAppStore((s) => s.modelStatus);
  const modelDevice = useAppStore((s) => s.modelDevice);
  const refineProgress = useAppStore((s) => s.refineProgress);
  const recordOnly = useAppStore((s) => s.recordingMode.recordOnly);
  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);
  const elapsed = useElapsedRecordingSec(recordingPhase);

  // One slot, five mutually exclusive occupants: the take's own state wins
  // while one exists, then the post-stop pipeline, then the idle chip -- which
  // is the mode chip in record-only mode and the device chip otherwise. The
  // two can't collide: record-only mode never loads a model, so
  // `showDeviceChip`'s "ready" requirement already fails there.
  const idleChip = recordingPhase === "stopped" && processing === null;
  const showDeviceChip = idleChip && modelStatus === "ready" && modelDevice;

  return (
    <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-2 text-sm">
      <div className="flex items-center gap-3">
        <InputControls />

        {recordingPhase === "recording" && (
          <span className="flex items-center gap-1.5 font-medium text-signal">
            <span className="h-2 w-2 animate-pulse rounded-full bg-signal motion-reduce:animate-none" aria-hidden="true" />
            録音中
            <span className="font-mono tabular-nums">{formatTimestamp(elapsed)}</span>
          </span>
        )}
        {recordingPhase === "paused" && (
          // Same signal red (a take is still open) but a static dot, matching
          // the record button's pulse/no-pulse split for the same two states.
          <span className="flex items-center gap-1.5 font-medium text-signal">
            <span className="h-2 w-2 rounded-full bg-signal" aria-hidden="true" />
            一時停止中
            <span className="font-mono tabular-nums">{formatTimestamp(elapsed)}</span>
          </span>
        )}
        {processing === "transcribing" && <span className="text-muted-foreground">文字起こし処理中…</span>}
        {processing === "saving" && <span className="text-muted-foreground">録音を保存中…</span>}
        {processing === "refining" && (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            精度向上パス実行中…
            <span className="font-mono tabular-nums">{Math.round(refineProgress ?? 0)}%</span>
          </span>
        )}
        {idleChip && recordOnly && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <FileAudio className="h-3 w-3" />
            録音のみ（文字起こしはあとで）
          </span>
        )}
        {showDeviceChip && !recordOnly && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            {modelDevice === "vulkan" ? <Zap className="h-3 w-3" /> : <Cpu className="h-3 w-3" />}
            {modelDevice === "vulkan" ? "Vulkan (GPU)" : "CPU"}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={THEME_LABEL[preference]}
          title={THEME_LABEL[preference]}
          onClick={() => setPreference(NEXT_THEME[preference])}
        >
          {preference === "system" ? (
            <MonitorCog className="h-4 w-4" />
          ) : preference === "dark" ? (
            <Moon className="h-4 w-4" />
          ) : (
            <Sun className="h-4 w-4" />
          )}
        </Button>
        <SettingsDialog />
      </div>
    </div>
  );
}
