// PAR-13933: moved verbatim from pages/PlanningCanvas.tsx; no behaviour change.
import { useCallback, useMemo } from "react";
import { type CanvasNode, type CanvasNodeColor, type PersonalNote, type PlanningCanvasRefNodeKind } from "@paperclipai/shared";
import { personalNotesApi } from "@/api/personalNotes";
import { clampZoom } from "@/components/planning-canvas/canvas-constants";
import { newTable } from "@/components/planning-canvas/nodes/table-edit";
import { newKanban, newTimeline } from "@/components/planning-canvas/nodes/issue-board";
import { type CanvasAlignMode, alignSelectedNodes, buildFrameAgentBrief, buildSelectionAgentBrief, createCanvasId, snapToGrid } from "@/lib/planning-canvas-helpers";
import { queryKeys } from "@/lib/queryKeys";
import type { CanvasData } from "@/components/planning-canvas/state/useCanvasData";
import type { CanvasState } from "@/components/planning-canvas/state/useCanvasState";
import type { CanvasBoard } from "@/components/planning-canvas/state/useCanvasBoard";

export function useCanvasActions(ctx: CanvasData & CanvasState & CanvasBoard) {
  const {
    selectedCompanyId,
    openNewIssue,
    pushToast,
    queryClient,
    personalNotes,
    notesById,
    nodes,
    connectors,
    viewport,
    setViewport,
    setTool,
    snapEnabled,
    selectedNodeIds,
    setSelectedNodeIds,
    selectedConnectorId,
    setSelectedConnectorId,
    setEditingNodeId,
    notesSearch,
    canvasRef,
    commitCanvasChange,
    opStore,
    activeBoard,
  } = ctx;

  const screenToWorld = useCallback(
    (clientX: number, clientY: number) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: (clientX - rect.left - viewport.x) / viewport.zoom,
        y: (clientY - rect.top - viewport.y) / viewport.zoom,
      };
    },
    [viewport],
  );

  const getViewportCenterWorld = useCallback(() => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 300, y: 200 };
    return {
      x: (rect.width / 2 - viewport.x) / viewport.zoom,
      y: (rect.height / 2 - viewport.y) / viewport.zoom,
    };
  }, [viewport]);

  const nextZIndex = useMemo(
    () => nodes.reduce((max, n) => Math.max(max, n.zIndex), 1) + 1,
    [nodes],
  );

  const addNodeAt = useCallback(
    (kind: CanvasNode["kind"], worldX: number, worldY: number, overrides?: Partial<CanvasNode>) => {
      const defaults: Record<CanvasNode["kind"], { w: number; h: number; color: CanvasNodeColor; title: string; content: string }> = {
        sticky: { w: 230, h: 150, color: "yellow", title: "New Sticky", content: "" },
        frame: { w: 360, h: 420, color: "blue", title: "New Frame", content: "" },
        shape: { w: 200, h: 88, color: "violet", title: "Step", content: "" },
        text: { w: 240, h: 52, color: "slate", title: "Heading", content: "" },
        note: { w: 280, h: 190, color: "slate", title: "Personal Note", content: "" },
      };
      const def = defaults[kind];
      const x = snapEnabled ? snapToGrid(worldX - def.w / 2) : Math.round(worldX - def.w / 2);
      const y = snapEnabled ? snapToGrid(worldY - def.h / 2) : Math.round(worldY - def.h / 2);
      const newNode: CanvasNode = {
        id: createCanvasId(kind),
        kind,
        x,
        y,
        width: def.w,
        height: def.h,
        zIndex: kind === "frame" ? 1 : nextZIndex,
        color: def.color,
        title: def.title,
        content: def.content,
        shape: kind === "shape" ? "rect" : undefined,
        ...overrides,
      };
      commitCanvasChange([...nodes, newNode], connectors);
      setSelectedNodeIds([newNode.id]);
      setSelectedConnectorId(null);
      setTool("select");
      if (kind !== "note") setEditingNodeId(newNode.id);
    },
    [commitCanvasChange, connectors, nextZIndex, nodes, snapEnabled],
  );

  const dropPersonalNoteOnCanvas = useCallback(
    (note: PersonalNote) => {
      const center = getViewportCenterWorld();
      const offset = (nodes.length % 5) * 24;
      const mappedColor: CanvasNodeColor =
        note.color === "amber" ||
        note.color === "blue" ||
        note.color === "emerald" ||
        note.color === "rose" ||
        note.color === "violet"
          ? note.color
          : "slate";
      addNodeAt("note", center.x + offset, center.y + offset, {
        noteId: note.id,
        title: note.title,
        content: note.body,
        color: mappedColor,
        handedOffIssueId: note.handedOffIssueId,
        handedOffIssueIdentifier: note.handedOffIssueIdentifier,
      });
    },
    [addNodeAt, getViewportCenterWorld, nodes.length],
  );

  const deleteSelection = useCallback(() => {
    if (selectedConnectorId) {
      commitCanvasChange(
        nodes,
        connectors.filter((c) => c.id !== selectedConnectorId),
      );
      setSelectedConnectorId(null);
      return;
    }
    if (selectedNodeIds.length === 0) return;
    const toRemove = new Set(selectedNodeIds);
    commitCanvasChange(
      nodes.filter((n) => !toRemove.has(n.id)),
      connectors.filter((c) => !toRemove.has(c.fromNodeId) && !toRemove.has(c.toNodeId)),
    );
    setSelectedNodeIds([]);
    setEditingNodeId(null);
  }, [commitCanvasChange, connectors, nodes, selectedConnectorId, selectedNodeIds]);

  const duplicateSelection = useCallback(() => {
    if (selectedNodeIds.length === 0) return;
    const copies: CanvasNode[] = [];
    const newIds: string[] = [];
    for (const id of selectedNodeIds) {
      const orig = nodes.find((n) => n.id === id);
      if (!orig) continue;
      const copyId = createCanvasId(orig.kind);
      copies.push({
        ...orig,
        id: copyId,
        x: orig.x + 32,
        y: orig.y + 32,
        zIndex: orig.kind === "frame" ? 1 : nextZIndex + copies.length,
      });
      newIds.push(copyId);
    }
    if (copies.length > 0) {
      commitCanvasChange([...nodes, ...copies], connectors);
      setSelectedNodeIds(newIds);
    }
  }, [commitCanvasChange, connectors, nextZIndex, nodes, selectedNodeIds]);

  /** Place a live issue, agent, project or goal card at the centre of the view (C10). */
  const insertLinkNode = useCallback(
    (kind: PlanningCanvasRefNodeKind, refId: string) => {
      const center = getViewportCenterWorld();
      const width = 260;
      const height = 140;
      const key = createCanvasId(kind);
      opStore.addItem(key, {
        kind,
        ref: { id: refId },
        x: snapToGrid(center.x - width / 2),
        y: snapToGrid(center.y - height / 2),
        width,
        height,
        zIndex: nextZIndex,
        color: "slate",
        title: "",
        content: "",
      });
      setSelectedNodeIds([key]);
      setTool("select");
    },
    [getViewportCenterWorld, nextZIndex, opStore.addItem, setSelectedNodeIds, setTool],
  );

  /** Add an empty table or markdown node at the viewport centre. */
  const insertTypedNode = useCallback(
    (kind: "table" | "markdown" | "kanban" | "timeline") => {
      const center = getViewportCenterWorld();
      const wide = kind === "table" || kind === "kanban" || kind === "timeline";
      const width = kind === "kanban" ? 640 : wide ? 480 : 320;
      const height = kind === "kanban" ? 360 : kind === "timeline" ? 280 : kind === "table" ? 220 : 240;
      const key = createCanvasId(kind);
      // A kanban or timeline added from a project board starts filtered to that project.
      const boardProjectId = activeBoard?.scope === "project" ? activeBoard.projectId : null;
      opStore.addItem(key, {
        kind,
        data: kind === "table" ? newTable() : kind === "kanban" ? newKanban(boardProjectId) : kind === "timeline" ? newTimeline(boardProjectId) : { markdown: "" },
        x: snapToGrid(center.x - width / 2),
        y: snapToGrid(center.y - height / 2),
        width,
        height,
        zIndex: nextZIndex,
        color: "slate",
        title: "",
        content: "",
      });
      setSelectedNodeIds([key]);
      setTool("select");
    },
    [getViewportCenterWorld, nextZIndex, opStore.addItem, setSelectedNodeIds, setTool, activeBoard?.scope, activeBoard?.projectId],
  );

  const fitToScreen = useCallback(() => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || nodes.length === 0) {
      setViewport({ x: 40, y: 40, zoom: 1 });
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
    }
    const padding = 80;
    const contentW = Math.max(200, maxX - minX + padding * 2);
    const contentH = Math.max(200, maxY - minY + padding * 2);
    const zoom = clampZoom(Math.min(rect.width / contentW, rect.height / contentH, 1.1));
    const x = Math.round((rect.width - (maxX - minX) * zoom) / 2 - minX * zoom);
    const y = Math.round((rect.height - (maxY - minY) * zoom) / 2 - minY * zoom);
    setViewport({ x, y, zoom });
  }, [nodes]);

  function handleGiveNodeToAgent(node: CanvasNode) {
    if (node.kind === "frame") {
      const brief = buildFrameAgentBrief(node, nodes, notesById);
      openNewIssue(
        {
          title: brief.title,
          description: brief.description,
          status: "todo",
        },
        {
          onCreated: (created) => {
            commitCanvasChange(
              nodes.map((n) =>
                n.id === node.id
                  ? { ...n, handedOffIssueId: created.id, handedOffIssueIdentifier: created.identifier }
                  : n,
              ),
              connectors,
            );
            pushToast({
              title: "Frame delegated to agent",
              body: `${created.identifier ?? created.title} created from frame “${brief.title}”.`,
              tone: "success",
            });
          },
        },
      );
      return;
    }

    const linkedNote = node.noteId ? notesById.get(node.noteId) : null;
    const title = linkedNote?.title ?? (node.title.trim() || "Canvas Idea");
    const description = linkedNote?.body ?? node.content;

    openNewIssue(
      {
        title,
        description,
        projectId: linkedNote?.projectId ?? undefined,
        status: "todo",
      },
      {
        onCreated: (created) => {
          commitCanvasChange(
            nodes.map((n) =>
              n.id === node.id
                ? { ...n, handedOffIssueId: created.id, handedOffIssueIdentifier: created.identifier }
                : n,
            ),
            connectors,
          );
          if (linkedNote && selectedCompanyId) {
            void personalNotesApi
              .recordHandoff(selectedCompanyId, linkedNote.id, created.id, null)
              .then(() => {
                queryClient.invalidateQueries({ queryKey: queryKeys.personalNotes.list(selectedCompanyId) });
              });
          }
          pushToast({
            title: "Given to agent",
            body: `${created.identifier ?? created.title} created from Planning Canvas.`,
            tone: "success",
          });
        },
      },
    );
  }

  function handleAlignSelection(mode: CanvasAlignMode) {
    if (selectedNodeIds.length < 2) return;
    commitCanvasChange(alignSelectedNodes(nodes, selectedNodeIds, mode), connectors);
  }

  function handleDelegateMultiSelection() {
    const selected = nodes.filter((n) => selectedNodeIds.includes(n.id));
    if (selected.length === 0) return;
    const brief = buildSelectionAgentBrief(selected, notesById);
    openNewIssue(
      {
        title: brief.title,
        description: brief.description,
        status: "todo",
      },
      {
        onCreated: (created) => {
          pushToast({
            title: "Selection delegated to agent",
            body: `${created.identifier ?? created.title} created from ${selected.length} canvas items.`,
            tone: "success",
          });
        },
      },
    );
  }

  const primarySelectedNode = useMemo(
    () => (selectedNodeIds.length === 1 ? nodes.find((n) => n.id === selectedNodeIds[0]) ?? null : null),
    [nodes, selectedNodeIds],
  );

  const nodeById = useMemo(() => new Map<string, CanvasNode>(nodes.map((n) => [n.id, n])), [nodes]);

  const sortedNodes = useMemo(
    () =>
      [...nodes].sort((a, b) => {
        if (a.kind === "frame" && b.kind !== "frame") return -1;
        if (a.kind !== "frame" && b.kind === "frame") return 1;
        return a.zIndex - b.zIndex;
      }),
    [nodes],
  );

  const filteredDrawerNotes = useMemo(() => {
    const q = notesSearch.trim().toLowerCase();
    return personalNotes
      .filter((n) => !n.archived)
      .filter((n) => !q || `${n.title} ${n.body} ${n.tags.join(" ")}`.toLowerCase().includes(q));
  }, [personalNotes, notesSearch]);

  return {
    screenToWorld,
    getViewportCenterWorld,
    nextZIndex,
    addNodeAt,
    dropPersonalNoteOnCanvas,
    deleteSelection,
    duplicateSelection,
    insertLinkNode,
    insertTypedNode,
    fitToScreen,
    handleGiveNodeToAgent,
    handleAlignSelection,
    handleDelegateMultiSelection,
    primarySelectedNode,
    nodeById,
    sortedNodes,
    filteredDrawerNotes,
  };
}

export type CanvasActions = ReturnType<typeof useCanvasActions>;
