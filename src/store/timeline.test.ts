import { describe, it, expect, beforeEach } from "vitest";
import {
  peekNextSegmentId,
  consumeSegmentId,
  consumeSegmentIds,
  setNextSegmentId,
  getTimelineBaseSec,
  setTimelineBaseSec,
  getRecordingBaseSec,
  setRecordingBaseSec,
  getSegmentsBeforeRecording,
  setSegmentsBeforeRecording,
  resetTimeline,
} from "./timeline";

// This module holds module-scoped singleton state, so every test resets it
// through the same public setters the app uses -- there is no test-only
// backdoor into the private counters.
beforeEach(() => {
  setNextSegmentId(1);
  setTimelineBaseSec(0);
  setRecordingBaseSec(0);
  setSegmentsBeforeRecording(0);
});

describe("segment id counter", () => {
  it("consumeSegmentId returns the current id and advances by one", () => {
    expect(consumeSegmentId()).toBe(1);
    expect(consumeSegmentId()).toBe(2);
    expect(peekNextSegmentId()).toBe(3);
  });

  it("peekNextSegmentId does not advance the counter", () => {
    expect(peekNextSegmentId()).toBe(1);
    expect(peekNextSegmentId()).toBe(1);
  });

  it("consumeSegmentIds advances by count without returning a value read", () => {
    consumeSegmentIds(5);
    expect(peekNextSegmentId()).toBe(6);
  });

  it("setNextSegmentId jumps the counter directly, e.g. resuming a history entry", () => {
    setNextSegmentId(42);
    expect(consumeSegmentId()).toBe(42);
  });
});

describe("timeline base tracking", () => {
  it("getTimelineBaseSec/setTimelineBaseSec round-trip", () => {
    setTimelineBaseSec(12.5);
    expect(getTimelineBaseSec()).toBe(12.5);
  });

  it("getRecordingBaseSec/setRecordingBaseSec round-trip", () => {
    setRecordingBaseSec(7);
    expect(getRecordingBaseSec()).toBe(7);
  });

  it("getSegmentsBeforeRecording/setSegmentsBeforeRecording round-trip", () => {
    setSegmentsBeforeRecording(3);
    expect(getSegmentsBeforeRecording()).toBe(3);
  });
});

describe("resetTimeline", () => {
  it("restarts the segment id counter at 1 and the timeline base at 0", () => {
    consumeSegmentIds(10);
    setTimelineBaseSec(99);
    resetTimeline();
    expect(peekNextSegmentId()).toBe(1);
    expect(getTimelineBaseSec()).toBe(0);
  });

  it("does not touch recordingBaseSec or segmentsBeforeRecording -- those are set explicitly by the caller", () => {
    setRecordingBaseSec(15);
    setSegmentsBeforeRecording(4);
    resetTimeline();
    expect(getRecordingBaseSec()).toBe(15);
    expect(getSegmentsBeforeRecording()).toBe(4);
  });
});
