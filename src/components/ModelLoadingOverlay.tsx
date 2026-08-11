import { useAppStore } from "../store/appStore";

export function ModelLoadingOverlay() {
  const modelStatus = useAppStore((s) => s.modelStatus);
  const errorMessage = useAppStore((s) => s.errorMessage);

  if (modelStatus === "ready") return null;

  return (
    <div className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-white/90 backdrop-blur-sm">
      {modelStatus === "error" ? (
        <p className="max-w-sm text-center text-sm text-red-600">
          モデルの読み込みに失敗しました: {errorMessage}
        </p>
      ) : (
        <>
          <p className="text-sm text-neutral-600">音声認識モデルを読み込んでいます...</p>
          <div className="h-2 w-64 overflow-hidden rounded-full bg-neutral-200">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-neutral-900" />
          </div>
        </>
      )}
    </div>
  );
}
