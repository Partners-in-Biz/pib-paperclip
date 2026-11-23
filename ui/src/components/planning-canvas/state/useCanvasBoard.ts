// PAR-13933: moved verbatim from pages/PlanningCanvas.tsx; no behaviour change.
import { useCallback, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { type CanvasConnector, type CanvasNode, type CanvasStroke, type PlanningCanvasBoard, type PlanningCanvasData } from "@paperclipai/shared";
import { personalNotesApi } from "@/api/personalNotes";
import { planningCanvasesApi } from "@/api/planningCanvases";
import { CANVAS_BOARD_TEMPLATES, exportBoardToMarkdown } from "@/lib/planning-canvas-helpers";
import { queryKeys } from "@/lib/queryKeys";
import type { CanvasData } from "@/components/planning-canvas/state/useCanvasData";
import type { CanvasState } from "@/components/planning-canvas/state/useCanvasState";

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
    history,
    setHistory,
    future,
    setFuture,
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

  const saveBoardMutation = useMutation({
    mutationFn: ({
      boardId,
      title,
      data,
    }: {
      boardId: string;
      title: string;
      data: PlanningCanvasData;
    }) => planningCanvasesApi.update(selectedCompanyId!, boardId, { title, data }),
    onSuccess: (updated) => {
      queryClient.setQueryData<PlanningCanvasBoard[]>(
        queryKeys.planningCanvases.list(selectedCompanyId!),
        (prev) => (prev ? prev.map((b) => (b.id === updated.id ? updated : b)) : [updated]),
      );
    },
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

  // Hydrate local canvas state when switching boards
  useEffect(() => {
    if (!activeBoard) return;
    setBoardTitle(activeBoard.title);
    setNodes(activeBoard.data.nodes ?? []);
    setConnectors(activeBoard.data.connectors ?? []);
    setStrokes(activeBoard.data.strokes ?? []);
    setViewport(activeBoard.data.viewport ?? { x: 40, y: 40, zoom: 1 });
    setSelectedNodeIds([]);
    setSelectedConnectorId(null);
    setEditingNodeId(null);
    setConnectFromId(null);
    setHistory([]);
    setFuture([]);
    setDirty(false);
  }, [activeBoard?.id]);

  // Debounced auto-save
  useEffect(() => {
    if (!dirty || !activeBoard || !selectedCompanyId) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveBoardMutation.mutate({
        boardId: activeBoard.id,
        title: boardTitle.trim() || "Untitled Board",
        data: { nodes, connectors, strokes, viewport },
      });
      setDirty(false);
    }, 650);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [dirty, nodes, connectors, strokes, viewport, boardTitle, activeBoard?.id, selectedCompanyId]);

  const commitCanvasChange = useCallback(
    (nextNodes: CanvasNode[], nextConnectors: CanvasConnector[], nextStrokes: CanvasStroke[] = strokes) => {
      setHistory((prev) => [...prev.slice(-39), { nodes, connectors, strokes }]);
      setFuture([]);
      setNodes(nextNodes);
      setConnectors(nextConnectors);
      setStrokes(nextStrokes);
      setDirty(true);
    },
    [nodes, connectors, strokes],
  );

  const handleUndo = useCallback(() => {
    if (history.length === 0) return;
    const previous = history[history.length - 1]!;
    setHistory((h) => h.slice(0, -1));
    setFuture((f) => [{ nodes, connectors, strokes }, ...f.slice(0, 39)]);
    setNodes(previous.nodes);
    setConnectors(previous.connectors);
    setStrokes(previous.strokes);
    setDirty(true);
  }, [history, nodes, connectors, strokes]);

  const handleRedo = useCallback(() => {
    if (future.length === 0) return;
    const next = future[0]!;
    setFuture((f) => f.slice(1));
    setHistory((h) => [...h.slice(-39), { nodes, connectors, strokes }]);
    setNodes(next.nodes);
    setConnectors(next.connectors);
    setStrokes(next.strokes);
    setDirty(true);
  }, [future, nodes, connectors, strokes]);

  return {
    createBoardMutation,
    saveBoardMutation,
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
