import type { Agent } from "@paperclipai/shared";
import { Bot } from "lucide-react";
import { AgentIcon } from "../AgentIconPicker";
import { EmptyState } from "../EmptyState";
import { EntityRow } from "../EntityRow";
import { AgentStatusBadge } from "../StatusBadge";
import { agentUrl } from "../../lib/utils";

// Not listed, as on the full roster: `terminated` and `pending_approval`.
const HIDDEN_STATUSES = new Set(["terminated", "pending_approval"]);

/**
 * The agents list a restricted member sees under `enforce` (PAR-13474, AC-G10):
 * his agents with name, title, icon and status, and nothing else. It reads no
 * other list and mounts no control that needs one.
 */
export function ReducedAgentList({ agents }: { agents: Agent[] }) {
  const visible = agents
    .filter((agent) => !HIDDEN_STATUSES.has(agent.status))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (visible.length === 0) return <EmptyState icon={Bot} message="No agents to show." />;
  return (
    <div className="flex flex-col" data-testid="reduced-agent-list">
      {visible.map((agent) => (
        <EntityRow
          key={agent.id}
          title={agent.name}
          subtitle={agent.title ?? undefined}
          titleClassName="min-w-0 flex-1"
          titleTextClassName="truncate"
          subtitleClassName="truncate"
          to={agentUrl(agent)}
          className="py-3"
          leading={
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground" data-agent-icon={agent.icon ?? "default"}>
              <AgentIcon icon={agent.icon} className="size-4" />
            </span>
          }
          trailing={<AgentStatusBadge status={agent.status} />}
        />
      ))}
    </div>
  );
}
