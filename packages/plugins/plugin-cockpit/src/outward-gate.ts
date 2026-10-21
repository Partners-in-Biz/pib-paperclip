/**
 * Outward-issue gate: when an agent closes an outward issue, require evidence.
 * An "outward" issue involves external actions (launching, publishing, submitting,
 * sending to clients, etc.). The gate requires a 'shot' evidence row or exemption.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { escalate, DONE_CHECK_MAX_REOPENS, wakeIssue } from "@partnersinbiz/pib-plugin-kit";
import type { Env } from "./env.js";
import { message } from "./env.js";
import { NAMESPACE } from "./namespace.js";

const T = `${NAMESPACE}.issue_evidence`;
export const OUTWARD_GATE_ENABLED = true;

export const OUTWARD_TITLE_PATTERNS: RegExp[] = [
  /\bpublish/i,
  /\bgo\s+live\b|\bgoes\s+live\b/i,
  /\blaunch\s+(?:the\s+)?(site|campaign|ad|store|website)\b/i,
  /\bsubmit\s+(?:the\s+)?(form|application|listing|filing)\b/i,
  /\bpay\s+(?:the\s+)?invoice\b/i,
  /\bsend\s+(?:the\s+)?(campaign|newsletter|email\s+blast|invoice\s+to\s+client)\b/i,
];

export function isOutwardIssue(issue: { title: string; originId?: string | null }): boolean {
  const originId = (issue as { originId?: string | null }).originId ?? null;
  if (originId && (originId.startsWith("payroll:") || originId.startsWith("pay-run:"))) {
    return false;
  }
  return OUTWARD_TITLE_PATTERNS.some((pattern) => pattern.test(issue.title));
}

const attemptsKey = (companyId: string, issueId: string) => ({
  scopeKind: "company" as const,
  scopeId: companyId,
  namespace: "pib-outward-gate",
  stateKey: issueId,
});

const REOPEN_MARKER = "[outward evidence]";

async function countPriorReopens(ctx: PluginContext, issueId: string, companyId: string): Promise<number> {
  const count = await ctx.state.get(attemptsKey(companyId, issueId)).catch(() => null);
  return Number(count ?? 0);
}

async function findExemption(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
  closingAgentId: string | null,
): Promise<{ exempt: boolean; reason: string | null }> {
  if (!closingAgentId) return { exempt: false, reason: null };

  const comments = await ctx.issues.listComments(issueId, companyId);
  for (const comment of comments) {
    if ((comment as { authorAgentId?: string | null }).authorAgentId !== closingAgentId) continue;
    const body = (comment as { body?: string }).body ?? "";
    const match = /Evidence:\s*not\s+applicable,\s*because\s+(\S+.*\S*)/i.exec(body);
    if (match) {
      return { exempt: true, reason: match[1].trim() };
    }
  }
  return { exempt: false, reason: null };
}

async function hasEvidenceShot(ctx: PluginContext, issueId: string, companyId: string): Promise<boolean> {
  const result = await ctx.db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM ${T} WHERE issue_id = $1 AND company_id = $2 AND kind = 'shot'`,
    [issueId, companyId],
  );
  return parseInt(result[0]?.count ?? "0", 10) > 0;
}

async function recordExemption(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
  reason: string,
): Promise<void> {
  const now = new Date().toISOString();
  await ctx.db.execute(
    `INSERT INTO ${T} (id, company_id, issue_id, step, kind, note, created_at)
     SELECT $1, $2, $3, $4, $5, $6, $7
     WHERE NOT EXISTS (SELECT 1 FROM ${T} WHERE company_id = $2 AND issue_id = $3 AND kind = 'exempt')`,
    [randomUUID(), companyId, issueId, "exempt", "exempt", reason, now],
  );
}

async function reopenIssue(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
  closingAgentId: string | null,
  raw: { identifier: string | null; id: string },
  marker: string,
): Promise<void> {
  const msg = `**Evidence required** ${marker}: Please capture a screenshot of the completed action and run:

\`\`\`
pib-evidence <path/to/screenshot.png> --issue ${raw.identifier ?? raw.id} --step submitted
\`\`\`

Then call the **evidence-record** tool to attach it, or post a comment \`Evidence: not applicable, because <reason>\` if evidence is not needed.`;

  await ctx.issues.update(issueId, { status: "todo" }, companyId).catch(() => undefined);
  await ctx.issues.createComment(issueId, msg, companyId).catch(() => undefined);
  if (closingAgentId) {
    await wakeIssue(ctx, issueId, companyId, "Outward gate: evidence required").catch(() => undefined);
  }
}

export type OutwardGateOutcome = "skipped" | "passed" | "exempted" | "reopened" | "escalated";

export async function runOutwardGate(
  env: Env,
  event: Pick<PluginEvent, "entityId" | "companyId" | "actorType" | "actorId">,
): Promise<OutwardGateOutcome> {
  if (!OUTWARD_GATE_ENABLED) return "skipped";
  if (event.actorType !== "agent" || !event.entityId || !event.companyId || !event.actorId) return "skipped";

  const companyId = event.companyId;
  const issueId = event.entityId;
  const closingAgentId = event.actorId;

  const raw = await env.ctx.issues.get(issueId, companyId).catch(() => null);
  if (!raw || raw.status !== "done") return "skipped";

  if (!isOutwardIssue({ title: raw.title, originId: (raw as { originId?: string | null }).originId ?? null })) {
    return "skipped";
  }

  const exemptionCheck = await findExemption(env.ctx, issueId, companyId, closingAgentId);
  if (exemptionCheck.exempt && exemptionCheck.reason) {
    await recordExemption(env.ctx, issueId, companyId, exemptionCheck.reason);
    await env.ctx.state.set(attemptsKey(companyId, issueId), 0).catch(() => undefined);
    return "exempted";
  }

  const hasShot = await hasEvidenceShot(env.ctx, issueId, companyId);
  if (hasShot) {
    await env.ctx.state.set(attemptsKey(companyId, issueId), 0).catch(() => undefined);
    return "passed";
  }

  const priorAttempts = await countPriorReopens(env.ctx, issueId, companyId);
  const attempts = priorAttempts + 1;
  await env.ctx.state.set(attemptsKey(companyId, issueId), attempts).catch(() => undefined);

  if (attempts >= DONE_CHECK_MAX_REOPENS) {
    const escalateResult = await escalate(env.ctx, issueId, "outward_issue_no_evidence", { companyId }).catch(() => null);
    if (escalateResult && "id" in escalateResult) {
      const unblockId = escalateResult.id;
      await env.ctx.issues.update(issueId, { status: "blocked" }, companyId).catch(() => undefined);
      let msg = `**Evidence required**, escalated after ${attempts} failed attempts.\n\nPlease provide evidence or request exemption.`;
      if (escalateResult.created) msg += `\n\nEscalated to Unblock issue ${unblockId}.`;
      else msg += `\n\nAlready escalated; waiting for resolution.`;
      await env.ctx.issues.createComment(issueId, msg, companyId).catch(() => undefined);
      return "escalated";
    }
  }

  await reopenIssue(env.ctx, issueId, companyId, closingAgentId, raw, REOPEN_MARKER);
  return "reopened";
}

export function outwardGateFor(env: Env): (event: Parameters<typeof runOutwardGate>[1]) => Promise<OutwardGateOutcome> {
  return (event) => runOutwardGate(env, event);
}
