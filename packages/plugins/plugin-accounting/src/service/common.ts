/**
 * Shared service helpers: who is acting, settings, private R2, issues and a
 * per-company lock so postings from events, jobs and the page never race
 * each other inside the worker.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { presignUrl, readConfig, SecretResolver } from "@partnersinbiz/pib-plugin-kit";
import { parseVatCategory, parseYearEndMonth, type VatCategory } from "../domain/periods.js";
import { AccountingError } from "../domain/util.js";
import { PLUGIN_ID } from "../namespace.js";

export const ORIGIN = `plugin:${PLUGIN_ID}` as const;
export const BOOK_CURRENCY = "ZAR";

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
