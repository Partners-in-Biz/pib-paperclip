import { useEffect, useRef } from "react";
import { isTypingTarget } from "@/components/planning-canvas/keyboard/canvas-keymap";
import { canEditBoard } from "@/components/planning-canvas/panels/related/related-source";
import type { CanvasActions } from "@/components/planning-canvas/state/useCanvasActions";
import type { CanvasData } from "@/components/planning-canvas/state/useCanvasData";
import type { CanvasState } from "@/components/planning-canvas/state/useCanvasState";

type Ctx = Pick<CanvasData, "pushToast"> & Pick<CanvasState, "activeBoard"> & Pick<CanvasActions, "insertWebLinkNode">;

/** The pasted text when it is exactly one `http(s)://` link and nothing else, else null. */
export function pastedLink(text: string): string | null {
  const value = text.trim();
  return /^https?:\/\/\S+$/i.test(value) ? value : null;
}

/**
 * Board paste (PAR-14389 C.5): one `https://` link pasted while no text field has focus becomes a
 * web link card. An `http://` link is not made a card; the person is told why. Anything else, or
 * a paste into a field, is left to the browser.
 */
export function useCanvasPaste(ctx: Ctx) {
  const latest = useRef(ctx);
  latest.current = ctx;

  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (e.defaultPrevented || isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
      const c = latest.current;
      if (!canEditBoard(c.activeBoard)) return;
      const url = pastedLink(e.clipboardData?.getData("text/plain") ?? "");
      if (!url) return;
      e.preventDefault();
      const problem = c.insertWebLinkNode(url);
      if (problem) c.pushToast({ title: problem, tone: "warn" });
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);
}
