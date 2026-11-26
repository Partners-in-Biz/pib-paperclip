import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, Building2, CircleDot, FolderOpen, Layers, Mail, Megaphone, MessageSquare, Receipt, Search, Target, User, X } from "lucide-react";
import { CANVAS_CARDS_LIMITS, CANVAS_CARDS_SEARCH_ACTION, canvasCardsSearchResultSchema, type PlanningCanvasRefNodeKind } from "@paperclipai/shared";
import { goalsApi } from "@/api/goals";
import { issuesApi } from "@/api/issues";
import { pluginsApi } from "@/api/plugins";
import { usePluginSlots } from "@/plugins/slots";
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

/** Icon per plugin card kind; unknown kinds fall back to a generic card icon. The tooltip carries the name. */
const PLUGIN_KIND_ICONS: Record<string, typeof Bot> = {
  company: Building2,
  contact: User,
  campaign: Megaphone,
  invoice: Receipt,
  mail: Mail,
  "card-post": MessageSquare,
};

type Row = { id: string; primary: string; secondary?: string | null; type?: string };

/** One tab per installed entity kind that offers search (PAR-14389 C.3). */
interface PluginTab {
  id: string;
  label: string;
  pluginId: string;
  pluginKey: string;
  kind: string;
}

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
  const { insertEmbedNode } = c;
  const [tabId, setTabId] = useState<string>("issue");
  const { slots } = usePluginSlots({ slotTypes: ["canvasNode"], companyId: selectedCompanyId });
  const pluginTabs = useMemo((): PluginTab[] => {
    const seen = new Set<string>();
    const tabs: PluginTab[] = [];
    for (const slot of slots) {
      if (!slot.entityCard?.search) continue;
      const id = `plugin:${slot.pluginKey}:${slot.entityCard.kind}`;
      if (seen.has(id)) continue;
      seen.add(id);
      tabs.push({ id, label: slot.entityCard.kind, pluginId: slot.pluginId, pluginKey: slot.pluginKey, kind: slot.entityCard.kind });
    }
    return tabs;
  }, [slots]);
  const pluginTab = pluginTabs.find((tab) => tab.id === tabId) ?? null;
  // A tab whose plugin is no longer in the slot list falls back to Issues, and Issues shows as selected.
  const activeTabId = pluginTab ? tabId : TABS.some((tab) => tab.kind === tabId) ? tabId : "issue";
  const kind: PlanningCanvasRefNodeKind = pluginTab ? "issue" : (activeTabId as PlanningCanvasRefNodeKind);
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

  const cardResults = useQuery({
    queryKey: ["planning-canvas", "card-search", selectedCompanyId, pluginTab?.id, q],
    enabled: insertPanelOpen && !!pluginTab && !!selectedCompanyId,
    retry: false,
    queryFn: async (): Promise<Row[]> => {
      try {
        const res = await pluginsApi.bridgePerformAction(
          pluginTab!.pluginId,
          CANVAS_CARDS_SEARCH_ACTION,
          { type: pluginTab!.kind, q, limit: CANVAS_CARDS_LIMITS.searchLimitMax },
          selectedCompanyId,
        );
        const parsed = canvasCardsSearchResultSchema.safeParse(res.data);
        if (!parsed.success) return [];
        return parsed.data.cards.map((card) => ({ id: card.id, primary: card.title, secondary: card.subtitle, type: card.type }));
      } catch {
        // A refusal or outage shows "Nothing found", never another person's data or a raw error.
        return [];
      }
    },
  });

  const { rows, loading } = useMemo((): { rows: Row[]; loading: boolean } => {
    if (pluginTab) return { loading: cardResults.isLoading, rows: cardResults.data ?? [] };
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
  }, [kind, issueResults.data, issueResults.isLoading, goalResults.data, goalResults.isLoading, agents, projects, needle, pluginTab, cardResults.data, cardResults.isLoading]);

  if (!insertPanelOpen) return null;
  return (
    <div className="z-30 flex w-72 shrink-0 flex-col border-l border-border bg-background/95 shadow-xl backdrop-blur-xs">
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <div className="text-xs font-semibold text-foreground">Add live card</div>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Close insert panel" onClick={() => setInsertPanelOpen(false)}>
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="flex flex-wrap gap-1 border-b border-border p-2" role="tablist" aria-label="Card type">
        {TABS.map(({ kind: tabKind, label, icon: Icon }) => (
          <button
            key={tabKind}
            type="button"
            role="tab"
            aria-selected={activeTabId === tabKind}
            title={label}
            aria-label={label}
            onClick={() => setTabId(tabKind)}
            className={cn(
              "flex h-7 flex-1 items-center justify-center rounded-md transition-colors",
              activeTabId === tabKind ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
          </button>
        ))}
        {pluginTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTabId === tab.id}
            title={tab.label}
            aria-label={tab.label}
            onClick={() => setTabId(tab.id)}
            className={cn(
              "flex h-7 flex-1 items-center justify-center rounded-md transition-colors",
              activeTabId === tab.id ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {(() => {
              const PluginIcon = PLUGIN_KIND_ICONS[tab.kind] ?? Layers;
              return <PluginIcon className="size-3.5" />;
            })()}
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
            placeholder={`Search ${(pluginTab?.label ?? TABS.find((tab) => tab.kind === kind)!.label).toLowerCase()}…`}
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
                onClick={() => (pluginTab ? insertEmbedNode(pluginTab.pluginKey, row.type ?? pluginTab.kind, row.id) : insertLinkNode(kind, row.id))}
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
