/**
 * Journal entries: one row per entry with its lines in `lines jsonb`, so a
 * posting is a single statement. Posted journals are never edited; a
 * reversal is a new journal with the lines swapped. Each journal carries a
 * sha256 over its canonical content and the previous journal's hash, so any
 * later edit to the table breaks the chain (`verifyChain`).
 */
import { createHash } from "node:crypto";
import { isBalanced, TAX_CODES, type LedgerLine } from "@partnersinbiz/pib-plugin-kit";
import { normaliseRole, resolveRoleCode, type Account } from "./chart.js";
import { AccountingError, canonicalJson, isIsoDate, monthOf } from "./util.js";

export const MAX_JOURNAL_LINES = 400;
export const GENESIS_HASH = "0".repeat(64);

export const JOURNAL_KINDS = [
  "event",
  "manual",
  "reversal",
  "bank",
  "opening",
  "depreciation",
  "disposal",
  "fx_revaluation",
] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

/** A line as stored: always an account, amounts in the book currency. */
export interface JournalLine {
  accountId: string;
  accountCode: string;
  role?: string | null;
  debitMinor: number;
  creditMinor: number;
  memo?: string | null;
  taxCode?: string | null;
  /** Net amount the VAT is charged on, in the book currency (always ≥ 0). */
  taxBaseMinor?: number | null;
  clientKind?: "company" | "contact" | null;
  clientRef?: string | null;
  dimensions?: Record<string, string> | null;
  /** Amounts in the document currency when it differs from the book. */
  originalDebitMinor?: number | null;
  originalCreditMinor?: number | null;
}

export interface JournalSource {
  plugin: string;
  kind: string;
  id: string;
}

export interface JournalContent {
  companyId: string;
  seq: number;
  number: string;
  date: string;
  memo: string;
  kind: JournalKind;
  currency: string;
  fxRate: number | null;
  bookCurrency: string;
  sourceKey: string;
  source: JournalSource;
  lines: JournalLine[];
  reversesId: string | null;
  prevHash: string;
}

export interface Journal extends JournalContent {
  id: string;
  status: "posted" | "reversed";
  reversedById: string | null;
  totalMinor: number;
  postedBy: Record<string, unknown>;
  hash: string;
  createdAt?: string | null;
}

/** `JNL-000123` */
export function journalNumber(seq: number): string {
  return `JNL-${String(seq).padStart(6, "0")}`;
}

/** Which currency amounts are rounded in; ZAR books use cents. */
export function isCurrencyCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

/** Check shape and balance before anything touches the chart. */
export function validatePostingInput(input: { date: unknown; lines: unknown; currency?: unknown; memo?: unknown }): asserts input is {
  date: string;
  lines: LedgerLine[];
  currency: string;
  memo: string;
} {
  if (!isIsoDate(input.date)) throw new AccountingError("date must be a real date written YYYY-MM-DD");
  if (!Array.isArray(input.lines) || input.lines.length < 2) throw new AccountingError("A journal needs at least two lines", "unbalanced");
  if (input.lines.length > MAX_JOURNAL_LINES) throw new AccountingError(`A journal can have at most ${MAX_JOURNAL_LINES} lines`);
  if (input.currency != null && !isCurrencyCode(input.currency)) throw new AccountingError("currency must be a 3-letter code such as ZAR");
  input.lines.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") throw new AccountingError(`Line ${index + 1} must be an object`);
    const line = raw as LedgerLine;
    if (!line.role && !line.accountCode) throw new AccountingError(`Line ${index + 1} needs a role or an accountCode`);
    for (const key of ["debitMinor", "creditMinor"] as const) {
      const v = line[key];
      if (!Number.isSafeInteger(v) || v < 0) throw new AccountingError(`Line ${index + 1}: ${key} must be a whole number of cents, 0 or more`, "unbalanced");
    }
    if (line.debitMinor > 0 && line.creditMinor > 0) throw new AccountingError(`Line ${index + 1} has both a debit and a credit`, "unbalanced");
    if (line.taxCode != null && !(line.taxCode in TAX_CODES)) throw new AccountingError(`Line ${index + 1}: unknown tax code ${line.taxCode}`);
    if (line.taxBaseMinor != null && !Number.isSafeInteger(line.taxBaseMinor)) throw new AccountingError(`Line ${index + 1}: taxBaseMinor must be whole cents`);
  });
  if (!isBalanced(input.lines as LedgerLine[])) {
    const lines = input.lines as LedgerLine[];
    const d = lines.reduce((s, l) => s + l.debitMinor, 0);
    const c = lines.reduce((s, l) => s + l.creditMinor, 0);
    throw new AccountingError(`The journal does not balance: debits ${d} and credits ${c} (cents)`, "unbalanced");
  }
}

