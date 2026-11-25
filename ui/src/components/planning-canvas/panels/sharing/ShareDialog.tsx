import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PLANNING_CANVAS_MEMBER_ACCESS, type PlanningCanvasMemberAccess, type PlanningCanvasScope } from "@paperclipai/shared";
import { planningCanvasesApi, type PlanningCanvasListItem } from "@/api/planningCanvases";
import { AgentGrantsList } from "@/components/planning-canvas/panels/sharing/AgentGrantsList";
import {
  boardPermissions,
  currentSharing,
  MEMBER_ACCESS_LABEL,
  SCOPE_LABEL,
  SHARE_TEXT_NOTE,
  sharingSendable,
  sharingSummary,
  sharingUnchanged,
  sharingWidens,
  type SharingTarget,
} from "@/components/planning-canvas/panels/sharing/sharing-helpers";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/select";
import { queryKeys } from "@/lib/queryKeys";

const SCOPES: PlanningCanvasScope[] = ["personal", "company", "project"];

interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  board: PlanningCanvasListItem;
  userId: string | null;
  projects: Array<{ id: string; name: string }>;
  agents: Array<{ id: string; name: string }>;
  onToast: (title: string, tone: "success" | "error") => void;
}

/**
 * Share a board (plan PAR-13925 Q15-Q17). Widening is the owner's alone and never silent: the access
 * level is shown (edit preselected) before confirm, with the note that everyone with access sees all text.
 * Narrowing, archive and restore are for the owner or a company admin; the server enforces all of it.
 */
export function ShareDialog(props: ShareDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-md" data-testid="planning-canvas-share-dialog">
        <ShareDialogBody {...props} />
      </DialogContent>
    </Dialog>
  );
}

/** The dialog's content, split out so it renders without the portal in tests. */
export function ShareDialogBody({ open, onOpenChange, companyId, board, userId, projects, agents, onToast }: ShareDialogProps) {
  const queryClient = useQueryClient();
  const perms = boardPermissions(board, userId);
  const current = currentSharing(board);
  const [target, setTarget] = useState<SharingTarget>(current);
  const archived = Boolean(board.archivedAt);

  useEffect(() => {
    if (open) setTarget(currentSharing(board));
    // Reset when the dialog opens or a different board is shown, not on every list refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, board.id]);

  const agentNames = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);
  const projectName = projects.find((project) => project.id === target.projectId)?.name ?? null;
  const widens = sharingWidens(board, target);
  const unchanged = sharingUnchanged(board, target);
  const allowed = widens ? perms.canWiden : perms.canNarrow;
  const sendable = sharingSendable(target);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.planningCanvases.list(companyId) });
  const fail = (e: unknown) => onToast(e instanceof Error ? e.message : "The change was refused.", "error");

  const save = useMutation({
    mutationFn: () =>
      planningCanvasesApi.setSharing(companyId, board.id, {
        scope: target.scope,
        ...(target.scope === "project" ? { projectId: target.projectId } : {}),
        ...(target.scope === "personal" ? {} : { memberAccess: target.memberAccess }),
      }),
    onSuccess: async () => {
      await invalidate();
      onToast("Sharing updated", "success");
      onOpenChange(false);
    },
    onError: fail,
  });

  const setArchived = useMutation({
    mutationFn: (next: boolean) => (next ? planningCanvasesApi.archive(companyId, board.id) : planningCanvasesApi.restore(companyId, board.id)),
    onSuccess: async (_result, next) => {
      await Promise.all([invalidate(), queryClient.invalidateQueries({ queryKey: queryKeys.planningCanvases.archived(companyId) })]);
      onToast(next ? "Board archived" : "Board restored", "success");
      onOpenChange(false);
    },
    onError: fail,
  });

  const busy = save.isPending || setArchived.isPending;
  const shared = target.scope !== "personal";

  return (
    <>
        <DialogHeader>
          <DialogTitle>Share “{board.title}”</DialogTitle>
          <DialogDescription>Choose who can open this board and what they can do.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-foreground">
            Who can open it
            <NativeSelect
              aria-label="Who can open this board"
              value={target.scope}
              disabled={archived || busy || !(perms.canWiden || perms.canNarrow)}
              onChange={(e) => {
                const scope = e.target.value as PlanningCanvasScope;
                // Widening never keeps a stale level: edit is preselected, then shown before confirm (Q15).
                setTarget({
                  scope,
                  projectId: scope === "project" ? target.projectId : null,
                  memberAccess: scope !== "personal" && current.scope === "personal" ? "edit" : target.memberAccess,
                });
              }}
            >
              {SCOPES.map((scope) => (
                <option key={scope} value={scope}>
                  {SCOPE_LABEL[scope]}
                </option>
              ))}
            </NativeSelect>
          </label>

          {target.scope === "project" ? (
            <label className="flex flex-col gap-1 text-xs font-medium text-foreground">
              Project
              <NativeSelect
                aria-label="Project"
                value={target.projectId ?? ""}
                disabled={archived || busy}
                onChange={(e) => setTarget({ ...target, projectId: e.target.value || null })}
              >
                <option value="">Choose a project…</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
          ) : null}

          {shared ? (
            <label className="flex flex-col gap-1 text-xs font-medium text-foreground">
              Access level
              <NativeSelect
                aria-label="Access level"
                value={target.memberAccess}
                disabled={archived || busy}
                onChange={(e) => setTarget({ ...target, memberAccess: e.target.value as PlanningCanvasMemberAccess })}
              >
                {PLANNING_CANVAS_MEMBER_ACCESS.map((level) => (
                  <option key={level} value={level}>
                    {MEMBER_ACCESS_LABEL[level]}
                  </option>
                ))}
              </NativeSelect>
            </label>
          ) : null}

          <p data-testid="planning-canvas-share-summary" className="text-xs text-foreground">
            {sharingSummary(target, projectName)}
          </p>
          {shared ? (
            <p data-testid="planning-canvas-share-text-note" className="text-xs text-muted-foreground">
              {SHARE_TEXT_NOTE}
            </p>
          ) : null}
          {widens && !perms.canWiden ? (
            <p role="note" className="text-xs text-muted-foreground">Only the board owner can widen sharing.</p>
          ) : null}

          {perms.canNarrow && board.scope === "personal" ? (
            <AgentGrantsList companyId={companyId} boardId={board.id} agentNames={agentNames} onError={(m) => onToast(m, "error")} />
          ) : null}
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <div className="flex gap-2">
            {perms.canArchive ? (
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setArchived.mutate(!archived)}>
                {archived ? "Restore" : "Archive"}
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" disabled={busy || archived || unchanged || !allowed || !sendable} onClick={() => save.mutate()}>
              {widens ? `Share as ${MEMBER_ACCESS_LABEL[target.memberAccess].toLowerCase()}` : "Save"}
            </Button>
          </div>
        </DialogFooter>
    </>
  );
}
