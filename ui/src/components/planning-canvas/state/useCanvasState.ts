// PAR-13933: moved verbatim from pages/PlanningCanvas.tsx; no behaviour change.
import { useMemo, useRef, useState } from "react";
import { type CanvasConnector, type CanvasNode, type CanvasNodeColor, type CanvasStroke, type PersonalNote } from "@paperclipai/shared";
import { type ToolMode } from "@/components/planning-canvas/canvas-constants";
import { type WorldRect } from "@/lib/planning-canvas-helpers";
import type { CanvasData } from "@/components/planning-canvas/state/useCanvasData";

export function useCanvasState(ctx: CanvasData) {
  const {
    boards,
  } = ctx;

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
  /** The board title has unsaved edits. Items save through the op store (PAR-13934). */
  const [dirty, setDirty] = useState(false);

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
  const [insertPanelOpen, setInsertPanelOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [blueprintsOpen, setBlueprintsOpen] = useState(false);
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

  return {
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
    tool,
    setTool,
    penColor,
    setPenColor,
    penHighlighter,
    setPenHighlighter,
    spacePressed,
    setSpacePressed,
    snapEnabled,
    setSnapEnabled,
    selectedNodeIds,
    setSelectedNodeIds,
    selectedConnectorId,
    setSelectedConnectorId,
    editingNodeId,
    setEditingNodeId,
    connectFromId,
    setConnectFromId,
    marqueeRect,
    setMarqueeRect,
    dragConnect,
    setDragConnect,
    activeStroke,
    setActiveStroke,
    notesDrawerOpen,
    setNotesDrawerOpen,
    insertPanelOpen,
    setInsertPanelOpen,
    handoffOpen,
    setHandoffOpen,
    templatesOpen,
    setTemplatesOpen,
    blueprintsOpen,
    setBlueprintsOpen,
    notesSearch,
    setNotesSearch,
    boardSearch,
    setBoardSearch,
    scheduleNote,
    setScheduleNote,
    canvasRef,
    saveTimerRef,
    autoCreatedRef,
    panDragRef,
    marqueeStartRef,
    activeStrokeRef,
    dragConnectRef,
    nodeDragRef,
    resizeDragRef,
  };
}

export type CanvasState = ReturnType<typeof useCanvasState>;
