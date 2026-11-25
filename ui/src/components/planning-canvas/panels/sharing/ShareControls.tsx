import { useState } from "react";
import { Share2 } from "lucide-react";
import { type PlanningCanvasListItem } from "@/api/planningCanvases";
import { ArchivedBoards } from "@/components/planning-canvas/panels/sharing/BoardSections";
import { ShareDialog } from "@/components/planning-canvas/panels/sharing/ShareDialog";
import { useSessionUserId } from "@/components/planning-canvas/panels/sharing/useSessionUserId";
import { type CanvasController } from "@/components/planning-canvas/state/useCanvasController";
import { Button } from "@/components/ui/button";

/** Share button for the active board plus the Archived section, mounted in the board bar. */
export function ShareControls({ c }: { c: CanvasController }) {
  const { selectedCompanyId, activeBoard, projects, agents, pushToast } = c;
  const userId = useSessionUserId();
  const [shared, setShared] = useState<PlanningCanvasListItem | null>(null);
  if (!selectedCompanyId) return null;
  return (
    <>
      {activeBoard ? (
        <Button type="button" size="xs" variant="outline" onClick={() => setShared(activeBoard as PlanningCanvasListItem)}>
          <Share2 className="size-3.5" />
          Share
        </Button>
      ) : null}
      <ArchivedBoards companyId={selectedCompanyId} onOpenShare={setShared} />
      {shared ? (
        <ShareDialog
          open
          onOpenChange={(open) => !open && setShared(null)}
          companyId={selectedCompanyId}
          board={shared}
          userId={userId}
          projects={projects}
          agents={agents}
          onToast={(title, tone) => pushToast({ title, tone })}
        />
      ) : null}
    </>
  );
}
