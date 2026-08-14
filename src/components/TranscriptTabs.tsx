import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { TranscriptPanel } from "./TranscriptPanel";
import { AudioEventPanel } from "./AudioEventPanel";
import { useAppStore } from "../store/appStore";

/**
 * Switches between the transcript and the detected-audio-events list, which
 * used to be two permanently stacked panels. Tabbing them hides whichever one
 * is not active, so the "音響イベント" trigger carries a count -- otherwise a
 * user reading the transcript would have no way to notice new events landed
 * behind the other tab.
 */
export function TranscriptTabs() {
  const eventCount = useAppStore((s) => s.audioEvents.length);

  return (
    <Tabs defaultValue="transcript" className="w-full flex-1 gap-3 rounded-lg border border-border p-4">
      <TabsList className="self-start">
        <TabsTrigger value="transcript">文字起こし</TabsTrigger>
        <TabsTrigger value="audio-events">
          音響イベント
          {eventCount > 0 && (
            <span className="rounded-full bg-muted-foreground/20 px-1.5 text-xs tabular-nums">{eventCount}</span>
          )}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="transcript">
        <TranscriptPanel />
      </TabsContent>
      <TabsContent value="audio-events">
        <AudioEventPanel />
      </TabsContent>
    </Tabs>
  );
}
