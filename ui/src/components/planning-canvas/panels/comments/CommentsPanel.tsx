import { useEffect, useMemo } from "react";
import { CheckCircle2, RotateCcw, X } from "lucide-react";
import type { PlanningCanvasComment } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { MarkdownBody } from "@/components/MarkdownBody";
import { CommentComposer } from "@/components/planning-canvas/panels/comments/CommentComposer";
import { LinkedIssueChip } from "@/components/planning-canvas/panels/comments/LinkedIssueChip";
import { useCanvasComments, useCommentThread } from "@/components/planning-canvas/panels/comments/useCanvasComments";
import type { CanvasController } from "@/components/planning-canvas/state/useCanvasController";
import { timeAgo } from "@/lib/timeAgo";
import { cn } from "@/lib/utils";

type Entry = {
  id: string;
  body: string;
  createdAt: string;
  author: string;
  issueId?: string;
  comment?: PlanningCanvasComment;
};

/**
 * The thread side panel: on desktop a right column; under 768 px a bottom sheet over the canvas so the
 * node stays visible. Shows the node's comments plus the comments of the issues its mentions created.
 */
export function CommentsPanel({ c }: { c: CanvasController }) {
  const { selectedCompanyId, activeBoard, nodes, agents, commentThread, setCommentThread } = c;
  const open = commentThread !== null;
  const itemKey = commentThread?.key ?? null;
  const boardId = activeBoard?.id;
  const { threads, currentUserId, markSeen, create, resolve } = useCanvasComments(selectedCompanyId, boardId);
  const thread = useCommentThread(selectedCompanyId, boardId, itemKey, open);

  const agentName = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);
  const entries = useMemo<Entry[]>(() => {
    const data = thread.data;
    if (!data) return [];
    const own = data.comments
      .filter((cm) => !cm.deletedAt)
      .map((cm) => ({
        id: cm.id,
        body: cm.body,
        createdAt: cm.createdAt,
        comment: cm,
        author: cm.authorAgentId
          ? (agentName.get(cm.authorAgentId) ?? "Agent")
          : cm.authorUserId && cm.authorUserId === currentUserId
            ? "You"
            : "Member",
      }));
    const fromIssues = data.issueComments.map((ic) => ({
      id: `issue:${ic.id}`,
      body: ic.body,
      createdAt: ic.createdAt,
      issueId: ic.issueId,
      author: ic.authorAgentId ? (agentName.get(ic.authorAgentId) ?? "Agent") : ic.authorUserId === currentUserId ? "You" : "Member",
    }));
    return [...own, ...fromIssues].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [thread.data, agentName, currentUserId]);

  const latestAt = entries.length > 0 ? entries[entries.length - 1]!.createdAt : "";
  useEffect(() => {
    if (open && latestAt) markSeen(itemKey, latestAt);
  }, [open, itemKey, latestAt, markSeen]);

  if (!open) return null;

  const node = itemKey ? nodes.find((n) => n.id === itemKey) : null;
  const title = itemKey === null ? "Board comments" : node ? (node.title.trim() || node.content.trim().split("\n")[0] || node.kind) : "Comments";
  const summary = threads.get(itemKey ?? "");
  const root = entries.find((e) => e.comment && !e.comment.parentId)?.comment ?? null;
  const resolved = root ? Boolean(root.resolvedAt) : false;
  const errorMessage = create.error instanceof Error ? create.error.message : resolve.error instanceof Error ? resolve.error.message : null;

  return (
    <aside
      aria-label="Comments"
      data-testid="canvas-comments-panel"
      className={cn(
        "pointer-events-auto z-30 flex flex-col border-border bg-background/95 shadow-xl backdrop-blur-xs",
        "absolute inset-x-0 bottom-0 max-h-1/2 border-t md:static md:max-h-none md:w-80 md:shrink-0 md:border-l md:border-t-0",
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold text-foreground">{title}</div>
          <div className="text-xs text-muted-foreground">
            {summary ? `${summary.count} comment${summary.count === 1 ? "" : "s"}` : "No comments yet"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {root ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={resolve.isPending}
              onClick={() => resolve.mutate({ commentId: root.id, resolved: !resolved })}
            >
              {resolved ? <RotateCcw className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
              {resolved ? "Reopen" : "Resolve"}
            </Button>
          ) : null}
          <Button type="button" size="icon-sm" variant="ghost" aria-label="Close comments" onClick={() => setCommentThread(null)}>
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {thread.data && thread.data.linkedIssues.length > 0 ? (
        <div className="flex flex-col items-start gap-1 border-b border-border px-3 py-2">
          {thread.data.linkedIssues.map((issue) => (
            <LinkedIssueChip key={issue.id} issue={issue} />
          ))}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {thread.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : thread.error ? (
          <p role="alert" className="text-xs text-destructive">Could not load comments.</p>
        ) : entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">No comments yet. Mention an agent with @ to hand this node over.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {entries.map((entry) => (
              <li key={entry.id} className={cn("min-w-0", entry.comment?.parentId && "ml-3")}>
                <div className="flex items-baseline gap-2 text-xs">
                  <span className="font-medium text-foreground">{entry.author}</span>
                  <span className="text-muted-foreground">{timeAgo(entry.createdAt)}</span>
                  {entry.issueId ? <span className="text-muted-foreground">via issue</span> : null}
                </div>
                <MarkdownBody className="text-sm wrap-break-word">{entry.body}</MarkdownBody>
              </li>
            ))}
          </ul>
        )}
      </div>

      <CommentComposer
        c={c}
        busy={create.isPending}
        error={errorMessage}
        placeholder={itemKey === null ? "Comment on the board" : "Comment on this node"}
        onSubmit={async (body) => {
          await create.mutateAsync({ itemKey, parentId: root?.id ?? null, body });
          await thread.refetch();
        }}
      />
    </aside>
  );
}
