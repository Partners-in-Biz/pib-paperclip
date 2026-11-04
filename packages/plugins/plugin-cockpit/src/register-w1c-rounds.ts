/**
 * Review rounds cap (W1c F3): at the third `REVIEW: CHANGES NEEDED` by the Code Reviewer on an issue, comment
 * "round cap reached, handing to Planner" and mention the Planner (the mention wakes it). Once per issue.
 * No field edits on the issue: it is another agent's.
 */

import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { listCompanyAgents, type HireAgentSummary } from "@partnersinbiz/pib-plugin-kit";
import { message, type Env } from "./env.js";
import { countChangesRounds, isChangesNeeded, renderCapComment, shouldHandOver } from "./review-rounds-model.js";

const IN_FLIGHT = new Set<string>();

function hasTitle(agent: HireAgentSummary, role: string): boolean {
  const title = agent.title?.trim().toLowerCase() ?? "";
  return title === role || (title === "" && agent.name.trim().toLowerCase() === role);
}

export async function reviewRoundsCheck(env: Env, event: PluginEvent): Promise<void> {
  const companyId = event.companyId;
  const issueId = event.entityId;
  if (!companyId || !issueId) return;
  const key = `${companyId}:${issueId}`;
  if (IN_FLIGHT.has(key)) return;
  IN_FLIGHT.add(key);
  try {
    const stateKey = { scopeKind: "company" as const, scopeId: companyId, namespace: "cockpit", stateKey: `review-rounds-cap:${issueId}` };
    if (await env.ctx.state.get(stateKey)) return;
    const comments = await env.ctx.issues.listComments(issueId, companyId);
    // Cheap exit: only a change-request comment can move the count.
    if (!comments.some((c) => !c.deletedAt && typeof c.body === "string" && isChangesNeeded(c.body))) return;
    const agents = await listCompanyAgents(env.ctx, companyId);
    const reviewerIds = agents.filter((a) => hasTitle(a, "code reviewer")).map((a) => a.id);
    const rounds = countChangesRounds(
      comments.map((c) => ({ authorAgentId: c.authorAgentId ?? null, body: c.body ?? "", deletedAt: c.deletedAt ?? null })),
      reviewerIds,
    );
    if (!shouldHandOver(rounds, false)) return;
    const planner = agents.find((a) => hasTitle(a, "planner"));
    if (!planner) {
      env.ctx.logger.info("Review rounds: cap reached but no Planner found", { issueId, companyId });
      return;
    }
    // Marker first: a failed comment is retried by nobody, a double hand-over is worse than a missed one.
    await env.ctx.state.set(stateKey, { handedOver: true, rounds, at: env.now().toISOString() });
    await env.ctx.issues.createComment(issueId, renderCapComment({ id: planner.id, name: planner.name }), companyId);
  } catch (error) {
    env.ctx.logger.info("Review rounds: check failed", { issueId, error: message(error) });
  } finally {
    IN_FLIGHT.delete(key);
  }
}