export interface ChartIndex {
  byCode: ReadonlyMap<string, Account>;
  roles: ReadonlyMap<string, string>;
}

/** Map roles and codes to accounts. Unknown roles or accounts are rejected with a clear message. */
export function resolveLines(lines: LedgerLine[], chart: ChartIndex): JournalLine[] {
  const unknownRoles: string[] = [];
  const unknownCodes: string[] = [];
  const inactive: string[] = [];
  const out: JournalLine[] = [];
  for (const line of lines) {
    let code = line.accountCode?.trim() || null;
    let role: string | null = null;
    if (!code && line.role) {
      role = normaliseRole(String(line.role));
      code = resolveRoleCode(role, chart.roles);
      if (!code) {
        unknownRoles.push(role);
        continue;
      }
    }
    const account = code ? chart.byCode.get(code) : undefined;
    if (!account) {
      unknownCodes.push(role ? `${code} (role ${role})` : String(code));
      continue;
    }
    if (!account.active) {
      inactive.push(`${account.code} ${account.name}`);
      continue;
    }
    out.push(cleanLine({
      accountId: account.id,
      accountCode: account.code,
      role,
      debitMinor: line.debitMinor,
      creditMinor: line.creditMinor,
      memo: line.memo ?? null,
      taxCode: line.taxCode ?? null,
      taxBaseMinor: line.taxBaseMinor == null ? null : Math.abs(line.taxBaseMinor),
      clientKind: line.clientKind ?? null,
      clientRef: line.clientRef ?? null,
      dimensions: line.dimensions && Object.keys(line.dimensions).length ? stringDims(line.dimensions) : null,
    }));
  }
  if (unknownRoles.length) {
    throw new AccountingError(`No account is mapped to role ${[...new Set(unknownRoles)].join(", ")}. Map it under Accounting → Chart & roles.`, "unknown_role");
  }
  if (unknownCodes.length) throw new AccountingError(`Unknown account ${[...new Set(unknownCodes)].join(", ")}`, "unknown_account");
  if (inactive.length) throw new AccountingError(`Account ${[...new Set(inactive)].join(", ")} is inactive`, "inactive_account");
  return out;
}

function stringDims(dims: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(dims)) {
    if (v == null) continue;
    out[k.slice(0, 64)] = String(v).slice(0, 200);
  }
  return out;
}

function cleanLine(line: JournalLine): JournalLine {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(line)) {
    if (v === null || v === undefined || v === "") continue;
    out[k] = v;
  }
  return out as unknown as JournalLine;
}

/**
 * Convert document-currency lines to the book currency. Each amount is
 * rounded; any rounding difference goes to the rounding account so the
 * journal still balances.
 */
export function convertToBook(
  lines: JournalLine[],
  input: { currency: string; bookCurrency: string; fxRate?: number | null; rounding?: { accountId: string; accountCode: string } | null },
): { lines: JournalLine[]; fxRate: number | null } {
  if (input.currency === input.bookCurrency) return { lines, fxRate: null };
  const rate = Number(input.fxRate);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new AccountingError(`fxRate is required to post a ${input.currency} journal into a ${input.bookCurrency} book`, "fx_rate_required");
  }
  const converted = lines.map((line) =>
    cleanLine({
      ...line,
      originalDebitMinor: line.debitMinor || null,
      originalCreditMinor: line.creditMinor || null,
      debitMinor: Math.round(line.debitMinor * rate),
      creditMinor: Math.round(line.creditMinor * rate),
      taxBaseMinor: line.taxBaseMinor == null ? null : Math.round(line.taxBaseMinor * rate),
    }),
  );
  const debit = converted.reduce((s, l) => s + l.debitMinor, 0);
  const credit = converted.reduce((s, l) => s + l.creditMinor, 0);
  const diff = debit - credit;
  if (diff !== 0) {
    if (!input.rounding) throw new AccountingError("Currency rounding left a difference and no rounding account is mapped", "unknown_role");
    converted.push(
      cleanLine({
        accountId: input.rounding.accountId,
        accountCode: input.rounding.accountCode,
        role: "rounding",
        debitMinor: diff < 0 ? -diff : 0,
        creditMinor: diff > 0 ? diff : 0,
        memo: "Currency rounding",
      }),
    );
  }
  return { lines: converted, fxRate: rate };
}

