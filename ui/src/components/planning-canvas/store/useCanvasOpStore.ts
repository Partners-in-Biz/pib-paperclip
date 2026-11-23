import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CanvasConnector, CanvasNode, CanvasStroke, PlanningCanvasItemType } from "@paperclipai/shared";
import { planningCanvasesApi, type PlanningCanvasBoardWithItems } from "@/api/planningCanvases";
import { queryKeys } from "@/lib/queryKeys";
import { CanvasOpStore, type OpStoreSnapshot, type StoreItem } from "@/components/planning-canvas/store/canvas-op-store";
import { diffElements, elementToItem, itemToElement, patchElements, type CanvasElement } from "@/components/planning-canvas/store/legacy-bridge";

type Setter<T> = Dispatch<SetStateAction<T>>;
interface ElementUpdates {
  node: Map<string, CanvasNode | null>;
  connector: Map<string, CanvasConnector | null>;
  stroke: Map<string, CanvasStroke | null>;
}

export interface CanvasOpStoreInput {
  companyId: string | null | undefined;
  boardId: string | null | undefined;
  nodes: CanvasNode[];
  connectors: CanvasConnector[];
  strokes: CanvasStroke[];
  setNodes: Setter<CanvasNode[]>;
  setConnectors: Setter<CanvasConnector[]>;
  setStrokes: Setter<CanvasStroke[]>;
  notify: (message: string) => void;
  /** Called with each full read the page is hydrated from. */
  onHydrate: (read: PlanningCanvasBoardWithItems) => void;
}

const IDLE_SNAPSHOT: OpStoreSnapshot = { saveState: "saved", canUndo: false, canRedo: false, drafts: [] };
const noopSubscribe = () => () => undefined;

