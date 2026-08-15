import { Moon, Sun, MonitorCog } from "lucide-react";
import { Button } from "./ui/button";
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

/**
 * Cycles system -> light -> dark -> system. A single cycling button rather
 * than a three-way picker: there are only three states and the current one is
 * always drawn, so a menu would cost a click to show what the icon already
 * says.
 *
 * Lives in the sidebar's footer with the settings dialog -- both are
 * app-wide configuration consulted occasionally, unlike the titlebar's
 * controls which decide what the *next recording* captures.
 */
export function ThemeToggle() {
  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);

  return (
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
  );
}
