import { useEffect, useState } from "react";
import { Mic, Square, Loader2, X } from "lucide-react";
import { Button } from "./ui/button";
import { useAppStore } from "../store/appStore";

/** How long a first tap on "中断" stays armed before it resets back to a
 * plain, un-armed button -- long enough to make the deliberate second tap
 * easy, short enough that walking away doesn't leave it primed to discard a
 * recording on the next accidental click. Mirrors the same tap-to-arm /
 * timeout pattern `HistoryRow`'s delete button already uses. */
const CONFIRM_TIMEOUT_MS = 3000;

/**
 * Discards the in-progress recording outright rather than stopping it
 * normally: no second pass, no history entry, as if it never started (see
 * `cancelRecording`'s doc comment). That is destructive enough, and sits
 * close enough to the primary stop button, to warrant a tap-to-arm step
 * instead of firing on a single click.
 */
function CancelButton() {
  const cancelRecording = useAppStore((s) => s.cancelRecording);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const id = setTimeout(() => setConfirming(false), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [confirming]);

  return (
    <Button
      type="button"
      size="lg"
      variant={confirming ? "destructive" : "outline"}
      className="h-12 rounded-full px-4"
      onClick={() => {
        if (!confirming) {
          setConfirming(true);
          return;
        }
        setConfirming(false);
        cancelRecording();
      }}
      aria-label={confirming ? "もう一度押すと録音を破棄します" : "録音を中断（保存せず破棄）"}
      title={confirming ? "もう一度押すと録音を破棄します" : "録音を中断（保存せず破棄）"}
    >
      <X className="h-4 w-4" />
      {confirming ? "本当に中断" : "中断"}
    </Button>
  );
}

export function RecordButton() {
  const recordingStatus = useAppStore((s) => s.recordingStatus);
  const modelStatus = useAppStore((s) => s.modelStatus);
  const startRecording = useAppStore((s) => s.startRecording);
  const stopRecording = useAppStore((s) => s.stopRecording);

  // Refining holds the model lock and rewrites the transcript, so starting the
  // next recording has to wait for it.
  const busy = recordingStatus === "processing" || recordingStatus === "refining";
  const disabled = modelStatus !== "ready" || busy;

  if (recordingStatus === "recording") {
    return (
      <div className="flex items-center gap-3">
        <CancelButton />
        <Button
          type="button"
          size="lg"
          variant="destructive"
          onClick={() => void stopRecording()}
          // The destructive variant is deliberately subtle (a tinted background,
          // for things like delete buttons) -- the stop button is the app's one
          // central action while recording and gets a bold, unmistakable fill
          // instead, using the same --signal red the rest of the app reserves
          // for "recording".
          className="h-16 w-16 rounded-full bg-signal p-0 text-white hover:bg-signal/90"
          aria-label="録音を停止して保存"
          title="録音を停止して保存"
        >
          <Square className="h-6 w-6" />
        </Button>
      </div>
    );
  }

  return (
    <Button
      type="button"
      size="lg"
      variant="default"
      disabled={disabled}
      onClick={() => void startRecording()}
      className="h-16 w-16 rounded-full p-0"
      aria-label="録音を開始"
    >
      {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : <Mic className="h-6 w-6" />}
    </Button>
  );
}
