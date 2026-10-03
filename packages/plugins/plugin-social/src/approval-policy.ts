/**
 * Who approves a post (Q1a-2).
 *
 * Until 0.8.0 exactly one thing approved a post: a board user clicking Approve.
 * Nobody outside the company could, and an agent never could (nor can it now).
 * A policy per scope says which sign-offs a post needs before it can be
 * approved:
 *
 * - `reviewer`: the Reviewer agent passed THIS version (`record-review-verdict`).
 *   A pass is a check, never an approval.
 * - `owner`: a person on the team approves on the Social page (the default).
 * - `client`: the client approves on the tokenised approval page, or a person
 *   records that the client approved elsewhere (with a note).
 *
 * The post becomes approved when every required sign-off is in. Only a person
 * can set a policy (it delegates authority), and a scope with no row keeps the
 * owner-approves behaviour of 0.7.x. An agent can read a policy, never change it.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { formatClientParam, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { table } from "./db.js";
import { SocialError } from "./domain.js";
import { STAGES, type Stage, type StageState } from "./review-outcomes.js";

export interface ApprovalPolicy {
  /** `own`, `company:<id>` or `contact:<id>`. */
  scopeKey: string;
  requireReviewer: boolean;
  requireOwner: boolean;
  requireClient: boolean;
  /** How long a client link stays open. */
  linkExpiryDays: number;
  /** False for a scope nobody has set: the default (the owner approves). */
  custom: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

export const DEFAULT_LINK_DAYS = 14;
export const MAX_LINK_DAYS = 60;

export function scopeKeyOf(scope: ClientScope): string {
  return scope ? formatClientParam(scope) : "own";
}

export function defaultPolicy(scope: ClientScope): ApprovalPolicy {
  return { scopeKey: scopeKeyOf(scope), requireReviewer: false, requireOwner: true, requireClient: false, linkExpiryDays: DEFAULT_LINK_DAYS, custom: false, updatedBy: null, updatedAt: null };
}

export interface PolicyInput {
  requireReviewer?: unknown;
  requireOwner?: unknown;
  requireClient?: unknown;
  linkExpiryDays?: unknown;
}

function flag(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  throw new SocialError("Approval requirements must be true or false");
}

/**
 * The policy a person asked for, checked. Somebody has to approve (the owner,
 * the client, or both: a Reviewer pass alone is a check, not an approval), and
 * only a client scope can require the client. Pure.
 */
export function normalizePolicy(scope: ClientScope, input: PolicyInput, current: ApprovalPolicy = defaultPolicy(scope)): ApprovalPolicy {
  const requireReviewer = flag(input.requireReviewer, current.requireReviewer);
  const requireOwner = flag(input.requireOwner, current.requireOwner);
  const requireClient = flag(input.requireClient, current.requireClient);
  let days = current.linkExpiryDays;
  if (input.linkExpiryDays !== undefined && input.linkExpiryDays !== null && input.linkExpiryDays !== "") {
    const n = typeof input.linkExpiryDays === "number" ? input.linkExpiryDays : Number(input.linkExpiryDays);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LINK_DAYS) throw new SocialError(`The client link must stay open between 1 and ${MAX_LINK_DAYS} days`);
    days = n;
  }
  if (!requireOwner && !requireClient) {
    throw new SocialError("Someone has to approve: the owner, the client, or both. A Reviewer pass is a check, not an approval.");
  }
  if (requireClient && !scope) throw new SocialError("PiB's own work has no client to approve it. Turn the client off, or set this on a client.");
  return { ...current, requireReviewer, requireOwner, requireClient, linkExpiryDays: days, custom: true };
}

/** The sign-offs this policy needs, in order. */
export function requiredStages(policy: Pick<ApprovalPolicy, "requireReviewer" | "requireOwner" | "requireClient">): Stage[] {
  return STAGES.filter((stage) => (stage === "reviewer" ? policy.requireReviewer : stage === "owner" ? policy.requireOwner : policy.requireClient));
}

/** Required sign-offs that are not in yet for the current version. Pure. */
export function missingStages(policy: Pick<ApprovalPolicy, "requireReviewer" | "requireOwner" | "requireClient">, state: Record<Stage, StageState>): Stage[] {
  return requiredStages(policy).filter((stage) => state[stage] !== "approved");
}

