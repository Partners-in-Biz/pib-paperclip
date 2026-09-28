/**
 * Shared service helpers: who is acting, settings, private R2, issues and a
 * per-company lock so postings from events, jobs and the page never race
 * each other inside the worker.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { companyRoles, createWorkIssue, formatMoneyMinor, presignUrl, readConfig, reopenApprovalForPerson, SecretResolver } from "@partnersinbiz/pib-plugin-kit";
import { parseVatCategory, parseYearEndMonth, type VatCategory } from "../domain/periods.js";
import { AccountingError } from "../domain/util.js";
import { PLUGIN_ID } from "../namespace.js";

export const ORIGIN = `plugin:${PLUGIN_ID}` as const;
export const BOOK_CURRENCY = "ZAR";

/**
 * Origin ids of the work Accounting hands to agents, one prefix per kind
 * (the done-checks match on them). Approval issues for people keep
 * `draft:`, `reconciliation:` and `vat:` ids.
 * - statement: `accounting:statement:<Mailbox message id>` ("Bank statement received")
 * - reconcile: `accounting:reconcile:<statement id>` ("Reconcile N new bank lines")
 * - close: `accounting:close:<YYYY-MM>` ("Month-end close")
 * - rejections: `accounting:rejections` ("Accounting: postings were rejected", one open at a time)
 */
export const WORK_ORIGINS = {
  statement: "accounting:statement:",
  reconcile: "accounting:reconcile:",
  close: "accounting:close:",
  rejections: "accounting:rejections",
} as const;

/** Money in issue text and messages, the way every PiB page shows it: `R 12,345.67`. */
export function money(minor: number): string {
  return formatMoneyMinor(minor, BOOK_CURRENCY);
}

export type Actor =
  | { kind: "user"; userId: string }
  | { kind: "agent"; agentId: string; runId: string | null; userId: string | null }
  | { kind: "system"; reason: string }
  | { kind: "plugin"; plugin: string };

export function actorRecord(actor: Actor): Record<string, unknown> {
  if (actor.kind === "user") return { kind: "user", userId: actor.userId };
  if (actor.kind === "agent") return { kind: "agent", agentId: actor.agentId, runId: actor.runId };
  if (actor.kind === "plugin") return { kind: "plugin", plugin: actor.plugin };
  return { kind: "system", reason: actor.reason };
}

export function actorLabel(actor: Actor): string {
  if (actor.kind === "user") return "a board user";
  if (actor.kind === "agent") return "an agent";
  if (actor.kind === "plugin") return actor.plugin;
  return "the plugin";
}

/** Only a person may approve, lock or post money-moving work. */
export function requireUser(actor: Actor, what: string): string {
  if (actor.kind !== "user") throw new AccountingError(`Only a board user can ${what}.`, "forbidden");
  return actor.userId;
}

export interface Settings {
  saved: boolean;
  legalName: string;
  vatNumber: string;
  vatCategory: VatCategory;
  yearEndMonth: number;
  currency: string;
  agentsMayAcceptCategorisation: boolean;
  raw: Record<string, unknown>;
}

