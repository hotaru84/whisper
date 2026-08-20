/**
 * Drives `StreamingTranscriber` from a finished recording's WAV file instead
 * of live mic frames, for record-only mode's deferred analysis and history
 * "再解析" -- the two places that need to transcribe a recording that was
 * never (or only partly) transcribed live.
 *
 * Kept decoupled from `asrClient`/`runWhisperTask`, same as `streaming.ts`
 * itself: the caller (`recordingPipeline.ts`'s `runPostHocAnalysis`) supplies
 * `transcribe` and `readWavPcm` as plain callbacks, so this module stays a
 * "lib" concern with no knowledge of the Zustand store or the whisper
 * priority queue.
 *
 * **Resumable by construction, not by any state this module holds.** Nothing
 * here remembers anything across calls -- a fresh `StreamingTranscriber` is
 * built every time. What makes resuming work is entirely the caller's job:
 * pass `fromSec` at wherever the recording's `analyzedThroughSec` cursor left
 * off, and `existingSegments` so newly committed segments get ids that
 * continue rather than collide.
 */
import type { TranscribeResult } from "./client";
import type { HallucinationSettings } from "./client";
import { isCancelledError } from "./cancel";
import { StreamingTranscriber } from "./streaming";
import type { TranscriptSegment } from "../transcript";

export interface PostHocOutcome {
  /** Whether this run stopped early because the caller's `wasCancelled`
   * check (or `readWavPcm` itself) reported a cancellation. `false` means
   * every window from `fromSec` to the end of the recording was decoded. */
  cancelled: boolean;
  /** New resume cursor, in absolute recording-seconds -- pass this back as
   * the next call's `fromSec` if `cancelled` is `true`. Equals the
   * recording's own `totalSec` when `cancelled` is `false`. */
  analyzedThroughSec: number;
  /** Freshly committed segments, numbered starting at
   * `existingSegments.length + 1`. Does not include `existingSegments`
   * themselves -- the caller concatenates, mirroring what `onSegmentPersist`
   * already received incrementally. */
  newSegments: TranscriptSegment[];
}

/**
 * Transcribes `[fromSec, totalSec)` of a recording via `readWavPcm`-supplied
 * PCM, committing windows through the same chunk-and-commit logic the live
 * pass uses.
 *
 * `onSegmentPersist` fires after every committed window with the full
 * segment list so far (`existingSegments` plus every new segment committed
 * up to and including this one) and the cursor that describes it -- the
 * caller is expected to write this to the history sidecar each time, which
 * is what makes a cancellation lose nothing: by the time this function can
 * even notice a cancel request, whatever was already committed is already on
 * disk.
 *
 * `wasCancelled` is threaded into `StreamingTranscriber`'s `shouldStop`
 * option (see that module's doc comment for why post-hoc PCM -- arriving far
 * faster than decoding can keep up -- needs an explicit stop hook that the
 * live path never did). A window already decoding when cancellation is
 * noticed still finishes and commits; only the next window is skipped.
 */
export async function transcribeWavPostHoc(
  transcribe: (audio: Float32Array) => Promise<TranscribeResult>,
  readWavPcm: (fromSec: number, onChunk: (chunk: Float32Array) => void) => Promise<void>,
  fromSec: number,
  totalSec: number,
  existingSegments: TranscriptSegment[],
  hallucinationSettings: HallucinationSettings,
  onSegmentPersist: (allSegmentsSoFar: TranscriptSegment[], analyzedThroughSec: number) => void,
  onProgress?: (analyzedThroughSec: number, totalSec: number) => void,
  wasCancelled?: () => boolean,
): Promise<PostHocOutcome> {
  const newSegments: TranscriptSegment[] = [];
  let analyzedThroughSec = fromSec;
  let nextId = existingSegments.length + 1;

  const streamer = new StreamingTranscriber(
    transcribe,
    (seg) => {
      // seg.offsetSec is relative to where *this* stream started (0), and
      // seg.chunks[].timestamp are relative to seg.offsetSec (the window's
      // own start) -- see this module's own doc comment and streaming.ts's
      // processWindow. Absolute recording-seconds is therefore fromSec plus
      // both.
      const segRelativeEnd = seg.chunks.length > 0 ? Math.max(...seg.chunks.map((c) => c.timestamp[1])) : 0;
      analyzedThroughSec = fromSec + seg.offsetSec + segRelativeEnd;

      newSegments.push({
        id: nextId,
        startOffsetSec: fromSec + seg.offsetSec,
        text: seg.text,
        chunks: seg.chunks,
      });
      nextId += 1;

      onProgress?.(analyzedThroughSec, totalSec);
      onSegmentPersist([...existingSegments, ...newSegments], analyzedThroughSec);
    },
    { silenceRms: hallucinationSettings.silenceRms, shouldStop: wasCancelled },
  );

  // Reported once up front, before the first window even completes, so a
  // resumed job's progress bar starts wherever fromSec already put it rather
  // than snapping to 0% and then jumping -- see `analysisQueue.ts`'s
  // `onProgress` fix.
  onProgress?.(analyzedThroughSec, totalSec);

  try {
    await readWavPcm(fromSec, (chunk) => streamer.pushFrame(chunk));
  } catch (err) {
    if (!isCancelledError(err)) throw err;
  }

  // Always flush: if cancellation was noticed, shouldStop makes this a
  // near no-op (nothing further gets decoded) rather than force-draining
  // whatever PCM arrived before the cancel was seen.
  await streamer.finish();

  const cancelled = wasCancelled?.() ?? false;
  if (!cancelled) analyzedThroughSec = totalSec;

  return { cancelled, analyzedThroughSec, newSegments };
}