const STAGE_WORDS: Record<Stage, string> = { reviewer: "the Reviewer's pass", owner: "a team member's approval", client: "the client's approval" };

/** "the Reviewer's pass and the client's approval". Pure. */
export function stageList(stages: Stage[]): string {
  const words = stages.map((stage) => STAGE_WORDS[stage]);
  if (words.length <= 1) return words[0] ?? "nothing";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** One line saying who approves in this scope, for the page and for issue text. Pure. */
export function policySummary(policy: ApprovalPolicy): string {
  const needs = requiredStages(policy);
  const approvers = needs.filter((stage) => stage !== "reviewer");
  const who = approvers.length === 2 ? "a team member and the client both approve" : approvers[0] === "client" ? "the client approves" : "a team member approves";
  return `${who}${policy.requireReviewer ? ", after the Reviewer passes it" : ""}${policy.custom ? "" : " (the default)"}`;
}

interface PolicyRow {
  scope_key: string;
  require_reviewer: boolean;
  require_owner: boolean;
  require_client: boolean;
  link_expiry_days: number | string;
  updated_by: string | null;
  updated_at: unknown;
}

function stampOf(value: unknown): string | null {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function fromRow(row: PolicyRow): ApprovalPolicy {
  return {
    scopeKey: row.scope_key,
    requireReviewer: row.require_reviewer === true,
    requireOwner: row.require_owner !== false,
    requireClient: row.require_client === true,
    linkExpiryDays: Number(row.link_expiry_days) || DEFAULT_LINK_DAYS,
    custom: true,
    updatedBy: row.updated_by,
    updatedAt: stampOf(row.updated_at),
  };
}

/** The scope's policy, or the default. Never throws: an unreadable table means the strictest old behaviour (the owner approves). */
export async function getPolicy(ctx: PluginContext, companyId: string, scope: ClientScope): Promise<ApprovalPolicy> {
  try {
    const rows = await ctx.db.query<PolicyRow>(
      `SELECT scope_key, require_reviewer, require_owner, require_client, link_expiry_days, updated_by, updated_at
         FROM ${table(ctx, "approval_policies")} WHERE company_id = $1 AND scope_key = $2 LIMIT 1`,
      [companyId, scopeKeyOf(scope)],
    );
    return rows[0] ? fromRow(rows[0]) : defaultPolicy(scope);
  } catch (error) {
    ctx.logger.info("Social approval policy unreadable; the owner approves", { companyId, error: error instanceof Error ? error.message : String(error) });
    return defaultPolicy(scope);
  }
}

/** Saves a policy. `by` is the person who set it (never an agent). */
export async function savePolicy(
  ctx: PluginContext,
  companyId: string,
  target: { scope: ClientScope; clientName: string | null },
  input: PolicyInput,
  by: string,
): Promise<ApprovalPolicy> {
  const current = await getPolicy(ctx, companyId, target.scope);
  const next = normalizePolicy(target.scope, input, current);
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "approval_policies")}
       (company_id, scope_key, client_kind, client_ref, client_name, require_reviewer, require_owner, require_client, link_expiry_days, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (company_id, scope_key) DO UPDATE SET client_name = EXCLUDED.client_name, require_reviewer = EXCLUDED.require_reviewer,
       require_owner = EXCLUDED.require_owner, require_client = EXCLUDED.require_client, link_expiry_days = EXCLUDED.link_expiry_days,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [
      companyId, next.scopeKey, target.scope?.kind ?? null, target.scope?.id ?? null, target.scope ? target.clientName : null,
      next.requireReviewer, next.requireOwner, next.requireClient, next.linkExpiryDays, by,
    ],
  );
  return { ...next, updatedBy: by, updatedAt: new Date().toISOString() };
}

/** What the page and `get-approval-policy` show. */
export function policyOut(policy: ApprovalPolicy) {
  return {
    scope: policy.scopeKey === "own" ? null : policy.scopeKey,
    requireReviewer: policy.requireReviewer,
    requireOwner: policy.requireOwner,
    requireClient: policy.requireClient,
    linkExpiryDays: policy.linkExpiryDays,
    custom: policy.custom,
    summary: policySummary(policy),
    updatedBy: policy.updatedBy,
    updatedAt: policy.updatedAt,
  };
}
