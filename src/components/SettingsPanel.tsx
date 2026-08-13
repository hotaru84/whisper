import { Info } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./ui/accordion";
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
  const recordingStatus = useAppStore((s) => s.recordingStatus);
  const isRecording = recordingStatus === "recording";
  const glossaryChars = Array.from(settings.glossary).length;

  return (
    <Accordion type="single" collapsible className="w-full">
      <AccordionItem value="settings">
        <AccordionTrigger>詳細設定</AccordionTrigger>
        <AccordionContent>
          <TooltipProvider>
            <div className="flex flex-col gap-4">
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
            </div>
          </TooltipProvider>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
