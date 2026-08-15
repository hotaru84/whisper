/**
 * Bookkeeping for where a recording session's transcript segments and audio
 * events sit on the app's two running timelines. Kept behind functions
 * (rather than plain exported `let`s) so every read/write site is explicit
 * about which of the two timelines it means -- the distinction between
 * "global session timeline" and "this recording's own 0-based timeline" is
 * exactly the thing `PlaybackState.timelineOffsetSec`'s doc comment (in
 * `appStore.ts`) warns is easy to confuse.
 *
 * Used by both the recording lifecycle (`startRecording`/`loadHistoryEntry`
 * in `appStore.ts`) and the accuracy pipeline (`recordingPipeline.ts`), which
 * is why this lives in its own module rather than inside either.
 */

// Monotonic id for the next transcript segment to be created.
let segmentId = 1;
// Where the *next* recording's audio begins, on the session's global
// timeline -- so appended segments across multiple takes in one session
// stay on a continuous timeline.
let timelineBaseSec = 0;
// Where the *current* recording starts, on both the global timeline and in
// the segment list. The second pass (`refineRecording`/`finishRecordOnly`)
// replaces everything this recording produced, so it needs both.
let recordingBaseSec = 0;
let segmentsBeforeRecording = 0;

/** Reads the next segment id without consuming it -- e.g. to pass as the
 * starting id for a batch of segments about to be created. */
export function peekNextSegmentId(): number {
  return segmentId;
}

/** Reads the next segment id and advances the counter by one, for creating
 * exactly one segment (the streaming pass, one per committed window). */
export function consumeSegmentId(): number {
  return segmentId++;
}

/** Advances the counter by `count` without reading it, for a batch of
 * segments already assigned ids starting at `peekNextSegmentId()`. */
export function consumeSegmentIds(count: number): void {
  segmentId += count;
}

export function setNextSegmentId(id: number): void {
  segmentId = id;
}

export function getTimelineBaseSec(): number {
  return timelineBaseSec;
}

export function setTimelineBaseSec(sec: number): void {
  timelineBaseSec = sec;
}

export function getRecordingBaseSec(): number {
  return recordingBaseSec;
}

export function setRecordingBaseSec(sec: number): void {
  recordingBaseSec = sec;
}

export function getSegmentsBeforeRecording(): number {
  return segmentsBeforeRecording;
}

export function setSegmentsBeforeRecording(count: number): void {
  segmentsBeforeRecording = count;
}

/** Back to a fresh session: the next segment id restarts at 1 and the global
 * timeline restarts at 0. Used when a new recording starts while browsing a
 * past history entry, so the new take does not keep appending after it. */
export function resetTimeline(): void {
  segmentId = 1;
  timelineBaseSec = 0;
}
