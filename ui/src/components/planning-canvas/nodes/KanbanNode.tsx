import { memo, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Columns3, RefreshCw } from "lucide-react";
import type { PlanningCanvasKanbanData } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { StatusIcon } from "@/components/StatusIcon";
import { PriorityIcon } from "@/components/PriorityIcon";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { useLatestCanvas } from "@/components/planning-canvas/nodes/canvas-context";
import { IssueFilters } from "@/components/planning-canvas/nodes/IssueFilters";
import { RefCard } from "@/components/planning-canvas/nodes/RefCard";
import { useIssueQuery } from "@/components/planning-canvas/nodes/useIssueQuery";
import { groupIssues, isCapped, UNASSIGNED, withStatus, type KanbanGroupBy, type QueriedIssue } from "@/components/planning-canvas/nodes/issue-board";
import { OptionSelect } from "@/components/OptionSelect";

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
const GROUPS: KanbanGroupBy[] = ["status", "assignee", "priority"];
const titleCase = (key: string) => key.replace(/_/g, " ").replace(/^\w/, (ch) => ch.toUpperCase());

/** Column title for a group key; an assignee key is an agent id (or `user:<id>`, or "unassigned"). */
function columnLabel(key: string, groupBy: KanbanGroupBy, agentName: (id: string) => string | null) {
  if (groupBy !== "assignee") return titleCase(key);
  if (key === UNASSIGNED) return "Unassigned";
  if (key.startsWith("user:")) return "A person";
  return agentName(key) ?? "An agent";
}

/**
 * A kanban node: cards are real issues, read through the board's query (so access is the reader's
 * own). Grouped by status, a card drags to another column and sends `PATCH /issues/:id {status}`;
 * the card moves at once and snaps back with a toast when the server refuses (a 403 included).
 * Grouped by assignee or priority the board is read-only. Only `source` (the filter), `groupBy` and `collapsed` are saved
 * to the board, as a field-level merge of the node's own data.
 */
