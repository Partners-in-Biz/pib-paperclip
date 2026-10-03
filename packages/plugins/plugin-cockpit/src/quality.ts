/**
 * The two honesty checks, worker part (Q5-4, Q5-6, Q5-7). The rules are in
 * `quality-model.ts`; this reads what they need: done code issues with the
 * coverage count's own review test, and open outward approvals with their
 * comments. Both read through the SDK (issue comments), so they add no table to
 * the plugin's read list.
 */
import { isApprovalIssue, roleAgentUsable, type HealthCheck } from "@partnersinbiz/pib-plugin-kit";
import { getRoles } from "./db.js";
import { message, type Env } from "./env.js";
import { readReviewRows } from "./measure.js";
import { splitAuthorsReviewers } from "./measure-model.js";
import {
  APPROVAL_READ_LIMIT,
  approvalCandidates,
  hasEvidence,
  PROOF_WINDOW_DAYS,
  proofCandidates,
  proofCheck,
  unreviewedApprovalsCheck,
  type ApprovalLike,
  type ProofGap,
  type UnreviewedApproval,
} from "./quality-model.js";
import { agentStatus } from "./roles.js";

type Raw = Record<string, unknown>;

/** Finished code work with no review (by the coverage count's rule) and no comment showing evidence. */
export async function proofGapCheck(env: Env, companyId: string): Promise<HealthCheck | null> {
  const now = env.now();
  const agents = (await env.ctx.agents.list({ companyId, limit: 200 })) as unknown as Raw[];
  const roles = await getRoles(env.ctx, companyId).catch(() => null);
  const { authors, reviewers } = splitAuthorsReviewers(
    agents.filter((a) => !["terminated", "archived", "deleted"].includes(String(a.status ?? ""))).map((a) => ({ id: String(a.id), name: String(a.name ?? ""), title: typeof a.title === "string" ? a.title : null, role: typeof a.role === "string" ? a.role : null })),
    [roles?.reviewerAgentId],
  );
  const since = new Date(now.getTime() - PROOF_WINDOW_DAYS * 86_400_000).toISOString();
  const rows = await readReviewRows(env.ctx, companyId, since, authors, reviewers, 300);
  const candidates = proofCandidates(rows.map((r) => ({ id: r.id, identifier: r.identifier, completedAt: r.completedAt, reviewed: r.policyApproved || !!r.reviewIssueId })), now);
  const gaps: ProofGap[] = [];
  for (const c of candidates) {
    // A comment list that cannot be read says nothing about the issue: it is not flagged.
    const comments = await env.ctx.issues.listComments(c.id, companyId).catch((error) => {
      env.ctx.logger.info("Proof check: comments unreadable", { companyId, issueId: c.id, error: message(error) });
      return null;
    });
    if (comments && !hasEvidence(comments as unknown as Array<{ body?: string | null }>)) gaps.push({ id: c.id, identifier: c.identifier, completedAt: c.completedAt });
  }
  return proofCheck(gaps, rows.length);
}

const OPEN = ["todo", "in_review", "backlog", "blocked"] as const;

/** Outward approvals a person holds that the Reviewer never commented on, while the company reviews outward work and the Reviewer can work. */
export async function unreviewedApprovalCheck(env: Env, companyId: string): Promise<HealthCheck | null> {
  const roles = await getRoles(env.ctx, companyId).catch(() => null);
  if (!roles?.reviewOutward || !roles.reviewerAgentId) return null;
  // A paused, failing or removed Reviewer is skipped on purpose (approvals go straight to the person): nothing to flag.
  if (!roleAgentUsable(await agentStatus(env, companyId, roles.reviewerAgentId))) return null;
  const now = env.now();
  const issues: ApprovalLike[] = [];
  for (const status of OPEN) {
    const found = (await env.ctx.issues.list({ companyId, originKindPrefix: "plugin:", status, limit: 200 })) as unknown as Array<Record<string, unknown>>;
    for (const i of found) {
      const like: ApprovalLike = { id: String(i.id), identifier: typeof i.identifier === "string" ? i.identifier : null, title: String(i.title ?? ""), description: typeof i.description === "string" ? i.description : null, originKind: typeof i.originKind === "string" ? i.originKind : null, createdAt: i.createdAt instanceof Date ? i.createdAt.toISOString() : typeof i.createdAt === "string" ? i.createdAt : null, status };
      if (isApprovalIssue({ title: like.title, originKind: like.originKind, originId: typeof i.originId === "string" ? i.originId : null })) issues.push(like);
    }
  }
  const unreviewed: UnreviewedApproval[] = [];
  for (const issue of approvalCandidates(issues, now).slice(0, APPROVAL_READ_LIMIT)) {
    const comments = await env.ctx.issues.listComments(issue.id, companyId).catch(() => null);
    if (!comments) continue;
    const seen = (comments as unknown as Array<{ authorAgentId?: string | null }>).some((c) => c.authorAgentId === roles.reviewerAgentId);
    if (!seen) unreviewed.push({ id: issue.id, identifier: issue.identifier ?? null, title: issue.title, createdAt: issue.createdAt ?? null });
  }
  return unreviewedApprovalsCheck(unreviewed);
}
