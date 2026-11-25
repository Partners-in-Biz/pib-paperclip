import { Target } from "lucide-react";
import { StatusBadge } from "@/components/StatusBadge";
import { isRefData, useCanvasRef } from "@/components/planning-canvas/nodes/canvas-refs";
import { RefCard, refPlaceholder } from "@/components/planning-canvas/nodes/RefCard";
import type { PlanningCanvasGoalRef } from "@/api/planningCanvases";
import { Link } from "@/lib/router";

export function GoalNode({ refId }: { refId: string | null }) {
  const goal = useCanvasRef<PlanningCanvasGoalRef>(refId);
  return (
    <RefCard label="Goal" icon={<Target className="size-3.5" />}>
      {!isRefData(goal) ? refPlaceholder(goal) : (
        <>
          <Link
            to={`/goals/${goal.id}`}
            onPointerDown={(e) => e.stopPropagation()}
            className="line-clamp-2 text-sm font-semibold leading-snug text-foreground hover:underline"
          >
            {goal.title}
          </Link>
          <div className="mt-auto flex items-center gap-2">
            <StatusBadge status={goal.status} />
            <span className="truncate text-xs text-muted-foreground">{goal.level}</span>
          </div>
        </>
      )}
    </RefCard>
  );
}