export const KanbanNode = memo(function KanbanNode({ nodeKey, data, title }: { nodeKey: string; data: PlanningCanvasKanbanData; title: string }) {
  const latest = useLatestCanvas();
  const queryClient = useQueryClient();
  const { read, key, companyId } = useIssueQuery(data.source);
  const [dragId, setDragIdState] = useState<string | null>(null);
  // The ref is what the drop handlers read: a drag event can follow dragstart before React re-renders.
  const dragRef = useRef<string | null>(null);
  const setDragId = (id: string | null) => {
    dragRef.current = id;
    setDragIdState(id);
  };
  const [overKey, setOverKey] = useState<string | null>(null);

  const issues = read.data?.issues;
  const columns = useMemo(() => groupIssues(issues ?? [], data.groupBy), [issues, data.groupBy]);
  const agentName = (id: string) => latest.current.agents?.find((a) => a.id === id)?.name ?? null;
  const edit = (next: Partial<PlanningCanvasKanbanData>) => latest.current.opStore.setNodeData(nodeKey, { ...data, ...next });
  const canDrag = data.groupBy === "status";

  const move = async (issueId: string, status: string) => {
    const prev = queryClient.getQueryData<{ issues: QueriedIssue[]; limit: number }>(key);
    const issue = prev?.issues.find((i) => i.id === issueId);
    if (!prev || !issue || issue.status === status) return;
    queryClient.setQueryData(key, { ...prev, issues: withStatus(prev.issues, issueId, status) });
    try {
      await issuesApi.update(issueId, { status });
      void queryClient.invalidateQueries({ queryKey: key });
    } catch (error) {
      queryClient.setQueryData(key, prev);
      const denied = error instanceof ApiError && error.status === 403;
      latest.current.pushToast({
        title: denied ? "You can't move this issue" : "Couldn't move the issue",
        body: denied ? `${issue.identifier ?? issue.title} stays in ${titleCase(issue.status)}.` : error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
    }
  };

  let body;
  if (read.isError) {
    body = (
      <div role="alert" className="flex flex-col items-start gap-1 text-xs text-destructive">
        <span>Couldn't load issues.</span>
        <Button type="button" size="xs" variant="outline" onClick={() => void read.refetch()}>
          <RefreshCw className="size-3" /> Retry
        </Button>
      </div>
    );
  } else if (!issues) {
    body = <p className="text-xs text-muted-foreground">Loading issues…</p>;
  } else if (issues.length === 0) {
    body = <p className="text-xs text-muted-foreground">No issues match this query.</p>;
  } else {
    body = (
      <div className="flex min-h-0 flex-1 gap-2 overflow-auto" onPointerDown={stop} data-canvas-scroll="">
        {columns.map((column) => {
          const collapsed = data.collapsed.includes(column.key);
          return (
            <section
              key={column.key}
              aria-label={columnLabel(column.key, data.groupBy, agentName)}
              onDragOver={(e) => {
                if (!canDrag || !dragRef.current) return;
                e.preventDefault();
                setOverKey(column.key);
              }}
              onDragLeave={() => setOverKey((k) => (k === column.key ? null : k))}
              onDrop={(e) => {
                e.preventDefault();
                setOverKey(null);
                if (canDrag && dragRef.current) void move(dragRef.current, column.key);
                setDragId(null);
              }}
              className={cn("flex w-40 shrink-0 flex-col gap-1 rounded-lg bg-muted/40 p-1.5", overKey === column.key && "ring-2 ring-blue-500")}
            >
              <button
                type="button"
                aria-expanded={!collapsed}
                className="flex items-center gap-1 text-left text-xs font-semibold text-foreground"
                onClick={() => edit({ collapsed: collapsed ? data.collapsed.filter((k) => k !== column.key) : [...data.collapsed, column.key] })}
              >
                {collapsed ? <ChevronRight className="size-3 shrink-0" /> : <ChevronDown className="size-3 shrink-0" />}
                <span className="truncate">{columnLabel(column.key, data.groupBy, agentName)}</span>
                <span className="ml-auto text-muted-foreground">{column.issues.length}</span>
              </button>
              {collapsed ? null : (
                <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto">
                  {column.issues.map((issue) => (
                    <li
                      key={issue.id}
                      draggable={canDrag}
                      onDragStart={() => setDragId(issue.id)}
                      onDragEnd={() => {
                        setDragId(null);
                        setOverKey(null);
                      }}
                      className={cn("flex flex-col gap-1 rounded-md border border-border bg-card p-1.5 text-xs", canDrag && "cursor-grab", dragId === issue.id && "opacity-50")}
                    >
                      <Link to={`/issues/${issue.identifier ?? issue.id}`} className="line-clamp-2 break-words font-medium text-foreground hover:underline" draggable={false}>
                        {issue.title}
                      </Link>
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <StatusIcon status={issue.status} />
                        <PriorityIcon priority={issue.priority} />
                        <span className="truncate">{issue.identifier ?? ""}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    );
  }

  return (
    <RefCard label={title || "Kanban"} icon={<Columns3 className="size-3.5" />}>
      <div className="flex items-center gap-1" onPointerDown={stop} onDoubleClick={stop}>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          Group by
          <OptionSelect
            ariaLabel="Group by"
            items={GROUPS.map((g) => ({ value: g, label: titleCase(g) }))}
            value={data.groupBy}
            onChange={(next) => edit({ groupBy: next as KanbanGroupBy, collapsed: [] })}
            placeholder="Group by"
            triggerClassName="h-auto py-0.5 text-xs font-normal"
          />
        </label>
        {issues ? <span className="ml-auto text-xs text-muted-foreground">{issues.length} issues</span> : null}
      </div>
      <IssueFilters query={data.source} onChange={(source) => edit({ source })} />
      {issues && isCapped(issues.length, data.source) ? (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-300">
          Showing the first {issues.length} issues. Narrow the query to see the rest.
        </p>
      ) : null}
      {!canDrag && issues?.length ? <p className="text-xs text-muted-foreground">Group by status to move cards.</p> : null}
      {companyId ? body : null}
    </RefCard>
  );
});
