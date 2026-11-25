import { useSyncExternalStore } from "react";
import { WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { initialsOf, peerColor, uniqueActors } from "@/components/planning-canvas/realtime/realtime-view";
import type { CanvasController } from "@/components/planning-canvas/state/useCanvasController";

const MAX_AVATARS = 4;

/** Who else has the board open (one avatar per person or agent), and the socket state when it is not live. */
export function PresenceAvatars({ c }: { c: CanvasController }) {
  const { view, labelFor, status } = c.realtime;
  const { peers } = useSyncExternalStore(view.subscribe, view.getSnapshot, view.getSnapshot);
  const actors = uniqueActors(peers);
  const shown = actors.slice(0, MAX_AVATARS);
  const hidden = actors.slice(MAX_AVATARS);

  return (
    <div className="flex items-center gap-1.5" data-testid="planning-canvas-presence" data-peers={actors.length}>
      <span role="status" aria-live="polite" data-testid="planning-canvas-live-state" data-state={status} className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        {status === "reconnecting" ? (
          <>
            <WifiOff className="size-3 text-amber-500" />
            Reconnecting…
          </>
        ) : (
          <span className="sr-only">{status === "live" ? "Live" : "Connecting"}</span>
        )}
      </span>
      {shown.length > 0 && (
        <div className="flex -space-x-1.5">
          {shown.map((actor) => {
            const label = labelFor(actor);
            return (
              <span
                key={`${actor.type}:${actor.id}`}
                title={label}
                aria-label={label}
                data-testid="planning-canvas-avatar"
                className={cn(
                  "inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ring-2 ring-background",
                  peerColor(actor).solid,
                )}
              >
                {initialsOf(label)}
              </span>
            );
          })}
          {hidden.length > 0 && (
            <span
              title={hidden.map(labelFor).join(", ")}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground ring-2 ring-background"
            >
              +{hidden.length}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
