import { FolderOpen } from "lucide-react";
import { StatusBadge } from "@/components/StatusBadge";
import { isRefData, useCanvasRef } from "@/components/planning-canvas/nodes/canvas-refs";
import { RefCard, refPlaceholder } from "@/components/planning-canvas/nodes/RefCard";
import type { PlanningCanvasProjectRef } from "@/api/planningCanvases";
import { Link } from "@/lib/router";

export function ProjectNode({ refId }: { refId: string | null }) {
  const project = useCanvasRef<PlanningCanvasProjectRef>(refId);
  return (
    <RefCard label="Project" icon={<FolderOpen className="size-3.5" />}>
      {!isRefData(project) ? refPlaceholder(project) : (
        <>
          <Link
            to={`/projects/${project.id}`}
            onMouseDown={(e) => e.stopPropagation()}
            className="line-clamp-2 text-sm font-semibold leading-snug text-foreground hover:underline"
          >
            {project.name}
          </Link>
          <div className="mt-auto flex items-center gap-2">
            <StatusBadge status={project.archivedAt ? "archived" : project.status} />
            {project.targetDate ? <span className="truncate text-xs text-muted-foreground">{project.targetDate}</span> : null}
          </div>
        </>
      )}
    </RefCard>
  );
}
