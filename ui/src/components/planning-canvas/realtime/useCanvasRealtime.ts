import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PlanningCanvasBoard } from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { buildCompanyUserProfileMap } from "@/lib/company-members";
import { queryKeys } from "@/lib/queryKeys";
import { buildSameOriginWebSocketUrl } from "@/lib/websocket-url";
import { CanvasRealtimeClient, type RealtimeStatus } from "@/components/planning-canvas/realtime/canvas-realtime-client";
import type { RealtimeActor } from "@/components/planning-canvas/realtime/realtime-protocol";
import { RealtimeView } from "@/components/planning-canvas/realtime/realtime-view";
import type { CanvasBoard } from "@/components/planning-canvas/state/useCanvasBoard";
import type { CanvasData } from "@/components/planning-canvas/state/useCanvasData";
import type { CanvasState } from "@/components/planning-canvas/state/useCanvasState";

export function planningCanvasSocketPath(companyId: string, boardId: string) {
  return `/api/companies/${encodeURIComponent(companyId)}/planning-canvases/${encodeURIComponent(boardId)}/ws`;
}

/**
 * The board socket for the open board (plan E, C15): remote ops go into the op
 * store, presence into a `RealtimeView` the overlay reads, and every (re)connect
 * catches up with `?since`. `access.revoked` closes the board behind a notice.
 */
export function useCanvasRealtime(ctx: CanvasData & CanvasState & CanvasBoard) {
  const companyId = ctx.selectedCompanyId ?? null;
  const boardId = ctx.activeBoard?.id ?? null;
  const latest = useRef(ctx);
  latest.current = ctx;
  const clientRef = useRef<CanvasRealtimeClient | null>(null);
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  const [revokedBoardId, setRevokedBoardId] = useState<string | null>(null);
  const view = useMemo(() => new RealtimeView(), [boardId]);
  useEffect(() => () => view.dispose(), [view]);

  useEffect(() => {
    if (!companyId || !boardId) return;
    setStatus("connecting");
    const client = new CanvasRealtimeClient({
      url: buildSameOriginWebSocketUrl(planningCanvasSocketPath(companyId, boardId)),
      onStatus: (next) => {
        setStatus(next);
        if (next !== "live") view.clearPeers();
      },
      onMessage: (message) => {
        const { opStore } = latest.current;
        if (message.type === "ops.applied") {
          // Before the first read lands there is nothing to merge into; the catch-up on load covers it.
          if (opStore.loaded) opStore.applyRemote(message.revision, message.truncated ? undefined : message.items);
          if (message.actor.type === "agent") {
            const keys = message.truncated
              ? message.keys
              : message.items.filter((item) => item.itemType === "node" && !item.deletedAt).map((item) => item.key);
            view.flash(keys, message.actor);
          }
        } else if (message.type === "resync") {
          if (opStore.loaded) opStore.applyRemote(message.revision);
        } else if (message.type === "access.revoked") {
          setRevokedBoardId(boardId);
        } else {
          view.applyPresence(message);
        }
      },
    });
    clientRef.current = client;
    client.start();
    const onOnline = () => client.reconnectNow();
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("online", onOnline);
      client.stop();
      if (clientRef.current === client) clientRef.current = null;
    };
  }, [companyId, boardId, view]);

  // Every (re)connect, and the first read landing: catch up on what the socket did not carry.
  const loaded = ctx.opStore.loaded;
  useEffect(() => {
    if (loaded && status === "live") void latest.current.opStore.catchUp();
  }, [loaded, status]);

  // This tab's presence: selection and viewport as they change, the cursor on pointer moves.
  const { viewport, selectedNodeIds, canvasRef } = ctx;
  useEffect(() => {
    const el = canvasRef.current;
    clientRef.current?.setPresence({
      selection: selectedNodeIds,
      viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom, width: el?.clientWidth, height: el?.clientHeight },
    });
  }, [viewport, selectedNodeIds, canvasRef, boardId]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || !boardId) return;
    const onMove = (event: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const vp = latest.current.viewport;
      clientRef.current?.setPresence({
        cursor: { x: (event.clientX - rect.left - vp.x) / vp.zoom, y: (event.clientY - rect.top - vp.y) / vp.zoom },
      });
    };
    const onLeave = () => clientRef.current?.setPresence({ cursor: null });
    el.addEventListener("pointermove", onMove, { passive: true });
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
    };
  }, [canvasRef, companyId, boardId]);

  const { data: directory } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId ?? ""),
    queryFn: () => accessApi.listUserDirectory(companyId!),
    enabled: !!companyId,
    retry: false,
  });
  const profiles = useMemo(() => buildCompanyUserProfileMap(directory?.users), [directory?.users]);
  const agentNames = useMemo(() => new Map(ctx.agents.map((agent) => [agent.id, agent.name])), [ctx.agents]);
  const labelFor = useCallback(
    (actor: RealtimeActor) =>
      actor.type === "agent" ? agentNames.get(actor.id) ?? "An agent" : profiles.get(actor.id)?.label ?? "Someone",
    [agentNames, profiles],
  );

  const revoked = revokedBoardId !== null && revokedBoardId === boardId;
  /** Leave the revoked board: drop it from the list and open another. */
  const leaveRevokedBoard = useCallback(() => {
    const { queryClient, setActiveBoardId } = latest.current;
    if (companyId) {
      const listKey = queryKeys.planningCanvases.list(companyId);
      queryClient.setQueryData<PlanningCanvasBoard[]>(listKey, (prev) => prev?.filter((board) => board.id !== revokedBoardId));
      void queryClient.invalidateQueries({ queryKey: listKey });
    }
    setActiveBoardId(null);
    setRevokedBoardId(null);
  }, [companyId, revokedBoardId]);

  return { status, revoked, view, labelFor, leaveRevokedBoard };
}

export type CanvasRealtime = ReturnType<typeof useCanvasRealtime>;
