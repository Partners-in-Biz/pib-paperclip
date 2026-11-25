import type { Agent } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";
import { Link } from "@/lib/router";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { agentRouteRef } from "../../lib/utils";
import { AgentIcon } from "../AgentIconPicker";
import { AgentStatusBadge } from "../StatusBadge";
import { TaskSummaryList } from "../TaskSummaryList";
import { Button } from "../ui/button";

/**
 * The agent page a restricted member sees under `enforce` (PAR-13475, AC-G10):
 * name, title, icon and status, a chat with the agent and his tasks for it.
 * Every read of a part is `open` in the route table:
 * - header: `GET /api/agents/:id` (read by the page);
 * - chat: a link; the chat page reads `/api/companies/:companyId/chats/:agentRef`;
 * - tasks: `GET /api/companies/:companyId/issues` (`participantAgentId`).
 * `companyId` is the company in the route, so no request carries `undefined`.
 */
export function ReducedAgentView({ agent, companyId }: { agent: Agent; companyId: string | null | undefined }) {
  const agentRef = agentRouteRef(agent);
  // Same key as the full page's task read, so a switch between the views shares it.
  const tasks = useQuery({
    queryKey: [...queryKeys.issues.list(companyId ?? "__none__"), "participant-agent", agent.id],
    queryFn: () => issuesApi.list(companyId!, { participantAgentId: agent.id }),
    enabled: Boolean(companyId),
  });
  const issues = [...(tasks.data ?? [])].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8" data-testid="reduced-agent-view">
      <header className="flex min-w-0 items-center gap-3">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground" data-agent-icon={agent.icon ?? "default"}>
          <AgentIcon icon={agent.icon} className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold leading-8 text-foreground" title={agent.name}>{agent.name}</h1>
          {agent.title ? <p className="truncate text-sm leading-5 text-muted-foreground">{agent.title}</p> : null}
        </div>
        <AgentStatusBadge status={agent.status} />
        <Button variant="outline" size="icon" asChild>
          <Link to={`/chats/${agentRef}`} aria-label={`Chat with ${agent.name}`} title="Chat with this agent">
            <MessagesSquare className="size-4" />
          </Link>
        </Button>
      </header>
      <section className="flex flex-col gap-3" aria-label="Recent tasks">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-foreground">Recent tasks</h2>
          <Link to={`/issues?participantAgentId=${agent.id}`} className="text-xs text-muted-foreground no-underline transition-colors hover:text-foreground">
            See all tasks
          </Link>
        </div>
        {issues.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tasks.isLoading ? "Loading tasks…" : "No recent tasks."}</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <TaskSummaryList issues={issues.slice(0, 5)} />
          </div>
        )}
      </section>
    </div>
  );
}
