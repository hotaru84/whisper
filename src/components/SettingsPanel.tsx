import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./ui/accordion";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Slider } from "./ui/slider";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";
import { FolderOpen } from "lucide-react";
import { InfoTooltip } from "./InfoTooltip";
import { useAppStore } from "../store/appStore";
import { SUPPORTED_LANGUAGES } from "../lib/asr";
import { pickAutoSaveDirectory } from "../lib/export/autoSave";
import { useMockBackend } from "../lib/env";
import { MOCK_NATIVE_FEATURE_UNAVAILABLE } from "../lib/mock/fixtures";
import { cn } from "../lib/utils";

/**
 * Practical size of the glossary, in characters.
 *
 * whisper caps `initial_prompt` at `n_text_ctx / 2` = 224 tokens for
 * large-v3-turbo, and measured on this model Japanese runs at roughly one token
 * per character (「議事録」3 chars / 3 tokens, 「与信管理」4 / 5). Anything past
 * the cap is dropped from the front, silently.
 */
const GLOSSARY_LIMIT = 200;

/**
 * A 0-1 threshold, shown as a slider and its numeric readout together --
 * the slider gives an immediate sense of range a bare number does not, the
 * number stays for anyone who wants to type an exact value. Reused across
 * VAD/diarization/audio-event thresholds, the three places this app asks for
 * a probability cutoff.
 */
function ThresholdControl({
  id,
  label,
  value,
  onChange,
  tooltip,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  tooltip: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Label htmlFor={id}>{label}</Label>
        <InfoTooltip>{tooltip}</InfoTooltip>
      </div>
      <div className="flex items-center gap-3">
        <Slider
          id={id}
          min={0}
          max={1}
          step={0.05}
          value={[value]}
          onValueChange={([v]) => v !== undefined && onChange(v)}
          className="max-w-40"
        />
        <Input
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={value}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange(v);
          }}
          className="w-20 font-mono"
        />
      </div>
    </div>
  );
}

