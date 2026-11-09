/**
 * Who may wake (invoke) an agent when the caller is itself an agent.
 *
 * - An agent may always wake itself.
 * - A manager may wake any agent below it in the reporting chain
 *   (the target's chain of command contains the caller).
 * - An agent that holds `agents:configure` for the target may wake it
 *   (the same authority that already lets it resume that agent).
 *
 * Cross-company wakes are never allowed.
 */
export type AgentWakeAuthorityReason =
  | "self"
  | "manager_chain"
  | "configure_grant"
  | "deny_company_boundary"
  | "deny_not_manager";

export interface AgentWakeAuthorityInput {
  actorAgentId: string | null | undefined;
  actorCompanyId: string | null | undefined;
  target: { id: string; companyId: string };
  getChainOfCommand: (agentId: string) => Promise<Array<{ id: string }>>;
  canConfigureTarget: () => Promise<boolean>;
}

export async function decideAgentWakeAuthority(
  input: AgentWakeAuthorityInput,
): Promise<{ allowed: boolean; reason: AgentWakeAuthorityReason }> {
  const { actorAgentId, actorCompanyId, target } = input;
  if (actorAgentId && actorAgentId === target.id) return { allowed: true, reason: "self" };
  if (!actorAgentId || !actorCompanyId || actorCompanyId !== target.companyId) {
    return { allowed: false, reason: "deny_company_boundary" };
  }
  const chain = await input.getChainOfCommand(target.id);
  if (chain.some((manager) => manager.id === actorAgentId)) {
    return { allowed: true, reason: "manager_chain" };
  }
  if (await input.canConfigureTarget()) return { allowed: true, reason: "configure_grant" };
  return { allowed: false, reason: "deny_not_manager" };
}

export const AGENT_WAKE_DENIED_MESSAGE =
  "An agent can wake only itself, agents that report to it, or agents it may configure (agents:configure)";
