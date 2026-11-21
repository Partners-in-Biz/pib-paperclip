import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CANVAS_NODE_COLORS,
  type CanvasConnector,
  type CanvasNode,
  type CanvasNodeColor,
  type CanvasShapeVariant,
  type CanvasStroke,
  type PersonalNote,
  type PlanningCanvasBoard,
  type PlanningCanvasData,
} from "@paperclipai/shared";
import {
  AlignHorizontalJustifyStart,
  AlignVerticalJustifyStart,
  ArrowRight,
  CalendarClock,
  Check,
  CheckCircle2,
  Copy,
  Eraser,
  ExternalLink,
  FileDown,
  Frame,
  Grid2x2,
  Hand,
  Highlighter,
  LayoutGrid,
  LayoutTemplate,
  ListChecks,
  Maximize2,
  Minus,
  MousePointer2,
  NotebookPen,
  Pen,
  Plus,
  Redo2,
  Search,
  Send,
  Shapes,
  Sparkles,
  StickyNote,
  Trash2,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { Link } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useDialogActions } from "@/context/DialogContext";
import { useToastActions } from "@/context/ToastContext";
import { planningCanvasesApi } from "@/api/planningCanvases";
import { personalNotesApi } from "@/api/personalNotes";
import { agentsApi } from "@/api/agents";
import { projectsApi } from "@/api/projects";
import { queryKeys } from "@/lib/queryKeys";
import {
  alignSelectedNodes,
  buildFrameAgentBrief,
  buildSelectionAgentBrief,
  CANVAS_BOARD_TEMPLATES,
  CANVAS_COLOR_THEMES,
  computeConnectorPath,
  createCanvasId,
  exportBoardToMarkdown,
  getNodesInRect,
  getNodesInsideFrame,
  snapToGrid,
  strokePointsToSvgPath,
  type CanvasAlignMode,
  type WorldRect,
} from "@/lib/planning-canvas-helpers";
import { parseChecklistItems } from "@/lib/personal-note-markdown";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScheduleNoteHandoffDialog } from "@/components/ScheduleNoteHandoffDialog";

type ToolMode = "select" | "hand" | "sticky" | "frame" | "shape" | "text" | "connect" | "pen";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.0;

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));
}