export function SettingsPanel() {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const diarizeSettings = useAppStore((s) => s.diarizeSettings);
  const updateDiarizeSettings = useAppStore((s) => s.updateDiarizeSettings);
  const vadSettings = useAppStore((s) => s.vadSettings);
  const updateVadSettings = useAppStore((s) => s.updateVadSettings);
  const hallucinationSettings = useAppStore((s) => s.hallucinationSettings);
  const updateHallucinationSettings = useAppStore((s) => s.updateHallucinationSettings);
  const audioEventSettings = useAppStore((s) => s.audioEventSettings);
  const updateAudioEventSettings = useAppStore((s) => s.updateAudioEventSettings);
  const autoSaveSettings = useAppStore((s) => s.autoSaveSettings);
  const updateAutoSaveSettings = useAppStore((s) => s.updateAutoSaveSettings);
  const recordingPhase = useAppStore((s) => s.recordingPhase);
  // Locked for the whole take, paused included: the streaming transcriber
  // re-reads `settings` on every window, so a change part-way through would
  // silently decode the rest of the recording under different settings than
  // the beginning.
  const locked = recordingPhase !== "stopped";
  const glossaryChars = Array.from(settings.glossary).length;
  const fixedSpeakerCount = diarizeSettings.numSpeakers > 0;
  const handlePickAutoSaveDirectory = async () => {
    const directory = await pickAutoSaveDirectory();
    if (directory) updateAutoSaveSettings({ directory });
  };

  return (
    // Every category starts open: before this dialog existed, every setting
    // sat in one always-open panel, so nothing needed an extra click to
    // find. Splitting into categories organizes them but must not hide any
    // of them behind a second click by default -- a user reported not being
    // able to find a setting for exactly this reason when this had three
    // categories (the mic/app-audio one has since moved to the titlebar --
    // see TitleBarControls.tsx -- since those are switched often enough to
    // want one click, not two). Anyone who wants a quieter view can still
    // collapse a category; this only changes the starting state.
    //
    // 保存設定 (autosave) leads rather than trails: where a take's files end
    // up matters more, and is checked less often, than the decode/accuracy
    // knobs below it -- worth seeing first without scrolling, not buried
    // under the two categories someone tunes far more frequently.
    <Accordion
      type="multiple"
      className={cn("w-full", locked && "pointer-events-none opacity-60")}
      defaultValue={["autosave", "transcription", "hallucination", "accuracy"]}
    >
      <AccordionItem value="autosave">
        <AccordionTrigger>保存設定</AccordionTrigger>
        <AccordionContent>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Label htmlFor="autosave-directory">保存先フォルダ</Label>
                <InfoTooltip>
                  録音のWAVファイルと文字起こしのテキストファイルは、ここで指定したフォルダに保存されます。
                  録音を開始する前に必ず設定してください。
                </InfoTooltip>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  id="autosave-directory"
                  readOnly
                  value={autoSaveSettings.directory}
                  placeholder="未設定（録音を開始する前に選択してください）"
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handlePickAutoSaveDirectory()}
                  disabled={useMockBackend}
                  title={useMockBackend ? MOCK_NATIVE_FEATURE_UNAVAILABLE : undefined}
                >
                  <FolderOpen className="h-4 w-4" />
                  フォルダを選択
                </Button>
              </div>
              {!autoSaveSettings.directory && (
                <p className="text-xs text-destructive">録音を開始するには保存先フォルダの設定が必要です。</p>
              )}
            </div>
          </div>
        </AccordionContent>
      </AccordionItem>

      <AccordionItem value="transcription">
        <AccordionTrigger>文字起こし</AccordionTrigger>
        <AccordionContent>
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <Label htmlFor="language-select">音声の言語</Label>
              <Select value={settings.language} onValueChange={(v) => updateSettings({ language: v })}>
                <SelectTrigger id="language-select" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPORTED_LANGUAGES.map((lang) => (
                    <SelectItem key={lang.code} value={lang.code}>
                      {lang.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
              <InfoTooltip>選択した言語の音声を、文字起こしと同時に英語へ翻訳します。</InfoTooltip>
            </div>

            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Label htmlFor="glossary-input">用語集</Label>
                <InfoTooltip>
                  聞き間違えられやすい固有名詞・製品名・専門用語を「、」区切りで並べます。認識がその語に寄りますが、
                  強制ではないため必ず正しくなるわけではありません。まれに用語集の文字列がそのまま出力に混ざることがあります。
                </InfoTooltip>
              </div>
              <Textarea
                id="glossary-input"
                value={settings.glossary}
                onChange={(e) => updateSettings({ glossary: e.target.value })}
                rows={3}
                placeholder="議事録、稟議書、与信管理、東京海上日動"
              />
              <p
                className={
                  glossaryChars > GLOSSARY_LIMIT
                    ? "font-mono text-xs text-destructive"
                    : "font-mono text-xs text-muted-foreground"
                }
              >
                {glossaryChars} / 約{GLOSSARY_LIMIT}文字
                {glossaryChars > GLOSSARY_LIMIT
                  ? " — 上限を超えた分は末尾が優先され、先頭から捨てられます"
                  : ""}
              </p>
              {/*
                Edits reach the model on their own -- the transcribe callback reads
                settings fresh for each window -- so there is nothing to press.
              */}
              <p className="text-xs text-muted-foreground">
                変更は自動で保存され、次の文字起こしから反映されます。
              </p>
            </div>
          </div>
        </AccordionContent>
      </AccordionItem>

      <AccordionItem value="hallucination">
        <AccordionTrigger>幻覚対策（上級者向け）</AccordionTrigger>
        <AccordionContent>
          <div className="flex flex-col gap-4">
            <p className="text-xs text-muted-foreground">
              無音や低SNRのノイズに対して whisper が定型句を作文したり、同じ語句を繰り返す「幻覚」を起こす
              ことがあります。以下は事前の値をコンソールログ（<code>rms=</code>）で確認したうえで、
              当て推量ではなく実測に基づいて調整してください。逐次パス・精度向上パスの両方に反映されます。
            </p>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Label htmlFor="silence-rms-input">無音判定の RMS しきい値</Label>
                <InfoTooltip>
                  この値を下回る音量の区間は「無音」として扱われ、逐次パスではモデルに渡さずスキップし、
                  精度向上パスでは文字起こし後に無音フラグを付けます（削除はされません）。上げすぎると
                  小さな声を無音側に倒してしまうため、静かな区間で実測した <code>rms=</code> の値のすぐ下まで
                  だけ上げるのが安全です（既定 0.001）。
                </InfoTooltip>
              </div>
              <div className="flex items-center gap-3">
                <Input
                  id="silence-rms-input"
                  type="number"
                  min={0}
                  max={0.05}
                  step={0.0005}
                  value={hallucinationSettings.silenceRms}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v >= 0) updateHallucinationSettings({ silenceRms: v });
                  }}
                  className="w-28 font-mono"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Label htmlFor="entropy-thold-input">反復ループ対策の閾値（entropy_thold）</Label>
                <InfoTooltip>
                  32トークンを超える出力のエントロピーがこの値を下回ると、より高い温度で再デコードします。
                  上げるほど長い反復ループを検出しやすくなりますが、短い反復（十数文字程度）にはこの仕組み自体が
                  効きません。whisper.cpp の既定は 2.4、このアプリの既定は 2.8 です。
                </InfoTooltip>
              </div>
              <div className="flex items-center gap-3">
                <Input
                  id="entropy-thold-input"
                  type="number"
                  min={0}
                  max={5}
                  step={0.1}
                  value={hallucinationSettings.entropyThold}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v > 0) updateHallucinationSettings({ entropyThold: v });
                  }}
                  className="w-28 font-mono"
                />
              </div>
            </div>
          </div>
        </AccordionContent>
      </AccordionItem>

      <AccordionItem value="accuracy">
        <AccordionTrigger>精度向上パス</AccordionTrigger>
        <AccordionContent>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Switch
                  id="vad-enabled"
                  checked={vadSettings.enabled}
                  onCheckedChange={(checked) => updateVadSettings({ enabled: checked })}
                />
                <Label htmlFor="vad-enabled">無音区間を検出して除く（VAD）</Label>
                <InfoTooltip>
                  録音停止後の精度向上パスにのみ効きます。会議中の「間」を音声区間検出で先に取り除いてから
                  文字起こしすることで、無音での幻覚（架空の発言）を抑え、処理も速くなります。逐次表示中は
                  別の仕組み（音量ベースの無音スキップ）が既に効いているため対象外です。
                </InfoTooltip>
              </div>

              {vadSettings.enabled && (
                <div className="pl-6">
                  <ThresholdControl
                    id="vad-threshold"
                    label="検出の閾値"
                    value={vadSettings.threshold}
                    onChange={(threshold) => updateVadSettings({ threshold })}
                    tooltip="高くするほど発話とみなす基準が厳しくなり、小さな声を無音側に倒しやすくなります（既定 0.5）。"
                  />
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2 border-t border-border pt-4">
              <div className="flex items-center gap-2">
                <Switch
                  id="diarize-enabled"
                  checked={diarizeSettings.enabled}
                  onCheckedChange={(checked) => updateDiarizeSettings({ enabled: checked })}
                />
                <Label htmlFor="diarize-enabled">話者分離を行う</Label>
                <InfoTooltip>
                  録音停止後の精度向上パスに続けて、声の特徴から発言者を推定し「話者1」「話者2」のように
                  ラベルを付けます。録音全体を見る必要があるため録音中には効きません。追加のモデル読み込みで
                  停止後の待ち時間が延びます。
                </InfoTooltip>
              </div>

              {diarizeSettings.enabled && (
                <div className="flex flex-col gap-3 pl-6">
                  <ThresholdControl
                    id="diarize-threshold"
                    label="分離の閾値"
                    value={diarizeSettings.threshold}
                    onChange={(threshold) => updateDiarizeSettings({ threshold })}
                    tooltip="小さくするほど話者を細かく分け、大きくするほど同一人物とみなしてまとめます（既定 0.5）。"
                  />

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
                      <Input
                        type="number"
                        min={1}
                        max={20}
                        value={diarizeSettings.numSpeakers}
                        onChange={(e) => {
                          const v = Math.round(Number(e.target.value));
                          if (Number.isFinite(v) && v > 0) updateDiarizeSettings({ numSpeakers: v });
                        }}
                        className="w-16 font-mono"
                      />
                    )}
                    <span className="text-xs text-muted-foreground">
                      {fixedSpeakerCount ? "" : "未指定（自動推定）"}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <div className="flex items-center gap-2">
                      <Label htmlFor="diarize-min-on" className="whitespace-nowrap text-xs">
                        最小発話長（秒）
                      </Label>
                      <Input
                        id="diarize-min-on"
                        type="number"
                        min={0}
                        step={0.1}
                        value={diarizeSettings.minDurationOn}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v) && v >= 0) updateDiarizeSettings({ minDurationOn: v });
                        }}
                        className="w-16 font-mono"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Label htmlFor="diarize-min-off" className="whitespace-nowrap text-xs">
                        最小無音長（秒）
                      </Label>
                      <Input
                        id="diarize-min-off"
                        type="number"
                        min={0}
                        step={0.1}
                        value={diarizeSettings.minDurationOff}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v) && v >= 0) updateDiarizeSettings({ minDurationOff: v });
                        }}
                        className="w-16 font-mono"
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    短い相槌が独立した話者として分かれてしまう場合は、最小発話長を長くする。
                  </p>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2 border-t border-border pt-4">
              <div className="flex items-center gap-2">
                <Switch
                  id="audio-event-enabled"
                  checked={audioEventSettings.enabled}
                  onCheckedChange={(checked) => updateAudioEventSettings({ enabled: checked })}
                />
                <Label htmlFor="audio-event-enabled">音響イベントを検出する</Label>
                <InfoTooltip>
                  録音停止後の精度向上パスに続けて、音楽・拍手・ノイズなどを検出し、下の「音響イベント」欄に
                  時刻付きで一覧表示します。文字起こし本文には反映されません。会話が検出されない区間は
                  文字起こしの対象から除外されます。
                </InfoTooltip>
              </div>

              {audioEventSettings.enabled && (
                <div className="flex flex-col gap-3 pl-6">
                  <ThresholdControl
                    id="audio-event-threshold"
                    label="検出の閾値"
                    value={audioEventSettings.threshold}
                    onChange={(threshold) => updateAudioEventSettings({ threshold })}
                    tooltip="高くするほど確信度の高いタグだけが残ります（既定 0.3）。"
                  />

                  <div className="flex items-center gap-2">
                    <Label htmlFor="audio-event-topk" className="whitespace-nowrap">
                      タグの最大数
                    </Label>
                    <Input
                      id="audio-event-topk"
                      type="number"
                      min={1}
                      max={10}
                      value={audioEventSettings.topK}
                      onChange={(e) => {
                        const v = Math.round(Number(e.target.value));
                        if (Number.isFinite(v) && v > 0) updateAudioEventSettings({ topK: v });
                      }}
                      className="w-16 font-mono"
                    />
                    <InfoTooltip>10秒ごとの区間で保持するタグの数（既定 3）。</InfoTooltip>
                  </div>
                </div>
              )}
            </div>
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
