import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/**
 * A small (i) glyph that reveals explanatory copy on hover/focus. Originally
 * local to `SettingsPanel` (every threshold/switch there needs one); shared
 * here so panels outside settings can use the same affordance instead of
 * re-implementing it.
 */
export function InfoTooltip({ children }: { children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger type="button" className="text-muted-foreground">
        <Info className="h-3.5 w-3.5" />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{children}</TooltipContent>
    </Tooltip>
  );
}
