import { useCallback, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PLANNING_CANVAS_CHAT_ERROR_CODES, type PlanningCanvasChatMessageResult } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { heartbeatsApi } from "@/api/heartbeats";
import { issuesApi } from "@/api/issues";
import { planningCanvasesApi } from "@/api/planningCanvases";
import { useSessionUserId } from "@/components/planning-canvas/panels/sharing/useSessionUserId";

const THREAD_ORIGIN_KIND = "planning_canvas";
const POLL_MS = 4000;

export type ChatNotice = { kind: "off" | "rate_limited" | "error"; message: string };

function noticeFor(err: unknown): ChatNotice {
  if (err instanceof ApiError) {
    if (err.code === PLANNING_CANVAS_CHAT_ERROR_CODES.disabled) return { kind: "off", message: "Board chat is switched off." };
    if (err.code === PLANNING_CANVAS_CHAT_ERROR_CODES.rateLimited) {
      return { kind: "rate_limited", message: "You have sent a lot of messages. Wait a little, then send again." };
    }
    return { kind: "error", message: err.message };
  }
  return { kind: "error", message: err instanceof Error ? err.message : "Could not send the message." };
}

/**
 * Board chat state (PAR-14277): the asker's thread with one agent on one board (found by its origin, or taken
 * from the last send), its comments, and the run state of the issue. The thread is an ordinary issue.
 */
export function useBoardChat(companyId: string | null, boardId: string | undefined, agentId: string | null, open: boolean) {
  const client = useQueryClient();
  const userId = useSessionUserId();
  const [sentThread, setSentThread] = useState<{ agentId: string; issueId: string } | null>(null);
  const [notice, setNotice] = useState<ChatNotice | null>(null);
  const [off, setOff] = useState(false);
  // One id per draft: a double click, or a retry after a failure, sends the same id and the server writes it once.
  const requestId = useRef<string | null>(null);
  const inFlight = useRef(false);

  const enabled = Boolean(open && companyId && boardId && agentId && userId);
  const threads = useQuery({
    queryKey: ["planning-canvas-chat", companyId, boardId, agentId, "thread"],
    queryFn: () =>
      issuesApi.list(companyId!, { originKind: THREAD_ORIGIN_KIND, originId: `${boardId}:chat`, assigneeAgentId: agentId!, limit: 20 }),
    enabled,
  });
  const found = useMemo(
    () => threads.data?.find((i) => i.createdByUserId === userId && !["cancelled"].includes(i.status))?.id ?? null,
    [threads.data, userId],
  );
  const threadId = sentThread && sentThread.agentId === agentId ? sentThread.issueId : found;

  const comments = useQuery({
    queryKey: ["planning-canvas-chat", companyId, boardId, agentId, "comments", threadId],
    queryFn: () => issuesApi.listComments(threadId!, { order: "asc", limit: 100 }),
    enabled: open && Boolean(threadId),
    refetchInterval: POLL_MS,
  });
  const runs = useQuery({
    queryKey: ["planning-canvas-chat", companyId, boardId, agentId, "runs", threadId],
    queryFn: () => heartbeatsApi.liveRunsForIssue(threadId!),
    enabled: open && Boolean(threadId),
    refetchInterval: POLL_MS,
  });
  const liveRun = runs.data?.find((r) => r.status === "running" || r.status === "queued") ?? null;

  const mutation = useMutation({
    mutationFn: (body: string) =>
      planningCanvasesApi.sendChat(companyId!, boardId!, { agentId: agentId!, body, clientRequestId: requestId.current! }),
  });

  const send = useCallback(
    async (body: string): Promise<boolean> => {
      const text = body.trim();
      if (!text || !companyId || !boardId || !agentId || off || inFlight.current) return false;
      inFlight.current = true;
      requestId.current ??= crypto.randomUUID();
      setNotice(null);
      try {
        const result: PlanningCanvasChatMessageResult = await mutation.mutateAsync(text);
        requestId.current = null;
        setSentThread({ agentId, issueId: result.threadIssueId });
        void client.invalidateQueries({ queryKey: ["planning-canvas-chat", companyId, boardId, agentId] });
        return true;
      } catch (err) {
        const n = noticeFor(err);
        if (n.kind === "off") setOff(true);
        setNotice(n);
        return false;
      } finally {
        inFlight.current = false;
      }
    },
    [companyId, boardId, agentId, off, mutation, client],
  );

  return {
    userId,
    threadId,
    comments: comments.data ?? [],
    loading: enabled && (threads.isLoading || (Boolean(threadId) && comments.isLoading)),
    loadError: threads.error ?? comments.error,
    liveRun,
    sending: mutation.isPending,
    notice,
    off,
    send,
  };
}
