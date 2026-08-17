import { describe, it, expect, afterEach } from "vitest";
import { watchPowerSource } from "./power";

class FakeBatteryManager extends EventTarget {
  charging: boolean;
  constructor(charging: boolean) {
    super();
    this.charging = charging;
  }
  setCharging(charging: boolean) {
    this.charging = charging;
    this.dispatchEvent(new Event("chargingchange"));
  }
}

describe("watchPowerSource", () => {
  const originalGetBattery = (navigator as { getBattery?: unknown }).getBattery;

  afterEach(() => {
    (navigator as { getBattery?: unknown }).getBattery = originalGetBattery;
  });

  it("reports 'unknown' when the browser has no Battery Status API", () => {
    delete (navigator as { getBattery?: unknown }).getBattery;
    const readings: string[] = [];
    const dispose = watchPowerSource((s) => readings.push(s));
    expect(readings).toEqual(["unknown"]);
    dispose();
  });

  it("reports 'unknown' when getBattery() itself rejects", async () => {
    (navigator as { getBattery?: unknown }).getBattery = () => Promise.reject(new Error("denied"));
    const readings: string[] = [];
    watchPowerSource((s) => readings.push(s));
    await new Promise((r) => setTimeout(r, 0));
    expect(readings).toEqual(["unknown"]);
  });

  it("reports the current reading once resolvable, then again on change", async () => {
    const battery = new FakeBatteryManager(true); // plugged in
    (navigator as { getBattery?: unknown }).getBattery = () => Promise.resolve(battery);

    const readings: string[] = [];
    watchPowerSource((s) => readings.push(s));
    await new Promise((r) => setTimeout(r, 0));
    expect(readings).toEqual(["ac"]);

    battery.setCharging(false); // unplugged
    expect(readings).toEqual(["ac", "battery"]);

    battery.setCharging(true); // plugged back in
    expect(readings).toEqual(["ac", "battery", "ac"]);
  });

  it("stops reporting after being disposed", async () => {
    const battery = new FakeBatteryManager(true);
    (navigator as { getBattery?: unknown }).getBattery = () => Promise.resolve(battery);

    const readings: string[] = [];
    const dispose = watchPowerSource((s) => readings.push(s));
    await new Promise((r) => setTimeout(r, 0));
    dispose();

    battery.setCharging(false);
    expect(readings).toEqual(["ac"]);
  });

  it("does not report if disposed before getBattery() resolves", async () => {
    const battery = new FakeBatteryManager(true);
    let resolveBattery!: (b: FakeBatteryManager) => void;
    (navigator as { getBattery?: unknown }).getBattery = () =>
      new Promise((resolve) => {
        resolveBattery = resolve;
      });

    const readings: string[] = [];
    const dispose = watchPowerSource((s) => readings.push(s));
    dispose();
    resolveBattery(battery);
    await new Promise((r) => setTimeout(r, 0));

    expect(readings).toEqual([]);
  });
});
