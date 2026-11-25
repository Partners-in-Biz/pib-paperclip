import { Link } from "@/lib/router";
import { StatusBadge } from "@/components/StatusBadge";
import type { PlanningCanvasLinkedIssue } from "@/api/planningCanvases";

/** The issue a mention created or woke: live status, links to the issue. A hidden issue shows no detail. */
export function LinkedIssueChip({ issue }: { issue: PlanningCanvasLinkedIssue }) {
  if (issue.hidden) {
    return (
      <span className="inline-flex max-w-full items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">
        Linked issue (no access)
      </span>
    );
  }
  const label = issue.identifier ?? issue.id.slice(0, 8);
  return (
    <Link
      to={`/issues/${issue.identifier ?? issue.id}`}
      data-testid="linked-issue-chip"
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-card px-2 py-0.5 text-xs hover:bg-accent"
    >
      <span className="shrink-0 font-medium">{label}</span>
      <span className="min-w-0 truncate text-muted-foreground">{issue.title}</span>
      <StatusBadge status={issue.status} />
    </Link>
  );
}
