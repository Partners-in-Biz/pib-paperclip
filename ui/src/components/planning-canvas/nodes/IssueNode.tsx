import { useState } from "react";
import { ChevronDown, ChevronRight, CircleDot } from "lucide-react";
import { IssueStatusBadge } from "@/components/StatusBadge";
import { isRefData, useCanvasRef } from "@/components/planning-canvas/nodes/canvas-refs";
import { IssueExpandPanel } from "@/components/planning-canvas/nodes/IssueExpandPanel";
import { RefCard, refPlaceholder } from "@/components/planning-canvas/nodes/RefCard";
import type { PlanningCanvasIssueRef } from "@/api/planningCanvases";
import { Link } from "@/lib/router";

export function IssueNode({ refId }: { refId: string | null }) {
  const issue = useCanvasRef<PlanningCanvasIssueRef>(refId);
  // Per viewer and never saved (plan C.4), so view access is enough to open it.
  const [open, setOpen] = useState(false);
  return (
    <div className="relative h-full min-w-0">
      <RefCard label="Issue" icon={<CircleDot className="size-3.5" />}>
        {!isRefData(issue) ? refPlaceholder(issue) : (
          <>
            <div className="flex min-w-0 items-center justify-between gap-2">
              <Link
                to={`/issues/${issue.identifier ?? issue.id}`}
                onPointerDown={(e) => e.stopPropagation()}
                className="truncate text-xs font-semibold text-foreground hover:underline"
              >
                {issue.identifier ?? "Issue"}
              </Link>
              <div className="flex shrink-0 items-center gap-1">
                <IssueStatusBadge status={issue.status} />
                <button
                  type="button"
                  aria-expanded={open}
                  aria-label={open ? "Hide subtasks and artifacts" : "Show subtasks and artifacts"}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => setOpen((v) => !v)}
                  className="nodrag rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                </button>
              </div>
            </div>
            <p className="line-clamp-3 text-sm font-semibold leading-snug text-foreground">{issue.title}</p>
          </>
        )}
      </RefCard>
      {isRefData(issue) && open ? <IssueExpandPanel issueId={issue.id} slug={issue.identifier ?? issue.id} /> : null}
    </div>
  );
}
