import { describe, it, expect } from "vitest";
import { toAudioInputDevices } from "./devices";

function device(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: "", toJSON: () => ({}) };
}

describe("toAudioInputDevices", () => {
  it("keeps only audioinput devices", () => {
    const out = toAudioInputDevices([
      device("audioinput", "mic1", "USB Microphone"),
      device("audiooutput", "spk1", "Speakers"),
      device("videoinput", "cam1", "Webcam"),
    ]);
    expect(out).toEqual([{ deviceId: "mic1", label: "USB Microphone" }]);
  });

  it("returns an empty array when there are no microphones", () => {
    expect(toAudioInputDevices([])).toEqual([]);
    expect(toAudioInputDevices([device("audiooutput", "spk1", "Speakers")])).toEqual([]);
  });

  it("synthesizes a 1-indexed placeholder label when the real one is empty", () => {
    // MediaDeviceInfo.label is "" until the page has microphone permission.
    const out = toAudioInputDevices([
      device("audioinput", "mic1", ""),
      device("audioinput", "mic2", ""),
    ]);
    expect(out).toEqual([
      { deviceId: "mic1", label: "マイク 1" },
      { deviceId: "mic2", label: "マイク 2" },
    ]);
  });

  it("numbers only the unlabeled devices, independent of their position", () => {
    const out = toAudioInputDevices([
      device("audioinput", "mic1", "Real Name"),
      device("audioinput", "mic2", ""),
      device("audioinput", "mic3", ""),
    ]);
    expect(out.map((d) => d.label)).toEqual(["Real Name", "マイク 1", "マイク 2"]);
  });

  it("preserves device order", () => {
    const out = toAudioInputDevices([
      device("audioinput", "b", "B"),
      device("audioinput", "a", "A"),
    ]);
    expect(out.map((d) => d.deviceId)).toEqual(["b", "a"]);
  });
});
