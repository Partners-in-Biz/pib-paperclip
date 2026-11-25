import { createContext, useContext, type MutableRefObject } from "react";
import type { CanvasController } from "@/components/planning-canvas/state/useCanvasController";

/**
 * Always-current controller for memoized children. They must read it inside event handlers
 * (never to render from) so a skipped re-render cannot leave a stale closure behind.
 */
export const CanvasRefContext = createContext<MutableRefObject<CanvasController> | null>(null);

export function useLatestCanvas(): MutableRefObject<CanvasController> {
  const ref = useContext(CanvasRefContext);
  if (!ref) throw new Error("useLatestCanvas must be used inside the Planning Canvas page");
  return ref;
}
