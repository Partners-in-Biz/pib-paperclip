/**
 * Small tool results for the Bookkeeper (audit Q8-11).
 *
 * `list-bank-lines` returned about 2.4 KB per line (every suggestion, the Jev
 * answer, the match record), 44 KB on average and 231 KB at most, and the
 * Bookkeeper only needs the date, amount, text and the best suggestion to
 * decide. `accept-categorisation` returned the same full row for one line.
 *
 * - compact (the default): id, date, amount, a short description, status and the
 *   top suggestion in one line each; the full line stays reachable by id
 *   (`list-bank-lines` with `ids`, `compact: false`).
 * - `fields`: exactly the listed fields, for an agent that wants one more column.
 * - `accept-categorisations`: many lines in one call with a result per line, so a
 *   month of statement lines is not fifty round trips of 2.8 KB each.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import * as db from "../db.js";
import type { Suggestion } from "../domain/matching.js";
import { AccountingError } from "../domain/util.js";
import { acceptSuggestion, categorise } from "./bank.js";
import { errorMessage, type Actor } from "./common.js";

/** Lines per call, compact or not. The page and the old tool allowed 500; nobody can use that many in one answer. */
export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;
export const LIST_FULL_MAX_LIMIT = 50;
export const BATCH_MAX = 50;

export const LINE_FIELDS = ["id", "bankAccountId", "date", "amountMinor", "description", "reference", "counterparty", "balanceMinor", "status", "note", "suggestions", "match"] as const;
export type LineField = (typeof LINE_FIELDS)[number];

/** One line of text for a suggestion: what accepting index 0 would do. */
export function suggestionLabel(s: Suggestion): string {
  if (s.kind === "open_item") return `${s.itemKind === "receivable" ? "invoice" : "bill"} ${s.number} (${s.counterparty}), ${s.basis} match`;
  if (s.kind === "journal") return `journal ${s.number} already in the books`;
  return `categorise to ${s.accountCode}${s.taxCode ? ` with ${s.taxCode}` : ""} (${s.source === "rule" ? "bank rule" : "Jev"}${s.counterparty ? `, ${s.counterparty}` : ""})`;
}

export interface CompactLine {
  id: string;
  bankAccountId?: string;
  date: string;
  amountMinor: number;
  description: string;
  status: string;
  /** The best suggestion, in words; accept it with `accept-categorisation` (index 0). */
  top?: string;
  /** How many more suggestions there are (read them with `ids` and `compact: false`). */
  more?: number;
  note?: string;
}

export function compactLine(line: db.BankLineRow, options: { withAccount?: boolean } = {}): CompactLine {
  const out: CompactLine = {
    id: line.id,
    ...(options.withAccount ? { bankAccountId: line.bankAccountId } : {}),
    date: line.date,
    amountMinor: line.amountMinor,
    description: line.description.length > 80 ? `${line.description.slice(0, 77)}...` : line.description,
    status: line.status,
  };
  const first = line.suggestions[0];
  if (first) out.top = suggestionLabel(first);
  if (line.suggestions.length > 1) out.more = line.suggestions.length - 1;
  if (line.note) out.note = line.note.slice(0, 160);
  return out;
}

/** The full line as the old tool returned it. */
export function fullLine(line: db.BankLineRow) {
  return {
    id: line.id,
    bankAccountId: line.bankAccountId,
    date: line.date,
    amountMinor: line.amountMinor,
    description: line.description,
    reference: line.reference,
    counterparty: line.counterparty,
    status: line.status,
    note: line.note,
    suggestions: line.suggestions.map((s, index) => ({ index, ...s })),
  };
}

/** Exactly the listed fields (unknown names are an error, so a typo is not silently an empty answer). */
export function pickLineFields(line: db.BankLineRow, fields: unknown): Record<string, unknown> {
  const wanted = Array.isArray(fields) ? fields.map(String) : [];
  const bad = wanted.filter((f) => !(LINE_FIELDS as readonly string[]).includes(f));
  if (bad.length) throw new AccountingError(`Unknown field ${bad.join(", ")}. Fields: ${LINE_FIELDS.join(", ")}.`);
  const all: Record<string, unknown> = { ...fullLine(line), balanceMinor: line.balanceMinor, match: line.match };
  const out: Record<string, unknown> = {};
  for (const field of wanted) out[field] = all[field];
  return out;
}

export interface ListLinesInput {
  status?: string | null;
  bankAccountId?: string | null;
  from?: string | null;
  to?: string | null;
  limit?: unknown;
  ids?: unknown;
  compact?: unknown;
  fields?: unknown;
}

