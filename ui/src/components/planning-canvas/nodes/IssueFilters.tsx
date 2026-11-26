import { OptionSelect } from "@/components/OptionSelect";
import { AgentPicker } from "@/components/AgentPicker";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ISSUE_STATUSES, type PlanningCanvasIssueQuery } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { goalsApi } from "@/api/goals";
import { issuesApi } from "@/api/issues";
import { projectsApi } from "@/api/projects";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useLatestCanvas } from "@/components/planning-canvas/nodes/canvas-context";
import { activeFilterCount, toggleStatus, withFilter, type IssueFilterPatch } from "@/components/planning-canvas/nodes/issue-board";

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
// One size for every control in the row so the selectors line up.
const SELECT = "h-7 w-36 rounded-md border border-border bg-background px-2 text-xs font-normal text-foreground";
const TRIGGER = "h-7 min-h-7 w-36 px-2 py-0 text-xs font-normal";
const titleCase = (key: string) => key.replace(/_/g, " ").replace(/^\w/, (ch) => ch.toUpperCase());

/**
 * Filter controls for a kanban or timeline node. Every change is written to the node's
 * `IssueQuery.filter` through `onChange`; names render as text only (React escapes them).
 */
export function IssueFilters({ query, onChange }: { query: PlanningCanvasIssueQuery; onChange: (next: PlanningCanvasIssueQuery) => void }) {
  const latest = useLatestCanvas();
  const companyId = latest.current.selectedCompanyId ?? "";
  // Same key as the controller's agents read, so it is shared from cache and re-renders when it loads.
  const agentsQuery = useQuery({ queryKey: queryKeys.agents.list(companyId), queryFn: () => agentsApi.list(companyId), enabled: !!companyId, staleTime: 30_000 });
  const agents = agentsQuery.data ?? [];
  const projects = useQuery({ queryKey: queryKeys.projects.list(companyId), queryFn: () => projectsApi.list(companyId), enabled: !!companyId, staleTime: 30_000 });
  const goals = useQuery({ queryKey: queryKeys.goals.list(companyId), queryFn: () => goalsApi.list(companyId), enabled: !!companyId, staleTime: 30_000 });
  const parentId = query.filter.parentId;
  const parent = useQuery({ queryKey: queryKeys.issues.detail(parentId ?? ""), queryFn: () => issuesApi.get(parentId!), enabled: !!parentId, staleTime: 30_000 });
  const [parentText, setParentText] = useState("");
  const [parentError, setParentError] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!statusOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!statusRef.current?.contains(e.target as Node)) setStatusOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setStatusOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [statusOpen]);
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
      <OptionSelect
        ariaLabel="Filter by project"
        value={filter.projectId ?? ""}
        items={[
          ...(filter.projectId && !projects.data?.some((p) => p.id === filter.projectId) ? [{ value: filter.projectId, label: "Project" }] : []),
          ...(projects.data ?? []).map((p) => ({ value: p.id, label: p.name })),
        ]}
        emptyLabel="All projects"
        placeholder="All projects"
        searchPlaceholder="Search projects…"
        triggerClassName={TRIGGER}
        onChange={(id) => set({ projectId: id })}
      />
      <AgentPicker
        ariaLabel="Filter by assignee"
        agents={agents}
        value={filter.assigneeAgentId ?? ""}
        onChange={(id) => set({ assigneeAgentId: id })}
        emptyLabel="Any assignee"
        placeholder="Any assignee"
        triggerClassName={TRIGGER}
        compact
      />
      <OptionSelect
        ariaLabel="Filter by goal"
        items={[
          ...(filter.goalId && !goals.data?.some((g) => g.id === filter.goalId) ? [{ value: filter.goalId, label: "Goal" }] : []),
          ...(goals.data ?? []).map((g) => ({ value: g.id, label: g.title })),
        ]}
        value={filter.goalId ?? ""}
        onChange={(id) => set({ goalId: id })}
        emptyLabel="Any goal"
        placeholder="Any goal"
        triggerClassName={TRIGGER}
      />
      <div className="relative" ref={statusRef}>
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
        <button type="button" aria-label="Clear parent filter" className={cn(SELECT, "truncate text-left")} onClick={() => set({ parentId: null })}>
          Parent: {parent.data?.identifier ?? "…"} ×
        </button>
      ) : (
        <input
          aria-label="Filter by parent issue"
          aria-invalid={parentError}
          placeholder="Parent (PAR-1)"
          className={cn(SELECT, parentError && "border-destructive")}
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
