import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CanvasController } from "@/components/planning-canvas/state/useCanvasController";

/** `access.revoked` (plan E): the board closes behind this notice; nothing of it stays on screen. */
export function RevokedNotice({ c }: { c: CanvasController }) {
  if (!c.realtime.revoked) return null;
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="planning-canvas-revoked-title"
      aria-describedby="planning-canvas-revoked-body"
      data-testid="planning-canvas-access-revoked"
      className="absolute inset-0 z-50 flex items-center justify-center bg-background p-6"
    >
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <Lock aria-hidden className="size-6 text-muted-foreground" />
        <h2 id="planning-canvas-revoked-title" className="text-base font-semibold text-foreground">
          You no longer have access to this board
        </h2>
        <p id="planning-canvas-revoked-body" className="text-sm text-muted-foreground">
          Its sharing changed, or it was archived or deleted. Ask the owner if you still need it.
        </p>
        <Button size="sm" autoFocus onClick={c.realtime.leaveRevokedBoard}>
          Back to boards
        </Button>
      </div>
    </div>
  );
}
