// PAR-13933 moved this from pages/PlanningCanvas.tsx; PAR-13934: drags and resizes are undo groups in the op store.
import { type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent, useEffect } from "react";
import { type CanvasConnector, type CanvasNode, type CanvasStroke } from "@paperclipai/shared";
import { clampZoom } from "@/components/planning-canvas/canvas-constants";
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
    setCommentThread,
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
  } = ctx;

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
      } else if (e.key.toLowerCase() === "c" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setTool("comment");
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

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [commitCanvasChange, connectors, nextZIndex, nodes, opStore.endGesture, screenToWorld, snapEnabled, strokes, viewport.zoom]);

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

    if (tool === "comment") {
      setCommentThread({ key: null });
      return;
    }

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

    if (tool === "comment") {
      setCommentThread({ key: node.id });
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
    handleCanvasMouseDown,
    handleCanvasWheel,
    handleNodeMouseDown,
  };
}

export type CanvasPointer = ReturnType<typeof useCanvasPointer>;
