// PAR-13933 moved this from pages/PlanningCanvas.tsx; PAR-13934: drags and resizes are undo groups in the op store.
// PAR-13948 (C17): pointer events instead of mouse events, one move per animation frame, a native
// non-passive wheel listener (also coalesced per frame) and two-finger pinch zoom and pan.
import { type PointerEvent as ReactPointerEvent, useEffect, useRef } from "react";
import { type CanvasConnector, type CanvasNode, type CanvasStroke } from "@paperclipai/shared";
import { type Point, pinchViewport, zoomAbout } from "@/components/planning-canvas/canvas/gestures";
import { type WorldRect, createCanvasId, getNodesInRect, getNodesInsideFrame, snapToGrid } from "@/lib/planning-canvas-helpers";
import type { CanvasData } from "@/components/planning-canvas/state/useCanvasData";
import type { CanvasState } from "@/components/planning-canvas/state/useCanvasState";
import type { CanvasBoard } from "@/components/planning-canvas/state/useCanvasBoard";
import type { CanvasActions } from "@/components/planning-canvas/state/useCanvasActions";

export function useCanvasPointer(ctx: CanvasData & CanvasState & CanvasBoard & CanvasActions) {
  const {
    nodes,
    setNodes,
    connectors,
    strokes,
    viewport,
    setViewport,
    tool,
    setTool,
    penColor,
    penHighlighter,
    spacePressed,
    setSpacePressed,
    snapEnabled,
    selectedNodeIds,
    setSelectedNodeIds,
    setSelectedConnectorId,
    editingNodeId,
    setEditingNodeId,
    connectFromId,
    setConnectFromId,
    setMarqueeRect,
    setDragConnect,
    setActiveStroke,
    setNotesDrawerOpen,
    canvasRef,
    panDragRef,
    marqueeStartRef,
    activeStrokeRef,
    dragConnectRef,
    nodeDragRef,
    resizeDragRef,
    commitCanvasChange,
    opStore,
    handleUndo,
    handleRedo,
    screenToWorld,
    nextZIndex,
    addNodeAt,
    deleteSelection,
    duplicateSelection,
    selectedCompanyId,
    activeBoard,
  } = ctx;

  /** Latest-render handlers, so the window and element listeners are attached once. */
  const handlers = useRef<{
    move: (e: MovePoint) => void;
    up: (e: PointerEvent) => void;
    wheel: (e: WheelEvent) => void;
    active: () => boolean;
    cancel: () => void;
    point: (p: Point) => Point;
    viewport: { x: number; y: number; zoom: number };
  } | null>(null);
  const pendingMove = useRef<MovePoint | null>(null);
  const moveFrame = useRef<number | null>(null);
  const wheelAcc = useRef<{ dx: number; dy: number; factor: number; at: Point | null } | null>(null);
  const wheelFrame = useRef<number | null>(null);
  /** Touch pointers down on the canvas, in client coordinates. */
  const touches = useRef(new Map<number, Point>());
  const pinch = useRef<{ ids: [number, number]; from: [Point, Point]; start: { x: number; y: number; zoom: number } } | null>(null);

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
      // C19: Ctrl/Cmd/Alt chords belong to the keyboard module (Ctrl+F find, Ctrl+G frame ...).
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // A dialog (cheat sheet, handoff ...) owns its own keys.
      if ((e.target as HTMLElement | null)?.closest?.('[role="dialog"]')) return;

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

  const gestureActive = () =>
    !!(panDragRef.current || activeStrokeRef.current || dragConnectRef.current || marqueeStartRef.current || nodeDragRef.current || resizeDragRef.current || pinch.current);

  /** A second finger landed: drop the one-finger gesture so the board pans and zooms instead. */
  function cancelSingleGestures() {
    panDragRef.current = null;
    if (activeStrokeRef.current) {
      activeStrokeRef.current = null;
      setActiveStroke(null);
    }
    if (dragConnectRef.current) {
      dragConnectRef.current = null;
      setDragConnect(null);
    }
    if (marqueeStartRef.current) {
      marqueeStartRef.current = null;
      setMarqueeRect(null);
    }
    const drag = nodeDragRef.current;
    if (drag) {
      nodeDragRef.current = null;
      setNodes((prev) => prev.map((n) => {
        const orig = drag.origPositions.get(n.id);
        return orig ? { ...n, x: orig.x, y: orig.y } : n;
      }));
      opStore.endGesture();
    }
    const resize = resizeDragRef.current;
    if (resize) {
      resizeDragRef.current = null;
      setNodes((prev) => prev.map((n) => (n.id === resize.nodeId ? { ...n, width: resize.origW, height: resize.origH } : n)));
      opStore.endGesture();
    }
  }

  function canvasPoint(p: Point): Point {
    const rect = canvasRef.current?.getBoundingClientRect();
    return { x: p.x - (rect?.left ?? 0), y: p.y - (rect?.top ?? 0) };
  }

  function onWheel(e: WheelEvent) {
    const zoom = e.ctrlKey || e.metaKey;
    // Scrollable node bodies (table, kanban, timeline, markdown) keep their own scroll; Ctrl+wheel still zooms the board.
    if (!zoom && (e.target as Element | null)?.closest?.("[data-canvas-scroll]")) return;
    e.preventDefault();
    const acc = wheelAcc.current ?? { dx: 0, dy: 0, factor: 1, at: null };
    if (zoom) {
      acc.factor *= e.deltaY < 0 ? 1.08 : 0.92;
      acc.at = canvasPoint({ x: e.clientX, y: e.clientY });
    } else {
      acc.dx += e.deltaX;
      acc.dy += e.deltaY;
    }
    wheelAcc.current = acc;
    if (wheelFrame.current !== null) return;
    wheelFrame.current = requestAnimationFrame(() => {
      wheelFrame.current = null;
      const { dx, dy, factor, at } = wheelAcc.current ?? { dx: 0, dy: 0, factor: 1, at: null };
      wheelAcc.current = null;
      setViewport((prev) => {
        let next = dx || dy ? { ...prev, x: Math.round(prev.x - dx), y: Math.round(prev.y - dy) } : prev;
        if (factor !== 1 && at) next = zoomAbout(next, at, factor);
        return next;
      });
    });
  }

  function onMove(e: MovePoint) {
    const p = pinch.current;
    if (p) {
      const a = touches.current.get(p.ids[0]);
      const b = touches.current.get(p.ids[1]);
      if (a && b) setViewport(pinchViewport(p.start, p.from, [canvasPoint(a), canvasPoint(b)]));
      return;
    }
    // Read the gesture refs here, not inside the state updaters: the last move is flushed right
    // before pointerup clears them, and React runs the updater after that.
    const pan = panDragRef.current;
    if (pan) {
      setViewport((v) => ({ ...v, x: pan.origX + e.clientX - pan.startX, y: pan.origY + e.clientY - pan.startY }));
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

    const drag = nodeDragRef.current;
    if (drag) {
      const dx = (e.clientX - drag.startClientX) / viewport.zoom;
      const dy = (e.clientY - drag.startClientY) / viewport.zoom;
      const movingSet = new Set(drag.movingIds);
      setNodes((prev) =>
        prev.map((n) => {
          if (!movingSet.has(n.id)) return n;
          const orig = drag.origPositions.get(n.id);
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

  function onUp(e: PointerEvent) {
    if (panDragRef.current) {
      panDragRef.current = null;
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
      opStore.endGesture();
    }
    if (resizeDragRef.current) {
      resizeDragRef.current = null;
      opStore.endGesture();
    }
  }

  handlers.current = { move: onMove, up: onUp, wheel: onWheel, active: gestureActive, cancel: cancelSingleGestures, point: canvasPoint, viewport };

  // Window pointer move / up for dragging, panning, marquee, pen and drag-connect: one move per frame.
  useEffect(() => {
    const flush = () => {
      moveFrame.current = null;
      const pending = pendingMove.current;
      pendingMove.current = null;
      if (pending) handlers.current?.move(pending);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!handlers.current?.active()) return;
      pendingMove.current = { clientX: e.clientX, clientY: e.clientY };
      if (moveFrame.current === null) moveFrame.current = requestAnimationFrame(flush);
    };
    const onPointerUp = (e: PointerEvent) => {
      touches.current.delete(e.pointerId);
      if (pinch.current) {
        if (pinch.current.ids.includes(e.pointerId)) pinch.current = null;
        return;
      }
      if (moveFrame.current !== null) {
        cancelAnimationFrame(moveFrame.current);
        flush();
      }
      handlers.current?.up(e);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current);
      if (wheelFrame.current !== null) cancelAnimationFrame(wheelFrame.current);
      moveFrame.current = null;
      wheelFrame.current = null;
    };
  }, []);

  // On the viewport element: the wheel (non-passive, so Ctrl+wheel never zooms the page) and,
  // in the capture phase, touch pointers, so a second finger turns any gesture into pinch and pan.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => handlers.current?.wheel(e);
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.current.size < 2) return;
      e.stopPropagation();
      if (pinch.current) return;
      const h = handlers.current;
      if (!h) return;
      const [a, b] = [...touches.current.entries()].slice(-2);
      h.cancel();
      pendingMove.current = null;
      pinch.current = { ids: [a![0], b![0]], from: [h.point(a![1]), h.point(b![1])], start: h.viewport };
    };
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("pointerdown", down, { capture: true });
    return () => {
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("pointerdown", down, { capture: true });
    };
  }, [canvasRef, selectedCompanyId, activeBoard?.id]);

  function handleCanvasPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
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

  function handleNodePointerDown(e: ReactPointerEvent, node: CanvasNode) {
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

    // The drag is one undo step
    opStore.checkpoint();

    nodeDragRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      movingIds: Array.from(movingSet),
      origPositions,
    };
  }

  return {
    handleCanvasPointerDown,
    handleNodePointerDown,
  };
}

type MovePoint = { clientX: number; clientY: number };

export type CanvasPointer = ReturnType<typeof useCanvasPointer>;
