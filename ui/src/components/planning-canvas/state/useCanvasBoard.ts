// PAR-13933 moved this from pages/PlanningCanvas.tsx; PAR-13934 moved item saving to the op store.
import { useCallback, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  canvasViewportSchema,
  type CanvasConnector,
  type CanvasNode,
  type CanvasStroke,
  type CanvasViewport,
  type PlanningCanvasBoard,
  type PlanningCanvasData,
} from "@paperclipai/shared";
import { personalNotesApi } from "@/api/personalNotes";
import { planningCanvasesApi, type PlanningCanvasBoardWithItems } from "@/api/planningCanvases";
import { useCanvasOpStore } from "@/components/planning-canvas/store/useCanvasOpStore";
import { CANVAS_BOARD_TEMPLATES, exportBoardToMarkdown } from "@/lib/planning-canvas-helpers";
import { queryKeys } from "@/lib/queryKeys";
import type { CanvasData } from "@/components/planning-canvas/state/useCanvasData";
import type { CanvasState } from "@/components/planning-canvas/state/useCanvasState";

const DEFAULT_VIEWPORT: CanvasViewport = { x: 40, y: 40, zoom: 1 };

/** The viewport is this person's own: kept per board in this browser, never on the shared board. */
function viewportKey(boardId: string) {
  return `paperclip.planningCanvas.viewport:${boardId}`;
}

