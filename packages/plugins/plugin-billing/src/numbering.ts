/**
 * Document numbers: a per-client prefix (first three letters of the client's
 * name, deduplicated per company) and a counter per document kind and prefix.
 * Invoices `LUM-001`, quotes `Q-LUM-001`, credit notes `CN-LUM-001`.
 *
 * The host runs one statement per call and `execute` returns only a row
 * count (no RETURNING), so the counter is claimed with compare-and-swap:
 * read n, `UPDATE … SET n = n + 1 WHERE n = $read`, and retry when another
 * writer won. Each number is also claimed in `number_claims` (primary key),
 * so a number is never issued twice even if a counter was seeded low.
 * Numbers already on documents are never changed.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { BillingSettings } from "./config.js";
import { table } from "./db.js";
import { BillingError, nextNumber } from "./domain.js";

export type NumberedKind = "invoice" | "quote" | "credit_note";

/** Prefixes that would read like the legacy sequences. */
const RESERVED = new Set(["INV", "QTE", "CNX"]);

const KIND_PREFIX: Record<NumberedKind, string> = { invoice: "", quote: "Q-", credit_note: "CN-" };
const LEGACY_PREFIX: Record<NumberedKind, string> = { invoice: "INV", quote: "QTE", credit_note: "CN" };

function letters(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase();
}

/** "Lumen Digital" → LUM; "Jo" → JOX; "" → XXX. */
export function basePrefix(name: string): string {
  const alpha = letters(name);
  return alpha.length >= 3 ? alpha.slice(0, 3) : alpha.padEnd(3, "X");
}

/**
 * Candidate prefixes in order: the first three letters, then the first two
 * plus each later letter, then the first plus later pairs, then the first
 * two plus a digit, then generated fallbacks. Deterministic for a name.
 */
export function prefixCandidates(name: string): string[] {
  const alpha = letters(name);
  const out: string[] = [];
  const push = (value: string) => {
    if (value.length === 3 && !RESERVED.has(value) && !out.includes(value)) out.push(value);
  };
  push(basePrefix(name));
  const a = alpha[0] ?? "X";
  const b = alpha[1] ?? "X";
  for (let k = 2; k < alpha.length; k += 1) push(`${a}${b}${alpha[k]}`);
  for (let j = 1; j < alpha.length; j += 1) {
    for (let k = j + 1; k < alpha.length; k += 1) push(`${a}${alpha[j]}${alpha[k]}`);
    if (out.length > 60) break;
  }
  for (let d = 2; d <= 9; d += 1) push(`${a}${b}${d}`);
  for (let d = 10; d <= 99; d += 1) push(`${a}${d}`);
  return out;
}

export function formatDocNumber(kind: NumberedKind, prefix: string, n: number, digits = 3): string {
  return `${KIND_PREFIX[kind]}${prefix}-${String(n).padStart(Math.max(1, Math.min(8, digits)), "0")}`;
}

/** The sequence of `number` when it belongs to this kind and prefix, else 0. */
export function sequenceOf(number: string, kind: NumberedKind, prefix: string): number {
  const re = new RegExp(`^${KIND_PREFIX[kind].replace(/[-]/g, "\\-")}${prefix}-(\\d+)$`);
  const match = re.exec(String(number ?? ""));
  return match ? Number(match[1]) || 0 : 0;
}

export function numberingMode(settings: BillingSettings): "client" | "sequential" {
  return settings.numbering?.mode === "sequential" ? "sequential" : "client";
}

function digitsOf(settings: BillingSettings): number {
  const digits = Math.floor(Number(settings.numbering?.digits ?? 3));
  return Number.isFinite(digits) && digits >= 1 && digits <= 8 ? digits : 3;
}

const TABLE_OF: Record<NumberedKind, string> = { invoice: "invoices", quote: "quotes", credit_note: "credit_notes" };

/**
 * The client's prefix, assigned once and kept. A clash with another client's
 * prefix moves on to the next candidate.
 */
