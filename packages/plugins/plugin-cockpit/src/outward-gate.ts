/**
 * Outward-issue gate: when an agent closes an outward issue, require evidence.
 *
 * An "outward" issue is one that involves external actions (launching, publishing,
 * submitting forms, sending to clients, etc.). When an agent marks such an issue done,
 * the gate checks for a 'shot' row in the issue_evidence table. If missing, the issue
 * reopens with instructions to capture evidence or post an exemption. Exemption comments
 * by the closing agent create a 'exempt' row and pass the gate.
 *
 * The gate is behind OUTWARD_GATE_ENABLED so the behavior can be toggled off.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { escalate, DONE_CHECK_MAX_REOPENS, wakeIssue } from "@partnersinbiz/pib-plugin-kit";
import type { Env } from "./env.js";
import { message } from "./env.js";
import { NAMESPACE } from "./namespace.js";

const T = `${NAMESPACE}.issue_evidence`;

/** Toggle to disable the gate entirely (one-line revert if needed). */
export const OUTWARD_GATE_ENABLED = true;

/**
 * Conservative patterns matching outward issue titles.
 * Must avoid false positives like "Pay run", "Send fix PR", "Launch checklist", "Submit sprint report".
 */
export const OUTWARD_TITLE_PATTERNS: RegExp[] = [
  // Publish variants
  /\bpublish/i,
  // Go live variants
  /\bgo\s+live\b|\bgoes\s+live\b/i,
  // Launch with object (site, campaign, ad, store, website)
  /\blaunch\s+(?:the\s+)?(site|campaign|ad|store|website)\b/i,
  // Submit variants (form, application, listing, filing)
  /\bsubmit\s+(?:the\s+)?(form|application|listing|filing)\b/i,
  // Pay the invoice
  /\bpay\s+(?:the\s+)?invoice\b/i,
  // Send variants (campaign, newsletter, email blast, invoice to client)
  /\bsend\s+(?:the\s+)?(campaign|newsletter|email\s+blast|invoice\s+to\s+client)\b/i,
];

/**
 * Determines if an issue is "outward" (involves external actions).
 * Checks the title against OUTWARD_TITLE_PATTERNS.
 *
 * Note: ctx.issues.get() does not expose a `labels` field on the issue object,
 * so this implementation matches on title only. If labels become available in
 * the future, add a check like: (issue.labels ?? []).includes('outward').
 */
export function isOutwardIssue(issue: { title: string; originId?: string | null }): boolean {
  // Exclude payroll and non-outward origins
  const originId = (issue as { originId?: string | null }).originId ?? null;
  if (originId && (originId.startsWith("payroll:") || originId.startsWith("pay-run:"))) {
    return false;
  }

  // Match title against outward patterns
  return OUTWARD_TITLE_PATTERNS.some((pattern) => pattern.test(issue.title));
}

/** Reopen counting marker for the outward gate (distinct from done-check). */
const attemptsKey = (companyId: string, issueId: string) => ({
  scopeKind: "company" as const,
  scopeId: companyId,
  namespace: "pib-outward-gate",
  stateKey: issueId,
});

/** Marker in the reopen comment so we count only outward-gate retries, not done-check ones. */
const REOPEN_MARKER = "[outward evidence]";

/**
 * Count prior outward-gate reopens for this issue (not done-check reopens).
 */
async function countPriorReopens(ctx: PluginContext, issueId: string, companyId: string): Promise<number> {
  const key = attemptsKey(companyId, issueId);
  const count = await ctx.state.get(key).catch(() => null);
  return Number(count ?? 0);
}

/**
 * Check for an exemption comment authored by the closing agent.
 * Returns { exempt: true, reason: string } if found and valid.
 */
async function findExemption(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
  closingAgentId: string | null,
): Promise<{ exempt: boolean; reason: string | null }> {
  if (!closingAgentId) return { exempt: false, reason: null };

  try {
    const comments = await ctx.issues.listComments(issueId, companyId);
    for (const comment of comments) {
      const commentAuthorAgentId = (comment as { authorAgentId?: string | null }).authorAgentId;
      const body = (comment as { body?: string }).body ?? "";

      // Only comments from the closing agent
      if (commentAuthorAgentId !== closingAgentId) continue;

      // Match "Evidence: not applicable, because <reason>"
      const match = /Evidence:\s*not\s+applicable,\s*because\s+(\S+.*\S*)/i.exec(body);
      if (match) {
        const reason = match[1].trim();
        return { exempt: true, reason };
      }
    }
  } catch (error) {
    ctx.logger.info("Outward gate: could not list comments", { issueId, error: message(error) });
  }

  return { exempt: false, reason: null };
}

/**
 * Check if a 'shot' evidence row exists for this issue.
 */
