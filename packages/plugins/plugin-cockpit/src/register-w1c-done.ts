/**
 * Risk-tier close (W1c low-tier): auto-close LOW-tier in_review issues when Code Reviewer
 * and Dogfood Tester both give PASS verdicts, using the risk-tier model.
 */

import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { HireAgentSummary } from "@partnersinbiz/pib-plugin-kit";
import { listCompanyAgents } from "@partnersinbiz/pib-plugin-kit";
import { evaluateIssue, type VerdictComment } from "./risk-tier-model.js";
import { recordRepair } from "./repairs.js";
import { message, type Env } from "./env.js";

/**
 * Match agent by title (case-insensitive, trimmed; fall back to name when title is empty).
 * Returns true if the agent has the matching title or name.
 */
function matchAgentRole(agent: HireAgentSummary, targetRole: string): boolean {
  const titleToMatch = agent.title?.trim().toLowerCase() ?? "";
  const nameToMatch = agent.name.trim().toLowerCase();
  const target = targetRole.toLowerCase();
  return titleToMatch === target || (titleToMatch === "" && nameToMatch === target);
}

const IN_FLIGHT = new Set<string>();

/**
 * Handles close decision for LOW-tier in_review issues.
 * Idempotent: stores marker to prevent retries.
 */
async function handleDoneCheck(
  env: Env,
  { companyId, issueId }: { companyId: string; issueId: string }
): Promise<void> {
  // 1. Check config
  const config = await env.ctx.config.get(companyId);
  if ((config?.riskTierClose as Record<string, unknown> | undefined)?.enabled !== true) return;

  // 2. Get issue; skip if not in_review
  const issue = await env.ctx.issues.get(issueId, companyId);
  if (!issue || issue.status !== "in_review") return;

  // 3. Idempotency marker
  const markerKey = `riskTierClose:${issueId}`;
  if (await env.ctx.state.get({ scopeKind: "company", scopeId: companyId, namespace: "cockpit", stateKey: markerKey })) return;

  const marker = `${companyId}:${issueId}`;
  if (IN_FLIGHT.has(marker)) return;
  IN_FLIGHT.add(marker);

  try {
    // 4. Load agents by role
    const agents = await listCompanyAgents(env.ctx, companyId);
    const roleAgents = {
      planner: agents.filter((a) => matchAgentRole(a, "Planner")).map((a) => a.id),
      deliveryLead: agents.filter((a) => matchAgentRole(a, "Delivery Lead")).map((a) => a.id),
      codeReviewer: agents.filter((a) => matchAgentRole(a, "Code Reviewer")).map((a) => a.id),
      dogfoodTester: agents.filter((a) => matchAgentRole(a, "Dogfood Tester")).map((a) => a.id),
      reviewer: agents.filter((a) => matchAgentRole(a, "Reviewer")).map((a) => a.id),
    };

    // 5. Build verdict comments from issue comments with role author info
    const comments = await env.ctx.issues.listComments(issueId, companyId);
    const verdictComments: VerdictComment[] = comments.map((c) => ({
      authorAgentId: c.authorAgentId ?? null,
      body: c.body,
      createdAt: c.createdAt ?? new Date().toISOString(),
      deletedAt: null,
    }));

    // 6. Evaluate (statusChanges: empty array; actor-attributed status history not readable by plugin, only later comments void verdicts)
    const result = evaluateIssue({
      stored: undefined,
      description: issue.description ?? null,
      createdByAgentId: issue.createdByAgentId ?? null,
      assigneeAgentId: issue.assigneeAgentId ?? null,
      comments: verdictComments,
      statusChanges: [],
      roles: roleAgents,
    });

    // 7. Close ONLY if tier=low AND decision=close
    if (result.pin.tier !== "low" || result.decision !== "close") return;

    // 8. Update issue
    try {
      await env.ctx.issues.update(issueId, { status: "done" }, companyId);
    } catch (error) {
      env.ctx.logger.warn("Risk tier close: issue update refused", { issueId, companyId, error: message(error) });
      // Write a permanent marker to prevent retries on future events (logged once).
      await env.ctx.state.set(
        { scopeKind: "company", scopeId: companyId, namespace: "cockpit", stateKey: markerKey },
        { reason: "refused" }
      );
      return;
    }

    // 9. Post comment and record repair (evidence: only PASS comments from role agents)
    const roleAuthorIds = new Set([...roleAgents.codeReviewer, ...roleAgents.dogfoodTester, ...roleAgents.reviewer]);
    const verdictIds = comments
      .filter((_, i) => roleAuthorIds.has(verdictComments[i].authorAgentId ?? "") && /(REVIEW|DOGFOOD):\s*PASS\b/.test(verdictComments[i].body))
      .map((c) => c.id);

    try {
      await env.ctx.issues.createComment(issueId, `Closed by Cockpit: tier low, evidence ${verdictIds.join(", ")}`, companyId);
    } catch (error) {
      env.ctx.logger.info("Risk tier close: comment post failed", { issueId, companyId, error: message(error) });
    }

    try {
      await recordRepair(env.ctx, companyId, {
        kind: "risk_tier_close",
        targetKind: "issue",
        targetId: issueId,
        action: "close_low_tier",
        outcome: "closed",
        detail: verdictIds.join(", "),
        actor: "system:cockpit",
      });
    } catch (error) {
      env.ctx.logger.info("Risk tier close: repair record failed", { issueId, companyId, error: message(error) });
    }

    await env.ctx.state.set(
      { scopeKind: "company", scopeId: companyId, namespace: "cockpit", stateKey: markerKey },
      { closed: true }
    );
  } finally {
    IN_FLIGHT.delete(marker);
  }
}

/**
 * Hook called from issue.comment.created and issue.updated handlers.
 * Exceptions are caught and logged; handles idempotency internally.
 */
export async function riskTierCloseCheck(env: Env, event: PluginEvent): Promise<void> {
  if (!event.companyId || !event.entityId) return;
  try {
    await handleDoneCheck(env, { companyId: event.companyId, issueId: event.entityId });
  } catch (error) {
    env.ctx.logger.info("Risk tier close check error", { issueId: event.entityId, error: message(error) });
  }
}
