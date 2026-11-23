import { StatusGlyph } from "@/components/StatusGlyph";
import { useCanvasRef } from "@/components/planning-canvas/nodes/canvas-refs";
import type { PlanningCanvasIssueRef } from "@/api/planningCanvases";
import { Link } from "@/lib/router";

function LinkChip({ issueId }: { issueId: string }) {
  const issue = useCanvasRef<PlanningCanvasIssueRef>(issueId);
  if (!issue) return null;
  const className = "inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-xs font-medium text-foreground shadow-xs";
  if (issue.hidden) return <span className={className + " text-muted-foreground"}>No access</span>;
  return (
    <Link
      to={`/issues/${issue.identifier ?? issue.id}`}
      onMouseDown={(e) => e.stopPropagation()}
      title={issue.title}
      className={className + " hover:underline"}
    >
      <StatusGlyph status={issue.status} size="sm" />
      <span className="truncate">{issue.identifier ?? issue.title}</span>
    </Link>
  );
}

/** Every issue a node is linked to (a handoff can link a node to several), below the node. */
export function NodeLinks({ issueIds }: { issueIds: string[] }) {
  if (issueIds.length === 0) return null;
  return (
    <div className="pointer-events-auto absolute left-0 top-full mt-1 flex w-full flex-wrap gap-1">
      {issueIds.map((id) => (
        <LinkChip key={id} issueId={id} />
      ))}
    </div>
  );
}
