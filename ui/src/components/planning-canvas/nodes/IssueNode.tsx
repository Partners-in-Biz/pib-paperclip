import { CircleDot } from "lucide-react";
import { IssueStatusBadge } from "@/components/StatusBadge";
import { isRefData, useCanvasRef } from "@/components/planning-canvas/nodes/canvas-refs";
import { RefCard, refPlaceholder } from "@/components/planning-canvas/nodes/RefCard";
import type { PlanningCanvasIssueRef } from "@/api/planningCanvases";
import { Link } from "@/lib/router";

export function IssueNode({ refId }: { refId: string | null }) {
  const issue = useCanvasRef<PlanningCanvasIssueRef>(refId);
  return (
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
            <IssueStatusBadge status={issue.status} />
          </div>
          <p className="line-clamp-3 text-sm font-semibold leading-snug text-foreground">{issue.title}</p>
        </>
      )}
    </RefCard>
  );
}
