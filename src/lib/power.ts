/**
 * Reports whether the machine is running on battery or mains power, for the
 * "自動" recording mode choice (`RecordingModeSettings.mode === "auto"`):
 * record-only while on battery, the normal analyzed take otherwise -- see
 * `capabilities.ts`'s `effectiveRecordOnly`, the one place that decision is
 * actually made.
 *
 * Uses the (non-standard) Battery Status API rather than a Tauri/Rust command.
 * The spec was withdrawn over fingerprinting concerns and Firefox/Safari
 * dropped it, but Chromium kept `navigator.getBattery()` -- and Chromium, via
 * WebView2, is the only runtime this app ships on. Kept in `lib/`, not
 * `lib/audio/`, since it has nothing to do with sound; it's a browser
 * capability query the same way `lib/audio/devices.ts` is, just for power
 * instead of microphones.
 */

export type PowerSource = "battery" | "ac" | "unknown";

/** The parts of the Battery Status API this module reads. Not in `lib.dom.d.ts`
 * -- the spec was withdrawn before TypeScript ever shipped types for it. */
interface BatteryManager extends EventTarget {
  charging: boolean;
}

interface NavigatorWithBattery extends Navigator {
  getBattery?: () => Promise<BatteryManager>;
}

/**
 * Watches the machine's power source, calling `onChange` once with the
 * current reading (as soon as it can be taken) and again on every change.
 * Returns a disposer.
 *
 * `"unknown"` covers both "this browser has no Battery Status API" and "the
 * call itself failed" -- both are handled identically by every caller: treat
 * it as mains power. That default matters because it is the one that keeps
 * transcription running; the opposite default would mean a browser that
 * simply cannot answer this question silently drops into record-only and the
 * user never finds out why nothing was transcribed.
 */
export function watchPowerSource(onChange: (source: PowerSource) => void): () => void {
  const nav = navigator as NavigatorWithBattery;
  if (typeof nav.getBattery !== "function") {
    onChange("unknown");
    return () => {};
  }

  let disposed = false;
  let battery: BatteryManager | null = null;
  const report = () => {
    if (battery) onChange(battery.charging ? "ac" : "battery");
  };

  nav
    .getBattery()
    .then((b) => {
      if (disposed) return;
      battery = b;
      report();
      b.addEventListener("chargingchange", report);
    })
    .catch(() => {
      if (!disposed) onChange("unknown");
    });

  return () => {
    disposed = true;
    battery?.removeEventListener("chargingchange", report);
  };
}