/** The canonical rate text, so the hash does not depend on how numeric round-trips. */
function rateKey(rate: number | string | null | undefined): number | null {
  if (rate == null || rate === "") return null;
  const n = Number(rate);
  return Number.isFinite(n) ? n : null;
}

export function contentForHash(content: JournalContent): Record<string, unknown> {
  return {
    companyId: content.companyId,
    seq: content.seq,
    number: content.number,
    date: content.date,
    memo: content.memo,
    kind: content.kind,
    currency: content.currency,
    fxRate: rateKey(content.fxRate),
    bookCurrency: content.bookCurrency,
    sourceKey: content.sourceKey,
    source: content.source,
    lines: content.lines.map((line) => ({
      ...line,
      debitMinor: Number(line.debitMinor),
      creditMinor: Number(line.creditMinor),
    })),
    reversesId: content.reversesId,
    prevHash: content.prevHash,
  };
}

export function journalHash(content: JournalContent): string {
  return createHash("sha256").update(content.prevHash).update("\n").update(canonicalJson(contentForHash(content))).digest("hex");
}

export interface ChainCheck {
  ok: boolean;
  checked: number;
  firstBadSeq: number | null;
  problem: string | null;
  lastHash: string;
}

/**
 * Recompute every hash in seq order. `startPrevHash` lets a caller verify in
 * pages: pass the previous page's `lastHash`.
 */
export function verifyChain(journals: Array<JournalContent & { hash: string }>, startPrevHash = GENESIS_HASH, startSeq = 1): ChainCheck {
  let prev = startPrevHash;
  let expectedSeq = startSeq;
  let checked = 0;
  for (const j of journals) {
    if (j.seq !== expectedSeq) return { ok: false, checked, firstBadSeq: j.seq, problem: `Journal number ${expectedSeq} is missing`, lastHash: prev };
    if (j.prevHash !== prev) return { ok: false, checked, firstBadSeq: j.seq, problem: `${j.number} does not point at the journal before it`, lastHash: prev };
    const hash = journalHash(j);
    if (hash !== j.hash) return { ok: false, checked, firstBadSeq: j.seq, problem: `${j.number} was changed after it was posted`, lastHash: prev };
    if (!linesBalance(j.lines)) return { ok: false, checked, firstBadSeq: j.seq, problem: `${j.number} does not balance`, lastHash: prev };
    prev = j.hash;
    expectedSeq += 1;
    checked += 1;
  }
  return { ok: true, checked, firstBadSeq: null, problem: null, lastHash: prev };
}

export function linesBalance(lines: JournalLine[]): boolean {
  let d = 0;
  let c = 0;
  for (const l of lines) {
    d += Number(l.debitMinor);
    c += Number(l.creditMinor);
  }
  return lines.length >= 2 && d === c && d > 0;
}

export function totalDebit(lines: JournalLine[]): number {
  return lines.reduce((s, l) => s + Number(l.debitMinor), 0);
}

/** Lines of the reversing journal: debit and credit swapped, everything else kept. */
export function reverseLines(lines: JournalLine[]): JournalLine[] {
  return lines.map((line) =>
    cleanLine({
      ...line,
      debitMinor: line.creditMinor,
      creditMinor: line.debitMinor,
      originalDebitMinor: line.originalCreditMinor ?? null,
      originalCreditMinor: line.originalDebitMinor ?? null,
    }),
  );
}

export function periodKey(date: string): string {
  return monthOf(date);
}

/** Journal-level bank tx ids a Billing payment journal carries (dimensions.bankTxId). */
export function bankTxIds(lines: JournalLine[]): string[] {
  const ids = new Set<string>();
  for (const line of lines) {
    const id = line.dimensions?.bankTxId;
    if (id) ids.add(id);
  }
  return [...ids];
}
