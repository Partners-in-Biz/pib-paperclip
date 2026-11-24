import { useCanvasRealtime } from "@/components/planning-canvas/realtime/useCanvasRealtime";
import { useCanvasActions } from "@/components/planning-canvas/state/useCanvasActions";
import { useCanvasBoard } from "@/components/planning-canvas/state/useCanvasBoard";
import { useCanvasData } from "@/components/planning-canvas/state/useCanvasData";
import { useCanvasKeyboard } from "@/components/planning-canvas/keyboard/useCanvasKeyboard";
import { useCanvasPointer } from "@/components/planning-canvas/state/useCanvasPointer";
import { useCanvasState } from "@/components/planning-canvas/state/useCanvasState";

/**
 * Composes the canvas hooks in dependency order: data -> local state -> board persistence
 * -> realtime -> actions -> pointer/keyboard. Panels and node renderers read from the returned controller.
 */
export function useCanvasController() {
  const data = useCanvasData();
  const state = useCanvasState(data);
  const board = useCanvasBoard({ ...data, ...state });
  const realtime = useCanvasRealtime({ ...data, ...state, ...board });
  const actions = useCanvasActions({ ...data, ...state, ...board });
  const pointer = useCanvasPointer({ ...data, ...state, ...board, ...actions });
  useCanvasKeyboard({ ...data, ...state, ...board, ...actions });
  return { ...data, ...state, ...board, ...actions, ...pointer, realtime };
}

export type CanvasController = ReturnType<typeof useCanvasController>;
