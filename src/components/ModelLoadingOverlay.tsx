import { useAppStore } from "../store/appStore";

export function ModelLoadingOverlay() {
  const modelStatus = useAppStore((s) => s.modelStatus);
  const errorMessage = useAppStore((s) => s.errorMessage);

  // "idle" is the model not being loaded on purpose -- record-only mode never
  // asks for it, and a session that starts there must not be greeted by a
  // blocking overlay for a load that is never going to happen.
  if (modelStatus === "ready" || modelStatus === "idle") return null;

  return (
    <div className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-background/90 backdrop-blur-sm">
      {modelStatus === "error" ? (
        <p className="max-w-sm text-center text-sm text-destructive">
          モデルの読み込みに失敗しました: {errorMessage}
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">音声認識モデルを読み込んでいます...</p>
          <div className="h-2 w-64 overflow-hidden rounded-full bg-muted">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-foreground motion-reduce:animate-none" />
          </div>
        </>
      )}
    </div>
  );
}
