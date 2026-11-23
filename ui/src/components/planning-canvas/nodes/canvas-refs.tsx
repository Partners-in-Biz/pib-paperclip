import { createContext, useContext, useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { planningCanvasesApi, type PlanningCanvasRefsRead } from "@/api/planningCanvases";
import { queryKeys } from "@/lib/queryKeys";
import { linkedEntityIds, type NodeLinkMeta } from "@/components/planning-canvas/nodes/link-meta";

type AnyRef = { id: string; hidden?: boolean };
/** Entity id to its summary for this reader; absent while loading, `hidden` when the reader has no access. */
export type CanvasRefMap = ReadonlyMap<string, AnyRef>;

const EMPTY: CanvasRefMap = new Map();
export const CanvasRefsContext = createContext<CanvasRefMap>(EMPTY);

/** The summary of one entity: `undefined` while loading, `{ hidden: true }` for "No access". */
export function useCanvasRef<T extends { id: string }>(id: string | null | undefined): (T & { hidden?: false }) | { id: string; hidden: true } | undefined {
  const map = useContext(CanvasRefsContext);
  return (id ? map.get(id) : undefined) as never;
}

function hashIds(ids: string[]) {
  let h = 5381;
  for (const id of ids) for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  return `${ids.length}:${h >>> 0}`;
}

/**
 * Live summaries of everything the board links to. The query lives under its own root so the
 * live-update provider can invalidate it on issue, agent, project and goal activity without
 * touching the board read; a status change elsewhere shows within the invalidation throttle.
 */
export function useCanvasRefs(companyId: string | null | undefined, boardId: string | null | undefined, meta: ReadonlyMap<string, NodeLinkMeta>): CanvasRefMap {
  const ids = useMemo(() => linkedEntityIds(meta), [meta]);
  const idsKey = useMemo(() => hashIds(ids), [ids]);
  const read = useQuery({
    queryKey: queryKeys.planningCanvasRefs.board(companyId ?? "", boardId ?? "", idsKey),
    queryFn: () => planningCanvasesApi.refs(companyId!, boardId!),
    enabled: !!companyId && !!boardId && ids.length > 0,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  return useMemo(() => {
    const map = new Map<string, AnyRef>();
    const data = read.data;
    if (!data) return map;
    for (const list of [data.issues, data.agents, data.projects, data.goals]) {
      for (const entry of list) map.set(entry.id, entry);
    }
    return map;
  }, [read.data]);
}
