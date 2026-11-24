import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { planningCanvasesApi } from "@/api/planningCanvases";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";

/** Agents that can open a personal board through a grant (Q6, Q14). Owner or admin lists and revokes; nothing here writes a grant. */
export function AgentGrantsList({
  companyId,
  boardId,
  agentNames,
  onError,
}: {
  companyId: string;
  boardId: string;
  agentNames: Map<string, string>;
  onError: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const key = queryKeys.planningCanvases.grants(companyId, boardId);
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => planningCanvasesApi.agentGrants(companyId, boardId) });
  const revoke = useMutation({
    mutationFn: (grantId: string) => planningCanvasesApi.revokeAgentGrant(companyId, boardId, grantId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
    onError: (e) => onError(e instanceof Error ? e.message : "Could not revoke the grant."),
  });
  const live = (data?.grants ?? []).filter((grant) => !grant.revokedAt);

  return (
    <section aria-label="Agent access" className="flex flex-col gap-1.5" data-testid="planning-canvas-agent-grants">
      <h3 className="text-xs font-semibold text-foreground">Agents with access</h3>
      {isLoading ? <p className="text-xs text-muted-foreground">Loading…</p> : null}
      {error ? <p role="alert" className="text-xs text-destructive">Could not load agent access.</p> : null}
      {data && !data.enabled ? <p className="text-xs text-muted-foreground">Agent grants are switched off for this instance.</p> : null}
      {data && live.length === 0 ? <p className="text-xs text-muted-foreground">No agent has been given access to this board.</p> : null}
      <ul className="flex flex-col gap-1">
        {live.map((grant) => (
          <li key={grant.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5">
            <span className="min-w-0 truncate text-xs text-foreground">
              {agentNames.get(grant.agentId) ?? "Unknown agent"}
              <span className="ml-1.5 text-muted-foreground">via {grant.source}</span>
            </span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={revoke.isPending}
              aria-label={`Revoke access for ${agentNames.get(grant.agentId) ?? "agent"}`}
              onClick={() => revoke.mutate(grant.id)}
            >
              Revoke
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
