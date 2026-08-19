import { describe, it, expect } from "vitest";
import { selectCapabilities, effectiveRecordOnly, type RecordingPhase, type ModelStatus } from "./capabilities";

const RECORDING_PHASES: RecordingPhase[] = ["stopped", "recording", "paused"];
const MODEL_STATUSES: ModelStatus[] = ["idle", "loading", "ready", "error"];

describe("selectCapabilities", () => {
  it("allows starting a record-only take without a loaded model", () => {
    const can = selectCapabilities({
      recordingPhase: "stopped",
      modelStatus: "idle",
      recordOnly: true,
    });
    expect(can.startRecording).toBe(true);
  });

  it("still requires a ready model outside record-only mode", () => {
    const can = selectCapabilities({
      recordingPhase: "stopped",
      modelStatus: "idle",
      recordOnly: false,
    });
    expect(can.startRecording).toBe(false);
  });

  it("does not let a record-only take start while a take is already live", () => {
    const can = selectCapabilities({
      recordingPhase: "recording",
      modelStatus: "idle",
      recordOnly: true,
    });
    expect(can.startRecording).toBe(false);
  });

  it("keeps reanalyze available whenever stopped, regardless of model status", () => {
    for (const modelStatus of MODEL_STATUSES) {
      const can = selectCapabilities({
        recordingPhase: "stopped",
        modelStatus,
        recordOnly: false,
      });
      expect(can.reanalyze).toBe(true);
    }
  });

  it("never returns startRecording=true while a take is open, regardless of mode", () => {
    for (const recordingPhase of ["recording", "paused"] as const) {
      for (const recordOnly of [true, false]) {
        const can = selectCapabilities({ recordingPhase, modelStatus: "ready", recordOnly });
        expect(can.startRecording).toBe(false);
      }
    }
  });

  it("does not let a second record press start while the first is still in its async setup window", () => {
    // Otherwise idle -- this is exactly the state a rapid double-click on
    // record would land the second call in, since recordingPhase itself
    // doesn't flip to "recording" until the first call's setup finishes.
    const can = selectCapabilities({
      recordingPhase: "stopped",
      modelStatus: "ready",
      recordOnly: false,
      startingRecording: true,
    });
    expect(can.startRecording).toBe(false);
  });

  it("does not let a take start when no auto-save folder is configured", () => {
    const can = selectCapabilities({
      recordingPhase: "stopped",
      modelStatus: "ready",
      recordOnly: false,
      directoryConfigured: false,
    });
    expect(can.startRecording).toBe(false);
  });

  it("blocks a record-only take too when no folder is configured", () => {
    // Record-only mode skips the model-ready check, but a save folder is
    // still required -- it has nowhere else to write the WAV to.
    const can = selectCapabilities({
      recordingPhase: "stopped",
      modelStatus: "idle",
      recordOnly: true,
      directoryConfigured: false,
    });
    expect(can.startRecording).toBe(false);
  });

  it("defaults directoryConfigured to true for call sites that don't pass it", () => {
    const can = selectCapabilities({
      recordingPhase: "stopped",
      modelStatus: "ready",
      recordOnly: false,
    });
    expect(can.startRecording).toBe(true);
  });

  it("makes startRecording/reanalyze available immediately whenever stopped, independent of any recording's analysis state", () => {
    // Deliberate behavior change: this used to also require a global
    // `processing === null` (see the removed `ProcessingPhase` axis), which
    // meant one recording's background analysis blocked starting or
    // requesting another entirely. Recording/analysis concurrency
    // (`src/lib/asr/whisperQueue.ts`, `src/store/analysisQueue.ts`) replaced
    // that gate, so `selectCapabilities` no longer has -- or needs -- any
    // input describing analysis state at all.
    for (const modelStatus of MODEL_STATUSES) {
      for (const recordOnly of [true, false]) {
        if (!recordOnly && modelStatus !== "ready") continue;
        const can = selectCapabilities({ recordingPhase: "stopped", modelStatus, recordOnly });
        expect(can.startRecording).toBe(true);
        expect(can.reanalyze).toBe(true);
      }
    }
  });

  it("covers every state combination without throwing and keeps stop/browseHistory/playback/editSettings/reanalyze mutually consistent with recordingPhase", () => {
    for (const recordingPhase of RECORDING_PHASES) {
      for (const modelStatus of MODEL_STATUSES) {
        for (const recordOnly of [true, false]) {
          const can = selectCapabilities({ recordingPhase, modelStatus, recordOnly });
          const stopped = recordingPhase === "stopped";
          expect(can.stop).toBe(!stopped);
          expect(can.browseHistory).toBe(stopped);
          expect(can.playback).toBe(stopped);
          expect(can.editSettings).toBe(stopped);
          expect(can.reanalyze).toBe(stopped);
          expect(can.pause).toBe(recordingPhase === "recording");
          expect(can.resume).toBe(recordingPhase === "paused");
        }
      }
    }
  });
});

describe("effectiveRecordOnly", () => {
  it("is exactly the chosen mode, regardless of power source", () => {
    expect(effectiveRecordOnly({ mode: "recordOnly" }, "battery")).toBe(true);
    expect(effectiveRecordOnly({ mode: "recordOnly" }, "ac")).toBe(true);
    expect(effectiveRecordOnly({ mode: "analyze" }, "battery")).toBe(false);
    expect(effectiveRecordOnly({ mode: "analyze" }, "ac")).toBe(false);
  });

  it("follows the power source in auto mode", () => {
    expect(effectiveRecordOnly({ mode: "auto" }, "battery")).toBe(true);
    expect(effectiveRecordOnly({ mode: "auto" }, "ac")).toBe(false);
  });

  it("resolves an unknown power source to the analyzed take, never record-only", () => {
    expect(effectiveRecordOnly({ mode: "auto" }, "unknown")).toBe(false);
  });
});