/** The `list-bank-lines` tool. Compact unless `compact: false` (then at most 50 full lines) or `fields` is given. */
export async function listBankLinesTool(ctx: PluginContext, companyId: string, input: ListLinesInput) {
  const ids = Array.isArray(input.ids) ? input.ids.map(String).filter(Boolean).slice(0, LIST_FULL_MAX_LIMIT) : [];
  const fields = Array.isArray(input.fields) && input.fields.length ? input.fields : null;
  const full = input.compact === false && !fields;
  const cap = full ? LIST_FULL_MAX_LIMIT : LIST_MAX_LIMIT;
  const limit = Math.max(1, Math.min(Number(input.limit ?? LIST_DEFAULT_LIMIT) || LIST_DEFAULT_LIMIT, cap));
  const rows = await db.listBankLines(ctx.db, companyId, {
    bankAccountId: input.bankAccountId ?? null,
    statuses: input.status ? [input.status] : null,
    from: input.from ?? null,
    to: input.to ?? null,
    ...(ids.length ? { ids } : {}),
    // one more than asked, to say whether there is more
    limit: ids.length ? ids.length : limit + 1,
  });
  const more = !ids.length && rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const mode = fields ? "fields" : full ? "full" : "compact";
  const lines = fields ? page.map((l) => pickLineFields(l, fields)) : full ? page.map(fullLine) : page.map((l) => compactLine(l, { withAccount: !input.bankAccountId }));
  return {
    mode,
    count: lines.length,
    lines,
    ...(more ? { more: true, next: `More lines match. Narrow with bankAccountId, from and to, or work this ${limit} and ask again (accepted lines drop out of status "unreconciled").` } : {}),
  };
}

// ---------------------------------------------------------------------------
// Accepting
// ---------------------------------------------------------------------------

export interface AcceptedSummary {
  lineId: string;
  status: string;
  /** What the line was matched or categorised to, in words. */
  matchedTo: string | null;
  journalNumber: string | null;
  note: string | null;
}

/** What accepting did, without the full row. */
export function acceptedSummary(line: db.BankLineRow): AcceptedSummary {
  const m = (line.match ?? {}) as Record<string, unknown>;
  const matchedTo =
    m.kind === "open_item" ? `${m.number ?? "an invoice or bill"} (${m.basis ?? "match"}), sent to Billing to settle`
    : m.kind === "journal" ? `journal ${m.journalNumber ?? ""}`.trim()
    : m.kind === "category" ? `account ${m.accountCode ?? ""}${m.taxCode ? ` with ${m.taxCode}` : ""}`.trim()
    : null;
  return { lineId: line.id, status: line.status, matchedTo, journalNumber: typeof m.journalNumber === "string" ? m.journalNumber : null, note: line.note };
}

export interface AcceptItem {
  lineId?: unknown;
  index?: unknown;
  accountCode?: unknown;
  taxCode?: unknown;
  memo?: unknown;
}

export type AcceptOutcome = ({ ok: true } & AcceptedSummary) | { ok: false; lineId: string; error: string; code: string | null };

/**
 * The account code an agent asked for, or null when it asked for none (left out, null, or blank). Anything else that is
 * not text is refused: a model that sends `6100` as a number must not have the line quietly categorised to the
 * best suggestion instead (and a code such as "06100" would not survive a number).
 */
export function requestedAccountCode(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new AccountingError(`accountCode must be text, like "6100" (it was ${Array.isArray(value) ? "a list" : typeof value}). Send it as a string, or leave it out to accept the suggestion at index.`);
  return value.trim() || null;
}

/** One line: a category when `accountCode` is given, else the suggestion at `index` (default 0). Never throws. */
export async function acceptOne(ctx: PluginContext, companyId: string, actor: Actor, item: AcceptItem): Promise<AcceptOutcome> {
  const lineId = typeof item.lineId === "string" ? item.lineId : "";
  try {
    const accountCode = requestedAccountCode(item.accountCode);
    const line = accountCode
      ? await categorise(ctx, companyId, actor, { lineId: item.lineId, accountCode, taxCode: item.taxCode, memo: item.memo })
      : await acceptSuggestion(ctx, companyId, actor, { lineId: item.lineId, index: item.index });
    return { ok: true, ...acceptedSummary(line) };
  } catch (error) {
    return { ok: false, lineId, error: errorMessage(error), code: error instanceof AccountingError ? error.code ?? null : null };
  }
}

/**
 * `accept-categorisations`: up to 50 lines in one call, one after the other (journal numbers stay in order and a
 * failure of one line never stops the rest), with a result per line.
 */
export async function acceptMany(ctx: PluginContext, companyId: string, actor: Actor, items: unknown) {
  if (!Array.isArray(items) || items.length === 0) throw new AccountingError("lines must be a list of { lineId, index or accountCode }");
  if (items.length > BATCH_MAX) throw new AccountingError(`At most ${BATCH_MAX} lines per call; send the rest in another call.`);
  const results: AcceptOutcome[] = [];
  for (const raw of items) {
    const item = raw && typeof raw === "object" ? (raw as AcceptItem) : {};
    results.push(await acceptOne(ctx, companyId, actor, item));
  }
  const accepted = results.filter((r) => r.ok).length;
  return {
    accepted,
    failed: results.length - accepted,
    results,
    ...(results.length - accepted > 0 ? { next: "Lines that failed are unchanged. Read each error: a line an agent may not accept (setting off, inexact invoice match, dated after today) goes in your ask to the owner." } : {}),
  };
}
