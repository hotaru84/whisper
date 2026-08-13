import { Mic, Square, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import { useAppStore } from "../store/appStore";

export function RecordButton() {
  const recordingStatus = useAppStore((s) => s.recordingStatus);
  const modelStatus = useAppStore((s) => s.modelStatus);
  const startRecording = useAppStore((s) => s.startRecording);
  const stopRecording = useAppStore((s) => s.stopRecording);

  // Refining holds the model lock and rewrites the transcript, so starting the
  // next recording has to wait for it.
  const busy = recordingStatus === "processing" || recordingStatus === "refining";
  const disabled = modelStatus !== "ready" || busy;

  const handleClick = () => {
    if (recordingStatus === "recording") {
      void stopRecording();
    } else {
      void startRecording();
    }
  };

  return (
    <Button
      type="button"
      size="lg"
      variant={recordingStatus === "recording" ? "destructive" : "primary"}
      disabled={disabled}
      onClick={handleClick}
      className="h-16 w-16 rounded-full p-0"
      aria-label={recordingStatus === "recording" ? "録音を停止" : "録音を開始"}
    >
      {busy ? (
        <Loader2 className="h-6 w-6 animate-spin" />
      ) : recordingStatus === "recording" ? (
        <Square className="h-6 w-6" />
      ) : (
        <Mic className="h-6 w-6" />
      )}
    </Button>
  );
}