export async function clientPrefix(
  ctx: PluginContext,
  companyId: string,
  customer: { kind: string; ref: string; name: string },
): Promise<string> {
  const existing = await readPrefix(ctx, companyId, customer);
  if (existing) return existing;
  for (const candidate of prefixCandidates(customer.name)) {
    const res = await ctx.db.execute(
      `INSERT INTO ${table(ctx, "client_prefixes")} (company_id, customer_kind, customer_ref, prefix)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [companyId, customer.kind, customer.ref, candidate],
    );
    if ((res.rowCount ?? 0) > 0) return candidate;
    // Another call may have given this client a prefix in the meantime.
    const now = await readPrefix(ctx, companyId, customer);
    if (now) return now;
  }
  throw new BillingError("Could not assign a document prefix for this client");
}

async function readPrefix(ctx: PluginContext, companyId: string, customer: { kind: string; ref: string }): Promise<string | null> {
  const rows = await ctx.db.query<{ prefix: string }>(
    `SELECT prefix FROM ${table(ctx, "client_prefixes")} WHERE company_id = $1 AND customer_kind = $2 AND customer_ref = $3`,
    [companyId, customer.kind, customer.ref],
  );
  return rows[0]?.prefix ?? null;
}

/** Highest sequence already used for this kind and prefix (seeds a new counter). */
async function highestExisting(ctx: PluginContext, companyId: string, kind: NumberedKind, prefix: string, legacy: boolean): Promise<number> {
  const like = legacy ? `${prefix}-%` : `${KIND_PREFIX[kind]}${prefix}-%`;
  const rows = await ctx.db.query<{ number: string | null }>(
    `SELECT number FROM ${table(ctx, TABLE_OF[kind])} WHERE company_id = $1 AND number LIKE $2`,
    [companyId, like],
  );
  if (legacy) {
    const next = nextNumber(prefix, rows.map((row) => String(row.number ?? "")));
    return Number(next.split("-").pop()) - 1;
  }
  return rows.reduce((max, row) => Math.max(max, sequenceOf(String(row.number ?? ""), kind, prefix)), 0);
}

/** Claim the next value of a counter with compare-and-swap. */
export async function claimSequence(
  ctx: PluginContext,
  companyId: string,
  kind: string,
  prefix: string,
  seed: () => Promise<number>,
): Promise<number> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const rows = await ctx.db.query<{ n: string | number }>(
      `SELECT n FROM ${table(ctx, "numbering_counters")} WHERE company_id = $1 AND kind = $2 AND prefix = $3`,
      [companyId, kind, prefix],
    );
    if (!rows[0]) {
      const start = Math.max(0, Math.floor(await seed()));
      await ctx.db.execute(
        `INSERT INTO ${table(ctx, "numbering_counters")} (company_id, kind, prefix, n) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [companyId, kind, prefix, start],
      );
      continue;
    }
    const current = Number(rows[0].n);
    const res = await ctx.db.execute(
      `UPDATE ${table(ctx, "numbering_counters")} SET n = n + 1, updated_at = now()
        WHERE company_id = $1 AND kind = $2 AND prefix = $3 AND n = $4`,
      [companyId, kind, prefix, current],
    );
    if ((res.rowCount ?? 0) > 0) return current + 1;
  }
  throw new BillingError("Numbering is busy. Try again.");
}

async function claimNumber(ctx: PluginContext, companyId: string, kind: NumberedKind, number: string): Promise<boolean> {
  const res = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "number_claims")} (company_id, kind, number) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [companyId, kind, number],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Next number for a new document. `customer.name` drives the prefix in
 * client mode; sequential mode keeps the legacy INV-0001 / QTE-0001 series.
 */
export async function nextDocumentNumber(
  ctx: PluginContext,
  companyId: string,
  kind: NumberedKind,
  customer: { kind: string; ref: string; name: string } | null,
  settings: BillingSettings,
): Promise<string> {
  const sequential = numberingMode(settings) === "sequential" || !customer;
  const prefix = sequential
    ? (!customer && numberingMode(settings) === "client" && settings.numbering?.fallbackPrefix
        ? basePrefix(settings.numbering.fallbackPrefix)
        : LEGACY_PREFIX[kind])
    : await clientPrefix(ctx, companyId, customer);
  const legacy = sequential && prefix === LEGACY_PREFIX[kind];
  const counterKey = legacy ? `${kind}:legacy` : kind;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const n = await claimSequence(ctx, companyId, counterKey, prefix, () => highestExisting(ctx, companyId, kind, prefix, legacy));
    const number = legacy ? `${prefix}-${String(n).padStart(4, "0")}` : formatDocNumber(kind, prefix, n, digitsOf(settings));
    if (await claimNumber(ctx, companyId, kind, number)) return number;
  }
  throw new BillingError("Could not assign a document number");
}