function sessionStore() {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Connects the page's `nodes`/`connectors`/`strokes` state to a `CanvasOpStore`
 * for the active board: page edits become store edits (and ops), store changes
 * (undo, conflicts, others' edits) are patched back into the page state.
 */
export function useCanvasOpStore(input: CanvasOpStoreInput) {
  const { companyId, boardId } = input;
  const latest = useRef(input);
  latest.current = input;
  const synced = useRef<{ nodes: CanvasNode[]; connectors: CanvasConnector[]; strokes: CanvasStroke[] }>({ nodes: [], connectors: [], strokes: [] });
  const identifiers = useRef(new Map<string, string>());
  const closeGroupAfterSync = useRef(false);
  const [loadedStore, setLoadedStore] = useState<CanvasOpStore | null>(null);

  const read = useQuery({
    queryKey: queryKeys.planningCanvases.detail(companyId ?? "", boardId ?? ""),
    queryFn: () => planningCanvasesApi.get(companyId!, boardId!),
    enabled: !!companyId && !!boardId,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const refetchRef = useRef(read.refetch);
  refetchRef.current = read.refetch;

  const store = useMemo(() => {
    if (!companyId || !boardId) return null;
    return new CanvasOpStore({
      transport: {
        send: (batch) => planningCanvasesApi.applyOps(companyId, boardId, batch),
        readSince: (since) => planningCanvasesApi.readSince(companyId, boardId, since),
        sendKeepalive: (batch) => planningCanvasesApi.applyOpsKeepalive(companyId, boardId, batch),
      },
      storage: sessionStore(),
      storageKey: `paperclip.planningCanvas.undo:${boardId}`,
      onNotice: (message) => latest.current.notify(message),
      onFatal: () => {
        latest.current.notify("Could not save your last change; the board was reloaded.");
        void refetchRef.current();
      },
      onResync: () => void refetchRef.current(),
    });
  }, [companyId, boardId]);

  useEffect(() => {
    store?.reopen();
    return () => store?.close();
  }, [store]);

  /** Replace page state with a full read; the store already knows these arrays. */
  const publish = useCallback((next: { nodes: CanvasNode[]; connectors: CanvasConnector[]; strokes: CanvasStroke[] }) => {
    const { setNodes, setConnectors, setStrokes } = latest.current;
    setNodes(next.nodes);
    setConnectors(next.connectors);
    setStrokes(next.strokes);
    synced.current = next;
  }, []);

  /**
   * Patch store-side changes into page state. The patch goes on top of any page
   * change not yet synced, so a remote edit never overwrites a local one; the
   * sync effect then still sees the local change as a diff.
   */
  const patch = useCallback((updates: ElementUpdates) => {
    const { setNodes, setConnectors, setStrokes } = latest.current;
    const current = synced.current;
    synced.current = {
      nodes: patchElements(current.nodes, updates.node),
      connectors: patchElements(current.connectors, updates.connector),
      strokes: patchElements(current.strokes, updates.stroke),
    };
    if (updates.node.size > 0) setNodes((prev) => patchElements(prev, updates.node));
    if (updates.connector.size > 0) setConnectors((prev) => patchElements(prev, updates.connector));
    if (updates.stroke.size > 0) setStrokes((prev) => patchElements(prev, updates.stroke));
  }, []);

  // Hydrate from each full read (first load, or a reload after a refusal or a resync).
  useEffect(() => {
    const data = read.data;
    if (!store || !data || data.id !== boardId) return;
    store.load({ revision: data.revision, items: data.items });
    identifiers.current = new Map();
    for (const node of data.data.nodes) {
      if (node.handedOffIssueId && node.handedOffIssueIdentifier) identifiers.current.set(node.handedOffIssueId, node.handedOffIssueIdentifier);
    }
    synced.current = { nodes: latest.current.nodes, connectors: latest.current.connectors, strokes: latest.current.strokes };
    publish({ nodes: data.data.nodes, connectors: data.data.connectors, strokes: data.data.strokes ?? [] });
    latest.current.onHydrate(data);
    setLoadedStore(store);
  }, [store, read.data, read.dataUpdatedAt, boardId, publish]);

  const loaded = loadedStore === store && store !== null;

  // Store-side changes (undo, conflicts, others' edits) go back into page state.
  useEffect(() => {
    if (!store || !loaded) return;
    return store.subscribeView((keys) => {
      const updates: ElementUpdates = { node: new Map(), connector: new Map(), stroke: new Map() };
      const current = synced.current;
      let owners: Map<string, PlanningCanvasItemType> | null = null;
      const owner = (key: string) => {
        owners ??= new Map<string, PlanningCanvasItemType>([
          ...current.nodes.map((n) => [n.id, "node"] as const),
          ...current.connectors.map((c) => [c.id, "connector"] as const),
          ...current.strokes.map((s) => [s.id, "stroke"] as const),
        ]);
        return owners.get(key) ?? null;
      };
      for (const key of keys) {
        const item = store.getItem(key);
        const type = item?.itemType ?? owner(key);
        if (!type) continue;
        const element = item ? itemToElement(key, item, identifiers.current) : null;
        if (type === "node") updates.node.set(key, element as CanvasNode | null);
        else if (type === "connector") updates.connector.set(key, element as CanvasConnector | null);
        else updates.stroke.set(key, element as CanvasStroke | null);
      }
      patch(updates);
    });
  }, [store, loaded, patch]);

  // Page edits become store edits.
  const { nodes, connectors, strokes } = input;
  useEffect(() => {
    if (!store || !loaded) return;
    const prev = synced.current;
    synced.current = { nodes, connectors, strokes };
    const changes: Array<{ key: string; item: StoreItem | null }> = [];
    const collect = <T extends CanvasElement>(type: PlanningCanvasItemType, before: T[], after: T[]) => {
      const { changed, removed } = diffElements(before, after);
      for (const element of changed) {
        const node = element as CanvasNode;
        if (type === "node" && node.handedOffIssueId && node.handedOffIssueIdentifier) {
          identifiers.current.set(node.handedOffIssueId, node.handedOffIssueIdentifier);
        }
        changes.push({ key: element.id, item: elementToItem(type, element, store.getItem(element.id)) });
      }
      for (const key of removed) changes.push({ key, item: null });
    };
    collect("node", prev.nodes, nodes);
    collect("connector", prev.connectors, connectors);
    collect("stroke", prev.strokes, strokes);
    if (changes.length > 0) store.applyLocal(changes);
    if (closeGroupAfterSync.current) {
      closeGroupAfterSync.current = false;
      store.checkpoint();
    }
  }, [store, loaded, nodes, connectors, strokes]);

  // Leaving the page: send what is left; refocus or reconnect: catch up and retry now.
  useEffect(() => {
    if (!store) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      const unsaved = store.hasUnsaved();
      store.flushKeepalive();
      if (unsaved && store.getSnapshot().saveState === "offline") event.preventDefault();
    };
    const onOnline = () => store.retryNow();
    const onVisible = () => {
      if (document.visibilityState === "visible") void store.catchUp();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [store]);

  const snapshot = useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.getSnapshot ?? (() => IDLE_SNAPSHOT));

  /** Close the undo group once the page change now pending is synced (or after two frames if none is). */
  const closeAfterSync = useCallback(() => {
    closeGroupAfterSync.current = true;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!closeGroupAfterSync.current) return;
        closeGroupAfterSync.current = false;
        store?.checkpoint();
      }),
    );
  }, [store]);

  return {
    loaded,
    saveState: snapshot.saveState,
    canUndo: snapshot.canUndo,
    canRedo: snapshot.canRedo,
    drafts: snapshot.drafts,
    /** Close the open undo group (call when a drag or resize starts). */
    checkpoint: useCallback(() => store?.checkpoint(), [store]),
    /** A drag or resize ended: its last frame still belongs to it. */
    endGesture: closeAfterSync,
    /** The next page change is one undo step of its own. */
    markCommit: useCallback(() => {
      store?.checkpoint();
      closeAfterSync();
    }, [store, closeAfterSync]),
    undo: useCallback(() => store?.undo(), [store]),
    redo: useCallback(() => store?.redo(), [store]),
    resolveDraft: useCallback((id: string, choice: "mine" | "theirs" | "copy") => store?.resolveDraft(id, choice) ?? null, [store]),
  };
}

export type CanvasOpStoreHandle = ReturnType<typeof useCanvasOpStore>;
