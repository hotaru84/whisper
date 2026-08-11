import { Info } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./ui/accordion";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { useAppStore } from "../store/appStore";
import { SUPPORTED_LANGUAGES } from "../lib/asr";

export function SettingsPanel() {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

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
            </div>
          </TooltipProvider>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
