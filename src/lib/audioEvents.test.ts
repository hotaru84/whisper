import { describe, expect, it } from "vitest";
import { audioEventLabelJa, isNoiseOrMusicEvent } from "./audioEvents";

describe("audioEventLabelJa", () => {
  it("translates a known AudioSet class", () => {
    expect(audioEventLabelJa("Music")).toBe("音楽");
    expect(audioEventLabelJa("Applause")).toBe("拍手");
  });

  it("falls back to the original English name for an untranslated class", () => {
    expect(audioEventLabelJa("Ukulele")).toBe("Ukulele");
  });
});

describe("isNoiseOrMusicEvent", () => {
  it("flags music and noise labels", () => {
    expect(isNoiseOrMusicEvent("Music")).toBe(true);
    expect(isNoiseOrMusicEvent("Environmental noise")).toBe(true);
    expect(isNoiseOrMusicEvent("White noise")).toBe(true);
    expect(isNoiseOrMusicEvent("Static")).toBe(true);
  });

  it("does not flag speech or unrelated labels", () => {
    expect(isNoiseOrMusicEvent("Speech")).toBe(false);
    expect(isNoiseOrMusicEvent("Applause")).toBe(false);
    expect(isNoiseOrMusicEvent("Door")).toBe(false);
  });
});