function storedViewport(boardId: string): CanvasViewport | null {
  try {
    const parsed = canvasViewportSchema.safeParse(JSON.parse(window.localStorage.getItem(viewportKey(boardId)) ?? "null"));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function useCanvasBoard(ctx: CanvasData & CanvasState) {
  const {
    selectedCompanyId,
    pushToast,
    queryClient,
    boards,
    boardsLoading,
    notesById,
    activeBoardId,
    setActiveBoardId,
    activeBoard,
    boardTitle,
    setBoardTitle,
    nodes,
    setNodes,
    connectors,
    setConnectors,
    strokes,
    setStrokes,
    viewport,
    setViewport,
    dirty,
    setDirty,
    setSelectedNodeIds,
    setSelectedConnectorId,
    setEditingNodeId,
    setConnectFromId,
    setBoardSearch,
    canvasRef,
    saveTimerRef,
    autoCreatedRef,
  } = ctx;

  const createBoardMutation = useMutation({
    mutationFn: (input: { title: string; data?: PlanningCanvasData }) =>
      planningCanvasesApi.create(selectedCompanyId!, {
        title: input.title,
        description: "",
        data: input.data,
      }),
    onSuccess: (created) => {
      queryClient.setQueryData<PlanningCanvasBoard[]>(
        queryKeys.planningCanvases.list(selectedCompanyId!),
        (prev) => (prev ? [created, ...prev] : [created]),
      );
      setActiveBoardId(created.id);
    },
  });

  /** Title only: items never go through the whole-board PATCH (plan B.2, J.2). */
  const saveTitleMutation = useMutation({
    mutationFn: ({ boardId, title }: { boardId: string; title: string }) =>
      planningCanvasesApi.update(selectedCompanyId!, boardId, { title }),
    onSuccess: (updated) => {
      queryClient.setQueryData<PlanningCanvasBoard[]>(
        queryKeys.planningCanvases.list(selectedCompanyId!),
        (prev) => (prev ? prev.map((b) => (b.id === updated.id ? { ...b, title: updated.title } : b)) : prev),
      );
    },
  });

  const onHydrate = useCallback((read: PlanningCanvasBoardWithItems) => {
    setBoardTitle(read.title);
    setViewport(storedViewport(read.id) ?? read.data.viewport ?? DEFAULT_VIEWPORT);
    setSelectedNodeIds([]);
    setSelectedConnectorId(null);
    setEditingNodeId(null);
    setConnectFromId(null);
    setDirty(false);
  }, []);

  const opStore = useCanvasOpStore({
    companyId: selectedCompanyId,
    boardId: activeBoard?.id,
    nodes,
    connectors,
    strokes,
    setNodes,
    setConnectors,
    setStrokes,
    notify: (body) => pushToast({ title: body, tone: "info" }),
    onHydrate,
  });

  const deleteBoardMutation = useMutation({
    mutationFn: (boardId: string) => planningCanvasesApi.remove(selectedCompanyId!, boardId),
    onSuccess: (_res, boardId) => {
      queryClient.setQueryData<PlanningCanvasBoard[]>(
        queryKeys.planningCanvases.list(selectedCompanyId!),
        (prev) => (prev ? prev.filter((b) => b.id !== boardId) : []),
      );
      if (activeBoardId === boardId) setActiveBoardId(null);
      pushToast({ title: "Board deleted", tone: "info" });
    },
  });

  const promoteStickyToNoteMutation = useMutation({
    mutationFn: async (node: CanvasNode) => {
      const created = await personalNotesApi.create(selectedCompanyId!, {
        title: node.title.trim() || "Canvas Note",
        body: node.content,
        tags: ["canvas"],
        color:
          node.color === "amber" ||
          node.color === "blue" ||
          node.color === "emerald" ||
          node.color === "rose" ||
          node.color === "violet"
            ? node.color
            : "default",
        pinned: false,
        projectId: null,
        dailyDate: null,
      });
      return { nodeId: node.id, note: created };
    },
    onSuccess: ({ nodeId, note }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.personalNotes.list(selectedCompanyId!) });
      commitCanvasChange(
        nodes.map((n) =>
          n.id === nodeId
            ? {
                ...n,
                kind: "note",
                noteId: note.id,
                title: note.title,
                content: note.body,
                width: Math.max(n.width, 280),
                height: Math.max(n.height, 180),
              }
            : n,
        ),
        connectors,
      );
      pushToast({
        title: "Promoted to Personal Note",
        body: `“${note.title}” is now saved in your Note list and linked on this canvas.`,
        tone: "success",
      });
    },
  });

  const exportBoardAsNoteMutation = useMutation({
    mutationFn: async () => {
      const markdown = exportBoardToMarkdown(boardTitle, nodes, connectors, notesById);
      return personalNotesApi.create(selectedCompanyId!, {
        title: `${boardTitle.trim() || "Planning Canvas"} — Export`,
        body: markdown,
        tags: ["canvas", "export"],
        color: "violet",
        pinned: false,
        projectId: null,
        dailyDate: null,
      });
    },
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.personalNotes.list(selectedCompanyId!) });
      pushToast({
        title: "Board exported to Personal Notes",
        body: `Saved as “${created.title}” with all frames, checklists, and links.`,
        tone: "success",
      });
    },
  });

  const focusNodeOnBoard = useCallback((node: CanvasNode) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const zoom = Math.max(viewport.zoom, 0.9);
    const centerX = node.x + node.width / 2;
    const centerY = node.y + node.height / 2;
    setViewport({
      x: Math.round(rect.width / 2 - centerX * zoom),
      y: Math.round(rect.height / 2 - centerY * zoom),
      zoom,
    });
    setSelectedNodeIds([node.id]);
    setSelectedConnectorId(null);
    setBoardSearch("");
  }, [viewport.zoom]);

  // Auto-create a starter board on first visit if none exist
  useEffect(() => {
    if (
      selectedCompanyId &&
      !boardsLoading &&
      boards.length === 0 &&
      !autoCreatedRef.current &&
      !createBoardMutation.isPending
    ) {
      autoCreatedRef.current = true;
      createBoardMutation.mutate({
        title: "Main Planning Board",
        data: CANVAS_BOARD_TEMPLATES[0]!.build(),
      });
    }
  }, [selectedCompanyId, boardsLoading, boards.length, createBoardMutation.isPending]);

  // Debounced title save
  useEffect(() => {
    if (!dirty || !activeBoard || !selectedCompanyId) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTitleMutation.mutate({ boardId: activeBoard.id, title: boardTitle.trim() || "Untitled Board" });
      setDirty(false);
    }, 650);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [dirty, boardTitle, activeBoard?.id, selectedCompanyId]);

  // Remember where this person left the board
  useEffect(() => {
    if (!activeBoard || !opStore.loaded) return;
    const timer = setTimeout(() => {
      try {
        window.localStorage.setItem(viewportKey(activeBoard.id), JSON.stringify(viewport));
      } catch {
        // Storage blocked: the board opens at its default view next time.
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [viewport, activeBoard?.id, opStore.loaded]);

  /** One undoable step: the whole change is one undo group. */
  const commitCanvasChange = useCallback(
    (nextNodes: CanvasNode[], nextConnectors: CanvasConnector[], nextStrokes: CanvasStroke[] = strokes) => {
      opStore.markCommit();
      setNodes(nextNodes);
      setConnectors(nextConnectors);
      setStrokes(nextStrokes);
    },
    [strokes, opStore.markCommit],
  );

  const handleUndo = opStore.undo;
  const handleRedo = opStore.redo;

  return {
    createBoardMutation,
    saveTitleMutation,
    opStore,
    deleteBoardMutation,
    promoteStickyToNoteMutation,
    exportBoardAsNoteMutation,
    focusNodeOnBoard,
    commitCanvasChange,
    handleUndo,
    handleRedo,
  };
}

export type CanvasBoard = ReturnType<typeof useCanvasBoard>;
