import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ISSUE_STATUSES, type PlanningCanvasIssueQuery } from "@paperclipai/shared";
import { goalsApi } from "@/api/goals";
import { issuesApi } from "@/api/issues";
import { projectsApi } from "@/api/projects";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useLatestCanvas } from "@/components/planning-canvas/nodes/canvas-context";
import { activeFilterCount, toggleStatus, withFilter, type IssueFilterPatch } from "@/components/planning-canvas/nodes/issue-board";

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
const SELECT = "max-w-28 rounded border border-border bg-background px-1 py-0.5 text-xs text-foreground";
const titleCase = (key: string) => key.replace(/_/g, " ").replace(/^\w/, (ch) => ch.toUpperCase());

/**
 * Filter controls for a kanban or timeline node. Every change is written to the node's
 * `IssueQuery.filter` through `onChange`; names render as text only (React escapes them).
 */
export function IssueFilters({ query, onChange }: { query: PlanningCanvasIssueQuery; onChange: (next: PlanningCanvasIssueQuery) => void }) {
  const latest = useLatestCanvas();
  const companyId = latest.current.selectedCompanyId ?? "";
  const agents = latest.current.agents ?? [];
  const projects = useQuery({ queryKey: queryKeys.projects.list(companyId), queryFn: () => projectsApi.list(companyId), enabled: !!companyId, staleTime: 30_000 });
  const goals = useQuery({ queryKey: queryKeys.goals.list(companyId), queryFn: () => goalsApi.list(companyId), enabled: !!companyId, staleTime: 30_000 });
  const parentId = query.filter.parentId;
  const parent = useQuery({ queryKey: queryKeys.issues.detail(parentId ?? ""), queryFn: () => issuesApi.get(parentId!), enabled: !!parentId, staleTime: 30_000 });
  const [parentText, setParentText] = useState("");
  const [parentError, setParentError] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const { filter } = query;
  const set = (patch: IssueFilterPatch) => onChange(withFilter(query, patch));
  const count = activeFilterCount(filter);

  const resolveParent = async () => {
    const text = parentText.trim();
    if (!text) return;
    try {
      const found = await issuesApi.get(text);
      setParentError(false);
      setParentText("");
      set({ parentId: found.id });
    } catch {
      setParentError(true);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1" onPointerDown={stop} onDoubleClick={stop} role="group" aria-label="Filters">
      <select aria-label="Filter by project" className={SELECT} value={filter.projectId ?? ""} onChange={(e) => set({ projectId: e.target.value })}>
        <option value="">All projects</option>
        {filter.projectId && !projects.data?.some((p) => p.id === filter.projectId) ? <option value={filter.projectId}>Project</option> : null}
        {(projects.data ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <select aria-label="Filter by assignee" className={SELECT} value={filter.assigneeAgentId ?? ""} onChange={(e) => set({ assigneeAgentId: e.target.value })}>
        <option value="">Any assignee</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <select aria-label="Filter by goal" className={SELECT} value={filter.goalId ?? ""} onChange={(e) => set({ goalId: e.target.value })}>
        <option value="">Any goal</option>
        {filter.goalId && !goals.data?.some((g) => g.id === filter.goalId) ? <option value={filter.goalId}>Goal</option> : null}
        {(goals.data ?? []).map((g) => (
          <option key={g.id} value={g.id}>
            {g.title}
          </option>
        ))}
      </select>
      <div className="relative">
        <button type="button" aria-expanded={statusOpen} aria-label="Filter by status" className={cn(SELECT, "text-left")} onClick={() => setStatusOpen((o) => !o)}>
          {filter.status?.length ? `Status (${filter.status.length})` : "Any status"}
        </button>
        {statusOpen ? (
          <ul className="absolute z-10 mt-0.5 flex flex-col rounded border border-border bg-popover p-1 text-xs shadow-md">
            {ISSUE_STATUSES.map((s) => (
              <li key={s}>
                <label className="flex items-center gap-1 whitespace-nowrap px-1 py-0.5">
                  <input type="checkbox" checked={filter.status?.includes(s) ?? false} onChange={() => set({ status: toggleStatus(filter, s) })} />
                  {titleCase(s)}
                </label>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {parentId ? (
        <button type="button" aria-label="Clear parent filter" className={SELECT} onClick={() => set({ parentId: null })}>
          Parent: {parent.data?.identifier ?? "…"} ×
        </button>
      ) : (
        <input
          aria-label="Filter by parent issue"
          aria-invalid={parentError}
          placeholder="Parent (PAR-1)"
          className={cn(SELECT, "w-24", parentError && "border-destructive")}
          value={parentText}
          onChange={(e) => setParentText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") void resolveParent();
          }}
        />
      )}
      {count > 0 ? (
        <button type="button" className="text-xs text-muted-foreground underline" onClick={() => onChange({ ...query, filter: {} })}>
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
