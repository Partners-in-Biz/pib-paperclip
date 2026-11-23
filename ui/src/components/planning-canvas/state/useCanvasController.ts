import { useCanvasActions } from "@/components/planning-canvas/state/useCanvasActions";
import { useCanvasBoard } from "@/components/planning-canvas/state/useCanvasBoard";
import { useCanvasData } from "@/components/planning-canvas/state/useCanvasData";
import { useCanvasPointer } from "@/components/planning-canvas/state/useCanvasPointer";
import { useCanvasState } from "@/components/planning-canvas/state/useCanvasState";

/**
 * Composes the canvas hooks in dependency order: data -> local state -> board persistence
 * -> actions -> pointer/keyboard. Panels and node renderers read from the returned controller.
 */
export function useCanvasController() {
  const data = useCanvasData();
  const state = useCanvasState(data);
  const board = useCanvasBoard({ ...data, ...state });
  const actions = useCanvasActions({ ...data, ...state, ...board });
  const pointer = useCanvasPointer({ ...data, ...state, ...board, ...actions });
  return { ...data, ...state, ...board, ...actions, ...pointer };
}

export type CanvasController = ReturnType<typeof useCanvasController>;
