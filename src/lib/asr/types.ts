/**
 * Which backend the Rust side was built to run inference on.
 *
 * Reported from the build configuration, not a runtime probe: whisper.cpp only
 * announces whether a GPU device actually bound in a log line and offers no API
 * to ask afterwards, so a "vulkan" build that fell back to CPU still says
 * "vulkan".
 */
export type AsrDevice = "cpu" | "vulkan";

export type TranscriptionTask = "transcribe" | "translate";

export interface TranscriptChunk {
  text: string;
  timestamp: [number, number];
}
