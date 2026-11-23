import { CircleDot } from "lucide-react";
import { IssueStatusBadge } from "@/components/StatusBadge";
import { useCanvasRef } from "@/components/planning-canvas/nodes/canvas-refs";
import { RefCard, RefLoading, RefNoAccess } from "@/components/planning-canvas/nodes/RefCard";
import type { PlanningCanvasIssueRef } from "@/api/planningCanvases";
import { Link } from "@/lib/router";

export function IssueNode({ refId }: { refId: string | null }) {
  const issue = useCanvasRef<PlanningCanvasIssueRef>(refId);
  return (
    <RefCard label="Issue" icon={<CircleDot className="size-3.5" />}>
      {!issue ? <RefLoading /> : issue.hidden ? <RefNoAccess /> : (
        <>
          <div className="flex min-w-0 items-center justify-between gap-2">
            <Link
              to={`/issues/${issue.identifier ?? issue.id}`}
              onMouseDown={(e) => e.stopPropagation()}
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
