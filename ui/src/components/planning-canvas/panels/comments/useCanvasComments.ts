import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PlanningCanvasComment } from "@paperclipai/shared";
import { authApi } from "@/api/auth";
import { planningCanvasesApi } from "@/api/planningCanvases";
import { queryKeys } from "@/lib/queryKeys";

/** Pins poll slowly; an open thread polls fast so an agent's reply shows up without a reload. */
const PINS_POLL_MS = 15_000;
const THREAD_POLL_MS = 5_000;

const seenKey = (boardId: string) => `paperclip.planningCanvas.commentsSeen:${boardId}`;
const threadId = (itemKey: string | null) => itemKey ?? "";

function readSeen(boardId: string): Record<string, string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(seenKey(boardId)) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export interface ThreadSummary {
  itemKey: string | null;
  count: number;
  openCount: number;
  unread: boolean;
  latestAt: string;
}

/** Summarise the comments of a board into one entry per thread (node key, or `""` for the board thread). */
export function summarizeThreads(
  comments: readonly PlanningCanvasComment[],
  seen: Record<string, string>,
  currentUserId: string | null,
): Map<string, ThreadSummary> {
  const out = new Map<string, ThreadSummary>();
  for (const comment of comments) {
    if (comment.deletedAt) continue;
    const id = threadId(comment.itemKey);
    const entry = out.get(id) ?? { itemKey: comment.itemKey, count: 0, openCount: 0, unread: false, latestAt: "" };
    entry.count += 1;
    // A thread is resolved when its root comment is; replies follow their root.
    if (!comment.parentId && !comment.resolvedAt) entry.openCount += 1;
    const mine = currentUserId !== null && comment.authorUserId === currentUserId;
    if (!mine && comment.createdAt > (seen[id] ?? "")) entry.unread = true;
    if (comment.createdAt > entry.latestAt) entry.latestAt = comment.createdAt;
    out.set(id, entry);
  }
  return out;
}

export function useCanvasComments(companyId: string | null | undefined, boardId: string | null | undefined) {
  const queryClient = useQueryClient();
  const enabled = Boolean(companyId && boardId);
  const [seenVersion, setSeenVersion] = useState(0);

  const { data: session } = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  const all = useQuery({
    queryKey: queryKeys.planningCanvases.comments(companyId ?? "", boardId ?? ""),
    queryFn: () => planningCanvasesApi.listComments(companyId!, boardId!),
    enabled,
    refetchInterval: PINS_POLL_MS,
  });

  const comments = all.data?.comments;
  const threads = useMemo(
    () => summarizeThreads(comments ?? [], boardId ? readSeen(boardId) : {}, currentUserId),
    // `seenVersion` re-reads the storage after markSeen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [comments, boardId, currentUserId, seenVersion],
  );

  const markSeen = useCallback(
    (itemKey: string | null, latestAt: string) => {
      if (!boardId || !latestAt) return;
      const seen = readSeen(boardId);
      const id = threadId(itemKey);
      if ((seen[id] ?? "") >= latestAt) return;
      try {
        window.localStorage.setItem(seenKey(boardId), JSON.stringify({ ...seen, [id]: latestAt }));
      } catch {
        // Storage unavailable: the dot just comes back on reload.
      }
      setSeenVersion((v) => v + 1);
    },
    [boardId],
  );

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.planningCanvases.comments(companyId ?? "", boardId ?? "") }),
    [queryClient, companyId, boardId],
  );

  const create = useMutation({
    mutationFn: (input: { itemKey: string | null; parentId?: string | null; body: string }) =>
      planningCanvasesApi.createComment(companyId!, boardId!, input),
    onSuccess: refresh,
  });

  const resolve = useMutation({
    mutationFn: (input: { commentId: string; resolved: boolean }) =>
      planningCanvasesApi.resolveComment(companyId!, boardId!, input.commentId, input.resolved),
    onSuccess: refresh,
  });

  return { threads, currentUserId, markSeen, create, resolve, loading: all.isLoading, error: all.error };
}

export function useCommentThread(
  companyId: string | null | undefined,
  boardId: string | null | undefined,
  itemKey: string | null,
  open: boolean,
) {
  return useQuery({
    queryKey: queryKeys.planningCanvases.thread(companyId ?? "", boardId ?? "", itemKey),
    queryFn: () => planningCanvasesApi.readThread(companyId!, boardId!, itemKey),
    enabled: open && Boolean(companyId && boardId),
    refetchInterval: THREAD_POLL_MS,
  });
}
