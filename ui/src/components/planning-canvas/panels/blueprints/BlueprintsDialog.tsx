import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { LayoutTemplate } from "lucide-react";
import {
  PLANNING_CANVAS_BLUEPRINTS,
  PLANNING_CANVAS_BLUEPRINT_ISSUES_PER_CALL_MAX,
  type PlanningCanvasBlueprint,
} from "@paperclipai/shared";
import { planningCanvasesApi } from "@/api/planningCanvases";
import type { PlanningCanvasBoard } from "@paperclipai/shared";
import { BlueprintPreview } from "@/components/planning-canvas/panels/blueprints/BlueprintPreview";
import { type CanvasController } from "@/components/planning-canvas/state/useCanvasController";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/select";
import { createCanvasId } from "@/lib/planning-canvas-helpers";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

/** `crypto.randomUUID` only exists on secure origins; the key only has to be unique per attempt. */
function newIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() ?? `${createCanvasId("blueprint")}-${Date.now().toString(36)}`;
}

function nodeTitles(blueprint: PlanningCanvasBlueprint) {
  const titles = new Map<string, string>();
  for (const item of blueprint.items) if (item.itemType === "node") titles.set(item.key, item.title || item.key);
  return titles;
}

/**
 * Blueprints (C18): a gallery of the six built-ins, a to-scale preview, and an apply step where each
 * marked node can be switched on or off as an issue and given an assignee. Apply creates a new board
 * (plus the parent issue and the chosen issues) and opens it. The same `idempotencyKey` replays, so a
 * double click or a retry creates nothing twice.
 */
export function BlueprintsDialog({ c }: { c: CanvasController }) {
  const { blueprintsOpen, setBlueprintsOpen, selectedCompanyId, agents, pushToast, queryClient, setActiveBoardId } = c;
  const [blueprintId, setBlueprintId] = useState<string>(PLANNING_CANVAS_BLUEPRINTS[0]!.id);
  const [title, setTitle] = useState("");
  const [parentIssue, setParentIssue] = useState(true);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [assignees, setAssignees] = useState<Record<string, string>>({});
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey());

  const blueprint = PLANNING_CANVAS_BLUEPRINTS.find((b) => b.id === blueprintId) ?? PLANNING_CANVAS_BLUEPRINTS[0]!;
  const titles = useMemo(() => nodeTitles(blueprint), [blueprint]);
  const shownKeys = blueprint.issueKeys.slice(0, PLANNING_CANVAS_BLUEPRINT_ISSUES_PER_CALL_MAX);
  const chosen = shownKeys.filter((key) => enabled[key] !== false);
  const issueCount = chosen.length + (parentIssue ? 1 : 0);
  const activeAgents = agents.filter((agent) => agent.status !== "terminated");

  const apply = useMutation({
    mutationFn: () =>
      planningCanvasesApi.fromBlueprint(selectedCompanyId!, {
        blueprintId: blueprint.id,
        idempotencyKey,
        ...(title.trim() ? { title: title.trim() } : {}),
        parentIssue,
        issues: chosen.map((key) => (assignees[key] ? { key, assigneeAgentId: assignees[key] } : { key })),
      }),
    onSuccess: (result) => {
      queryClient.setQueryData<PlanningCanvasBoard[]>(queryKeys.planningCanvases.list(selectedCompanyId!), (prev) => {
        const rest = (prev ?? []).filter((board) => board.id !== result.board.id);
        return [result.board, ...rest];
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.planningCanvasRefs.all(selectedCompanyId!) });
      const made = result.issues.length + (result.parentIssue ? 1 : 0);
      pushToast({
        title: result.replayed ? "Board already created" : `Board created with ${made} issue${made === 1 ? "" : "s"}`,
        body: [result.parentIssue, ...result.issues].map((issue) => issue?.identifier).filter(Boolean).join(", ") || undefined,
        tone: "success",
      });
      setActiveBoardId(result.board.id);
      setBlueprintsOpen(false);
    },
  });

  // A new pick or a fresh open starts clean: every marked node on, nobody assigned, a new key.
  useEffect(() => {
    setEnabled({});
    setAssignees({});
    setTitle("");
    setParentIssue(true);
    setIdempotencyKey(newIdempotencyKey());
    apply.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blueprintsOpen, blueprintId]);

  return (
    <Dialog open={blueprintsOpen} onOpenChange={(open) => !apply.isPending && setBlueprintsOpen(open)}>
      <DialogContent className="max-h-dvh max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Start from a blueprint</DialogTitle>
          <DialogDescription>Pick a layout. It opens as a new board; the nodes you tick become issues.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Blueprint">
            {PLANNING_CANVAS_BLUEPRINTS.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={option.id === blueprint.id}
                onClick={() => setBlueprintId(option.id)}
                className={cn(
                  "flex flex-col gap-0.5 rounded-lg border p-2.5 text-left transition-colors",
                  option.id === blueprint.id ? "border-ring bg-accent/40" : "border-border hover:bg-accent/30",
                )}
              >
                <span className="text-sm font-semibold text-foreground">{option.title}</span>
                <span className="text-xs text-muted-foreground">{option.description}</span>
              </button>
            ))}
          </div>

          <div className="flex min-w-0 flex-col gap-3 md:col-span-2">
            <BlueprintPreview blueprint={blueprint} issueKeys={new Set(chosen)} className="max-h-72" />
            <label className="flex flex-col gap-1 text-xs font-medium text-foreground">
              Board title
              <input
                type="text"
                value={title}
                maxLength={160}
                placeholder={blueprint.title}
                onChange={(e) => setTitle(e.target.value)}
                className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-ring"
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-foreground">
              <Checkbox checked={parentIssue} onCheckedChange={(v) => setParentIssue(v === true)} aria-label="Create a parent issue" />
              Create a parent issue; the issues below become its children
            </label>
            <ul className="flex flex-col gap-1.5" aria-label="Issues to create">
              {shownKeys.map((key) => (
                <li key={key} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5">
                  <label className="flex min-w-0 flex-1 items-center gap-2 text-xs font-medium text-foreground">
                    <Checkbox
                      checked={enabled[key] !== false}
                      onCheckedChange={(v) => setEnabled((prev) => ({ ...prev, [key]: v === true }))}
                      aria-label={`Create an issue for ${titles.get(key) ?? key}`}
                    />
                    <span className="truncate">{titles.get(key) ?? key}</span>
                  </label>
                  <NativeSelect
                    value={assignees[key] ?? ""}
                    disabled={enabled[key] === false}
                    onChange={(e) => setAssignees((prev) => ({ ...prev, [key]: e.target.value }))}
                    aria-label={`Assign ${titles.get(key) ?? key} to`}
                    className="w-40"
                  >
                    <option value="">Unassigned</option>
                    {activeAgents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </NativeSelect>
                </li>
              ))}
            </ul>
            {apply.error ? (
              <p role="alert" className="text-xs text-destructive">
                {apply.error instanceof Error ? apply.error.message : "Could not create the board."}
              </p>
            ) : null}
          </div>
        </div>
        <DialogFooter className="sm:justify-between">
          <Button type="button" variant="ghost" onClick={() => setBlueprintsOpen(false)} disabled={apply.isPending}>
            Cancel
          </Button>
          <Button type="button" onClick={() => apply.mutate()} disabled={apply.isPending || !selectedCompanyId}>
            <LayoutTemplate className="size-3.5" />
            {apply.isPending ? "Creating…" : `Create board${issueCount ? ` and ${issueCount} issue${issueCount === 1 ? "" : "s"}` : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
