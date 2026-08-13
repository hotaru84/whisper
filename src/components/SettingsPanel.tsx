import { Info, RefreshCw } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./ui/accordion";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { useAppStore } from "../store/appStore";
import { SUPPORTED_LANGUAGES } from "../lib/asr";

/**
 * Practical size of the glossary, in characters.
 *
 * whisper caps `initial_prompt` at `n_text_ctx / 2` = 224 tokens for
 * large-v3-turbo, and measured on this model Japanese runs at roughly one token
 * per character (「議事録」3 chars / 3 tokens, 「与信管理」4 / 5). Anything past
 * the cap is dropped from the front, silently.
 */
const GLOSSARY_LIMIT = 200;

export function SettingsPanel() {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const diarizeSettings = useAppStore((s) => s.diarizeSettings);
  const updateDiarizeSettings = useAppStore((s) => s.updateDiarizeSettings);
  const vadSettings = useAppStore((s) => s.vadSettings);
  const updateVadSettings = useAppStore((s) => s.updateVadSettings);
  const audioEventSettings = useAppStore((s) => s.audioEventSettings);
  const updateAudioEventSettings = useAppStore((s) => s.updateAudioEventSettings);
  const appAudioSettings = useAppStore((s) => s.appAudioSettings);
  const updateAppAudioSettings = useAppStore((s) => s.updateAppAudioSettings);
  const appAudioApps = useAppStore((s) => s.appAudioApps);
  const appAudioTargetPid = useAppStore((s) => s.appAudioTargetPid);
  const setAppAudioTarget = useAppStore((s) => s.setAppAudioTarget);
  const refreshAppAudioApps = useAppStore((s) => s.refreshAppAudioApps);
  const audioInputDevices = useAppStore((s) => s.audioInputDevices);
  const recordingStatus = useAppStore((s) => s.recordingStatus);
  const isRecording = recordingStatus === "recording";
  const glossaryChars = Array.from(settings.glossary).length;
  const fixedSpeakerCount = diarizeSettings.numSpeakers > 0;

  return (
    <Accordion type="single" collapsible className="w-full">
      <AccordionItem value="settings">
        <AccordionTrigger>詳細設定</AccordionTrigger>
        <AccordionContent>
          <TooltipProvider>
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <Label htmlFor="device-select">マイク</Label>
                <select
                  id="device-select"
                  value={settings.inputDeviceId}
                  onChange={(e) => updateSettings({ inputDeviceId: e.target.value })}
                  className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm"
                >
                  <option value="">既定のマイク</option>
                  {audioInputDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))}
                </select>
                <Tooltip>
                  <TooltipTrigger type="button" className="text-neutral-400">
                    <Info className="h-3.5 w-3.5" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    録音中の切り替えは次の録音から反映されます。選択したマイクが見つからない場合は
                    既定のマイクにフォールバックします。
                  </TooltipContent>
                </Tooltip>
              </div>

              <div className="flex flex-col gap-2 border-t border-neutral-200 pt-4">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="app-audio-enabled"
                    checked={appAudioSettings.enabled}
                    onCheckedChange={(checked) => {
                      const enabled = checked === true;
                      updateAppAudioSettings({ enabled });
                      if (enabled) void refreshAppAudioApps();
                    }}
                  />
                  <Label htmlFor="app-audio-enabled">相手（アプリ）の音声も録音する</Label>
                  <Tooltip>
                    <TooltipTrigger type="button" className="text-neutral-400">
                      <Info className="h-3.5 w-3.5" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      Teams や Zoom など、指定したアプリが再生している音声をマイクと合わせて録音します。
                      Windows の音声セッションを使って取得するため、対象アプリが実際に音を再生していないと
                      一覧に出てきません（通話に参加してから「更新」を押してください）。
                    </TooltipContent>
                  </Tooltip>
                </div>

                {appAudioSettings.enabled && (
                  <div className="flex flex-col gap-2 pl-6">
                    <div className="flex items-center gap-2">
                      <Label htmlFor="app-audio-target" className="whitespace-nowrap">
                        対象アプリ
                      </Label>
                      <select
                        id="app-audio-target"
                        value={appAudioTargetPid ?? ""}
                        onChange={(e) =>
                          setAppAudioTarget(e.target.value ? Number(e.target.value) : null)
                        }
                        className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm"
                      >
                        <option value="">選択してください</option>
                        {appAudioApps.map((a) => (
                          <option key={a.processId} value={a.processId}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void refreshAppAudioApps()}
                        title="対象アプリの一覧を更新"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        更新
                      </Button>
                    </div>
                    <p className="text-xs text-neutral-500">
                      一覧に出ない場合は、対象アプリで通話や再生を始めてから更新してください。
                      {appAudioTargetPid == null && "未選択のままだとマイクのみで録音します。"}
                    </p>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <Label htmlFor="language-select">音声の言語</Label>
                <select
                  id="language-select"
                  value={settings.language}
                  onChange={(e) => updateSettings({ language: e.target.value })}
                  className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm"
                >
                  {SUPPORTED_LANGUAGES.map((lang) => (
                    <option key={lang.code} value={lang.code}>
                      {lang.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="translate-checkbox"
                  checked={settings.task === "translate"}
                  onCheckedChange={(checked) =>
                    updateSettings({ task: checked === true ? "translate" : "transcribe" })
                  }
                />
                <Label htmlFor="translate-checkbox">英語に翻訳する</Label>
                <Tooltip>
                  <TooltipTrigger type="button" className="text-neutral-400">
                    <Info className="h-3.5 w-3.5" />
                  </TooltipTrigger>
                  <TooltipContent>選択した言語の音声を、文字起こしと同時に英語へ翻訳します。</TooltipContent>
                </Tooltip>
              </div>

              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <Label htmlFor="glossary-input">用語集</Label>
                  <Tooltip>
                    <TooltipTrigger type="button" className="text-neutral-400">
                    <Info className="h-3.5 w-3.5" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      聞き間違えられやすい固有名詞・製品名・専門用語を「、」区切りで並べます。認識がその語に寄りますが、
                      強制ではないため必ず正しくなるわけではありません。まれに用語集の文字列がそのまま出力に混ざることがあります。
                    </TooltipContent>
                  </Tooltip>
                </div>
                <textarea
                  id="glossary-input"
                  value={settings.glossary}
                  onChange={(e) => updateSettings({ glossary: e.target.value })}
                  rows={3}
                  placeholder="議事録、稟議書、与信管理、東京海上日動"
                  className="w-full resize-y rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm"
                />
                <p className={glossaryChars > GLOSSARY_LIMIT ? "text-xs text-red-600" : "text-xs text-neutral-500"}>
                  {glossaryChars} / 約{GLOSSARY_LIMIT}文字
                  {glossaryChars > GLOSSARY_LIMIT
                    ? " — 上限を超えた分は末尾が優先され、先頭から捨てられます"
                    : ""}
                </p>
                {/*
                  Edits reach the model on their own -- the transcribe callback reads
                  settings fresh for each window -- so there is nothing to press. What
                  was missing is only that the delay was invisible, hence this line.
                */}
                <p className="text-xs text-neutral-500">
                  {isRecording
                    ? "録音中の変更は、次のウィンドウ（最大15秒後）の文字起こしから反映されます。処理済みの部分は変わりません。"
                    : "変更は自動で保存され、次の文字起こしから反映されます。"}
                </p>
              </div>

              <div className="flex flex-col gap-2 border-t border-neutral-200 pt-4">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="vad-enabled"
                    checked={vadSettings.enabled}
                    onCheckedChange={(checked) => updateVadSettings({ enabled: checked === true })}
                  />
                  <Label htmlFor="vad-enabled">無音区間を検出して除く（VAD）</Label>
                  <Tooltip>
                    <TooltipTrigger type="button" className="text-neutral-400">
                      <Info className="h-3.5 w-3.5" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      録音停止後の精度向上パスにのみ効きます。会議中の「間」を音声区間検出で先に取り除いてから
                      文字起こしすることで、無音での幻覚（架空の発言）を抑え、処理も速くなります。逐次表示中は
                      別の仕組み（音量ベースの無音スキップ）が既に効いているため対象外です。
                    </TooltipContent>
                  </Tooltip>
                </div>

                {vadSettings.enabled && (
                  <div className="flex items-center gap-2 pl-6">
                    <Label htmlFor="vad-threshold" className="whitespace-nowrap">
                      検出の閾値
                    </Label>
                    <input
                      id="vad-threshold"
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={vadSettings.threshold}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isFinite(v)) updateVadSettings({ threshold: v });
                      }}
                      className="w-20 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm"
                    />
                    <Tooltip>
                      <TooltipTrigger type="button" className="text-neutral-400">
                        <Info className="h-3.5 w-3.5" />
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        高くするほど発話とみなす基準が厳しくなり、小さな声を無音側に倒しやすくなります（既定 0.5）。
                      </TooltipContent>
                    </Tooltip>
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-2 border-t border-neutral-200 pt-4">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="diarize-enabled"
                    checked={diarizeSettings.enabled}
                    onCheckedChange={(checked) => updateDiarizeSettings({ enabled: checked === true })}
                  />
                  <Label htmlFor="diarize-enabled">話者分離を行う</Label>
                  <Tooltip>
                    <TooltipTrigger type="button" className="text-neutral-400">
                      <Info className="h-3.5 w-3.5" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      録音停止後の精度向上パスに続けて、声の特徴から発言者を推定し「話者1」「話者2」のように
                      ラベルを付けます。録音全体を見る必要があるため録音中には効きません。追加のモデル読み込みで
                      停止後の待ち時間が延びます。
                    </TooltipContent>
                  </Tooltip>
                </div>

                {diarizeSettings.enabled && (
                  <div className="flex flex-col gap-3 pl-6">
                    <div className="flex items-center gap-2">
                      <Label htmlFor="diarize-threshold" className="whitespace-nowrap">
                        分離の閾値
                      </Label>
                      <input
                        id="diarize-threshold"
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={diarizeSettings.threshold}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v)) updateDiarizeSettings({ threshold: v });
                        }}
                        className="w-20 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm"
                      />
                      <Tooltip>
                        <TooltipTrigger type="button" className="text-neutral-400">
                          <Info className="h-3.5 w-3.5" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          小さくするほど話者を細かく分け、大きくするほど同一人物とみなしてまとめます（既定 0.5）。
                        </TooltipContent>
                      </Tooltip>
                    </div>

                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="diarize-fixed-count"
                        checked={fixedSpeakerCount}
                        onCheckedChange={(checked) =>
                          updateDiarizeSettings({ numSpeakers: checked === true ? 2 : -1 })
                        }
                      />
                      <Label htmlFor="diarize-fixed-count">話者数を固定する</Label>
                      {fixedSpeakerCount && (
                        <input
                          type="number"
                          min={1}
                          max={20}
                          value={diarizeSettings.numSpeakers}
                          onChange={(e) => {
                            const v = Math.round(Number(e.target.value));
                            if (Number.isFinite(v) && v > 0) updateDiarizeSettings({ numSpeakers: v });
                          }}
                          className="w-16 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm"
                        />
                      )}
                      <span className="text-xs text-neutral-500">
                        {fixedSpeakerCount ? "" : "未指定（自動推定）"}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <div className="flex items-center gap-2">
                        <Label htmlFor="diarize-min-on" className="whitespace-nowrap text-xs">
                          最小発話長（秒）
                        </Label>
                        <input
                          id="diarize-min-on"
                          type="number"
                          min={0}
                          step={0.1}
                          value={diarizeSettings.minDurationOn}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            if (Number.isFinite(v) && v >= 0) updateDiarizeSettings({ minDurationOn: v });
                          }}
                          className="w-16 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <Label htmlFor="diarize-min-off" className="whitespace-nowrap text-xs">
                          最小無音長（秒）
                        </Label>
                        <input
                          id="diarize-min-off"
                          type="number"
                          min={0}
                          step={0.1}
                          value={diarizeSettings.minDurationOff}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            if (Number.isFinite(v) && v >= 0) updateDiarizeSettings({ minDurationOff: v });
                          }}
                          className="w-16 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm"
                        />
                      </div>
                    </div>
                    <p className="text-xs text-neutral-500">
                      短い相槌が独立した話者として分かれてしまう場合は、最小発話長を長くする。
                    </p>
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-2 border-t border-neutral-200 pt-4">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="audio-event-enabled"
                    checked={audioEventSettings.enabled}
                    onCheckedChange={(checked) => updateAudioEventSettings({ enabled: checked === true })}
                  />
                  <Label htmlFor="audio-event-enabled">音響イベントを検出する</Label>
                  <Tooltip>
                    <TooltipTrigger type="button" className="text-neutral-400">
                      <Info className="h-3.5 w-3.5" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      録音停止後の精度向上パスに続けて、音楽・拍手・ノイズなどを検出し、下の「音響イベント」欄に
                      時刻付きで一覧表示します。文字起こし本文には反映されません。会話が検出されない区間は
                      文字起こしの対象から除外されます。
                    </TooltipContent>
                  </Tooltip>
                </div>

                {audioEventSettings.enabled && (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pl-6">
                    <div className="flex items-center gap-2">
                      <Label htmlFor="audio-event-threshold" className="whitespace-nowrap">
                        検出の閾値
                      </Label>
                      <input
                        id="audio-event-threshold"
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        value={audioEventSettings.threshold}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v)) updateAudioEventSettings({ threshold: v });
                        }}
                        className="w-20 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm"
                      />
                      <Tooltip>
                        <TooltipTrigger type="button" className="text-neutral-400">
                          <Info className="h-3.5 w-3.5" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          高くするほど確信度の高いタグだけが残ります（既定 0.3）。
                        </TooltipContent>
                      </Tooltip>
                    </div>

                    <div className="flex items-center gap-2">
                      <Label htmlFor="audio-event-topk" className="whitespace-nowrap">
                        タグの最大数
                      </Label>
                      <input
                        id="audio-event-topk"
                        type="number"
                        min={1}
                        max={10}
                        value={audioEventSettings.topK}
                        onChange={(e) => {
                          const v = Math.round(Number(e.target.value));
                          if (Number.isFinite(v) && v > 0) updateAudioEventSettings({ topK: v });
                        }}
                        className="w-16 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm"
                      />
                      <Tooltip>
                        <TooltipTrigger type="button" className="text-neutral-400">
                          <Info className="h-3.5 w-3.5" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          10秒ごとの区間で保持するタグの数（既定 3）。
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </TooltipProvider>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
