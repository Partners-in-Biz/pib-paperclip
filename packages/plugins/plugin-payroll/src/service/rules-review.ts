/**
 * The accountant's check of the rules a rule version flags as unconfirmed
 * (`RuleVersion.unverified`). A board member records who checked them and
 * when (board action `payroll.review-rules`); the Payroll page shows
 * "Checked by <name> on <date>", and the page banner, the setup checklist
 * and the Cockpit stop asking. A new rule version (or changed rules) needs a
 * new check. Reviews saved before the name was recorded still count.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import * as db from "../db.js";
import type { Actor } from "../domain.js";
import { PayrollError } from "../money.js";
import { ruleVersionFor, type RuleVersion } from "../rules.js";
import { requireUser, today, type Env } from "./env.js";

const RULES_REVIEW_STATE = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "payroll-setup", stateKey: "rules-review" });

/** Stored in plugin state. Older reviews have no `accountantName` or `checkedOn`. */
export interface RulesReview {
  ruleVersionId: string;
  contentHash: string;
  paths: string[];
  /** When the check was recorded (ISO timestamp). */
  at: string;
  accountantName?: string | null;
  /** The day the accountant checked the rules (YYYY-MM-DD). */
  checkedOn?: string | null;
}

/** What the page shows ("Checked by <name> on <date>"); `accountantName` is null for older reviews. */
export interface RulesReviewView {
  accountantName: string | null;
  checkedOn: string;
  at: string;
}

export interface RulesReviewState {
  /** True when nothing is left to check (no unconfirmed rules, or a check covers them). */
  reviewed: boolean;
  /** The check that covers today's rule version, if any. */
  review: RulesReviewView | null;
}

/** Whether `review` covers every unconfirmed rule of `version` (same version, same rules). */
export function reviewCovers(review: RulesReview | null, version: RuleVersion): boolean {
  if (!review || review.ruleVersionId !== version.id || review.contentHash !== version.contentHash) return false;
  const reviewed = new Set(review.paths);
  return version.unverified.every((u) => reviewed.has(u.path));
}

export function rulesReviewView(review: RulesReview | null): RulesReviewView | null {
  if (!review) return null;
  const name = typeof review.accountantName === "string" && review.accountantName.trim() ? review.accountantName.trim() : null;
  const checkedOn = typeof review.checkedOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(review.checkedOn) ? review.checkedOn : String(review.at ?? "").slice(0, 10);
  return { accountantName: name, checkedOn, at: review.at };
}

export async function readRulesReview(ctx: PluginContext, companyId: string): Promise<RulesReview | null> {
  const value = (await ctx.state.get(RULES_REVIEW_STATE(companyId))) as RulesReview | null;
  return value && typeof value === "object" && typeof value.ruleVersionId === "string" ? value : null;
}

/** The check state for the rule version in force today. Never throws (a failure reads as "not checked"). */
export async function rulesReviewState(e: Env, companyId: string): Promise<RulesReviewState> {
  try {
    const version = ruleVersionFor(await db.listRuleVersions(e.ctx), today(e));
    if (!version || !version.unverified.length) return { reviewed: true, review: null };
    const stored = await readRulesReview(e.ctx, companyId);
    return reviewCovers(stored, version) ? { reviewed: true, review: rulesReviewView(stored) } : { reviewed: false, review: null };
  } catch {
    return { reviewed: false, review: null };
  }
}

/** Whether the unconfirmed rules of the rule version in force today were checked. */
export async function rulesReviewed(e: Env, companyId: string): Promise<boolean> {
  return (await rulesReviewState(e, companyId)).reviewed;
}

function accountantNameFrom(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (text.length < 2) throw new PayrollError("Enter the name of the accountant who checked the rules.");
  if (text.length > 120) throw new PayrollError("The accountant's name is too long (120 characters at most).");
  return text;
}

function checkedOnFrom(value: unknown, todayIso: string): string {
  if (value == null || value === "") return todayIso;
  const text = typeof value === "string" ? value.trim() : "";
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) && new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text;
  if (!valid) throw new PayrollError("Pick the date your accountant checked the rules.");
  if (text > todayIso) throw new PayrollError("The date your accountant checked the rules cannot be in the future.");
  return text;
}

/**
 * Board action `payroll.review-rules`: records that an accountant checked the
 * unconfirmed rules. `accountantName` is required; `checkedOn` (YYYY-MM-DD)
 * defaults to today and cannot be in the future.
 */
export async function markRulesReviewed(e: Env, companyId: string, actor: Actor, params: Record<string, unknown> = {}) {
  const user = requireUser(actor);
  const date = today(e);
  const accountantName = accountantNameFrom(params.accountantName);
  const checkedOn = checkedOnFrom(params.checkedOn, date);
  const version = ruleVersionFor(await db.listRuleVersions(e.ctx), date);
  if (!version) return { reviewed: false, unverified: 0, review: null };
  const review: RulesReview = {
    ruleVersionId: version.id,
    contentHash: version.contentHash,
    paths: version.unverified.map((u) => u.path),
    at: e.now().toISOString(),
    accountantName,
    checkedOn,
  };
  await e.ctx.state.set(RULES_REVIEW_STATE(companyId), review);
  await db.audit(e.ctx, companyId, { userId: user.userId, agentId: null }, "rules.reviewed", "rule_version", version.id, { paths: review.paths, accountantName, checkedOn });
  return { reviewed: true, unverified: version.unverified.length, review: rulesReviewView(review) };
}
