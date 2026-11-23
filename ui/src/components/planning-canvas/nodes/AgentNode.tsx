import { Bot } from "lucide-react";
import { AgentIdentity } from "@/components/AgentIdentity";
import { AgentStatusBadge } from "@/components/StatusBadge";
import { isRefData, useCanvasRef } from "@/components/planning-canvas/nodes/canvas-refs";
import { RefCard, refPlaceholder } from "@/components/planning-canvas/nodes/RefCard";
import type { PlanningCanvasAgentRef } from "@/api/planningCanvases";
import { Link } from "@/lib/router";

export function AgentNode({ refId }: { refId: string | null }) {
  const agent = useCanvasRef<PlanningCanvasAgentRef>(refId);
  return (
    <RefCard label="Agent" icon={<Bot className="size-3.5" />}>
      {!isRefData(agent) ? refPlaceholder(agent) : (
        <>
          <Link to={`/agents/${agent.id}`} onMouseDown={(e) => e.stopPropagation()} className="min-w-0 hover:underline">
            <AgentIdentity agent={{ id: agent.id, name: agent.name }} size="sm" />
          </Link>
          {agent.title ? <p className="min-h-0 shrink truncate text-xs text-muted-foreground">{agent.title}</p> : null}
          <div className="mt-auto shrink-0">
            <AgentStatusBadge status={agent.status} />
          </div>
        </>
      )}
    </RefCard>
  );
}