export async function readSettings(ctx: PluginContext, companyId: string): Promise<Settings> {
  let raw: Record<string, unknown> = {};
  try {
    raw = await readConfig(ctx, companyId);
  } catch {
    raw = {};
  }
  let vatCategory: VatCategory = "B";
  try {
    vatCategory = raw.vatCategory == null ? "B" : parseVatCategory(raw.vatCategory);
  } catch {
    vatCategory = "B";
  }
  return {
    saved: Object.keys(raw).length > 0,
    legalName: typeof raw.legalName === "string" ? raw.legalName.trim() : "",
    vatNumber: typeof raw.vatNumber === "string" ? raw.vatNumber.trim() : "",
    vatCategory,
    yearEndMonth: parseYearEndMonth(raw.financialYearEndMonth ?? 2),
    currency: BOOK_CURRENCY,
    agentsMayAcceptCategorisation: raw.agentsMayAcceptCategorisation === true,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Private R2 (statements, accountant packs). Never the public media bucket.
// ---------------------------------------------------------------------------

export interface PrivateR2 {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

export async function privateR2(ctx: PluginContext, companyId: string, raw?: Record<string, unknown>): Promise<PrivateR2 | null> {
  const config = raw ?? (await readConfig(ctx, companyId).catch(() => ({} as Record<string, unknown>)));
  const r2 = (config.r2 ?? null) as Record<string, unknown> | null;
  if (!r2) return null;
  const accountId = typeof r2.accountId === "string" ? r2.accountId.trim() : "";
  const bucket = typeof r2.bucket === "string" ? r2.bucket.trim() : "";
  const accessKeyId = typeof r2.accessKeyId === "string" ? r2.accessKeyId.trim() : "";
  if (!accountId || !bucket || !accessKeyId) return null;
  const secretAccessKey = await new SecretResolver(ctx, companyId, config).get("r2.secretAccessKey");
  if (!secretAccessKey) return null;
  const prefix = (typeof r2.prefix === "string" && r2.prefix.trim() ? r2.prefix.trim() : "accounting").replace(/^\/+|\/+$/g, "");
  return { accountId, bucket, accessKeyId, secretAccessKey, prefix };
}

export function r2Url(cfg: PrivateR2, method: "GET" | "PUT", key: string, expiresSec: number, query?: Record<string, string>): string {
  return presignUrl({
    method,
    host: `${cfg.accountId}.r2.cloudflarestorage.com`,
    path: `/${cfg.bucket}/${key}`,
    region: "auto",
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    expiresSec,
    query,
  });
}

/** Object keys live under `<prefix>/<companyId>/…`; the worker only reads its own. */
export function assertOwnKey(cfg: PrivateR2, companyId: string, key: string): void {
  if (!key.startsWith(`${cfg.prefix}/${companyId}/`) || key.includes("..")) throw new AccountingError("That file does not belong to this company", "forbidden");
}

export function safeFileName(name: string): string {
  return (name || "file")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "file";
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export async function commentOn(ctx: PluginContext, companyId: string, issueId: string, body: string): Promise<void> {
  try {
    await ctx.issues.createComment(issueId, body, companyId);
  } catch (error) {
    ctx.logger.info("Accounting comment skipped", { issueId, error: errorMessage(error) });
  }
}

export async function closeIssue(ctx: PluginContext, companyId: string, issueId: string | null, status: "done" | "cancelled", comment?: string): Promise<void> {
  if (!issueId) return;
  if (comment) await commentOn(ctx, companyId, issueId, comment);
  try {
    const issue = await ctx.issues.get(issueId, companyId);
    if (!issue || issue.status === "done" || issue.status === "cancelled") return;
    await ctx.issues.update(issueId, { status }, companyId);
  } catch (error) {
    ctx.logger.info("Accounting issue update skipped", { issueId, error: errorMessage(error) });
  }
}

/** A local_trusted install's board sentinel is not a company member, so issues cannot be assigned to it. */
export const LOCAL_BOARD_USER_ID = "local-board";

export function assignableUser(userId: string | null | undefined): string | null {
  return userId && userId !== LOCAL_BOARD_USER_ID ? userId : null;
}

/**
 * Who approves a manual journal, a reconciliation or a VAT201: always a
 * person. The company owner (Cockpit roles), else the person who asked.
 */
export async function approverFor(ctx: PluginContext, companyId: string, actor: Actor): Promise<string | null> {
  const owner = assignableUser((await companyRoles(ctx, companyId))?.ownerUserId);
  if (owner) return owner;
  return actor.kind === "user" ? assignableUser(actor.userId) : null;
}

type IssueInput = Parameters<typeof createWorkIssue>[1];

/**
 * Open an issue for an agent or a person (an agent is woken). If the host
 * refuses the assignee (for example a user who left), the issue still opens,
 * unassigned, so the work is never lost.
 */
export async function openIssue(
  ctx: PluginContext,
  input: Omit<IssueInput, "assigneeAgentId" | "assigneeUserId">,
  to: { assigneeAgentId?: string | null; assigneeUserId?: string | null },
): Promise<{ id: string; woke: boolean }> {
  const assignee = to.assigneeAgentId ? { assigneeAgentId: to.assigneeAgentId } : assignableUser(to.assigneeUserId) ? { assigneeUserId: assignableUser(to.assigneeUserId)! } : {};
  if (!Object.keys(assignee).length) ctx.logger.info("Accounting issue has nobody to go to (no Bookkeeper, Operator or owner yet)", { title: input.title });
  try {
    return await createWorkIssue(ctx, { ...input, ...assignee });
  } catch (error) {
    if (!Object.keys(assignee).length) throw error;
    ctx.logger.warn("Accounting issue could not be assigned, so it opened unassigned", { title: input.title, error: errorMessage(error) });
    return createWorkIssue(ctx, input);
  }
}

/**
 * An agent closed or cancelled an approval issue: only a person decides, so
 * it is reopened and handed to the approver (kit `reopenApprovalForPerson`).
 */
export async function reopenForPerson(ctx: PluginContext, companyId: string, issueId: string | null, what: string): Promise<void> {
  if (!issueId) return;
  const ok = await reopenApprovalForPerson(ctx, { issueId, companyId, what });
  if (!ok) ctx.logger.info("Could not hand the approval back to a person", { issueId });
}

export async function issueStatus(ctx: PluginContext, companyId: string, issueId: string | null): Promise<string | null> {
  if (!issueId) return null;
  try {
    const issue = await ctx.issues.get(issueId, companyId);
    return issue ? String(issue.status) : null;
  } catch {
    return null;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Per-company lock
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>();

/** Run `fn` after any earlier work for the same company and key has finished. */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

export function newId(): string {
  return crypto.randomUUID();
}
