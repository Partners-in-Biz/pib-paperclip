// PAR-13949 (C19): the keys plan section F adds (capture phase, so it wins over the app shell's `?` and `c`). Today's tool keys, undo, duplicate, Delete, Esc and
// Space stay in useCanvasPointer; this hook owns everything new and the command palette bridge.
import { useEffect, useRef } from "react";
import type { CanvasNode } from "@paperclipai/shared";
import { zoomAbout } from "@/components/planning-canvas/canvas/gestures";
import {
  CANVAS_COMMAND_EVENT,
  CANVAS_COMMENT_EVENT,
  type CanvasCommandId,
  isTypingTarget,
  nudgeDelta,
} from "@/components/planning-canvas/keyboard/canvas-keymap";
import { buildOutline } from "@/components/planning-canvas/panels/outline/outline-order";
import { createCanvasId } from "@/lib/planning-canvas-helpers";
import type { CanvasActions } from "@/components/planning-canvas/state/useCanvasActions";
import type { CanvasBoard } from "@/components/planning-canvas/state/useCanvasBoard";
import type { CanvasData } from "@/components/planning-canvas/state/useCanvasData";
import type { CanvasState } from "@/components/planning-canvas/state/useCanvasState";

type Ctx = CanvasData & CanvasState & CanvasBoard & CanvasActions;

const FRAME_PADDING = 32;

/** Move a node's DOM focus after React has mounted it (it may have been culled). */
export function focusNodeElement(nodeId: string, root: ParentNode = document) {
  requestAnimationFrame(() => {
    const el = root.querySelector<HTMLElement>(`[data-canvas-item="${CSS.escape(nodeId)}"]`);
    el?.focus({ preventScroll: true });
  });
}

export function useCanvasKeyboard(ctx: Ctx) {
  // Latest render's state, so the window listeners attach once.
  const latest = useRef(ctx);
  latest.current = ctx;

  useEffect(() => {
    function frameSelection() {
      const c = latest.current;
      const picked = c.nodes.filter((n) => c.selectedNodeIds.includes(n.id) && n.kind !== "frame");
      if (picked.length === 0) return;
      const minX = Math.min(...picked.map((n) => n.x)) - FRAME_PADDING;
      const minY = Math.min(...picked.map((n) => n.y)) - FRAME_PADDING;
      const maxX = Math.max(...picked.map((n) => n.x + n.width)) + FRAME_PADDING;
      const maxY = Math.max(...picked.map((n) => n.y + n.height)) + FRAME_PADDING;
      const frame: CanvasNode = {
        id: createCanvasId("frame"),
        kind: "frame",
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
        zIndex: 1,
        color: "blue",
        title: "Frame",
        content: "",
      };
      c.commitCanvasChange([...c.nodes, frame], c.connectors);
      c.setSelectedNodeIds([frame.id]);
    }

    function zoomTo100() {
      const c = latest.current;
      const rect = c.canvasRef.current?.getBoundingClientRect();
      const at = { x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2 };
      c.setViewport((v) => zoomAbout(v, at, 1 / v.zoom));
    }

    function find() {
      const c = latest.current;
      const input = document.querySelector<HTMLInputElement>("[data-canvas-find]");
      // The find box is hidden under 640 px: the Outline (with its filter) is the way to search there.
      if (input && input.offsetParent !== null) {
        input.focus();
        input.select();
      } else {
        c.setOutlineOpen(true);
      }
    }

    function walk(step: 1 | -1): boolean {
      const c = latest.current;
      const order = buildOutline(c.nodes).map((e) => e.node);
      if (order.length === 0) return false;
      const current = c.selectedNodeIds.length === 1 ? order.findIndex((n) => n.id === c.selectedNodeIds[0]) : -1;
      const next = current === -1 ? (step === 1 ? 0 : order.length - 1) : current + step;
      // Past either end: let the browser move focus out of the canvas.
      if (next < 0 || next >= order.length) return false;
      const node = order[next]!;
      c.focusNodeOnBoard(node);
      focusNodeElement(node.id);
      return true;
    }

    function run(id: CanvasCommandId) {
      const c = latest.current;
      switch (id) {
        case "cheat-sheet": c.setCheatSheetOpen(true); break;
        case "outline": c.setOutlineOpen((o) => !o); break;
        case "fit": c.fitToScreen(); break;
        case "zoom-100": zoomTo100(); break;
        case "select-all": c.setSelectedNodeIds(c.nodes.map((n) => n.id)); c.setSelectedConnectorId(null); break;
        case "frame-selection": frameSelection(); break;
        case "duplicate": c.duplicateSelection(); break;
        case "add-markdown": c.insertTypedNode("markdown"); break;
        case "find": find(); break;
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      const c = latest.current;
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('[role="dialog"], [role="menu"]')) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (mod && !e.altKey) {
        if (key === "g" && !e.shiftKey) { e.preventDefault(); run("frame-selection"); }
        else if (key === "a" && !e.shiftKey) { e.preventDefault(); run("select-all"); }
        else if (key === "f" && !e.shiftKey) { e.preventDefault(); run("find"); }
        return;
      }
      if (e.altKey) return;

      // The app shell (useKeyboardShortcuts) also binds `?` (app cheat sheet) and `c` (new task) on
      // document. This listener runs in the capture phase and stops them, so on the board `?` opens
      // the canvas cheat sheet and `C` comments.
      if (e.key === "?") { e.preventDefault(); e.stopPropagation(); run("cheat-sheet"); return; }

      // Arrow nudge moves the selection; with nothing selected the arrows keep scrolling the page.
      const nudge = nudgeDelta(e);
      if (nudge && c.selectedNodeIds.length > 0) {
        e.preventDefault();
        const moving = new Set(c.selectedNodeIds);
        c.commitCanvasChange(
          c.nodes.map((n) => (moving.has(n.id) ? { ...n, x: n.x + nudge.dx, y: n.y + nudge.dy } : n)),
          c.connectors,
        );
        return;
      }

      if (e.key === "Tab") {
        // Only inside the board (page body or a node); the rest of the page keeps its own Tab order.
        const inBoard = target === document.body || !!target?.closest?.("[data-canvas-item]");
        if (inBoard && walk(e.shiftKey ? -1 : 1)) e.preventDefault();
        return;
      }

      if (e.shiftKey) return;
      if (e.key === "Enter") {
        const node = c.primarySelectedNode;
        const onNode = !!target?.closest?.("[data-canvas-item]");
        const onControl = !!target?.closest?.("button, a, [role=button]");
        if (node && node.kind !== "note" && (onNode || target === document.body) && !onControl) {
          e.preventDefault();
          c.setEditingNodeId(node.id);
        }
        return;
      }
      if (e.key === "0") run("fit");
      else if (e.key === "1") run("zoom-100");
      else if (key === "m") run("add-markdown");
      else if (key === "o") run("outline");
      else if (key === "c") {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent(CANVAS_COMMENT_EVENT, { detail: { nodeId: c.selectedNodeIds[0] ?? null } }));
      }
    }

    function onCommand(e: Event) {
      const id = (e as CustomEvent<{ id: CanvasCommandId }>).detail?.id;
      if (id) run(id);
    }

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener(CANVAS_COMMAND_EVENT, onCommand);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener(CANVAS_COMMAND_EVENT, onCommand);
    };
  }, []);
}
