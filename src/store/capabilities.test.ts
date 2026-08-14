import { describe, it, expect } from "vitest";
import { selectCapabilities, type RecordingPhase, type ProcessingPhase, type ModelStatus } from "./capabilities";

const RECORDING_PHASES: RecordingPhase[] = ["stopped", "recording", "paused"];
const PROCESSING_PHASES: ProcessingPhase[] = ["transcribing", "refining", "saving", null];
const MODEL_STATUSES: ModelStatus[] = ["idle", "loading", "ready", "error"];

describe("selectCapabilities", () => {
  it("allows starting a record-only take without a loaded model", () => {
    const can = selectCapabilities({
      recordingPhase: "stopped",
      processing: null,
      modelStatus: "idle",
      recordOnly: true,
    });
    expect(can.startRecording).toBe(true);
  });

  it("still requires a ready model outside record-only mode", () => {
    const can = selectCapabilities({
      recordingPhase: "stopped",
      processing: null,
      modelStatus: "idle",
      recordOnly: false,
    });
    expect(can.startRecording).toBe(false);
  });

  it("does not let a new take start while the previous one is still saving", () => {
    // This is the entire reason ProcessingPhase has a "saving" value: without
    // it, the gap between a record-only take stopping and its sidecar being
    // written would briefly re-enable the record button.
    const can = selectCapabilities({
      recordingPhase: "stopped",
      processing: "saving",
      modelStatus: "idle",
      recordOnly: true,
    });
    expect(can.startRecording).toBe(false);
  });

  it("does not let a record-only take start while a take is already live", () => {
    const can = selectCapabilities({
      recordingPhase: "recording",
      processing: null,
      modelStatus: "idle",
      recordOnly: true,
    });
    expect(can.startRecording).toBe(false);
  });

  it("keeps reanalyze available whenever idle, regardless of model status", () => {
    for (const modelStatus of MODEL_STATUSES) {
      const can = selectCapabilities({
        recordingPhase: "stopped",
        processing: null,
        modelStatus,
        recordOnly: false,
      });
      expect(can.reanalyze).toBe(true);
    }
  });

  it("never returns startRecording=true while a take is open, regardless of mode", () => {
    for (const recordingPhase of ["recording", "paused"] as const) {
      for (const recordOnly of [true, false]) {
        const can = selectCapabilities({ recordingPhase, processing: null, modelStatus: "ready", recordOnly });
        expect(can.startRecording).toBe(false);
      }
    }
  });

  it("covers every state combination without throwing and keeps stop/browseHistory/playback/editSettings mutually consistent with recordingPhase", () => {
    for (const recordingPhase of RECORDING_PHASES) {
      for (const processing of PROCESSING_PHASES) {
        for (const modelStatus of MODEL_STATUSES) {
          for (const recordOnly of [true, false]) {
            const can = selectCapabilities({ recordingPhase, processing, modelStatus, recordOnly });
            const stopped = recordingPhase === "stopped";
            expect(can.stop).toBe(!stopped);
            expect(can.browseHistory).toBe(stopped);
            expect(can.playback).toBe(stopped);
            expect(can.editSettings).toBe(stopped);
            expect(can.pause).toBe(recordingPhase === "recording");
            expect(can.resume).toBe(recordingPhase === "paused");
            // startRecording/reanalyze can only ever be true while idle.
            const idle = stopped && processing === null;
            if (!idle) {
              expect(can.startRecording).toBe(false);
              expect(can.reanalyze).toBe(false);
            }
          }
        }
      }
    }
  });
});
