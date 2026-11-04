/**
 * Reviewer findings (W1c H1): the Code Reviewer records each finding once (keyed by hash), the author side
 * of the work or the owner sets its outcome. The noise share is not a tool: the Reflection Coach computes it
 * from the table, e.g. `avg((outcome IN ('wrong','did_not_matter'))::int) FILTER (WHERE outcome IS NOT NULL)`.
 */
import { createHash, randomUUID } from "node:crypto";
import type { ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { listCompanyAgents, toolFail, toolOk } from "@partnersinbiz/pib-plugin-kit";
import { message, type Env } from "./env.js";
import { NAMESPACE } from "./namespace.js";
import { FINDING_OUTCOMES, REVIEW_FINDING_TOOL_NAMES, type FindingOutcome } from "./review-finding-declarations.js";
import { currentRoles } from "./roles.js";

export { REVIEW_FINDING_TOOL_SET } from "./review-finding-declarations.js";

const TABLE = `${NAMESPACE}.review_findings`;
const COLUMNS =
  "id, company_id, finding_hash, issue_id, issue_identifier, reviewer_agent_id, author_agent_id, outcome, seen_count";

export class FindingError extends Error {}

export interface FindingRow {
  id: string;
  companyId: string;
  hash: string;
  issueId: string;
  issueIdentifier: string | null;
  reviewerAgentId: string;
  authorAgentId: string;
  outcome: FindingOutcome | null;
  seenCount: number;
}

function rowFrom(r: Record<string, unknown>): FindingRow {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    hash: String(r.finding_hash),
    issueId: String(r.issue_id),
    issueIdentifier: (r.issue_identifier as string | null) ?? null,
    reviewerAgentId: String(r.reviewer_agent_id),
    authorAgentId: String(r.author_agent_id),
    outcome: (r.outcome as FindingOutcome | null) ?? null,
    seenCount: Number(r.seen_count),
  };
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** Stable key: same issue, same file and the same words (case and spacing ignored) are one finding. */
export function findingHash(issueId: string, filePath: string | null, summary: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(`${issueId}\n${norm(filePath ?? "")}\n${norm(summary)}`).digest("hex");
}

async function findingBy(env: Env, companyId: string, key: { id?: string | null; hash?: string | null }): Promise<FindingRow | null> {
  const rows = key.id
    ? await env.ctx.db.query<Record<string, unknown>>(`SELECT ${COLUMNS} FROM ${TABLE} WHERE company_id = $1 AND id = $2 LIMIT 1`, [companyId, key.id])
    : await env.ctx.db.query<Record<string, unknown>>(`SELECT ${COLUMNS} FROM ${TABLE} WHERE company_id = $1 AND finding_hash = $2 LIMIT 1`, [companyId, key.hash ?? ""]);
  return rows[0] ? rowFrom(rows[0]) : null;
}

export interface RecordResult {
  status: "recorded" | "seen_again";
  finding: FindingRow;
}

export async function recordFinding(env: Env, companyId: string, reviewerAgentId: string | null, p: Record<string, unknown>): Promise<RecordResult> {
  if (!reviewerAgentId) throw new FindingError("Only an agent can record a review finding.");
  const issueRef = text(p.issueId, 120);
  const summary = text(p.summary, 600);
  if (!issueRef) throw new FindingError("Pass issueId: the reviewed issue (an id or an identifier such as PAR-12).");
  if (!summary) throw new FindingError("Pass summary: the finding in one or two sentences.");
  const issue = await env.ctx.issues.get(issueRef, companyId).catch(() => null);
  if (!issue) throw new FindingError(`Issue ${issueRef} was not found in this company.`);
  const agents = await listCompanyAgents(env.ctx, companyId);
  const author = text(p.authorAgentId, 80) ?? issue.assigneeAgentId ?? null;
  if (!author) throw new FindingError(`${issue.identifier ?? issue.id} has no agent assignee: pass authorAgentId, the agent whose work this is.`);
  if (author === reviewerAgentId) throw new FindingError("The author can not be you, the reviewer: pass authorAgentId, the agent whose work you reviewed.");
  if (!agents.some((a) => a.id === author)) throw new FindingError(`Agent ${author} is not an agent of this company.`);
  const filePath = text(p.filePath, 240);
  const hash = (text(p.hash, 128) ?? findingHash(issue.id, filePath, summary)).toLowerCase();
  const now = env.now().toISOString();
  // One statement: a repeat of the same hash in this company only counts as seen again (the unique index decides,
  // so two reviewers recording at once still give one row). Author and reviewer stay as first recorded.
  await env.ctx.db.execute(
    `INSERT INTO ${TABLE} (id, company_id, finding_hash, issue_id, issue_identifier, pr_ref, reviewer_agent_id, author_agent_id, tag, file_path, summary, created_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
     ON CONFLICT (company_id, finding_hash) DO UPDATE SET seen_count = review_findings.seen_count + 1, last_seen_at = EXCLUDED.last_seen_at`,
    [randomUUID(), companyId, hash, issue.id, issue.identifier ?? null, text(p.prRef, 200), reviewerAgentId, author, text(p.tag, 40), filePath, summary, now],
  );
  const finding = await findingBy(env, companyId, { hash });
  if (!finding) throw new FindingError("The finding was not saved; try again.");
  return { status: finding.seenCount > 1 ? "seen_again" : "recorded", finding };
}

export interface OutcomeActor {
  agentId?: string | null;
  userId?: string | null;
}

/** Only the finding's author-side agent or the company owner sets the outcome; never the reviewer. */
export async function setFindingOutcome(env: Env, companyId: string, actor: OutcomeActor, p: Record<string, unknown>): Promise<FindingRow> {
  const outcome = text(p.outcome, 40);
  if (!outcome || !(FINDING_OUTCOMES as readonly string[]).includes(outcome)) throw new FindingError(`Pass outcome: one of ${FINDING_OUTCOMES.join(", ")}.`);
  const id = text(p.findingId, 80);
  const hash = text(p.hash, 128)?.toLowerCase() ?? null;
  if (!id && !hash) throw new FindingError("Pass findingId (or hash) of the finding.");
  const finding = await findingBy(env, companyId, { id, hash });
  if (!finding) throw new FindingError("That finding was not found in this company.");
  const agentId = actor.agentId ?? null;
  const userId = actor.userId ?? null;
  let allowed = false;
  if (agentId) {
    if (agentId === finding.reviewerAgentId) throw new FindingError("The reviewer can not set the outcome of their own finding: the author of the work does.");
    allowed = agentId === finding.authorAgentId;
  } else if (userId) {
    allowed = (await currentRoles(env, companyId))?.ownerUserId === userId;
  }
  if (!allowed) throw new FindingError("Only the author of the reviewed work or the owner can set this finding's outcome.");
  // author_agent_id never changes after the insert, so the check above can not go stale before this write.
  await env.ctx.db.execute(
    `UPDATE ${TABLE} SET outcome = $3, outcome_note = $4, outcome_by_agent_id = $5, outcome_by_user_id = $6, outcome_at = $7 WHERE company_id = $1 AND id = $2`,
    [companyId, finding.id, outcome, text(p.note, 600), agentId, agentId ? null : userId, env.now().toISOString()],
  );
  return { ...finding, outcome: outcome as FindingOutcome };
}

function params(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function runReviewFindingTool(env: Env, name: string, raw: unknown, run: ToolRunContext): Promise<ToolResult> {
  const p = params(raw);
  try {
    if (name === REVIEW_FINDING_TOOL_NAMES.record) {
      const { status, finding } = await recordFinding(env, run.companyId, run.agentId ?? null, p);
      const where = finding.issueIdentifier ?? finding.issueId;
      const content = status === "recorded" ? `Recorded the finding on ${where}.` : `Already recorded on ${where}; counted as seen again (${finding.seenCount} times).`;
      return toolOk(content, { status, findingId: finding.id, hash: finding.hash, seenCount: finding.seenCount, authorAgentId: finding.authorAgentId }) as ToolResult;
    }
    if (name === REVIEW_FINDING_TOOL_NAMES.outcome) {
      const finding = await setFindingOutcome(env, run.companyId, { agentId: run.agentId ?? null }, p);
      return toolOk(`Set the finding's outcome to ${finding.outcome}.`, { findingId: finding.id, outcome: finding.outcome }) as ToolResult;
    }
    return toolFail(`Unknown tool ${name}`) as ToolResult;
  } catch (error) {
    if (error instanceof FindingError) return toolFail(error.message) as ToolResult;
    env.ctx.logger.info("Cockpit review findings tool failed", { name, error: message(error) });
    return toolFail(`${name} failed: ${message(error)}`) as ToolResult;
  }
}
