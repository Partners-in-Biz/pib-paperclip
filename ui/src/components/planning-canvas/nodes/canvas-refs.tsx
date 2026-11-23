import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { planningCanvasesApi, type PlanningCanvasRefsRead } from "@/api/planningCanvases";
import { queryKeys } from "@/lib/queryKeys";
import type { SaveState } from "@/components/planning-canvas/store/canvas-op-store";
import { linkedEntityIds, type NodeLinkMeta } from "@/components/planning-canvas/nodes/link-meta";

/** `notLoaded`: the refs read was cut at its id cap (`truncated`) before reaching this id. */
type AnyRef = { id: string; hidden?: boolean; notLoaded?: boolean };
/** Entity id to its summary for this reader; absent while loading, `hidden` when the reader has no access. */
export type CanvasRefMap = ReadonlyMap<string, AnyRef>;

const EMPTY: CanvasRefMap = new Map();
export const CanvasRefsContext = createContext<CanvasRefMap>(EMPTY);

export type RefPlaceholder = { id: string; hidden: true; notLoaded?: undefined } | { id: string; notLoaded: true; hidden?: undefined };

/** The summary of one entity: `undefined` while loading, a placeholder for "No access" or "Not loaded". */
export function useCanvasRef<T extends { id: string }>(id: string | null | undefined): (T & { hidden?: undefined; notLoaded?: undefined }) | RefPlaceholder | undefined {
  const map = useContext(CanvasRefsContext);
  return (id ? map.get(id) : undefined) as never;
}

/** True when `ref` is real data rather than loading, "No access" or "Not loaded". */
export function isRefData<T extends { id: string }>(ref: (T & { hidden?: undefined; notLoaded?: undefined }) | RefPlaceholder | undefined): ref is T & { hidden?: undefined; notLoaded?: undefined } {
  return !!ref && !ref.hidden && !ref.notLoaded;
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
export function useCanvasRefs(companyId: string | null | undefined, boardId: string | null | undefined, meta: ReadonlyMap<string, NodeLinkMeta>, saveState: SaveState = "saved"): CanvasRefMap {
  const queryClient = useQueryClient();
  const ids = useMemo(() => linkedEntityIds(meta), [meta]);
  const idsKey = useMemo(() => hashIds(ids), [ids]);
  const read = useQuery({
    queryKey: queryKeys.planningCanvasRefs.board(companyId ?? "", boardId ?? "", idsKey),
    queryFn: () => planningCanvasesApi.refs(companyId!, boardId!),
    enabled: !!companyId && !!boardId && ids.length > 0,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  // The server hydrates from saved items only: a card inserted a moment ago is unknown to the first
  // read, so read again once the op store has sent its pending batch.
  const lastSave = useRef(saveState);
  useEffect(() => {
    const before = lastSave.current;
    lastSave.current = saveState;
    if (before !== "saved" && saveState === "saved" && companyId) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.planningCanvasRefs.all(companyId) });
    }
  }, [saveState, companyId, queryClient]);
  return useMemo(() => {
    const map = new Map<string, AnyRef>();
    const data = read.data;
    if (!data) return map;
    for (const list of [data.issues, data.agents, data.projects, data.goals]) {
      for (const entry of list) map.set(entry.id, entry);
    }
    if (data.truncated) for (const id of ids) if (!map.has(id)) map.set(id, { id, notLoaded: true });
    return map;
  }, [read.data, ids]);
}