async function hasEvidenceShot(ctx: PluginContext, issueId: string, companyId: string): Promise<boolean> {
  try {
    const result = await ctx.db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM ${T} WHERE issue_id = $1 AND company_id = $2 AND kind = 'shot'`,
      [issueId, companyId],
    );
    const count = parseInt(result[0]?.count ?? "0", 10);
    return count > 0;
  } catch (error) {
    ctx.logger.info("Outward gate: could not check evidence", { issueId, error: message(error) });
    return false;
  }
}

/**
 * Record an exemption row in issue_evidence (idempotent).
 */
async function recordExemption(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
  reason: string,
): Promise<void> {
  const now = new Date().toISOString();
  try {
    // Check if an exempt row already exists for this issue
    const existing = await ctx.db.query<{ id: string }>(
      `SELECT id FROM ${T} WHERE company_id = $1 AND issue_id = $2 AND kind = 'exempt' LIMIT 1`,
      [companyId, issueId],
    );

    // If one already exists, don't insert another (idempotent)
    if (existing.length > 0) return;

    // Insert new exempt row
    await ctx.db.execute(
      `INSERT INTO ${T} (id, company_id, issue_id, step, kind, note, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        `evid${Math.random().toString(16).slice(2, 8)}`,
        companyId,
        issueId,
        "exempt",
        "exempt",
        reason,
        now,
      ],
    );
  } catch (error) {
    ctx.logger.info("Outward gate: could not record exemption", { issueId, error: message(error) });
  }
}

export type OutwardGateOutcome = "skipped" | "passed" | "exempted" | "reopened" | "escalated";

/**
 * Runs the outward-issue gate for one `issue.updated` event.
 * Returns the outcome: skipped, passed, exempted, reopened, or escalated.
 */
export async function runOutwardGate(env: Env, event: Pick<PluginEvent, "entityId" | "companyId" | "actorType">): Promise<OutwardGateOutcome> {
  // Skip if gate is disabled
  if (!OUTWARD_GATE_ENABLED) return "skipped";

  // Skip if not an agent close
  if (event.actorType !== "agent" || !event.entityId || !event.companyId) return "skipped";

  const companyId = event.companyId;
  const issueId = event.entityId;

  // Get the issue and skip if not in done status
  const raw = await env.ctx.issues.get(issueId, companyId).catch(() => null);
  if (!raw || raw.status !== "done") return "skipped";

  // Skip if not an outward issue
  if (!isOutwardIssue({ title: raw.title, originId: (raw as { originId?: string | null }).originId ?? null })) {
    return "skipped";
  }

  const closingAgentId = (raw as { assigneeAgentId?: string | null }).assigneeAgentId ?? null;

  // Check for exemption comment
  const exemptionCheck = await findExemption(env.ctx, issueId, companyId, closingAgentId);
  if (exemptionCheck.exempt && exemptionCheck.reason) {
    // Record exemption row (idempotent via ON CONFLICT)
    await recordExemption(env.ctx, issueId, companyId, exemptionCheck.reason);
    return "exempted";
  }

  // Check for evidence shot
  const hasShot = await hasEvidenceShot(env.ctx, issueId, companyId);
  if (hasShot) {
    return "passed";
  }

  // No evidence and no exemption: reopen or escalate
  const priorAttempts = await countPriorReopens(env.ctx, issueId, companyId);
  const attempts = priorAttempts + 1;
  await env.ctx.state.set(attemptsKey(companyId, issueId), attempts).catch(() => undefined);

  const reopenMessage = `**Evidence required** ${REOPEN_MARKER}: Please capture a screenshot of the completed action and run:

\`\`\`
pib-evidence <path/to/screenshot.png> --issue ${raw.identifier || issueId} --step submitted
\`\`\`

Then call the **evidence-record** tool to attach it, or post a comment \`Evidence: not applicable, because <reason>\` if evidence is not needed.`;

  if (attempts >= DONE_CHECK_MAX_REOPENS) {
    // Third failure: escalate instead of reopening
    const escalateResult = await escalate(env.ctx, issueId, "outward_issue_no_evidence", { companyId }).catch(() => null);

    if (escalateResult && "id" in escalateResult) {
      // Escalated successfully
      const unblockId = escalateResult.id;
      await env.ctx.issues.update(issueId, { status: "blocked" }, companyId).catch(() => undefined);

      let escalateMsg = `**Evidence required**, escalated after ${attempts} failed attempts.\n\nPlease provide evidence or request exemption.`;
      if (escalateResult.created) {
        escalateMsg += `\n\nEscalated to Unblock issue ${unblockId}.`;
      } else {
        escalateMsg += `\n\nAlready escalated; waiting for resolution.`;
      }

      await env.ctx.issues.createComment(issueId, escalateMsg, companyId).catch(() => undefined);
      return "escalated";
    } else {
      // Escalation failed or is disabled: reopen as fallback
      await env.ctx.issues.update(issueId, { status: "todo" }, companyId).catch(() => undefined);
      await env.ctx.issues.createComment(issueId, reopenMessage, companyId).catch(() => undefined);
      if (closingAgentId) await wakeIssue(env.ctx, issueId, companyId, "Outward gate: evidence required").catch(() => undefined);
      return "reopened";
    }
  }

  // First or second failure: reopen
  await env.ctx.issues.update(issueId, { status: "todo" }, companyId).catch(() => undefined);
  await env.ctx.issues.createComment(issueId, reopenMessage, companyId).catch(() => undefined);
  if (closingAgentId) await wakeIssue(env.ctx, issueId, companyId, "Outward gate: evidence required").catch(() => undefined);
  return "reopened";
}

/**
 * Returns a gate function bound to an env.
 * Call this once and reuse the result in the event handler.
 */
export function outwardGateFor(env: Env): (event: Parameters<typeof runOutwardGate>[1]) => Promise<OutwardGateOutcome> {
  return (event) => runOutwardGate(env, event);
}
