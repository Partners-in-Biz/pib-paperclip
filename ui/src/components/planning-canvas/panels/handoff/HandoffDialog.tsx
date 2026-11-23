import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { PLANNING_CANVAS_LIMITS, type PlanningCanvasHandoff } from "@paperclipai/shared";
import { planningCanvasesApi } from "@/api/planningCanvases";
import { type CanvasController } from "@/components/planning-canvas/state/useCanvasController";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/select";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

type Mode = PlanningCanvasHandoff["mode"];

const MODES: Array<{ mode: Mode; title: string; hint: (count: number) => string }> = [
  { mode: "one_per_node", title: "One issue per node", hint: (n) => `${n} issue${n === 1 ? "" : "s"}, each linked to its node` },
  { mode: "single", title: "One issue for the selection", hint: () => "One issue holding every node's text, linked to all nodes" },
];

/**
 * Hand the selected nodes to agents (C10): one issue per node, or a single issue for all of them,
 * optionally assigned (and woken). The server links each node to its issue; a replay of the same
 * `idempotencyKey` creates nothing, so a double click or a retry is safe.
 */
export function HandoffDialog({ c }: { c: CanvasController }) {
  const { handoffOpen, setHandoffOpen, selectedNodeIds, selectedCompanyId, activeBoard, agents, opStore, pushToast, queryClient } = c;
  const count = selectedNodeIds.length;
  const max = PLANNING_CANVAS_LIMITS.handoffKeysMax;
  const [mode, setMode] = useState<Mode>("one_per_node");
  const [assigneeAgentId, setAssigneeAgentId] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const handoff = useMutation({
    mutationFn: async () => {
      await opStore.flush();
      return planningCanvasesApi.handoff(selectedCompanyId!, activeBoard!.id, {
        keys: selectedNodeIds,
        mode,
        idempotencyKey,
        ...(assigneeAgentId ? { assigneeAgentId } : {}),
      });
    },
    onSuccess: async (result) => {
      const made = result.issues.length;
      pushToast({
        title: result.replayed ? "Already handed off" : `${made} issue${made === 1 ? "" : "s"} created`,
        body: result.issues.map((issue) => ("identifier" in issue && issue.identifier) || "").filter(Boolean).join(", ") || undefined,
        tone: "success",
      });
      setHandoffOpen(false);
      await opStore.catchUp();
      void queryClient.invalidateQueries({ queryKey: queryKeys.planningCanvasRefs.all(selectedCompanyId!) });
    },
  });

  useEffect(() => {
    if (handoffOpen) {
      handoff.reset();
      setMode(count > 1 ? "one_per_node" : "single");
      setAssigneeAgentId("");
      setIdempotencyKey(crypto.randomUUID());
    }
    // Reset only when the dialog opens, not as the selection is edited behind it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoffOpen]);

  const tooMany = count > max;
  const disabled = handoff.isPending || count === 0 || tooMany || !activeBoard;
  const activeAgents = agents.filter((agent) => agent.status !== "terminated");

  return (
    <Dialog open={handoffOpen} onOpenChange={(open) => !handoff.isPending && setHandoffOpen(open)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Hand {count} node{count === 1 ? "" : "s"} to agents</DialogTitle>
          <DialogDescription>Each node shows the issues it is linked to.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {count > 1 ? (
            <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Handoff mode">
              {MODES.map((option) => (
                <button
                  key={option.mode}
                  type="button"
                  role="radio"
                  aria-checked={mode === option.mode}
                  onClick={() => setMode(option.mode)}
                  className={cn(
                    "flex flex-col gap-0.5 rounded-lg border p-2.5 text-left transition-colors",
                    mode === option.mode ? "border-ring bg-accent/40" : "border-border hover:bg-accent/30",
                  )}
                >
                  <span className="text-sm font-semibold text-foreground">{option.title}</span>
                  <span className="text-xs text-muted-foreground">{option.hint(count)}</span>
                </button>
              ))}
            </div>
          ) : null}
          <label className="flex flex-col gap-1 text-xs font-medium text-foreground">
            Assign to
            <NativeSelect value={assigneeAgentId} onChange={(e) => setAssigneeAgentId(e.target.value)} aria-label="Assign to agent">
              <option value="">Nobody (create only)</option>
              {activeAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </NativeSelect>
          </label>
          {tooMany ? <p className="text-xs text-destructive">At most {max} nodes per handoff; you selected {count}.</p> : null}
          {handoff.error ? (
            <p role="alert" className="text-xs text-destructive">
              {handoff.error instanceof Error ? handoff.error.message : "The handoff failed."}
            </p>
          ) : null}
        </div>
        <DialogFooter className="sm:justify-between">
          <Button type="button" variant="ghost" onClick={() => setHandoffOpen(false)} disabled={handoff.isPending}>
            Cancel
          </Button>
          <Button type="button" onClick={() => handoff.mutate()} disabled={disabled}>
            <Send className="size-3.5" />
            {handoff.isPending ? "Handing off…" : "Hand off"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
