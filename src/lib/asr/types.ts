// Always "cpu" for the native whisper.cpp backend today; kept as a type in case
// GPU-accelerated inference (CUDA/Vulkan) is added later.
export type AsrDevice = "cpu";

export type TranscriptionTask = "transcribe" | "translate";

export interface TranscriptChunk {
  text: string;
  timestamp: [number, number];
}
