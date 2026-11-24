import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, CircleDot, FolderOpen, Search, Target, X } from "lucide-react";
import type { PlanningCanvasRefNodeKind } from "@paperclipai/shared";
import { goalsApi } from "@/api/goals";
import { issuesApi } from "@/api/issues";
import { type CanvasController } from "@/components/planning-canvas/state/useCanvasController";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

const TABS: Array<{ kind: PlanningCanvasRefNodeKind; label: string; icon: typeof Bot }> = [
  { kind: "issue", label: "Issues", icon: CircleDot },
  { kind: "agent", label: "Agents", icon: Bot },
  { kind: "project", label: "Projects", icon: FolderOpen },
  { kind: "goal", label: "Goals", icon: Target },
];

type Row = { id: string; primary: string; secondary?: string | null };

const RESULT_LIMIT = 30;

function useDebounced(value: string, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function matches(q: string, ...parts: Array<string | null | undefined>) {
  return !q || parts.some((part) => part?.toLowerCase().includes(q));
}

/** Search the company's issues, agents, projects and goals and drop one onto the board as a live card. */
export function InsertLinkPanel({ c }: { c: CanvasController }) {
  const { insertPanelOpen, setInsertPanelOpen, selectedCompanyId, agents, projects, insertLinkNode } = c;
  const [kind, setKind] = useState<PlanningCanvasRefNodeKind>("issue");
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 250);
  const needle = q.toLowerCase();

  const issueResults = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId ?? ""), "canvas-insert", q],
    queryFn: () => issuesApi.list(selectedCompanyId!, { q: q || undefined, limit: RESULT_LIMIT }),
    enabled: insertPanelOpen && kind === "issue" && !!selectedCompanyId,
  });
  const goalResults = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId ?? ""),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: insertPanelOpen && kind === "goal" && !!selectedCompanyId,
  });

  const { rows, loading } = useMemo((): { rows: Row[]; loading: boolean } => {
    switch (kind) {
      case "issue":
        return {
          loading: issueResults.isLoading,
          rows: (issueResults.data ?? []).map((issue) => ({ id: issue.id, primary: issue.title, secondary: issue.identifier })),
        };
      case "agent":
        return {
          loading: false,
          rows: agents
            .filter((agent) => agent.status !== "terminated" && matches(needle, agent.name, agent.title))
            .slice(0, RESULT_LIMIT)
            .map((agent) => ({ id: agent.id, primary: agent.name, secondary: agent.title })),
        };
      case "project":
        return {
          loading: false,
          rows: projects
            .filter((project) => !project.archivedAt && matches(needle, project.name))
            .slice(0, RESULT_LIMIT)
            .map((project) => ({ id: project.id, primary: project.name })),
        };
      case "goal":
        return {
          loading: goalResults.isLoading,
          rows: (goalResults.data ?? [])
            .filter((goal) => matches(needle, goal.title))
            .slice(0, RESULT_LIMIT)
            .map((goal) => ({ id: goal.id, primary: goal.title, secondary: goal.level })),
        };
    }
  }, [kind, issueResults.data, issueResults.isLoading, goalResults.data, goalResults.isLoading, agents, projects, needle]);

  if (!insertPanelOpen) return null;
  return (
    <div className="z-30 flex w-72 shrink-0 flex-col border-l border-border bg-background/95 shadow-xl backdrop-blur-xs">
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <div className="text-xs font-semibold text-foreground">Add live card</div>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Close insert panel" onClick={() => setInsertPanelOpen(false)}>
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="flex gap-1 border-b border-border p-2" role="tablist" aria-label="Card type">
        {TABS.map(({ kind: tabKind, label, icon: Icon }) => (
          <button
            key={tabKind}
            type="button"
            role="tab"
            aria-selected={kind === tabKind}
            title={label}
            aria-label={label}
            onClick={() => setKind(tabKind)}
            className={cn(
              "flex h-7 flex-1 items-center justify-center rounded-md transition-colors",
              kind === tabKind ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
          </button>
        ))}
      </div>
      <div className="border-b border-border p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${TABS.find((tab) => tab.kind === kind)!.label.toLowerCase()}…`}
            aria-label="Search"
            className="h-7 w-full rounded-md border border-border bg-background pl-7 pr-2 text-xs outline-none focus:border-ring"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {rows.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">{loading ? "Searching…" : "Nothing found."}</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {rows.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => insertLinkNode(kind, row.id)}
                className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-border bg-card p-2.5 text-left transition-colors hover:bg-accent/40"
              >
                {row.secondary ? <span className="truncate text-xs text-muted-foreground">{row.secondary}</span> : null}
                <span className="line-clamp-2 text-xs font-semibold text-foreground">{row.primary}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
