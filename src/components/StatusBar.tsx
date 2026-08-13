import { useEffect, useState } from "react";
import { Moon, Sun, MonitorCog, Cpu, Zap, Mic, Cast } from "lucide-react";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { SettingsDialog } from "./SettingsDialog";
import { useAppStore } from "../store/appStore";
import { useThemeStore, type ThemePreference } from "../store/themeStore";

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

function formatElapsed(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** Elapsed time since `recordingStatus` last became "recording", ticking
 * every half second. Local to this component -- nothing else in the app
 * needs a live clock, so it isn't worth a store field. */
function useElapsedRecordingSec(recordingStatus: string): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (recordingStatus !== "recording") {
      setElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => clearInterval(id);
  }, [recordingStatus]);

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

  return (
    <div className="flex items-center gap-1">
      <Select
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
  const recordingStatus = useAppStore((s) => s.recordingStatus);
  const modelStatus = useAppStore((s) => s.modelStatus);
  const modelDevice = useAppStore((s) => s.modelDevice);
  const refineProgress = useAppStore((s) => s.refineProgress);
  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);
  const elapsed = useElapsedRecordingSec(recordingStatus);

  return (
    <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-2 text-sm">
      <div className="flex items-center gap-3">
        <InputControls />

        {recordingStatus === "recording" && (
          <span className="flex items-center gap-1.5 font-medium text-signal">
            <span className="h-2 w-2 animate-pulse rounded-full bg-signal motion-reduce:animate-none" aria-hidden="true" />
            録音中
            <span className="font-mono tabular-nums">{formatElapsed(elapsed)}</span>
          </span>
        )}
        {recordingStatus === "processing" && (
          <span className="text-muted-foreground">文字起こし処理中…</span>
        )}
        {recordingStatus === "refining" && (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            精度向上パス実行中…
            <span className="font-mono tabular-nums">{Math.round(refineProgress ?? 0)}%</span>
          </span>
        )}
        {(recordingStatus === "idle" || recordingStatus === "done" || recordingStatus === "error") &&
          modelStatus === "ready" &&
          modelDevice && (
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
