import { create } from "zustand";

export type ThemePreference = "light" | "dark" | "system";

const THEME_KEY = "theme-settings";

/** Same persistence shape as appStore's settings: localStorage is a
 * convenience, so a missing/corrupt value just falls back silently. */
function loadThemePreference(): ThemePreference {
  try {
    const stored = globalThis.localStorage?.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  } catch {
    return "system";
  }
}

function saveThemePreference(pref: ThemePreference): void {
  try {
    globalThis.localStorage?.setItem(THEME_KEY, pref);
  } catch {
    // Persistence is a convenience; losing it is not worth surfacing an error.
  }
}

function systemPrefersDark(): boolean {
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function resolveIsDark(pref: ThemePreference): boolean {
  return pref === "system" ? systemPrefersDark() : pref === "dark";
}

/** The only place `.dark` is touched -- `index.css`'s `@custom-variant dark`
 * keys off this class on the root element. */
function applyTheme(isDark: boolean): void {
  document.documentElement.classList.toggle("dark", isDark);
}

interface ThemeState {
  preference: ThemePreference;
  isDark: boolean;
  setPreference: (pref: ThemePreference) => void;
}

export const useThemeStore = create<ThemeState>((set) => {
  const preference = loadThemePreference();
  const isDark = resolveIsDark(preference);
  // Applied synchronously at module init (before first paint) rather than in
  // an effect, so the app never flashes the wrong theme on load.
  applyTheme(isDark);

  return {
    preference,
    isDark,
    setPreference: (preference) => {
      saveThemePreference(preference);
      const isDark = resolveIsDark(preference);
      applyTheme(isDark);
      set({ preference, isDark });
    },
  };
});

// Keeps "system" preference live if the OS theme changes while the app stays
// open, rather than only resolving it once at startup.
globalThis.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (useThemeStore.getState().preference !== "system") return;
  const isDark = systemPrefersDark();
  applyTheme(isDark);
  useThemeStore.setState({ isDark });
});
