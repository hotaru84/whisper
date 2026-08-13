import { Settings } from "lucide-react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { SettingsPanel } from "./SettingsPanel";

/**
 * Settings live in an on-demand dialog rather than an always-inline panel:
 * they're consulted occasionally, not continuously, unlike the record button,
 * transcript, and level meter that make up the main working view -- see the
 * design plan's layout rationale.
 */
export function SettingsDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="設定">
          <Settings className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>詳細設定</DialogTitle>
        </DialogHeader>
        <SettingsPanel />
      </DialogContent>
    </Dialog>
  );
}