export function PlanningCanvas() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openNewIssue } = useDialogActions();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Planning Canvas" }]);
  }, [setBreadcrumbs]);

  const { data: boards = [], isLoading: boardsLoading } = useQuery({
    queryKey: queryKeys.planningCanvases.list(selectedCompanyId!),
    queryFn: () => planningCanvasesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: personalNotes = [] } = useQuery({
    queryKey: queryKeys.personalNotes.list(selectedCompanyId!),
    queryFn: () => personalNotesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects = [] } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const notesById = useMemo(
    () => new Map<string, PersonalNote>(personalNotes.map((n) => [n.id, n])),
    [personalNotes],
  );

  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const activeBoard = useMemo(
    () => boards.find((b) => b.id === activeBoardId) ?? boards[0] ?? null,
    [boards, activeBoardId],
  );

  // Local canvas state for 60fps interaction
  const [boardTitle, setBoardTitle] = useState("Planning Canvas");
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [connectors, setConnectors] = useState<CanvasConnector[]>([]);
  const [strokes, setStrokes] = useState<CanvasStroke[]>([]);
  const [viewport, setViewport] = useState({ x: 40, y: 40, zoom: 1 });
  const [dirty, setDirty] = useState(false);

  // Undo / redo stacks
  const [history, setHistory] = useState<Array<{ nodes: CanvasNode[]; connectors: CanvasConnector[]; strokes: CanvasStroke[] }>>([]);
  const [future, setFuture] = useState<Array<{ nodes: CanvasNode[]; connectors: CanvasConnector[]; strokes: CanvasStroke[] }>>([]);

  // Tool & interaction state
  const [tool, setTool] = useState<ToolMode>("select");
  const [penColor, setPenColor] = useState<CanvasNodeColor>("blue");
  const [penHighlighter, setPenHighlighter] = useState(false);
  const [spacePressed, setSpacePressed] = useState(false);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedConnectorId, setSelectedConnectorId] = useState<string | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [connectFromId, setConnectFromId] = useState<string | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<WorldRect | null>(null);
  const [dragConnect, setDragConnect] = useState<{
    fromNodeId: string;
    startX: number;
    startY: number;
    currX: number;
    currY: number;
  } | null>(null);
  const [activeStroke, setActiveStroke] = useState<CanvasStroke | null>(null);
  const [notesDrawerOpen, setNotesDrawerOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [notesSearch, setNotesSearch] = useState("");
  const [boardSearch, setBoardSearch] = useState("");
  const [scheduleNote, setScheduleNote] = useState<PersonalNote | null>(null);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoCreatedRef = useRef(false);

  // Dragging refs
  const panDragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const marqueeStartRef = useRef<{ x: number; y: number } | null>(null);
  const activeStrokeRef = useRef<CanvasStroke | null>(null);
  const dragConnectRef = useRef<{
    fromNodeId: string;
    startX: number;
    startY: number;
    currX: number;
    currY: number;
  } | null>(null);
  const nodeDragRef = useRef<{
    startClientX: number;
    startClientY: number;
    movingIds: string[];
    origPositions: Map<string, { x: number; y: number }>;
  } | null>(null);
  const resizeDragRef = useRef<{
    nodeId: string;
    startClientX: number;
    startClientY: number;
    origW: number;
    origH: number;
  } | null>(null);

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
    setDirty(true);
  }, [nodes]);

  // Keyboard shortcuts for Miro-style canvas control
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

      if (e.code === "Space" && !typing) {
        e.preventDefault();
        setSpacePressed(true);
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        if (typing) return;
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        if (typing) return;
        e.preventDefault();
        duplicateSelection();
        return;
      }

      if (typing) return;

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelection();
      } else if (e.key === "Escape") {
        setSelectedNodeIds([]);
        setSelectedConnectorId(null);
        setEditingNodeId(null);
        setConnectFromId(null);
        setTool("select");
      } else if (e.key.toLowerCase() === "v") {
        setTool("select");
      } else if (e.key.toLowerCase() === "h") {
        setTool("hand");
      } else if (e.key.toLowerCase() === "n" && !e.shiftKey) {
        setTool("sticky");
      } else if (e.key.toLowerCase() === "f") {
        setTool("frame");
      } else if (e.key.toLowerCase() === "s") {
        setTool("shape");
      } else if (e.key.toLowerCase() === "t") {
        setTool("text");
      } else if (e.key.toLowerCase() === "l") {
        setTool("connect");
      } else if (e.key.toLowerCase() === "d") {
        setTool("pen");
      } else if (e.key.toLowerCase() === "p") {
        setNotesDrawerOpen((o) => !o);
      }
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") setSpacePressed(false);
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [deleteSelection, duplicateSelection, handleRedo, handleUndo]);

  // Global mouse move / up for smooth dragging, panning, marquee, pen & drag-connect
  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (panDragRef.current) {
        const dx = e.clientX - panDragRef.current.startX;
        const dy = e.clientY - panDragRef.current.startY;
        setViewport((v) => ({
          ...v,
          x: panDragRef.current!.origX + dx,
          y: panDragRef.current!.origY + dy,
        }));
        return;
      }

      if (activeStrokeRef.current) {
        const pt = screenToWorld(e.clientX, e.clientY);
        const last = activeStrokeRef.current.points[activeStrokeRef.current.points.length - 1];
        if (!last || Math.hypot(pt.x - last.x, pt.y - last.y) >= 3) {
          const updated: CanvasStroke = {
            ...activeStrokeRef.current,
            points: [...activeStrokeRef.current.points, { x: Math.round(pt.x), y: Math.round(pt.y) }],
          };
          activeStrokeRef.current = updated;
          setActiveStroke(updated);
        }
        return;
      }

      if (dragConnectRef.current) {
        const pt = screenToWorld(e.clientX, e.clientY);
        const updated = { ...dragConnectRef.current, currX: pt.x, currY: pt.y };
        dragConnectRef.current = updated;
        setDragConnect(updated);
        return;
      }

      if (marqueeStartRef.current) {
        const pt = screenToWorld(e.clientX, e.clientY);
        const sx = marqueeStartRef.current.x;
        const sy = marqueeStartRef.current.y;
        const rect: WorldRect = {
          x: Math.min(sx, pt.x),
          y: Math.min(sy, pt.y),
          width: Math.abs(pt.x - sx),
          height: Math.abs(pt.y - sy),
        };
        setMarqueeRect(rect);
        return;
      }

      if (nodeDragRef.current) {
        const dx = (e.clientX - nodeDragRef.current.startClientX) / viewport.zoom;
        const dy = (e.clientY - nodeDragRef.current.startClientY) / viewport.zoom;
        const movingSet = new Set(nodeDragRef.current.movingIds);
        setNodes((prev) =>
          prev.map((n) => {
            if (!movingSet.has(n.id)) return n;
            const orig = nodeDragRef.current!.origPositions.get(n.id);
            if (!orig) return n;
            const rawX = orig.x + dx;
            const rawY = orig.y + dy;
            return {
              ...n,
              x: snapEnabled ? snapToGrid(rawX) : Math.round(rawX),
              y: snapEnabled ? snapToGrid(rawY) : Math.round(rawY),
            };
          }),
        );
        return;
      }

      if (resizeDragRef.current) {
        const { nodeId, startClientX, startClientY, origW, origH } = resizeDragRef.current;
        const dx = (e.clientX - startClientX) / viewport.zoom;
        const dy = (e.clientY - startClientY) / viewport.zoom;
        setNodes((prev) =>
          prev.map((n) =>
            n.id === nodeId
              ? {
                  ...n,
                  width: Math.max(120, Math.round(origW + dx)),
                  height: Math.max(60, Math.round(origH + dy)),
                }
              : n,
          ),
        );
      }
    }

    function onMouseUp(e: MouseEvent) {
      if (panDragRef.current) {
        panDragRef.current = null;
        setDirty(true);
      }
      if (activeStrokeRef.current) {
        const finished = activeStrokeRef.current;
        activeStrokeRef.current = null;
        setActiveStroke(null);
        if (finished.points.length >= 2) {
          commitCanvasChange(nodes, connectors, [...strokes, finished]);
        }
      }
      if (dragConnectRef.current) {
        const dc = dragConnectRef.current;
        dragConnectRef.current = null;
        setDragConnect(null);
        const dropPt = screenToWorld(e.clientX, e.clientY);
        // Check if released over another node
        const targetNode = [...nodes]
          .reverse()
          .find(
            (n) =>
              n.id !== dc.fromNodeId &&
              dropPt.x >= n.x &&
              dropPt.x <= n.x + n.width &&
              dropPt.y >= n.y &&
              dropPt.y <= n.y + n.height,
          );
        if (targetNode) {
          const newConn: CanvasConnector = {
            id: createCanvasId("conn"),
            fromNodeId: dc.fromNodeId,
            toNodeId: targetNode.id,
            color: "slate",
          };
          commitCanvasChange(nodes, [...connectors, newConn]);
          setSelectedConnectorId(newConn.id);
        } else if (Math.hypot(dropPt.x - dc.startX, dropPt.y - dc.startY) > 55) {
          // Miro magic: release on empty canvas to spawn a connected sticky right there!
          const newSticky: CanvasNode = {
            id: createCanvasId("sticky"),
            kind: "sticky",
            x: snapEnabled ? snapToGrid(dropPt.x - 115) : Math.round(dropPt.x - 115),
            y: snapEnabled ? snapToGrid(dropPt.y - 75) : Math.round(dropPt.y - 75),
            width: 230,
            height: 150,
            zIndex: nextZIndex,
            color: "yellow",
            title: "Next step",
            content: "",
          };
          const newConn: CanvasConnector = {
            id: createCanvasId("conn"),
            fromNodeId: dc.fromNodeId,
            toNodeId: newSticky.id,
            color: "slate",
          };
          commitCanvasChange([...nodes, newSticky], [...connectors, newConn]);
          setSelectedNodeIds([newSticky.id]);
          setEditingNodeId(newSticky.id);
        }
      }
      if (marqueeStartRef.current) {
        const pt = screenToWorld(e.clientX, e.clientY);
        const sx = marqueeStartRef.current.x;
        const sy = marqueeStartRef.current.y;
        marqueeStartRef.current = null;
        const rect: WorldRect = {
          x: Math.min(sx, pt.x),
          y: Math.min(sy, pt.y),
          width: Math.abs(pt.x - sx),
          height: Math.abs(pt.y - sy),
        };
        setMarqueeRect(null);
        if (rect.width > 8 && rect.height > 8) {
          const hit = getNodesInRect(nodes, rect);
          setSelectedNodeIds(hit.map((n) => n.id));
          setSelectedConnectorId(null);
        }
      }
      if (nodeDragRef.current) {
        nodeDragRef.current = null;
        setDirty(true);
      }
      if (resizeDragRef.current) {
        resizeDragRef.current = null;
        setDirty(true);
      }
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [commitCanvasChange, connectors, nextZIndex, nodes, screenToWorld, snapEnabled, strokes, viewport.zoom]);

  function handleCanvasMouseDown(e: ReactMouseEvent<HTMLDivElement>) {
    if (e.button === 1 || tool === "hand" || spacePressed) {
      e.preventDefault();
      panDragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: viewport.x,
        origY: viewport.y,
      };
      return;
    }

    if (tool === "pen") {
      e.preventDefault();
      const pt = screenToWorld(e.clientX, e.clientY);
      const stroke: CanvasStroke = {
        id: createCanvasId("stroke"),
        points: [{ x: Math.round(pt.x), y: Math.round(pt.y) }],
        color: penColor,
        width: penHighlighter ? 16 : 3,
        highlighter: penHighlighter,
      };
      activeStrokeRef.current = stroke;
      setActiveStroke(stroke);
      return;
    }

    if (e.target !== e.currentTarget) return;

    if (tool === "sticky" || tool === "frame" || tool === "shape" || tool === "text") {
      const world = screenToWorld(e.clientX, e.clientY);
      addNodeAt(tool, world.x, world.y);
      return;
    }

    if (tool === "select") {
      const world = screenToWorld(e.clientX, e.clientY);
      marqueeStartRef.current = world;
      setMarqueeRect({ x: world.x, y: world.y, width: 0, height: 0 });
    }

    setSelectedNodeIds([]);
    setSelectedConnectorId(null);
    setEditingNodeId(null);
    setConnectFromId(null);
  }

  function handleCanvasWheel(e: ReactWheelEvent<HTMLDivElement>) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.08 : 0.92;
      setViewport((prev) => {
        const nextZoom = clampZoom(prev.zoom * factor);
        const worldX = (mouseX - prev.x) / prev.zoom;
        const worldY = (mouseY - prev.y) / prev.zoom;
        return {
          x: Math.round(mouseX - worldX * nextZoom),
          y: Math.round(mouseY - worldY * nextZoom),
          zoom: nextZoom,
        };
      });
    } else {
      // Smooth Miro-style trackpad pan
      setViewport((prev) => ({
        ...prev,
        x: Math.round(prev.x - e.deltaX),
        y: Math.round(prev.y - e.deltaY),
      }));
    }
  }

  function handleNodeMouseDown(e: ReactMouseEvent, node: CanvasNode) {
    e.stopPropagation();
    if (tool === "hand" || spacePressed) {
      panDragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: viewport.x,
        origY: viewport.y,
      };
      return;
    }

    if (tool === "connect") {
      if (!connectFromId) {
        setConnectFromId(node.id);
        setSelectedNodeIds([node.id]);
      } else if (connectFromId !== node.id) {
        const newConn: CanvasConnector = {
          id: createCanvasId("conn"),
          fromNodeId: connectFromId,
          toNodeId: node.id,
          color: "slate",
        };
        commitCanvasChange(nodes, [...connectors, newConn]);
        setConnectFromId(null);
        setTool("select");
        setSelectedConnectorId(newConn.id);
      }
      return;
    }

    if (editingNodeId === node.id) return;

    const alreadySelected = selectedNodeIds.includes(node.id);
    let nextSelected: string[];
    if (e.shiftKey) {
      nextSelected = alreadySelected
        ? selectedNodeIds.filter((id) => id !== node.id)
        : [...selectedNodeIds, node.id];
    } else if (alreadySelected) {
      nextSelected = selectedNodeIds;
    } else {
      nextSelected = [node.id];
    }
    setSelectedNodeIds(nextSelected);
    setSelectedConnectorId(null);

    // If dragging a frame, automatically carry all nodes inside it!
    const movingSet = new Set(nextSelected);
    for (const id of nextSelected) {
      const candidate = nodes.find((n) => n.id === id);
      if (candidate?.kind === "frame") {
        for (const child of getNodesInsideFrame(candidate, nodes)) {
          movingSet.add(child.id);
        }
      }
    }

    const origPositions = new Map<string, { x: number; y: number }>();
    for (const n of nodes) {
      if (movingSet.has(n.id)) origPositions.set(n.id, { x: n.x, y: n.y });
    }

    // Save undo snapshot before drag starts
    setHistory((prev) => [...prev.slice(-39), { nodes, connectors, strokes }]);
    setFuture([]);

    nodeDragRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      movingIds: Array.from(movingSet),
      origPositions,
    };
  }

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

  if (!selectedCompanyId) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        Select a company to open the Planning Canvas.
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background select-none">
      {/* Top Miro-style Board Bar */}
      <div className="z-20 flex flex-wrap items-center justify-between gap-2 border-b border-border bg-background/95 px-4 py-2 backdrop-blur-xs">
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Select canvas board"
            value={activeBoard?.id ?? ""}
            onChange={(e) => setActiveBoardId(e.target.value)}
            className="h-7 rounded-md border border-border bg-muted/40 px-2 text-xs font-medium text-foreground outline-none focus:border-ring"
          >
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.title}
              </option>
            ))}
          </select>

          <input
            type="text"
            aria-label="Board title"
            value={boardTitle}
            onChange={(e) => {
              setBoardTitle(e.target.value);
              setDirty(true);
            }}
            className="h-7 w-44 rounded-md border border-transparent bg-transparent px-2 text-sm font-semibold text-foreground outline-none hover:border-border focus:border-ring"
          />

          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() =>
              createBoardMutation.mutate({
                title: `Board ${boards.length + 1}`,
                data: { nodes: [], connectors: [], viewport: { x: 40, y: 40, zoom: 1 } },
              })
            }
          >
            <Plus className="size-3" />
            New board
          </Button>

          {boards.length > 1 && activeBoard ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              title="Delete board"
              aria-label="Delete board"
              onClick={() => deleteBoardMutation.mutate(activeBoard.id)}
            >
              <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
            </Button>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {/* Quick Search & Jump on Board */}
          <div className="relative hidden sm:block">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={boardSearch}
              onChange={(e) => setBoardSearch(e.target.value)}
              placeholder="Find on board…"
              className="h-7 w-36 rounded-md border border-border bg-background pl-7 pr-2 text-xs text-foreground outline-none focus:w-44 focus:border-ring transition-all"
            />
            {boardSearch.trim() ? (
              <div className="absolute right-0 top-8 z-40 max-h-56 w-64 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg">
                {nodes
                  .filter((n) => {
                    const q = boardSearch.trim().toLowerCase();
                    return `${n.title} ${n.content}`.toLowerCase().includes(q);
                  })
                  .slice(0, 8)
                  .map((hit) => (
                    <button
                      key={hit.id}
                      type="button"
                      onClick={() => focusNodeOnBoard(hit)}
                      className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
                    >
                      <span className="truncate font-medium text-foreground">
                        {hit.title || hit.content || "(Untitled)"}
                      </span>
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] capitalize text-muted-foreground">
                        {hit.kind}
                      </span>
                    </button>
                  ))}
              </div>
            ) : null}
          </div>

          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={nodes.length === 0 || exportBoardAsNoteMutation.isPending}
            onClick={() => exportBoardAsNoteMutation.mutate()}
            title="Export this entire canvas board into a structured Personal Note"
          >
            <FileDown className="size-3.5 text-emerald-500" />
            {exportBoardAsNoteMutation.isPending ? "Exporting…" : "Save as Note"}
          </Button>

          <div className="relative">
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => setTemplatesOpen((v) => !v)}
            >
              <LayoutTemplate className="size-3.5 text-violet-500" />
              Templates
            </Button>
            {templatesOpen ? (
              <div className="absolute right-0 top-9 z-40 w-64 rounded-xl border border-border bg-popover p-1.5 shadow-lg">
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Insert Miro-style template
                </div>
                {CANVAS_BOARD_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => {
                      const built = tpl.build();
                      commitCanvasChange(built.nodes, built.connectors);
                      setViewport(built.viewport);
                      setTemplatesOpen(false);
                      pushToast({ title: `Applied “${tpl.label}” template`, tone: "success" });
                    }}
                    className="flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent"
                  >
                    <span className="text-xs font-medium text-foreground">{tpl.label}</span>
                    <span className="text-[11px] text-muted-foreground">{tpl.description}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <Button
            type="button"
            size="xs"
            variant={notesDrawerOpen ? "secondary" : "outline"}
            onClick={() => setNotesDrawerOpen((v) => !v)}
          >
            <NotebookPen className="size-3.5 text-blue-500" />
            My Notes ({personalNotes.filter((n) => !n.archived).length})
          </Button>

          <div className="mx-1 h-4 w-px bg-border" />

          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={history.length === 0}
            title="Undo (⌘Z)"
            aria-label="Undo"
            onClick={handleUndo}
          >
            <Undo2 className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={future.length === 0}
            title="Redo (⇧⌘Z)"
            aria-label="Redo"
            onClick={handleRedo}
          >
            <Redo2 className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant={snapEnabled ? "secondary" : "ghost"}
            title={snapEnabled ? "Snap to grid: ON" : "Snap to grid: OFF"}
            aria-label="Toggle snap to grid"
            onClick={() => setSnapEnabled((s) => !s)}
          >
            <Grid2x2 className="size-3.5" />
          </Button>

          <span className="ml-1 text-[11px] text-muted-foreground">
            {saveBoardMutation.isPending ? (
              "Saving…"
            ) : dirty ? (
              "Unsaved"
            ) : (
              <span className="inline-flex items-center gap-1">
                <Check className="size-3 text-emerald-500" />
                Saved
              </span>
            )}
          </span>
        </div>
      </div>

      {/* Main Infinite Canvas Area */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* Left Miro-style Floating Tool Rail */}
        <div className="pointer-events-auto absolute left-3 top-1/2 z-30 flex -translate-y-1/2 flex-col gap-1 rounded-xl border border-border bg-popover/95 p-1.5 shadow-lg backdrop-blur-xs">
          {(
            [
              { id: "select", icon: MousePointer2, label: "Select (V)" },
              { id: "hand", icon: Hand, label: "Pan (H / Space)" },
              { id: "sticky", icon: StickyNote, label: "Sticky Note (N)" },
              { id: "frame", icon: Frame, label: "Frame / Section (F)" },
              { id: "shape", icon: Shapes, label: "Shape (S)" },
              { id: "text", icon: Type, label: "Text (T)" },
              { id: "connect", icon: ArrowRight, label: "Connector Arrow (L)" },
              { id: "pen", icon: Pen, label: "Freehand Pen (D)" },
            ] as const
          ).map((item) => {
            const Icon = item.icon;
            const active = tool === item.id;
            return (
              <button
                key={item.id}
                type="button"
                title={item.label}
                aria-label={item.label}
                aria-pressed={active}
                onClick={() => {
                  setTool(item.id);
                  setConnectFromId(null);
                }}
                className={cn(
                  "flex size-9 items-center justify-center rounded-lg transition-colors",
                  active
                    ? "bg-foreground text-background shadow-xs"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
              </button>
            );
          })}
          <div className="my-0.5 h-px bg-border" />
          <button
            type="button"
            title="Drop Personal Notes onto board (P)"
            aria-label="Personal Notes drawer"
            aria-pressed={notesDrawerOpen}
            onClick={() => setNotesDrawerOpen((o) => !o)}
            className={cn(
              "flex size-9 items-center justify-center rounded-lg transition-colors",
              notesDrawerOpen
                ? "bg-blue-500 text-white shadow-xs"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <NotebookPen className="size-4" />
          </button>
        </div>

        {/* Pen mode toolbar */}
        {tool === "pen" ? (
          <div className="pointer-events-auto absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-border bg-popover/95 px-3 py-1.5 shadow-lg backdrop-blur-xs">
            <div className="flex items-center gap-1">
              {CANVAS_NODE_COLORS.map((c) => {
                const theme = CANVAS_COLOR_THEMES[c];
                return (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Pen color ${theme.label}`}
                    onClick={() => setPenColor(c)}
                    className={cn(
                      "size-4 rounded-full transition-transform",
                      theme.swatch,
                      penColor === c
                        ? "scale-110 ring-2 ring-foreground/60 ring-offset-1 ring-offset-background"
                        : "opacity-75 hover:opacity-100",
                    )}
                  />
                );
              })}
            </div>
            <div className="h-4 w-px bg-border" />
            <Button
              type="button"
              size="xs"
              variant={penHighlighter ? "secondary" : "ghost"}
              onClick={() => setPenHighlighter((h) => !h)}
            >
              <Highlighter className="size-3.5" />
              {penHighlighter ? "Highlighter" : "Pen"}
            </Button>
            {strokes.length > 0 ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => commitCanvasChange(nodes, connectors, [])}
              >
                <Eraser className="size-3.5" />
                Clear ink ({strokes.length})
              </Button>
            ) : null}
          </div>
        ) : null}

        {/* Multi-selection Align, Tidy & Delegate Toolbar */}
        {selectedNodeIds.length > 1 ? (
          <div className="pointer-events-auto absolute left-1/2 top-3 z-30 flex -translate-x-1/2 flex-wrap items-center gap-1.5 rounded-xl border border-border bg-popover/95 px-2.5 py-1.5 shadow-lg backdrop-blur-xs">
            <span className="px-1 text-xs font-semibold text-foreground">
              {selectedNodeIds.length} selected
            </span>
            <div className="h-4 w-px bg-border" />
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              title="Align left"
              aria-label="Align left"
              onClick={() => handleAlignSelection("left")}
            >
              <AlignHorizontalJustifyStart className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              title="Align top"
              aria-label="Align top"
              onClick={() => handleAlignSelection("top")}
            >
              <AlignVerticalJustifyStart className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              title="Distribute horizontally"
              onClick={() => handleAlignSelection("distribute-h")}
            >
              Row
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              title="Tidy into grid"
              onClick={() => handleAlignSelection("tidy-grid")}
            >
              <LayoutGrid className="size-3.5" />
              Tidy
            </Button>
            <div className="h-4 w-px bg-border" />
            <Button type="button" size="xs" onClick={handleDelegateMultiSelection}>
              <Send className="size-3" />
              Give {selectedNodeIds.length} to agent
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              title="Duplicate (⌘D)"
              aria-label="Duplicate selection"
              onClick={duplicateSelection}
            >
              <Copy className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              title="Delete (⌫)"
              aria-label="Delete selection"
              onClick={deleteSelection}
            >
              <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
            </Button>
          </div>
        ) : null}

        {/* Connector mode hint banner */}
        {tool === "connect" ? (
          <div className="pointer-events-none absolute left-1/2 top-3 z-30 -translate-x-1/2 rounded-full border border-border bg-popover/95 px-3.5 py-1 text-xs font-medium text-foreground shadow-md">
            {connectFromId
              ? "Click a target card to complete the arrow (Esc to cancel)"
              : "Click a source card to start drawing a connector arrow"}
          </div>
        ) : null}

        {/* Floating Context Toolbar for Selected Node */}
        {primarySelectedNode ? (
          <div className="pointer-events-auto absolute left-1/2 top-3 z-30 flex -translate-x-1/2 flex-wrap items-center gap-1.5 rounded-xl border border-border bg-popover/95 px-2.5 py-1.5 shadow-lg backdrop-blur-xs">
            <div className="flex items-center gap-1">
              {CANVAS_NODE_COLORS.map((c) => {
                const theme = CANVAS_COLOR_THEMES[c];
                return (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Color ${theme.label}`}
                    title={theme.label}
                    onClick={() =>
                      commitCanvasChange(
                        nodes.map((n) => (n.id === primarySelectedNode.id ? { ...n, color: c } : n)),
                        connectors,
                      )
                    }
                    className={cn(
                      "size-4 rounded-full transition-transform",
                      theme.swatch,
                      primarySelectedNode.color === c
                        ? "scale-110 ring-2 ring-foreground/60 ring-offset-1 ring-offset-background"
                        : "opacity-75 hover:opacity-100",
                    )}
                  />
                );
              })}
            </div>

            {primarySelectedNode.kind === "shape" ? (
              <>
                <div className="h-4 w-px bg-border" />
                <div className="flex items-center gap-1 text-[11px]">
                  {(["rect", "pill", "diamond"] as CanvasShapeVariant[]).map((variant) => (
                    <button
                      key={variant}
                      type="button"
                      onClick={() =>
                        commitCanvasChange(
                          nodes.map((n) =>
                            n.id === primarySelectedNode.id ? { ...n, shape: variant } : n,
                          ),
                          connectors,
                        )
                      }
                      className={cn(
                        "rounded px-1.5 py-0.5 capitalize transition-colors",
                        (primarySelectedNode.shape ?? "rect") === variant
                          ? "bg-foreground text-background"
                          : "text-muted-foreground hover:bg-accent",
                      )}
                    >
                      {variant}
                    </button>
                  ))}
                </div>
              </>
            ) : null}

            <div className="h-4 w-px bg-border" />

            <Button
              type="button"
              size="xs"
              onClick={() => handleGiveNodeToAgent(primarySelectedNode)}
            >
              <Send className="size-3" />
              {primarySelectedNode.kind === "frame" ? "Delegate frame" : "Give to agent"}
            </Button>

            {primarySelectedNode.kind === "note" && primarySelectedNode.noteId && notesById.get(primarySelectedNode.noteId) ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => setScheduleNote(notesById.get(primarySelectedNode.noteId!) ?? null)}
              >
                <CalendarClock className="size-3 text-amber-500" />
                Schedule
              </Button>
            ) : null}

            {primarySelectedNode.kind === "sticky" ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={promoteStickyToNoteMutation.isPending}
                onClick={() => promoteStickyToNoteMutation.mutate(primarySelectedNode)}
                title="Save this sticky as a full Personal Note"
              >
                <Sparkles className="size-3 text-violet-500" />
                Promote to Note
              </Button>
            ) : null}

            <div className="h-4 w-px bg-border" />

            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              title="Duplicate (⌘D)"
              aria-label="Duplicate"
              onClick={duplicateSelection}
            >
              <Copy className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              title="Delete (⌫)"
              aria-label="Delete"
              onClick={deleteSelection}
            >
              <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
            </Button>
          </div>
        ) : selectedConnectorId ? (
          <div className="pointer-events-auto absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-border bg-popover/95 px-3 py-1.5 shadow-lg">
            <input
              type="text"
              placeholder="Arrow label…"
              value={connectors.find((c) => c.id === selectedConnectorId)?.label ?? ""}
              onChange={(e) => {
                const label = e.target.value;
                setConnectors((prev) =>
                  prev.map((c) => (c.id === selectedConnectorId ? { ...c, label } : c)),
                );
                setDirty(true);
              }}
              className="h-6 w-36 rounded border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-ring"
            />
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                commitCanvasChange(
                  nodes,
                  connectors.map((c) =>
                    c.id === selectedConnectorId ? { ...c, dashed: !c.dashed } : c,
                  ),
                );
              }}
            >
              Dashed
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Delete connector"
              onClick={deleteSelection}
            >
              <Trash2 className="size-3.5 text-destructive" />
            </Button>
          </div>
        ) : null}

        {/* Infinite Canvas Viewport */}
        <div
          ref={canvasRef}
          onMouseDown={handleCanvasMouseDown}
          onWheel={handleCanvasWheel}
          className={cn(
            "relative flex-1 overflow-hidden",
            tool === "hand" || spacePressed
              ? "cursor-grab active:cursor-grabbing"
              : tool === "select"
                ? "cursor-default"
                : "cursor-crosshair",
          )}
          style={{
            backgroundImage:
              "radial-gradient(circle, color-mix(in oklab, var(--border) 85%, transparent) 1.25px, transparent 1.25px)",
            backgroundSize: `${24 * viewport.zoom}px ${24 * viewport.zoom}px`,
            backgroundPosition: `${viewport.x}px ${viewport.y}px`,
          }}
        >
          {/* Transformed World Container */}
          <div
            className="pointer-events-none absolute left-0 top-0 origin-top-left"
            style={{
              transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.zoom})`,
            }}
          >
            {/* SVG Connectors Layer */}
            <svg
              className="pointer-events-none absolute left-0 top-0 overflow-visible"
              width={1}
              height={1}
            >
              <defs>
                <marker
                  id="canvas-arrowhead"
                  markerWidth="10"
                  markerHeight="7"
                  refX="9"
                  refY="3.5"
                  orient="auto"
                >
                  <polygon points="0 0, 10 3.5, 0 7" fill="currentColor" />
                </marker>
              </defs>
              {connectors.map((conn) => {
                const from = nodeById.get(conn.fromNodeId);
                const to = nodeById.get(conn.toNodeId);
                if (!from || !to) return null;
                const geom = computeConnectorPath(from, to);
                const isSelected = selectedConnectorId === conn.id;
                const stroke = CANVAS_COLOR_THEMES[conn.color ?? "slate"].strokeHex;
                return (
                  <g
                    key={conn.id}
                    className="pointer-events-auto cursor-pointer"
                    style={{ color: isSelected ? "#3b82f6" : stroke }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedConnectorId(conn.id);
                      setSelectedNodeIds([]);
                    }}
                  >
                    <path d={geom.path} fill="none" stroke="transparent" strokeWidth={14} />
                    <path
                      d={geom.path}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={isSelected ? 3 : 2}
                      strokeDasharray={conn.dashed ? "6 4" : undefined}
                      markerEnd="url(#canvas-arrowhead)"
                    />
                    {conn.label ? (
                      <g transform={`translate(${geom.midX}, ${geom.midY})`}>
                        <rect
                          x={-Math.max(24, conn.label.length * 3.8 + 8)}
                          y={-11}
                          width={Math.max(48, conn.label.length * 7.6 + 16)}
                          height={22}
                          rx={6}
                          className="fill-background stroke-border"
                          strokeWidth={1}
                        />
                        <text
                          textAnchor="middle"
                          dominantBaseline="central"
                          className="fill-foreground text-[11px] font-medium"
                        >
                          {conn.label}
                        </text>
                      </g>
                    ) : null}
                  </g>
                );
              })}

              {/* Freehand Pen & Highlighter Strokes */}
              {[...strokes, ...(activeStroke ? [activeStroke] : [])].map((stroke) => (
                <path
                  key={stroke.id}
                  d={strokePointsToSvgPath(stroke.points)}
                  fill="none"
                  stroke={CANVAS_COLOR_THEMES[stroke.color]?.strokeHex ?? "#3b82f6"}
                  strokeWidth={stroke.width}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeOpacity={stroke.highlighter ? 0.35 : 0.9}
                />
              ))}

              {/* Live rubber-band arrow when dragging from a Miro blue handle */}
              {dragConnect ? (
                <line
                  x1={dragConnect.startX}
                  y1={dragConnect.startY}
                  x2={dragConnect.currX}
                  y2={dragConnect.currY}
                  stroke="#3b82f6"
                  strokeWidth={2.5}
                  strokeDasharray="6 4"
                  markerEnd="url(#canvas-arrowhead)"
                  style={{ color: "#3b82f6" }}
                />
              ) : null}
            </svg>

            {/* Marquee selection rectangle */}
            {marqueeRect && (marqueeRect.width > 4 || marqueeRect.height > 4) ? (
              <div
                style={{
                  left: marqueeRect.x,
                  top: marqueeRect.y,
                  width: marqueeRect.width,
                  height: marqueeRect.height,
                  zIndex: 9999,
                }}
                className="pointer-events-none absolute rounded border border-blue-500 bg-blue-500/12"
              />
            ) : null}

            {/* Nodes Layer */}
            {sortedNodes.map((node) => {
              const isSelected = selectedNodeIds.includes(node.id);
              const isEditing = editingNodeId === node.id;
              const theme = CANVAS_COLOR_THEMES[node.color] ?? CANVAS_COLOR_THEMES.yellow;
              const linkedNote = node.noteId ? notesById.get(node.noteId) : null;

              return (
                <div
                  key={node.id}
                  onMouseDown={(e) => handleNodeMouseDown(e, node)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (node.kind !== "note") setEditingNodeId(node.id);
                  }}
                  style={{
                    left: node.x,
                    top: node.y,
                    width: node.width,
                    height: node.height,
                    zIndex: node.kind === "frame" ? 1 : node.zIndex,
                  }}
                  className={cn(
                    "pointer-events-auto absolute transition-shadow",
                    isSelected && "ring-2 ring-blue-500 ring-offset-2 ring-offset-background",
                    connectFromId === node.id && "ring-2 ring-amber-500",
                    node.kind === "frame" &&
                      cn("rounded-2xl border-2 border-dashed", theme.frameBg, theme.frameBorder),
                    node.kind === "sticky" &&
                      cn("flex flex-col rounded-xl border p-3 shadow-md", theme.stickyBg, theme.stickyBorder, theme.stickyText),
                    node.kind === "note" &&
                      "flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-md",
                    node.kind === "text" && "flex items-center px-2",
                    node.kind === "shape" &&
                      cn(
                        "flex items-center justify-center border-2 p-3 text-center shadow-xs",
                        theme.shapeBg,
                        theme.shapeBorder,
                        node.shape === "pill" ? "rounded-full" : node.shape === "diamond" ? "rounded-xl" : "rounded-lg",
                      ),
                  )}
                >
                  {/* Frame Node */}
                  {node.kind === "frame" ? (
                    <div className="flex items-center justify-between px-3 py-2">
                      {isEditing ? (
                        <input
                          type="text"
                          autoFocus
                          value={node.title}
                          onChange={(e) => {
                            const val = e.target.value;
                            setNodes((prev) =>
                              prev.map((n) => (n.id === node.id ? { ...n, title: val } : n)),
                            );
                            setDirty(true);
                          }}
                          onBlur={() => setEditingNodeId(null)}
                          className="w-full bg-transparent text-xs font-bold uppercase tracking-wider outline-none"
                        />
                      ) : (
                        <span className={cn("text-xs font-bold uppercase tracking-wider", theme.frameHeader)}>
                          {node.title || "Untitled Frame"}
                        </span>
                      )}
                      {node.handedOffIssueIdentifier ? (
                        <Link
                          to={`/issues/${node.handedOffIssueIdentifier}`}
                          onMouseDown={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
                        >
                          {node.handedOffIssueIdentifier}
                        </Link>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Sticky Note Node */}
                  {node.kind === "sticky" ? (
                    <>
                      {isEditing ? (
                        <div className="flex h-full flex-col gap-1.5" onMouseDown={(e) => e.stopPropagation()}>
                          <input
                            type="text"
                            autoFocus
                            value={node.title}
                            onChange={(e) => {
                              const val = e.target.value;
                              setNodes((prev) =>
                                prev.map((n) => (n.id === node.id ? { ...n, title: val } : n)),
                              );
                              setDirty(true);
                            }}
                            placeholder="Title…"
                            className="w-full bg-transparent text-sm font-semibold outline-none"
                          />
                          <textarea
                            value={node.content}
                            onChange={(e) => {
                              const val = e.target.value;
                              setNodes((prev) =>
                                prev.map((n) => (n.id === node.id ? { ...n, content: val } : n)),
                              );
                              setDirty(true);
                            }}
                            placeholder="Write idea…"
                            className="flex-1 resize-none bg-transparent text-xs leading-relaxed outline-none"
                          />
                        </div>
                      ) : (
                        <div className="flex h-full flex-col justify-between gap-2 overflow-hidden">
                          <div className="space-y-1 overflow-hidden">
                            {node.title ? (
                              <div className="line-clamp-2 text-sm font-semibold leading-snug">
                                {node.title}
                              </div>
                            ) : null}
                            {node.content ? (
                              <p className="line-clamp-4 whitespace-pre-wrap text-xs leading-relaxed opacity-85">
                                {node.content}
                              </p>
                            ) : null}
                          </div>
                          {node.handedOffIssueIdentifier ? (
                            <Link
                              to={`/issues/${node.handedOffIssueIdentifier}`}
                              onMouseDown={(e) => e.stopPropagation()}
                              className="inline-flex w-fit items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 hover:underline dark:text-emerald-300"
                            >
                              <CheckCircle2 className="size-2.5" />
                              {node.handedOffIssueIdentifier}
                            </Link>
                          ) : null}
                        </div>
                      )}
                    </>
                  ) : null}

                  {/* Linked Personal Note Card */}
                  {node.kind === "note" ? (
                    (() => {
                      const displayTitle = linkedNote?.title ?? node.title;
                      const displayBody = linkedNote?.body ?? node.content;
                      const checklist = parseChecklistItems(displayBody);
                      const checked = checklist.filter((i) => i.checked).length;
                      return (
                        <div className="flex h-full flex-col justify-between">
                          <div className={cn("h-1.5 w-full", theme.swatch)} />
                          <div className="flex flex-1 flex-col gap-1.5 overflow-hidden p-3">
                            <div className="flex items-start justify-between gap-1.5">
                              <div className="flex min-w-0 items-center gap-1.5">
                                <NotebookPen className="size-3.5 shrink-0 text-blue-500" />
                                <span className="truncate text-sm font-semibold text-foreground">
                                  {displayTitle}
                                </span>
                              </div>
                              {linkedNote ? (
                                <Link
                                  to={`/notes/${linkedNote.id}`}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  title="Open in Personal Notes"
                                  className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                                >
                                  <ExternalLink className="size-3" />
                                </Link>
                              ) : null}
                            </div>

                            <p className="line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                              {displayBody.trim() || "Empty personal note"}
                            </p>

                            <div className="mt-auto flex flex-wrap items-center gap-1 pt-1">
                              {checklist.length > 0 ? (
                                <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                  <ListChecks className="size-2.5" />
                                  {checked}/{checklist.length}
                                </span>
                              ) : null}
                              {linkedNote?.scheduledStatus === "pending" ? (
                                <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                                  <CalendarClock className="size-2.5" />
                                  Scheduled
                                </span>
                              ) : null}
                              {(linkedNote?.handedOffIssueIdentifier ?? node.handedOffIssueIdentifier) ? (
                                <Link
                                  to={`/issues/${linkedNote?.handedOffIssueIdentifier ?? node.handedOffIssueIdentifier}`}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 hover:underline dark:text-emerald-300"
                                >
                                  <CheckCircle2 className="size-2.5" />
                                  {linkedNote?.handedOffIssueIdentifier ?? node.handedOffIssueIdentifier}
                                </Link>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      );
                    })()
                  ) : null}

                  {/* Shape Node */}
                  {node.kind === "shape" ? (
                    isEditing ? (
                      <input
                        type="text"
                        autoFocus
                        value={node.title}
                        onMouseDown={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const val = e.target.value;
                          setNodes((prev) =>
                            prev.map((n) => (n.id === node.id ? { ...n, title: val } : n)),
                          );
                          setDirty(true);
                        }}
                        onBlur={() => setEditingNodeId(null)}
                        className="w-full bg-transparent text-center text-sm font-semibold text-foreground outline-none"
                      />
                    ) : (
                      <span className="text-sm font-semibold text-foreground">
                        {node.title || "Shape"}
                      </span>
                    )
                  ) : null}

                  {/* Text Node */}
                  {node.kind === "text" ? (
                    isEditing ? (
                      <input
                        type="text"
                        autoFocus
                        value={node.title}
                        onMouseDown={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const val = e.target.value;
                          setNodes((prev) =>
                            prev.map((n) => (n.id === node.id ? { ...n, title: val } : n)),
                          );
                          setDirty(true);
                        }}
                        onBlur={() => setEditingNodeId(null)}
                        className="w-full bg-transparent text-xl font-bold text-foreground outline-none"
                      />
                    ) : (
                      <span className="text-xl font-bold tracking-tight text-foreground">
                        {node.title || "Text"}
                      </span>
                    )
                  ) : null}

                  {/* Miro-style Blue Connection Handles (drag to connect or spawn a linked sticky) */}
                  {isSelected && selectedNodeIds.length === 1 && !isEditing ? (
                    <>
                      {(
                        [
                          { side: "top", cls: "-top-3 left-1/2 -translate-x-1/2", sx: node.x + node.width / 2, sy: node.y },
                          { side: "right", cls: "top-1/2 -right-3 -translate-y-1/2", sx: node.x + node.width, sy: node.y + node.height / 2 },
                          { side: "bottom", cls: "-bottom-3 left-1/2 -translate-x-1/2", sx: node.x + node.width / 2, sy: node.y + node.height },
                          { side: "left", cls: "top-1/2 -left-3 -translate-y-1/2", sx: node.x, sy: node.y + node.height / 2 },
                        ] as const
                      ).map((handle) => (
                        <button
                          key={handle.side}
                          type="button"
                          title="Drag to connect to another card (or drop on empty canvas to spawn a connected sticky)"
                          aria-label={`Connect from ${handle.side}`}
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            const initial = {
                              fromNodeId: node.id,
                              startX: handle.sx,
                              startY: handle.sy,
                              currX: handle.sx,
                              currY: handle.sy,
                            };
                            dragConnectRef.current = initial;
                            setDragConnect(initial);
                          }}
                          className={cn(
                            "absolute z-30 size-3 rounded-full border-2 border-background bg-blue-500 shadow-xs transition-transform hover:scale-125",
                            handle.cls,
                          )}
                        />
                      ))}
                    </>
                  ) : null}

                  {/* Resize Handle */}
                  {isSelected ? (
                    <div
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        setHistory((prev) => [...prev.slice(-39), { nodes, connectors, strokes }]);
                        setFuture([]);
                        resizeDragRef.current = {
                          nodeId: node.id,
                          startClientX: e.clientX,
                          startClientY: e.clientY,
                          origW: node.width,
                          origH: node.height,
                        };
                      }}
                      className="absolute -bottom-1.5 -right-1.5 size-3.5 cursor-nwse-resize rounded-sm border border-blue-500 bg-background shadow-xs"
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Personal Notes Drawer */}
        {notesDrawerOpen ? (
          <div className="z-30 flex w-72 shrink-0 flex-col border-l border-border bg-background/95 shadow-xl backdrop-blur-xs">
            <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <NotebookPen className="size-3.5 text-blue-500" />
                Personal Notes
              </div>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Close notes drawer"
                onClick={() => setNotesDrawerOpen(false)}
              >
                <X className="size-3.5" />
              </Button>
            </div>
            <div className="border-b border-border p-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="search"
                  value={notesSearch}
                  onChange={(e) => setNotesSearch(e.target.value)}
                  placeholder="Filter notes to add…"
                  className="h-7 w-full rounded-md border border-border bg-background pl-7 pr-2 text-xs outline-none focus:border-ring"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {filteredDrawerNotes.length === 0 ? (
                <p className="p-4 text-center text-xs text-muted-foreground">
                  No personal notes found.
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {filteredDrawerNotes.map((note) => {
                    const alreadyOnBoard = nodes.some((n) => n.noteId === note.id);
                    return (
                      <button
                        key={note.id}
                        type="button"
                        onClick={() => dropPersonalNoteOnCanvas(note)}
                        className="flex flex-col gap-1 rounded-lg border border-border bg-card p-2.5 text-left transition-colors hover:border-blue-500/50 hover:bg-accent/40"
                      >
                        <div className="flex items-center justify-between gap-1.5">
                          <span className="truncate text-xs font-semibold text-foreground">
                            {note.title}
                          </span>
                          <span className="shrink-0 text-[10px] text-blue-500">
                            {alreadyOnBoard ? "+ Add copy" : "+ Place"}
                          </span>
                        </div>
                        <p className="line-clamp-2 text-[11px] text-muted-foreground">
                          {note.body.trim() || "Empty note"}
                        </p>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : null}

        {/* Bottom-Right Miro-style Zoom & Minimap Controls */}
        <div className="pointer-events-auto absolute bottom-3 right-3 z-20 flex flex-col items-end gap-2">
          {/* Compact Minimap */}
          {nodes.length > 0 ? (
            <div
              onClick={fitToScreen}
              title="Click to fit all items in view"
              className="relative h-24 w-36 cursor-pointer overflow-hidden rounded-lg border border-border bg-popover/90 p-1.5 shadow-md backdrop-blur-xs"
            >
              {(() => {
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
                const spanX = Math.max(400, maxX - minX);
                const spanY = Math.max(300, maxY - minY);
                const scale = Math.min(130 / spanX, 82 / spanY);
                return nodes.map((n) => (
                  <div
                    key={n.id}
                    style={{
                      left: 6 + (n.x - minX) * scale,
                      top: 6 + (n.y - minY) * scale,
                      width: Math.max(4, n.width * scale),
                      height: Math.max(3, n.height * scale),
                    }}
                    className={cn(
                      "absolute rounded-[2px]",
                      n.kind === "frame"
                        ? "border border-muted-foreground/40 bg-muted/30"
                        : CANVAS_COLOR_THEMES[n.color]?.swatch ?? "bg-amber-400",
                    )}
                  />
                ));
              })()}
            </div>
          ) : null}

          <div className="flex items-center gap-1 rounded-xl border border-border bg-popover/95 px-2 py-1 shadow-md backdrop-blur-xs">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Zoom out"
              onClick={() => setViewport((v) => ({ ...v, zoom: clampZoom(v.zoom - 0.15) }))}
            >
              <Minus className="size-3.5" />
            </Button>
            <button
              type="button"
              onClick={() => setViewport((v) => ({ ...v, zoom: 1 }))}
              className="min-w-11 rounded px-1.5 py-0.5 text-center font-mono text-xs text-foreground hover:bg-accent"
              title="Reset zoom to 100%"
            >
              {Math.round(viewport.zoom * 100)}%
            </button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Zoom in"
              onClick={() => setViewport((v) => ({ ...v, zoom: clampZoom(v.zoom + 0.15) }))}
            >
              <Plus className="size-3.5" />
            </Button>
            <div className="mx-0.5 h-4 w-px bg-border" />
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              title="Fit board to screen"
              aria-label="Fit to screen"
              onClick={fitToScreen}
            >
              <Maximize2 className="size-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Schedule Handoff Dialog for linked Personal Notes on Canvas */}
      <ScheduleNoteHandoffDialog
        open={scheduleNote !== null}
        onOpenChange={(open) => {
          if (!open) setScheduleNote(null);
        }}
        companyId={selectedCompanyId}
        note={scheduleNote}
        agents={agents}
        projects={projects}
      />
    </div>
  );
}
