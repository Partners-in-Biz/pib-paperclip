/**
 * Every SQL statement the plugin runs. Host guard rules (see wiki
 * plugin-jobs-company-scope): one statement per call, fully qualified
 * tables, SELECT/WITH through `query`, INSERT/UPDATE/DELETE through
 * `execute`, params JSON-encoded (lists travel as jsonb text), no
 * `FROM alias.col` constructs (EXTRACT … FROM, IS DISTINCT FROM).
 * bigint and numeric come back as strings, so rows are mapped with Number().
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { Account, AccountSubtype, AccountType, CashFlowClass } from "./domain/chart.js";
import type { Journal, JournalKind, JournalLine, JournalSource } from "./domain/journal.js";
import type { BankRule, Suggestion } from "./domain/matching.js";
import type { AccountTotals, GlEntry } from "./domain/reports.js";
import { NAMESPACE } from "./namespace.js";

export type Db = PluginContext["db"];
const N = NAMESPACE;

const num = (v: unknown): number => (v == null || v === "" ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v == null || v === "" ? null : Number(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const json = (v: unknown): string => JSON.stringify(v ?? null);

// ---------------------------------------------------------------------------
// Books
// ---------------------------------------------------------------------------

export interface BookRow {
  companyId: string;
  currency: string;
  chartTemplate: string;
  seededAt: string | null;
  rejectionIssueId: string | null;
  cutoverDate: string | null;
  openingJournalId: string | null;
  /** When a board user said the business started on these books (no opening balances to bring over). */
  cutoverSkippedAt: string | null;
}

export async function getBook(db: Db, companyId: string): Promise<BookRow | null> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT company_id, currency, chart_template, seeded_at, rejection_issue_id, cutover_date::text AS cutover_date, opening_journal_id, cutover_skipped_at
       FROM ${N}.books WHERE company_id = $1`,
    [companyId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    companyId: String(r.company_id),
    currency: String(r.currency),
    chartTemplate: String(r.chart_template),
    seededAt: iso(r.seeded_at),
    rejectionIssueId: str(r.rejection_issue_id),
    cutoverDate: str(r.cutover_date),
    openingJournalId: str(r.opening_journal_id),
    cutoverSkippedAt: iso(r.cutover_skipped_at),
  };
}

/** "We started on these books": no opening balances to bring over. Returns false when there is no book. */
export async function setCutoverSkipped(db: Db, companyId: string, by: unknown): Promise<boolean> {
  const res = await db.execute(
    `UPDATE ${N}.books SET cutover_skipped_at = now(), cutover_skipped_by = $2::jsonb, updated_at = now() WHERE company_id = $1`,
    [companyId, json(by)],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Undo the skip (a person changed their mind, or opening balances were posted after all). */
export async function clearCutoverSkipped(db: Db, companyId: string): Promise<void> {
  await db.execute(`UPDATE ${N}.books SET cutover_skipped_at = NULL, cutover_skipped_by = NULL, updated_at = now() WHERE company_id = $1 AND cutover_skipped_at IS NOT NULL`, [companyId]);
}

/** The date of the earliest journal in the book, or null when nothing is posted yet. */
export async function firstJournalDate(db: Db, companyId: string): Promise<string | null> {
  const rows = await db.query<{ first: string | null }>(`SELECT min(date)::text AS first FROM ${N}.journals WHERE company_id = $1`, [companyId]);
  return str(rows[0]?.first ?? null);
}

export async function insertBook(db: Db, companyId: string, currency: string, template: string): Promise<boolean> {
  const res = await db.execute(
    `INSERT INTO ${N}.books (company_id, currency, chart_template) VALUES ($1, $2, $3) ON CONFLICT (company_id) DO NOTHING`,
    [companyId, currency, template],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function setRejectionIssue(db: Db, companyId: string, issueId: string | null): Promise<void> {
  await db.execute(`UPDATE ${N}.books SET rejection_issue_id = $2, updated_at = now() WHERE company_id = $1`, [companyId, issueId]);
}

export async function setCutover(db: Db, companyId: string, date: string | null, journalId: string | null): Promise<void> {
  await db.execute(`UPDATE ${N}.books SET cutover_date = $2::date, opening_journal_id = $3, updated_at = now() WHERE company_id = $1`, [companyId, date, journalId]);
}

export async function setChartTemplate(db: Db, companyId: string, template: string): Promise<void> {
  await db.execute(`UPDATE ${N}.books SET chart_template = $2, updated_at = now() WHERE company_id = $1`, [companyId, template]);
}

export async function bookCompanies(db: Db): Promise<string[]> {
  const rows = await db.query<{ company_id: string }>(`SELECT company_id FROM ${N}.books ORDER BY company_id`);
  return rows.map((r) => String(r.company_id));
}

// ---------------------------------------------------------------------------
// Chart and roles
// ---------------------------------------------------------------------------

function mapAccount(r: Record<string, unknown>): Account {
  return {
    id: String(r.id),
    code: String(r.code),
    name: String(r.name),
    type: String(r.type) as AccountType,
    subtype: String(r.subtype) as AccountSubtype,
    cashFlow: String(r.cash_flow) as CashFlowClass,
    description: String(r.description ?? ""),
    system: Boolean(r.system),
    active: Boolean(r.active),
  };
}

export async function seedAccounts(db: Db, companyId: string, rows: Array<Record<string, unknown>>): Promise<number> {
  const res = await db.execute(
    `INSERT INTO ${N}.accounts (id, company_id, code, name, type, subtype, cash_flow, description, system)
     SELECT x.id, $1, x.code, x.name, x.type, x.subtype, x.cash_flow, x.description, x.system
       FROM jsonb_to_recordset($2::jsonb) AS x(id text, code text, name text, type text, subtype text, cash_flow text, description text, system boolean)
     ON CONFLICT (company_id, code) DO NOTHING`,
    [companyId, json(rows)],
  );
  return res.rowCount ?? 0;
}

export async function listAccounts(db: Db, companyId: string): Promise<Account[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, code, name, type, subtype, cash_flow, description, system, active FROM ${N}.accounts WHERE company_id = $1 ORDER BY code`,
    [companyId],
  );
  return rows.map(mapAccount);
}

export async function insertAccount(db: Db, companyId: string, a: Omit<Account, "system" | "active"> & { system?: boolean }): Promise<boolean> {
  const res = await db.execute(
    `INSERT INTO ${N}.accounts (id, company_id, code, name, type, subtype, cash_flow, description, system)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (company_id, code) DO NOTHING`,
    [a.id, companyId, a.code, a.name, a.type, a.subtype, a.cashFlow, a.description, Boolean(a.system)],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function updateAccount(db: Db, companyId: string, id: string, a: { code: string; name: string; type: AccountType; subtype: AccountSubtype; cashFlow: CashFlowClass; description: string; active: boolean }): Promise<boolean> {
  const res = await db.execute(
    `UPDATE ${N}.accounts SET code = $3, name = $4, type = $5, subtype = $6, cash_flow = $7, description = $8, active = $9, updated_at = now()
      WHERE company_id = $1 AND id = $2`,
    [companyId, id, a.code, a.name, a.type, a.subtype, a.cashFlow, a.description, a.active],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function accountHasPostings(db: Db, companyId: string, accountId: string): Promise<boolean> {
  const rows = await db.query<{ used: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM ${N}.journals j CROSS JOIN LATERAL jsonb_array_elements(j.lines) AS l
        WHERE j.company_id = $1 AND l->>'accountId' = $2
     ) AS used`,
    [companyId, accountId],
  );
  return Boolean(rows[0]?.used);
}

export async function seedRoles(db: Db, companyId: string, rows: Array<{ role: string; account_code: string }>): Promise<number> {
  const res = await db.execute(
    `INSERT INTO ${N}.account_roles (company_id, role, account_code)
     SELECT $1, x.role, x.account_code FROM jsonb_to_recordset($2::jsonb) AS x(role text, account_code text)
     ON CONFLICT (company_id, role) DO NOTHING`,
    [companyId, json(rows)],
  );
  return res.rowCount ?? 0;
}

export async function listRoles(db: Db, companyId: string): Promise<Map<string, string>> {
  const rows = await db.query<{ role: string; account_code: string }>(
    `SELECT role, account_code FROM ${N}.account_roles WHERE company_id = $1 ORDER BY role`,
    [companyId],
  );
  return new Map(rows.map((r) => [String(r.role), String(r.account_code)]));
}

export async function setRole(db: Db, companyId: string, role: string, code: string): Promise<void> {
  await db.execute(
    `INSERT INTO ${N}.account_roles (company_id, role, account_code) VALUES ($1, $2, $3)
     ON CONFLICT (company_id, role) DO UPDATE SET account_code = EXCLUDED.account_code, updated_at = now()`,
    [companyId, role, code],
  );
}

export async function deleteRole(db: Db, companyId: string, role: string): Promise<void> {
  await db.execute(`DELETE FROM ${N}.account_roles WHERE company_id = $1 AND role = $2`, [companyId, role]);
}

// ---------------------------------------------------------------------------
// Periods and tax rates
// ---------------------------------------------------------------------------

export async function periodStatus(db: Db, companyId: string, period: string): Promise<string> {
  const rows = await db.query<{ status: string }>(`SELECT status FROM ${N}.periods WHERE company_id = $1 AND period = $2`, [companyId, period]);
  return rows[0]?.status ? String(rows[0].status) : "open";
}

export async function listPeriods(db: Db, companyId: string): Promise<Array<{ period: string; status: string; changedBy: string | null; changedAt: string | null }>> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT period, status, changed_by, changed_at FROM ${N}.periods WHERE company_id = $1 ORDER BY period DESC`,
    [companyId],
  );
  return rows.map((r) => ({ period: String(r.period), status: String(r.status), changedBy: str(r.changed_by), changedAt: iso(r.changed_at) }));
}

export async function setPeriodStatus(db: Db, companyId: string, period: string, status: string, by: string | null): Promise<void> {
  await db.execute(
    `INSERT INTO ${N}.periods (company_id, period, status, changed_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_id, period) DO UPDATE SET status = EXCLUDED.status, changed_by = EXCLUDED.changed_by, changed_at = now()`,
    [companyId, period, status, by],
  );
}

export async function seedTaxRates(db: Db, companyId: string, rows: Array<Record<string, unknown>>): Promise<void> {
  await db.execute(
    `INSERT INTO ${N}.tax_rates (company_id, code, version, label, kind, rate_bps, effective_from, source)
     SELECT $1, x.code, x.version, x.label, x.kind, x.rate_bps, x.effective_from::date, x.source
       FROM jsonb_to_recordset($2::jsonb) AS x(code text, version integer, label text, kind text, rate_bps integer, effective_from text, source text)
     ON CONFLICT (company_id, code, version) DO NOTHING`,
    [companyId, json(rows)],
  );
}

export interface TaxRateRow {
  code: string;
  version: number;
  label: string;
  kind: string;
  rateBps: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: string;
}

export async function listTaxRates(db: Db, companyId: string): Promise<TaxRateRow[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT code, version, label, kind, rate_bps, effective_from::text AS effective_from, effective_to::text AS effective_to, source
       FROM ${N}.tax_rates WHERE company_id = $1 ORDER BY code, version`,
    [companyId],
  );
  return rows.map((r) => ({
    code: String(r.code),
    version: num(r.version),
    label: String(r.label),
    kind: String(r.kind),
    rateBps: num(r.rate_bps),
    effectiveFrom: String(r.effective_from),
    effectiveTo: str(r.effective_to),
    source: String(r.source ?? ""),
  }));
}

// ---------------------------------------------------------------------------
// Journals
// ---------------------------------------------------------------------------

const JOURNAL_COLUMNS = `id, company_id, seq, number, date::text AS date, memo, kind, currency, fx_rate::text AS fx_rate, book_currency, total_minor,
  lines, source_key, source, status, reverses_id, reversed_by_id, posted_by, prev_hash, hash, created_at`;

function mapJournal(r: Record<string, unknown>): Journal {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    seq: num(r.seq),
    number: String(r.number),
    date: String(r.date),
    memo: String(r.memo ?? ""),
    kind: String(r.kind) as JournalKind,
    currency: String(r.currency),
    fxRate: numOrNull(r.fx_rate),
    bookCurrency: String(r.book_currency),
    totalMinor: num(r.total_minor),
    lines: (Array.isArray(r.lines) ? r.lines : JSON.parse(String(r.lines ?? "[]"))) as JournalLine[],
    sourceKey: String(r.source_key),
    source: (typeof r.source === "string" ? JSON.parse(r.source) : r.source ?? {}) as JournalSource,
    status: String(r.status) as Journal["status"],
    reversesId: str(r.reverses_id),
    reversedById: str(r.reversed_by_id),
    postedBy: (typeof r.posted_by === "string" ? JSON.parse(r.posted_by) : r.posted_by ?? {}) as Record<string, unknown>,
    prevHash: String(r.prev_hash),
    hash: String(r.hash),
    createdAt: iso(r.created_at),
  };
}

export async function lastJournal(db: Db, companyId: string): Promise<{ seq: number; hash: string } | null> {
  const rows = await db.query<{ seq: string; hash: string }>(
    `SELECT seq, hash FROM ${N}.journals WHERE company_id = $1 ORDER BY seq DESC LIMIT 1`,
    [companyId],
  );
  return rows[0] ? { seq: num(rows[0].seq), hash: String(rows[0].hash) } : null;
}

/** Returns false when a journal with this source key already exists (idempotent). A seq clash throws. */
export async function insertJournal(db: Db, j: Journal): Promise<boolean> {
  const res = await db.execute(
    `INSERT INTO ${N}.journals (id, company_id, seq, number, date, memo, kind, currency, fx_rate, book_currency, total_minor, lines,
       source_key, source, status, reverses_id, posted_by, prev_hash, hash)
     VALUES ($1, $2, $3::bigint, $4, $5::date, $6, $7, $8, $9::numeric, $10, $11::bigint, $12::jsonb, $13, $14::jsonb, 'posted', $15, $16::jsonb, $17, $18)
     ON CONFLICT (company_id, source_key) DO NOTHING`,
    [
      j.id,
      j.companyId,
      j.seq,
      j.number,
      j.date,
      j.memo,
      j.kind,
      j.currency,
      j.fxRate == null ? null : String(j.fxRate),
      j.bookCurrency,
      j.totalMinor,
      json(j.lines),
      j.sourceKey,
      json(j.source),
      j.reversesId,
      json(j.postedBy),
      j.prevHash,
      j.hash,
    ],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function journalBySourceKey(db: Db, companyId: string, sourceKey: string): Promise<Journal | null> {
  const rows = await db.query<Record<string, unknown>>(`SELECT ${JOURNAL_COLUMNS} FROM ${N}.journals WHERE company_id = $1 AND source_key = $2`, [companyId, sourceKey]);
  return rows[0] ? mapJournal(rows[0]) : null;
}

export async function journalById(db: Db, companyId: string, id: string): Promise<Journal | null> {
  const rows = await db.query<Record<string, unknown>>(`SELECT ${JOURNAL_COLUMNS} FROM ${N}.journals WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return rows[0] ? mapJournal(rows[0]) : null;
}

export async function journalsByIds(db: Db, companyId: string, ids: string[]): Promise<Journal[]> {
  if (ids.length === 0) return [];
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${JOURNAL_COLUMNS} FROM ${N}.journals WHERE company_id = $1 AND id IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    [companyId, json(ids)],
  );
  return rows.map(mapJournal);
}

export async function reversalOf(db: Db, companyId: string, journalId: string): Promise<Journal | null> {
  const rows = await db.query<Record<string, unknown>>(`SELECT ${JOURNAL_COLUMNS} FROM ${N}.journals WHERE company_id = $1 AND reverses_id = $2 LIMIT 1`, [companyId, journalId]);
  return rows[0] ? mapJournal(rows[0]) : null;
}

export async function markReversed(db: Db, companyId: string, id: string, reversedById: string): Promise<void> {
  await db.execute(
    `UPDATE ${N}.journals SET status = 'reversed', reversed_by_id = $3 WHERE company_id = $1 AND id = $2 AND status = 'posted'`,
    [companyId, id, reversedById],
  );
}

export interface JournalFilter {
  from?: string | null;
  to?: string | null;
  kind?: string | null;
  search?: string | null;
  accountId?: string | null;
  limit?: number;
  offset?: number;
}

export async function listJournals(db: Db, companyId: string, f: JournalFilter = {}): Promise<{ journals: Journal[]; total: number }> {
  const params: unknown[] = [companyId];
  const where = ["company_id = $1"];
  if (f.from) {
    params.push(f.from);
    where.push(`date >= $${params.length}::date`);
  }
  if (f.to) {
    params.push(f.to);
    where.push(`date <= $${params.length}::date`);
  }
  if (f.kind) {
    params.push(f.kind);
    where.push(`kind = $${params.length}`);
  }
  if (f.search) {
    params.push(`%${f.search.toLowerCase()}%`);
    where.push(`(lower(memo) LIKE $${params.length} OR lower(number) LIKE $${params.length} OR lower(source_key) LIKE $${params.length})`);
  }
  if (f.accountId) {
    params.push(json([{ accountId: f.accountId }]));
    where.push(`lines @> $${params.length}::jsonb`);
  }
  const limit = Math.max(1, Math.min(f.limit ?? 50, 500));
  const offset = Math.max(0, f.offset ?? 0);
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${JOURNAL_COLUMNS}, count(*) OVER () AS total FROM ${N}.journals WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return { journals: rows.map(mapJournal), total: rows[0] ? num(rows[0].total) : 0 };
}

export async function journalsForChain(db: Db, companyId: string, afterSeq: number, limit: number): Promise<Journal[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${JOURNAL_COLUMNS} FROM ${N}.journals WHERE company_id = $1 AND seq > $2::bigint ORDER BY seq LIMIT ${Math.max(1, Math.min(limit, 2000))}`,
    [companyId, afterSeq],
  );
  return rows.map(mapJournal);
}

export async function journalsInRange(db: Db, companyId: string, from: string, to: string): Promise<Journal[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${JOURNAL_COLUMNS} FROM ${N}.journals WHERE company_id = $1 AND date >= $2::date AND date <= $3::date ORDER BY seq`,
    [companyId, from, to],
  );
  return rows.map(mapJournal);
}

export async function journalsWithSourcePrefix(db: Db, companyId: string, prefix: string): Promise<Journal[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${JOURNAL_COLUMNS} FROM ${N}.journals WHERE company_id = $1 AND starts_with(source_key, $2) ORDER BY seq`,
    [companyId, prefix],
  );
  return rows.map(mapJournal);
}

/** The first rate a posted journal for this Billing document used (for FX revaluation). */
export async function bookedRateFor(db: Db, companyId: string, sourceId: string): Promise<number | null> {
  const rows = await db.query<{ fx_rate: string | null }>(
    `SELECT fx_rate::text AS fx_rate FROM ${N}.journals
      WHERE company_id = $1 AND source->>'id' = $2 AND fx_rate IS NOT NULL AND reverses_id IS NULL AND kind <> 'fx_revaluation'
      ORDER BY seq LIMIT 1`,
    [companyId, sourceId],
  );
  return numOrNull(rows[0]?.fx_rate);
}

// ---------------------------------------------------------------------------
// Report aggregates (jsonb_array_elements over journal lines)
// ---------------------------------------------------------------------------

export async function accountTotals(db: Db, companyId: string, range: { from?: string | null; to?: string | null } = {}): Promise<AccountTotals[]> {
  const params: unknown[] = [companyId];
  const where = ["j.company_id = $1"];
  if (range.from) {
    params.push(range.from);
    where.push(`j.date >= $${params.length}::date`);
  }
  if (range.to) {
    params.push(range.to);
    where.push(`j.date <= $${params.length}::date`);
  }
  const rows = await db.query<{ account_id: string; debit: string; credit: string }>(
    `SELECT l->>'accountId' AS account_id,
            COALESCE(sum((l->>'debitMinor')::bigint), 0)::text AS debit,
            COALESCE(sum((l->>'creditMinor')::bigint), 0)::text AS credit
       FROM ${N}.journals j CROSS JOIN LATERAL jsonb_array_elements(j.lines) AS l
      WHERE ${where.join(" AND ")}
      GROUP BY l->>'accountId'`,
    params,
  );
  return rows.map((r) => ({ accountId: String(r.account_id), debitMinor: num(r.debit), creditMinor: num(r.credit) }));
}

export async function monthlyTotals(db: Db, companyId: string, from: string, to: string): Promise<Array<AccountTotals & { month: string }>> {
  const rows = await db.query<{ month: string; account_id: string; debit: string; credit: string }>(
    `SELECT to_char(j.date, 'YYYY-MM') AS month, l->>'accountId' AS account_id,
            COALESCE(sum((l->>'debitMinor')::bigint), 0)::text AS debit,
            COALESCE(sum((l->>'creditMinor')::bigint), 0)::text AS credit
       FROM ${N}.journals j CROSS JOIN LATERAL jsonb_array_elements(j.lines) AS l
      WHERE j.company_id = $1 AND j.date >= $2::date AND j.date <= $3::date
      GROUP BY 1, 2`,
    [companyId, from, to],
  );
  return rows.map((r) => ({ month: String(r.month), accountId: String(r.account_id), debitMinor: num(r.debit), creditMinor: num(r.credit) }));
}

export async function glEntries(db: Db, companyId: string, accountId: string, from: string, to: string, limit = 5000): Promise<GlEntry[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT j.id, j.number, j.date::text AS date, j.memo, l->>'memo' AS line_memo,
            COALESCE((l->>'debitMinor')::bigint, 0)::text AS debit, COALESCE((l->>'creditMinor')::bigint, 0)::text AS credit
       FROM ${N}.journals j CROSS JOIN LATERAL jsonb_array_elements(j.lines) AS l
      WHERE j.company_id = $1 AND l->>'accountId' = $2 AND j.date >= $3::date AND j.date <= $4::date
      ORDER BY j.date, j.seq
      LIMIT ${Math.max(1, Math.min(limit, 20000))}`,
    [companyId, accountId, from, to],
  );
  return rows.map((r) => ({
    journalId: String(r.id),
    number: String(r.number),
    date: String(r.date),
    memo: String(r.memo ?? ""),
    lineMemo: str(r.line_memo),
    debitMinor: num(r.debit),
    creditMinor: num(r.credit),
  }));
}

export interface VatLineRow {
  journalId: string;
  journalNumber: string;
  sourceKind: string | null;
  accountId: string;
  debitMinor: number;
  creditMinor: number;
  taxCode: string | null;
  taxBaseMinor: number | null;
}

/** Lines of journals in the range that carry a tax code or touch a VAT account. */
export async function vatLines(db: Db, companyId: string, from: string, to: string, vatAccountIds: string[]): Promise<VatLineRow[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT j.id, j.number, j.source->>'kind' AS source_kind, l->>'accountId' AS account_id,
            COALESCE((l->>'debitMinor')::bigint, 0)::text AS debit, COALESCE((l->>'creditMinor')::bigint, 0)::text AS credit,
            l->>'taxCode' AS tax_code, l->>'taxBaseMinor' AS tax_base
       FROM ${N}.journals j CROSS JOIN LATERAL jsonb_array_elements(j.lines) AS l
      WHERE j.company_id = $1 AND j.date >= $2::date AND j.date <= $3::date
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(j.lines) AS x
           WHERE x->>'taxCode' IS NOT NULL OR x->>'accountId' IN (SELECT jsonb_array_elements_text($4::jsonb))
        )
      ORDER BY j.seq`,
    [companyId, from, to, json(vatAccountIds)],
  );
  return rows.map((r) => ({
    journalId: String(r.id),
    journalNumber: String(r.number),
    sourceKind: str(r.source_kind),
    accountId: String(r.account_id),
    debitMinor: num(r.debit),
    creditMinor: num(r.credit),
    taxCode: str(r.tax_code),
    taxBaseMinor: numOrNull(r.tax_base),
  }));
}

/** Posted journals on a chart account (not yet linked to a bank line), with their net effect on it. */
export async function unlinkedBankJournals(db: Db, companyId: string, accountId: string, from: string, to: string) {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT j.id, j.number, j.date::text AS date, j.memo,
            (COALESCE(sum((l->>'debitMinor')::bigint), 0) - COALESCE(sum((l->>'creditMinor')::bigint), 0))::text AS amount
       FROM ${N}.journals j CROSS JOIN LATERAL jsonb_array_elements(j.lines) AS l
      WHERE j.company_id = $1 AND l->>'accountId' = $2 AND j.date >= $3::date AND j.date <= $4::date
        AND j.status = 'posted' AND j.reverses_id IS NULL AND j.kind <> 'opening'
        AND NOT EXISTS (SELECT 1 FROM ${N}.bank_lines b WHERE b.journal_id = j.id)
      GROUP BY j.id, j.number, j.date, j.memo`,
    [companyId, accountId, from, to],
  );
  return rows.map((r) => ({ journalId: String(r.id), number: String(r.number), date: String(r.date), memo: String(r.memo ?? ""), amountMinor: num(r.amount) }));
}

// ---------------------------------------------------------------------------
// Manual journal drafts
// ---------------------------------------------------------------------------

export interface DraftRow {
  id: string;
  companyId: string;
  date: string;
  memo: string;
  currency: string;
  fxRate: number | null;
  lines: Array<Record<string, unknown>>;
  status: string;
  approvalIssueId: string | null;
  createdBy: Record<string, unknown>;
  approvedBy: string | null;
  journalId: string | null;
  error: string | null;
  createdAt: string | null;
}

function mapDraft(r: Record<string, unknown>): DraftRow {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    date: String(r.date),
    memo: String(r.memo ?? ""),
    currency: String(r.currency),
    fxRate: numOrNull(r.fx_rate),
    lines: (Array.isArray(r.lines) ? r.lines : JSON.parse(String(r.lines ?? "[]"))) as Array<Record<string, unknown>>,
    status: String(r.status),
    approvalIssueId: str(r.approval_issue_id),
    createdBy: (typeof r.created_by === "string" ? JSON.parse(r.created_by) : r.created_by ?? {}) as Record<string, unknown>,
    approvedBy: str(r.approved_by),
    journalId: str(r.journal_id),
    error: str(r.error),
    createdAt: iso(r.created_at),
  };
}

const DRAFT_COLUMNS = `id, company_id, date::text AS date, memo, currency, fx_rate::text AS fx_rate, lines, status, approval_issue_id, created_by, approved_by, journal_id, error, created_at`;

export async function insertDraft(db: Db, d: DraftRow): Promise<void> {
  await db.execute(
    `INSERT INTO ${N}.journal_drafts (id, company_id, date, memo, currency, fx_rate, lines, status, created_by)
     VALUES ($1, $2, $3::date, $4, $5, $6::numeric, $7::jsonb, $8, $9::jsonb)`,
    [d.id, d.companyId, d.date, d.memo, d.currency, d.fxRate == null ? null : String(d.fxRate), json(d.lines), d.status, json(d.createdBy)],
  );
}

export async function updateDraftContent(db: Db, companyId: string, id: string, d: { date: string; memo: string; currency: string; fxRate: number | null; lines: unknown[] }): Promise<boolean> {
  const res = await db.execute(
    `UPDATE ${N}.journal_drafts SET date = $3::date, memo = $4, currency = $5, fx_rate = $6::numeric, lines = $7::jsonb, error = NULL, updated_at = now()
      WHERE company_id = $1 AND id = $2 AND status = 'draft'`,
    [companyId, id, d.date, d.memo, d.currency, d.fxRate == null ? null : String(d.fxRate), json(d.lines)],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function setDraftStatus(
  db: Db,
  companyId: string,
  id: string,
  from: string[],
  patch: { status: string; approvalIssueId?: string | null; approvedBy?: string | null; journalId?: string | null; error?: string | null },
): Promise<boolean> {
  const res = await db.execute(
    `UPDATE ${N}.journal_drafts
        SET status = $3,
            approval_issue_id = COALESCE($4, approval_issue_id),
            approved_by = COALESCE($5, approved_by),
            journal_id = COALESCE($6, journal_id),
            error = $7,
            updated_at = now()
      WHERE company_id = $1 AND id = $2 AND status IN (SELECT jsonb_array_elements_text($8::jsonb))`,
    [companyId, id, patch.status, patch.approvalIssueId ?? null, patch.approvedBy ?? null, patch.journalId ?? null, patch.error ?? null, json(from)],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function getDraft(db: Db, companyId: string, id: string): Promise<DraftRow | null> {
  const rows = await db.query<Record<string, unknown>>(`SELECT ${DRAFT_COLUMNS} FROM ${N}.journal_drafts WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return rows[0] ? mapDraft(rows[0]) : null;
}

export async function listDrafts(db: Db, companyId: string, statuses: string[] = ["draft", "pending_approval", "rejected"]): Promise<DraftRow[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${DRAFT_COLUMNS} FROM ${N}.journal_drafts WHERE company_id = $1 AND status IN (SELECT jsonb_array_elements_text($2::jsonb)) ORDER BY created_at DESC LIMIT 200`,
    [companyId, json(statuses)],
  );
  return rows.map(mapDraft);
}

export async function pendingDrafts(db: Db): Promise<DraftRow[]> {
  const rows = await db.query<Record<string, unknown>>(`SELECT ${DRAFT_COLUMNS} FROM ${N}.journal_drafts WHERE status = 'pending_approval' ORDER BY created_at LIMIT 200`);
  return rows.map(mapDraft);
}

// ---------------------------------------------------------------------------
// Rejected postings and the inbox
// ---------------------------------------------------------------------------

export interface RejectionRow {
  key: string;
  event: string;
  source: Record<string, unknown>;
  payload: Record<string, unknown>;
  error: string;
  attempts: number;
  status: string;
  journalId: string | null;
  firstAt: string | null;
  lastAt: string | null;
}

/** Returns true when this is the first time the key was rejected (a new row). */
export async function upsertRejection(db: Db, companyId: string, r: { key: string; event: string; source: unknown; payload: unknown; error: string }): Promise<boolean> {
  const existing = await db.query<{ status: string }>(`SELECT status FROM ${N}.posting_rejections WHERE company_id = $1 AND key = $2`, [companyId, r.key]);
  await db.execute(
    `INSERT INTO ${N}.posting_rejections AS r (company_id, key, event, source, payload, error)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
     ON CONFLICT (company_id, key) DO UPDATE
       SET error = EXCLUDED.error, payload = EXCLUDED.payload, attempts = r.attempts + 1,
           status = 'open', last_at = now(), resolved_at = NULL`,
    [companyId, r.key, r.event, json(r.source), json(r.payload), r.error],
  );
  return !existing[0] || existing[0].status !== "open";
}

export async function resolveRejection(db: Db, companyId: string, key: string, status: "resolved" | "dismissed", journalId: string | null): Promise<void> {
  await db.execute(
    `UPDATE ${N}.posting_rejections SET status = $3, journal_id = $4, resolved_at = now() WHERE company_id = $1 AND key = $2 AND status = 'open'`,
    [companyId, key, status, journalId],
  );
}

export async function listRejections(db: Db, companyId: string, status = "open"): Promise<RejectionRow[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT key, event, source, payload, error, attempts, status, journal_id, first_at, last_at
       FROM ${N}.posting_rejections WHERE company_id = $1 AND status = $2 ORDER BY last_at DESC LIMIT 200`,
    [companyId, status],
  );
  return rows.map((r) => ({
    key: String(r.key),
    event: String(r.event),
    source: (r.source ?? {}) as Record<string, unknown>,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    error: String(r.error),
    attempts: num(r.attempts),
    status: String(r.status),
    journalId: str(r.journal_id),
    firstAt: iso(r.first_at),
    lastAt: iso(r.last_at),
  }));
}

export async function getRejection(db: Db, companyId: string, key: string): Promise<RejectionRow | null> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT key, event, source, payload, error, attempts, status, journal_id, first_at, last_at FROM ${N}.posting_rejections WHERE company_id = $1 AND key = $2`,
    [companyId, key],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    key: String(r.key),
    event: String(r.event),
    source: (r.source ?? {}) as Record<string, unknown>,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    error: String(r.error),
    attempts: num(r.attempts),
    status: String(r.status),
    journalId: str(r.journal_id),
    firstAt: iso(r.first_at),
    lastAt: iso(r.last_at),
  };
}

export async function inboxResult(db: Db, key: string): Promise<Record<string, unknown> | null> {
  const rows = await db.query<{ result: Record<string, unknown> | null }>(`SELECT result FROM ${N}.inbox WHERE key = $1`, [key]);
  return rows[0]?.result ?? null;
}

export async function deleteInbox(db: Db, key: string): Promise<void> {
  await db.execute(`DELETE FROM ${N}.inbox WHERE key = $1`, [key]);
}

export async function setInboxResult(db: Db, companyId: string, key: string, event: string, result: unknown): Promise<void> {
  await db.execute(
    `INSERT INTO ${N}.inbox (key, company_id, event, result) VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (key) DO UPDATE SET result = EXCLUDED.result`,
    [key, companyId, event, json(result)],
  );
}

// ---------------------------------------------------------------------------
// Open items (projection of Billing's receivables and payables)
// ---------------------------------------------------------------------------

export interface OpenItemRow {
  key: string;
  kind: "receivable" | "payable";
  itemId: string;
  number: string;
  counterpartyName: string;
  clientKind: string | null;
  clientRef: string | null;
  currency: string;
  totalMinor: number;
  outstandingMinor: number;
  issueDate: string | null;
  dueDate: string | null;
  refs: string[];
  status: string;
  sourcePlugin: string;
  updatedAt: string | null;
}

function mapOpenItem(r: Record<string, unknown>): OpenItemRow {
  return {
    key: String(r.key),
    kind: String(r.kind) as OpenItemRow["kind"],
    itemId: String(r.item_id),
    number: String(r.number ?? ""),
    counterpartyName: String(r.counterparty_name ?? ""),
    clientKind: str(r.client_kind),
    clientRef: str(r.client_ref),
    currency: String(r.currency),
    totalMinor: num(r.total_minor),
    outstandingMinor: num(r.outstanding_minor),
    issueDate: str(r.issue_date),
    dueDate: str(r.due_date),
    refs: (Array.isArray(r.refs) ? r.refs : []).map(String),
    status: String(r.status ?? ""),
    sourcePlugin: String(r.source_plugin ?? ""),
    updatedAt: iso(r.source_updated_at),
  };
}

const OPEN_ITEM_COLUMNS = `key, kind, item_id, number, counterparty_name, client_kind, client_ref, currency, total_minor, outstanding_minor,
  issue_date::text AS issue_date, due_date::text AS due_date, refs, status, source_plugin, source_updated_at`;

/** Last `updatedAt` wins; an older event never overwrites a newer one. */
export async function upsertOpenItem(db: Db, companyId: string, item: Omit<OpenItemRow, "updatedAt"> & { updatedAt: string }): Promise<boolean> {
  const res = await db.execute(
    `INSERT INTO ${N}.open_items AS o (company_id, key, kind, item_id, number, counterparty_name, client_kind, client_ref, currency,
       total_minor, outstanding_minor, issue_date, due_date, refs, status, source_plugin, source_updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::bigint, $11::bigint, $12::date, $13::date, $14::jsonb, $15, $16, $17::timestamptz)
     ON CONFLICT (company_id, key) DO UPDATE SET
       kind = EXCLUDED.kind, item_id = EXCLUDED.item_id, number = EXCLUDED.number, counterparty_name = EXCLUDED.counterparty_name,
       client_kind = EXCLUDED.client_kind, client_ref = EXCLUDED.client_ref, currency = EXCLUDED.currency,
       total_minor = EXCLUDED.total_minor, outstanding_minor = EXCLUDED.outstanding_minor, issue_date = EXCLUDED.issue_date,
       due_date = EXCLUDED.due_date, refs = EXCLUDED.refs, status = EXCLUDED.status, source_plugin = EXCLUDED.source_plugin,
       source_updated_at = EXCLUDED.source_updated_at, received_at = now()
     WHERE o.source_updated_at <= EXCLUDED.source_updated_at`,
    [
      companyId,
      item.key,
      item.kind,
      item.itemId,
      item.number,
      item.counterpartyName,
      item.clientKind,
      item.clientRef,
      item.currency,
      item.totalMinor,
      item.outstandingMinor,
      item.issueDate,
      item.dueDate,
      json(item.refs),
      item.status,
      item.sourcePlugin,
      item.updatedAt,
    ],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function listOpenItems(db: Db, companyId: string, f: { kind?: "receivable" | "payable" | null; openOnly?: boolean; currency?: string | null } = {}): Promise<OpenItemRow[]> {
  const params: unknown[] = [companyId];
  const where = ["company_id = $1"];
  if (f.kind) {
    params.push(f.kind);
    where.push(`kind = $${params.length}`);
  }
  if (f.openOnly !== false) where.push("outstanding_minor <> 0");
  if (f.currency) {
    params.push(f.currency);
    where.push(`currency = $${params.length}`);
  }
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${OPEN_ITEM_COLUMNS} FROM ${N}.open_items WHERE ${where.join(" AND ")} ORDER BY due_date NULLS LAST, number LIMIT 5000`,
    params,
  );
  return rows.map(mapOpenItem);
}

export async function getOpenItem(db: Db, companyId: string, key: string): Promise<OpenItemRow | null> {
  const rows = await db.query<Record<string, unknown>>(`SELECT ${OPEN_ITEM_COLUMNS} FROM ${N}.open_items WHERE company_id = $1 AND key = $2`, [companyId, key]);
  return rows[0] ? mapOpenItem(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Bank accounts, statements, lines, rules
// ---------------------------------------------------------------------------

export interface BankAccountRow {
  id: string;
  name: string;
  accountCode: string;
  bankName: string;
  numberLast4: string;
  currency: string;
  active: boolean;
}

function mapBankAccount(r: Record<string, unknown>): BankAccountRow {
  return {
    id: String(r.id),
    name: String(r.name),
    accountCode: String(r.account_code),
    bankName: String(r.bank_name ?? ""),
    numberLast4: String(r.number_last4 ?? ""),
    currency: String(r.currency),
    active: Boolean(r.active),
  };
}

export async function insertBankAccount(db: Db, companyId: string, b: BankAccountRow): Promise<void> {
  await db.execute(
    `INSERT INTO ${N}.bank_accounts (id, company_id, name, account_code, bank_name, number_last4, currency, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [b.id, companyId, b.name, b.accountCode, b.bankName, b.numberLast4, b.currency, b.active],
  );
}

export async function updateBankAccount(db: Db, companyId: string, b: BankAccountRow): Promise<boolean> {
  const res = await db.execute(
    `UPDATE ${N}.bank_accounts SET name = $3, account_code = $4, bank_name = $5, number_last4 = $6, active = $7, updated_at = now() WHERE company_id = $1 AND id = $2`,
    [companyId, b.id, b.name, b.accountCode, b.bankName, b.numberLast4, b.active],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function listBankAccounts(db: Db, companyId: string): Promise<BankAccountRow[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, name, account_code, bank_name, number_last4, currency, active FROM ${N}.bank_accounts WHERE company_id = $1 ORDER BY name`,
    [companyId],
  );
  return rows.map(mapBankAccount);
}

export async function getBankAccount(db: Db, companyId: string, id: string): Promise<BankAccountRow | null> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, name, account_code, bank_name, number_last4, currency, active FROM ${N}.bank_accounts WHERE company_id = $1 AND id = $2`,
    [companyId, id],
  );
  return rows[0] ? mapBankAccount(rows[0]) : null;
}

export interface StatementRow {
  id: string;
  bankAccountId: string;
  fileName: string;
  format: string;
  objectKey: string | null;
  digest: string;
  lineCount: number;
  newCount: number;
  duplicateCount: number;
  periodStart: string | null;
  periodEnd: string | null;
  openingMinor: number | null;
  closingMinor: number | null;
  createdAt: string | null;
}

export async function insertStatement(db: Db, companyId: string, s: StatementRow, importedBy: unknown): Promise<boolean> {
  const res = await db.execute(
    `INSERT INTO ${N}.statements (id, company_id, bank_account_id, file_name, format, object_key, content_digest, line_count, new_count, duplicate_count,
       period_start, period_end, opening_minor, closing_minor, imported_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12::date, $13::bigint, $14::bigint, $15::jsonb)
     ON CONFLICT (bank_account_id, content_digest) DO NOTHING`,
    [s.id, companyId, s.bankAccountId, s.fileName, s.format, s.objectKey, s.digest, s.lineCount, s.newCount, s.duplicateCount, s.periodStart, s.periodEnd, s.openingMinor, s.closingMinor, json(importedBy)],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function updateStatementCounts(db: Db, companyId: string, id: string, newCount: number, duplicateCount: number): Promise<void> {
  await db.execute(`UPDATE ${N}.statements SET new_count = $3, duplicate_count = $4 WHERE company_id = $1 AND id = $2`, [companyId, id, newCount, duplicateCount]);
}

function mapStatement(r: Record<string, unknown>): StatementRow {
  return {
    id: String(r.id),
    bankAccountId: String(r.bank_account_id),
    fileName: String(r.file_name ?? ""),
    format: String(r.format),
    objectKey: str(r.object_key),
    digest: String(r.content_digest),
    lineCount: num(r.line_count),
    newCount: num(r.new_count),
    duplicateCount: num(r.duplicate_count),
    periodStart: str(r.period_start),
    periodEnd: str(r.period_end),
    openingMinor: numOrNull(r.opening_minor),
    closingMinor: numOrNull(r.closing_minor),
    createdAt: iso(r.created_at),
  };
}

const STATEMENT_COLUMNS = `id, bank_account_id, file_name, format, object_key, content_digest, line_count, new_count, duplicate_count,
  period_start::text AS period_start, period_end::text AS period_end, opening_minor, closing_minor, created_at`;

export async function statementByDigest(db: Db, bankAccountId: string, digest: string): Promise<StatementRow | null> {
  const rows = await db.query<Record<string, unknown>>(`SELECT ${STATEMENT_COLUMNS} FROM ${N}.statements WHERE bank_account_id = $1 AND content_digest = $2`, [bankAccountId, digest]);
  return rows[0] ? mapStatement(rows[0]) : null;
}

/** Link a statement imported earlier to the uploaded file it came from, when it has none yet. */
export async function linkStatementObjectKey(db: Db, companyId: string, statementId: string, objectKey: string): Promise<void> {
  await db.execute(`UPDATE ${N}.statements SET object_key = $3 WHERE company_id = $1 AND id = $2 AND object_key IS NULL`, [companyId, statementId, objectKey]);
}

/** Which of these uploaded files already have an imported statement (a PDF links to the CSV rows read from it). */
export async function importedObjectKeys(db: Db, companyId: string, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db.query<{ object_key: string }>(
    `SELECT DISTINCT object_key FROM ${N}.statements WHERE company_id = $1 AND object_key IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    [companyId, JSON.stringify(keys)],
  );
  return new Set(rows.map((r) => String(r.object_key)));
}

export async function listStatements(db: Db, companyId: string, bankAccountId?: string | null): Promise<StatementRow[]> {
  const params: unknown[] = [companyId];
  let where = "company_id = $1";
  if (bankAccountId) {
    params.push(bankAccountId);
    where += " AND bank_account_id = $2";
  }
  const rows = await db.query<Record<string, unknown>>(`SELECT ${STATEMENT_COLUMNS} FROM ${N}.statements WHERE ${where} ORDER BY created_at DESC LIMIT 100`, params);
  return rows.map(mapStatement);
}

// ---------------------------------------------------------------------------
// Statement emails from the Mailbox, and what became of each one
// ---------------------------------------------------------------------------

/**
 * received = waiting to be imported; imported = its lines are in the books; duplicate = imported before;
 * not_statement = no statement in it; closed = a person closed its issue without an import linked to it.
 */
export type StatementEmailStatus = "received" | "imported" | "duplicate" | "not_statement" | "closed";

export interface StatementEmailRow {
  messageId: string;
  subject: string;
  sender: string;
  receivedAt: string | null;
  issueId: string | null;
  status: StatementEmailStatus;
  statementIds: string[];
  note: string | null;
  resolvedBy: Record<string, unknown> | null;
  resolvedAt: string | null;
  createdAt: string | null;
}

const EMAIL_COLUMNS = "message_id, subject, sender, received_at, issue_id, status, statement_ids, note, resolved_by, resolved_at, created_at";

function mapStatementEmail(r: Record<string, unknown>): StatementEmailRow {
  return {
    messageId: String(r.message_id),
    subject: String(r.subject ?? ""),
    sender: String(r.sender ?? ""),
    receivedAt: iso(r.received_at),
    issueId: str(r.issue_id),
    status: String(r.status) as StatementEmailStatus,
    statementIds: Array.isArray(r.statement_ids) ? r.statement_ids.map(String) : [],
    note: str(r.note),
    resolvedBy: (r.resolved_by ?? null) as Record<string, unknown> | null,
    resolvedAt: iso(r.resolved_at),
    createdAt: iso(r.created_at),
  };
}

/** A statement email arrived. A repeat keeps the first row (true only the first time). */
export async function insertStatementEmail(db: Db, companyId: string, e: { messageId: string; subject: string; sender: string; receivedAt: string | null; issueId: string | null }): Promise<boolean> {
  const res = await db.execute(
    `INSERT INTO ${N}.statement_emails (company_id, message_id, subject, sender, received_at, issue_id)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6) ON CONFLICT (company_id, message_id) DO NOTHING`,
    [companyId, e.messageId, e.subject.slice(0, 200), e.sender.slice(0, 200), e.receivedAt, e.issueId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function getStatementEmail(db: Db, companyId: string, messageId: string): Promise<StatementEmailRow | null> {
  const rows = await db.query<Record<string, unknown>>(`SELECT ${EMAIL_COLUMNS} FROM ${N}.statement_emails WHERE company_id = $1 AND message_id = $2`, [companyId, messageId]);
  return rows[0] ? mapStatementEmail(rows[0]) : null;
}

/** Statement emails, newest first (only these statuses when given). */
export async function listStatementEmails(db: Db, companyId: string, statuses: StatementEmailStatus[] | null = null, limit = 50): Promise<StatementEmailRow[]> {
  const params: unknown[] = [companyId];
  let where = "company_id = $1";
  if (statuses?.length) {
    params.push(json(statuses));
    where += " AND status IN (SELECT jsonb_array_elements_text($2::jsonb))";
  }
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${EMAIL_COLUMNS} FROM ${N}.statement_emails WHERE ${where} ORDER BY COALESCE(received_at, created_at) DESC LIMIT ${Math.max(1, Math.min(limit, 500))}`,
    params,
  );
  return rows.map(mapStatementEmail);
}

/** Record what became of a statement email (a row is added when the email was never recorded). */
export async function saveStatementEmailOutcome(
  db: Db,
  companyId: string,
  messageId: string,
  o: { status: Exclude<StatementEmailStatus, "received">; statementIds: string[]; note: string | null; resolvedBy: unknown },
): Promise<void> {
  await db.execute(
    `INSERT INTO ${N}.statement_emails (company_id, message_id, status, statement_ids, note, resolved_by, resolved_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, now())
     ON CONFLICT (company_id, message_id) DO UPDATE SET status = EXCLUDED.status, statement_ids = EXCLUDED.statement_ids, note = EXCLUDED.note,
       resolved_by = EXCLUDED.resolved_by, resolved_at = now(), updated_at = now()`,
    [companyId, messageId, o.status, json(o.statementIds), o.note, json(o.resolvedBy)],
  );
}

// ---------------------------------------------------------------------------
// Month-end steps recorded as not needed (step: vat201 or reconciliation:<bankAccountId>)
// ---------------------------------------------------------------------------

export interface CloseSkipRow {
  month: string;
  step: string;
  reason: string;
  recordedBy: Record<string, unknown>;
  createdAt: string | null;
}

export async function saveCloseSkip(db: Db, companyId: string, s: { month: string; step: string; reason: string; recordedBy: unknown }): Promise<void> {
  await db.execute(
    `INSERT INTO ${N}.close_skips (company_id, month, step, reason, recorded_by) VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (company_id, month, step) DO UPDATE SET reason = EXCLUDED.reason, recorded_by = EXCLUDED.recorded_by, created_at = now()`,
    [companyId, s.month, s.step, s.reason, json(s.recordedBy)],
  );
}

export async function listCloseSkips(db: Db, companyId: string, month: string): Promise<CloseSkipRow[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT month, step, reason, recorded_by, created_at FROM ${N}.close_skips WHERE company_id = $1 AND month = $2 ORDER BY step`,
    [companyId, month],
  );
  return rows.map((r) => ({ month: String(r.month), step: String(r.step), reason: String(r.reason ?? ""), recordedBy: (r.recorded_by ?? {}) as Record<string, unknown>, createdAt: iso(r.created_at) }));
}

export interface BankLineRow {
  id: string;
  bankAccountId: string;
  statementId: string | null;
  date: string;
  amountMinor: number;
  description: string;
  reference: string | null;
  counterparty: string | null;
  balanceMinor: number | null;
  status: "unreconciled" | "matching" | "reconciled" | "excluded";
  suggestions: Suggestion[];
  jev: Record<string, unknown> | null;
  match: Record<string, unknown> | null;
  journalId: string | null;
  reconciliationId: string | null;
  note: string | null;
}

function mapLine(r: Record<string, unknown>): BankLineRow {
  return {
    id: String(r.id),
    bankAccountId: String(r.bank_account_id),
    statementId: str(r.statement_id),
    date: String(r.date),
    amountMinor: num(r.amount_minor),
    description: String(r.description ?? ""),
    reference: str(r.reference),
    counterparty: str(r.counterparty),
    balanceMinor: numOrNull(r.balance_minor),
    status: String(r.status) as BankLineRow["status"],
    suggestions: (Array.isArray(r.suggestions) ? r.suggestions : []) as Suggestion[],
    jev: (r.jev ?? null) as Record<string, unknown> | null,
    match: (r.match ?? null) as Record<string, unknown> | null,
    journalId: str(r.journal_id),
    reconciliationId: str(r.reconciliation_id),
    note: str(r.note),
  };
}

const LINE_COLUMNS = `id, bank_account_id, statement_id, date::text AS date, amount_minor, description, reference, counterparty, balance_minor,
  status, suggestions, jev, match, journal_id, reconciliation_id, note`;

export async function insertBankLines(db: Db, companyId: string, rows: Array<Record<string, unknown>>): Promise<number> {
  if (rows.length === 0) return 0;
  const res = await db.execute(
    `INSERT INTO ${N}.bank_lines (id, company_id, bank_account_id, statement_id, date, amount_minor, description, reference, counterparty, balance_minor, fingerprint)
     SELECT x.id, $1, x.bank_account_id, x.statement_id, x.date::date, x.amount_minor, x.description, x.reference, x.counterparty, x.balance_minor, x.fingerprint
       FROM jsonb_to_recordset($2::jsonb) AS x(id text, bank_account_id text, statement_id text, date text, amount_minor bigint, description text,
            reference text, counterparty text, balance_minor bigint, fingerprint text)
     ON CONFLICT (bank_account_id, fingerprint) DO NOTHING`,
    [companyId, json(rows)],
  );
  return res.rowCount ?? 0;
}

export interface LineFilter {
  bankAccountId?: string | null;
  statuses?: string[] | null;
  statementId?: string | null;
  from?: string | null;
  to?: string | null;
  ids?: string[] | null;
  limit?: number;
}

export async function listBankLines(db: Db, companyId: string, f: LineFilter = {}): Promise<BankLineRow[]> {
  const params: unknown[] = [companyId];
  const where = ["company_id = $1"];
  if (f.bankAccountId) {
    params.push(f.bankAccountId);
    where.push(`bank_account_id = $${params.length}`);
  }
  if (f.statuses?.length) {
    params.push(json(f.statuses));
    where.push(`status IN (SELECT jsonb_array_elements_text($${params.length}::jsonb))`);
  }
  if (f.statementId) {
    params.push(f.statementId);
    where.push(`statement_id = $${params.length}`);
  }
  if (f.from) {
    params.push(f.from);
    where.push(`date >= $${params.length}::date`);
  }
  if (f.to) {
    params.push(f.to);
    where.push(`date <= $${params.length}::date`);
  }
  if (f.ids?.length) {
    params.push(json(f.ids));
    where.push(`id IN (SELECT jsonb_array_elements_text($${params.length}::jsonb))`);
  }
  const limit = Math.max(1, Math.min(f.limit ?? 500, 5000));
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${LINE_COLUMNS} FROM ${N}.bank_lines WHERE ${where.join(" AND ")} ORDER BY date DESC, amount_minor LIMIT ${limit}`,
    params,
  );
  return rows.map(mapLine);
}

export async function getBankLine(db: Db, companyId: string, id: string): Promise<BankLineRow | null> {
  const rows = await db.query<Record<string, unknown>>(`SELECT ${LINE_COLUMNS} FROM ${N}.bank_lines WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return rows[0] ? mapLine(rows[0]) : null;
}

export async function setLineSuggestions(db: Db, companyId: string, id: string, suggestions: Suggestion[], jev?: unknown): Promise<void> {
  if (jev === undefined) {
    await db.execute(`UPDATE ${N}.bank_lines SET suggestions = $3::jsonb, updated_at = now() WHERE company_id = $1 AND id = $2`, [companyId, id, json(suggestions)]);
    return;
  }
  await db.execute(`UPDATE ${N}.bank_lines SET suggestions = $3::jsonb, jev = $4::jsonb, updated_at = now() WHERE company_id = $1 AND id = $2`, [
    companyId,
    id,
    json(suggestions),
    json(jev),
  ]);
}

/** Store suggestions for many lines in one statement (jev only where `setJev`). */
export async function setSuggestionsBatch(db: Db, companyId: string, rows: Array<{ id: string; suggestions: Suggestion[]; jev?: unknown }>): Promise<number> {
  if (rows.length === 0) return 0;
  const payload = rows.map((r) => ({ id: r.id, suggestions: r.suggestions, jev: r.jev ?? null, set_jev: r.jev !== undefined }));
  const res = await db.execute(
    `UPDATE ${N}.bank_lines AS b
        SET suggestions = x.suggestions, jev = CASE WHEN x.set_jev THEN x.jev ELSE b.jev END, updated_at = now()
       FROM jsonb_to_recordset($2::jsonb) AS x(id text, suggestions jsonb, jev jsonb, set_jev boolean)
      WHERE b.company_id = $1 AND b.id = x.id AND b.status = 'unreconciled'`,
    [companyId, json(payload)],
  );
  return res.rowCount ?? 0;
}

/** Move a line between states; `from` guards against double accepts. */
export async function setLineState(
  db: Db,
  companyId: string,
  id: string,
  from: string[],
  patch: { status: string; match?: unknown; journalId?: string | null; note?: string | null },
): Promise<boolean> {
  const res = await db.execute(
    `UPDATE ${N}.bank_lines SET status = $3, match = $4::jsonb, journal_id = $5, note = $6, updated_at = now()
      WHERE company_id = $1 AND id = $2 AND reconciliation_id IS NULL AND status IN (SELECT jsonb_array_elements_text($7::jsonb))`,
    [companyId, id, patch.status, json(patch.match ?? null), patch.journalId ?? null, patch.note ?? null, json(from)],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function linesForJournalMatch(db: Db, companyId: string, ids: string[]): Promise<BankLineRow[]> {
  return listBankLines(db, companyId, { ids, limit: 200 });
}

export async function lockLinesToReconciliation(db: Db, companyId: string, bankAccountId: string, from: string, to: string, reconciliationId: string): Promise<number> {
  const res = await db.execute(
    `UPDATE ${N}.bank_lines SET reconciliation_id = $5, updated_at = now()
      WHERE company_id = $1 AND bank_account_id = $2 AND date >= $3::date AND date <= $4::date AND reconciliation_id IS NULL`,
    [companyId, bankAccountId, from, to, reconciliationId],
  );
  return res.rowCount ?? 0;
}

export async function lineCounts(db: Db, companyId: string): Promise<Record<string, number>> {
  const rows = await db.query<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM ${N}.bank_lines WHERE company_id = $1 GROUP BY status`,
    [companyId],
  );
  return Object.fromEntries(rows.map((r) => [String(r.status), num(r.n)]));
}

export interface DatedAfterItem {
  kind: "bank_line" | "journal";
  id: string;
  date: string;
  label: string;
  amountMinor: number;
}

/**
 * Journals and bank lines dated after `today`. They count in no "as at
 * today" figure (cash, receivables, this month, charts) and are flagged for a
 * person to check the date. Also how many journals the book has.
 */
export async function datedAfter(db: Db, companyId: string, today: string, limit = 20): Promise<{ journalCount: number; items: DatedAfterItem[]; journals: number; bankLines: number }> {
  const counts = await db.query<{ journals_all: string; journals_future: string; lines_future: string }>(
    `SELECT (SELECT count(*) FROM ${N}.journals WHERE company_id = $1)::text AS journals_all,
            (SELECT count(*) FROM ${N}.journals WHERE company_id = $1 AND date > $2::date)::text AS journals_future,
            (SELECT count(*) FROM ${N}.bank_lines WHERE company_id = $1 AND date > $2::date)::text AS lines_future`,
    [companyId, today],
  );
  const journals = num(counts[0]?.journals_future);
  const bankLines = num(counts[0]?.lines_future);
  if (!journals && !bankLines) return { journalCount: num(counts[0]?.journals_all), items: [], journals, bankLines };
  const rows = await db.query<{ kind: string; id: string; date: string; label: string | null; amount: string | null }>(
    `SELECT kind, id, date, label, amount FROM (
       SELECT 'bank_line' AS kind, b.id, b.date::text AS date, b.description AS label, b.amount_minor::text AS amount
         FROM ${N}.bank_lines b WHERE b.company_id = $1 AND b.date > $2::date
       UNION ALL
       SELECT 'journal' AS kind, j.id, j.date::text AS date, j.number AS label, j.total_minor::text AS amount
         FROM ${N}.journals j WHERE j.company_id = $1 AND j.date > $2::date
     ) f ORDER BY date, kind LIMIT ${Math.max(1, Math.min(limit, 100))}`,
    [companyId, today],
  );
  return {
    journalCount: num(counts[0]?.journals_all),
    journals,
    bankLines,
    items: rows.map((r) => ({ kind: r.kind === "journal" ? "journal" : "bank_line", id: String(r.id), date: String(r.date), label: String(r.label ?? ""), amountMinor: num(r.amount) })),
  };
}

/** Bank lines per bank account and status (for the reconciliation bars). */
export async function lineCountsByAccount(db: Db, companyId: string): Promise<Array<{ bankAccountId: string; status: string; count: number }>> {
  const rows = await db.query<{ bank_account_id: string; status: string; n: string }>(
    `SELECT bank_account_id, status, count(*)::text AS n FROM ${N}.bank_lines WHERE company_id = $1 GROUP BY bank_account_id, status`,
    [companyId],
  );
  return rows.map((r) => ({ bankAccountId: String(r.bank_account_id), status: String(r.status), count: num(r.n) }));
}

export async function unreconciledInMonth(db: Db, companyId: string, from: string, to: string): Promise<number> {
  const rows = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${N}.bank_lines WHERE company_id = $1 AND date >= $2::date AND date <= $3::date AND status IN ('unreconciled', 'matching')`,
    [companyId, from, to],
  );
  return num(rows[0]?.n);
}

function mapRule(r: Record<string, unknown>): BankRule {
  return {
    id: String(r.id),
    name: String(r.name),
    priority: num(r.priority),
    active: Boolean(r.active),
    field: String(r.field) as BankRule["field"],
    operator: String(r.operator) as BankRule["operator"],
    value: String(r.value ?? ""),
    amountMinMinor: numOrNull(r.amount_min_minor),
    amountMaxMinor: numOrNull(r.amount_max_minor),
    direction: String(r.direction) as BankRule["direction"],
    accountCode: String(r.account_code),
    taxCode: str(r.tax_code),
    counterparty: str(r.counterparty),
  };
}

export async function listRules(db: Db, companyId: string): Promise<BankRule[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, name, priority, active, field, operator, value, amount_min_minor, amount_max_minor, direction, account_code, tax_code, counterparty
       FROM ${N}.bank_rules WHERE company_id = $1 ORDER BY priority, name`,
    [companyId],
  );
  return rows.map(mapRule);
}

export async function upsertRule(db: Db, companyId: string, r: BankRule): Promise<void> {
  await db.execute(
    `INSERT INTO ${N}.bank_rules AS b (id, company_id, name, priority, active, field, operator, value, amount_min_minor, amount_max_minor, direction, account_code, tax_code, counterparty)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::bigint, $10::bigint, $11, $12, $13, $14)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, priority = EXCLUDED.priority, active = EXCLUDED.active, field = EXCLUDED.field,
       operator = EXCLUDED.operator, value = EXCLUDED.value, amount_min_minor = EXCLUDED.amount_min_minor, amount_max_minor = EXCLUDED.amount_max_minor,
       direction = EXCLUDED.direction, account_code = EXCLUDED.account_code, tax_code = EXCLUDED.tax_code, counterparty = EXCLUDED.counterparty, updated_at = now()
     WHERE b.company_id = EXCLUDED.company_id`,
    [r.id, companyId, r.name, r.priority, r.active, r.field, r.operator, r.value, r.amountMinMinor, r.amountMaxMinor, r.direction, r.accountCode, r.taxCode, r.counterparty],
  );
}

export async function deleteRule(db: Db, companyId: string, id: string): Promise<boolean> {
  const res = await db.execute(`DELETE FROM ${N}.bank_rules WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return (res.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Reconciliations
// ---------------------------------------------------------------------------

export interface ReconciliationRow {
  id: string;
  bankAccountId: string;
  periodStart: string;
  periodEnd: string;
  openingMinor: number;
  closingMinor: number;
  linesTotalMinor: number;
  differenceMinor: number;
  unreconciledCount: number;
  glBalanceMinor: number;
  status: "draft" | "pending_approval" | "locked";
  approvalIssueId: string | null;
  approvedBy: string | null;
  lockedAt: string | null;
  companyId: string;
}

function mapRec(r: Record<string, unknown>): ReconciliationRow {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    bankAccountId: String(r.bank_account_id),
    periodStart: String(r.period_start),
    periodEnd: String(r.period_end),
    openingMinor: num(r.opening_minor),
    closingMinor: num(r.closing_minor),
    linesTotalMinor: num(r.lines_total_minor),
    differenceMinor: num(r.difference_minor),
    unreconciledCount: num(r.unreconciled_count),
    glBalanceMinor: num(r.gl_balance_minor),
    status: String(r.status) as ReconciliationRow["status"],
    approvalIssueId: str(r.approval_issue_id),
    approvedBy: str(r.approved_by),
    lockedAt: iso(r.locked_at),
  };
}

const REC_COLUMNS = `id, company_id, bank_account_id, period_start::text AS period_start, period_end::text AS period_end, opening_minor, closing_minor,
  lines_total_minor, difference_minor, unreconciled_count, gl_balance_minor, status, approval_issue_id, approved_by, locked_at`;

export async function upsertReconciliation(db: Db, companyId: string, r: Omit<ReconciliationRow, "approvalIssueId" | "approvedBy" | "lockedAt" | "status" | "companyId">, preparedBy: unknown): Promise<boolean> {
  const res = await db.execute(
    `INSERT INTO ${N}.reconciliations AS r (id, company_id, bank_account_id, period_start, period_end, opening_minor, closing_minor, lines_total_minor,
       difference_minor, unreconciled_count, gl_balance_minor, prepared_by)
     VALUES ($1, $2, $3, $4::date, $5::date, $6::bigint, $7::bigint, $8::bigint, $9::bigint, $10, $11::bigint, $12::jsonb)
     ON CONFLICT (bank_account_id, period_start, period_end) DO UPDATE SET
       opening_minor = EXCLUDED.opening_minor, closing_minor = EXCLUDED.closing_minor, lines_total_minor = EXCLUDED.lines_total_minor,
       difference_minor = EXCLUDED.difference_minor, unreconciled_count = EXCLUDED.unreconciled_count, gl_balance_minor = EXCLUDED.gl_balance_minor,
       prepared_by = EXCLUDED.prepared_by, updated_at = now()
     WHERE r.status = 'draft' AND r.company_id = EXCLUDED.company_id`,
    [r.id, companyId, r.bankAccountId, r.periodStart, r.periodEnd, r.openingMinor, r.closingMinor, r.linesTotalMinor, r.differenceMinor, r.unreconciledCount, r.glBalanceMinor, json(preparedBy)],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function reconciliationByPeriod(db: Db, companyId: string, bankAccountId: string, start: string, end: string): Promise<ReconciliationRow | null> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${REC_COLUMNS} FROM ${N}.reconciliations WHERE company_id = $1 AND bank_account_id = $2 AND period_start = $3::date AND period_end = $4::date`,
    [companyId, bankAccountId, start, end],
  );
  return rows[0] ? mapRec(rows[0]) : null;
}

export async function getReconciliation(db: Db, companyId: string, id: string): Promise<ReconciliationRow | null> {
  const rows = await db.query<Record<string, unknown>>(`SELECT ${REC_COLUMNS} FROM ${N}.reconciliations WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return rows[0] ? mapRec(rows[0]) : null;
}

export async function listReconciliations(db: Db, companyId: string, bankAccountId?: string | null): Promise<ReconciliationRow[]> {
  const params: unknown[] = [companyId];
  let where = "company_id = $1";
  if (bankAccountId) {
    params.push(bankAccountId);
    where += " AND bank_account_id = $2";
  }
  const rows = await db.query<Record<string, unknown>>(`SELECT ${REC_COLUMNS} FROM ${N}.reconciliations WHERE ${where} ORDER BY period_end DESC LIMIT 200`, params);
  return rows.map(mapRec);
}

export async function pendingReconciliations(db: Db): Promise<ReconciliationRow[]> {
  const rows = await db.query<Record<string, unknown>>(`SELECT ${REC_COLUMNS} FROM ${N}.reconciliations WHERE status = 'pending_approval' LIMIT 200`);
  return rows.map(mapRec);
}

export async function setReconciliationStatus(db: Db, companyId: string, id: string, from: string, patch: { status: string; approvalIssueId?: string | null; approvedBy?: string | null; lock?: boolean }): Promise<boolean> {
  const res = await db.execute(
    `UPDATE ${N}.reconciliations SET status = $4, approval_issue_id = COALESCE($5, approval_issue_id), approved_by = COALESCE($6, approved_by),
            locked_at = CASE WHEN $7::boolean THEN now() ELSE locked_at END, updated_at = now()
      WHERE company_id = $1 AND id = $2 AND status = $3`,
    [companyId, id, from, patch.status, patch.approvalIssueId ?? null, patch.approvedBy ?? null, Boolean(patch.lock)],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function lockedReconciliationOverlaps(db: Db, companyId: string, bankAccountId: string, start: string, end: string): Promise<boolean> {
  const rows = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${N}.reconciliations
      WHERE company_id = $1 AND bank_account_id = $2 AND status = 'locked' AND period_start <= $4::date AND period_end >= $3::date`,
    [companyId, bankAccountId, start, end],
  );
  return num(rows[0]?.n) > 0;
}

/** Another reconciliation (any status) whose period overlaps this one without being the same period. */
export async function overlappingReconciliation(db: Db, companyId: string, bankAccountId: string, start: string, end: string): Promise<ReconciliationRow | null> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${REC_COLUMNS} FROM ${N}.reconciliations
      WHERE company_id = $1 AND bank_account_id = $2 AND period_start <= $4::date AND period_end >= $3::date
        AND NOT (period_start = $3::date AND period_end = $4::date)
      ORDER BY period_start LIMIT 1`,
    [companyId, bankAccountId, start, end],
  );
  return rows[0] ? mapRec(rows[0]) : null;
}

/** Remove a reconciliation that is not locked. True when a row went. */
export async function deleteReconciliation(db: Db, companyId: string, id: string): Promise<boolean> {
  const res = await db.execute(`DELETE FROM ${N}.reconciliations WHERE company_id = $1 AND id = $2 AND status <> 'locked'`, [companyId, id]);
  return (res.rowCount ?? 0) > 0;
}

/** Which of these line fingerprints are already stored for the bank account. */
export async function existingFingerprints(db: Db, bankAccountId: string, fingerprints: string[]): Promise<Set<string>> {
  if (fingerprints.length === 0) return new Set();
  const rows = await db.query<{ fingerprint: string }>(
    `SELECT fingerprint FROM ${N}.bank_lines WHERE bank_account_id = $1 AND fingerprint IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    [bankAccountId, JSON.stringify(fingerprints)],
  );
  return new Set(rows.map((r) => String(r.fingerprint)));
}

// ---------------------------------------------------------------------------
// VAT returns
// ---------------------------------------------------------------------------

export interface VatReturnRow {
  id: string;
  companyId: string;
  periodStart: string;
  periodEnd: string;
  status: "draft" | "pending_approval" | "locked";
  boxes: Record<string, number>;
  detail: unknown[];
  adjustments: Record<string, number>;
  approvalIssueId: string | null;
  approvedBy: string | null;
  preparedAt: string | null;
  lockedAt: string | null;
}

function mapVat(r: Record<string, unknown>): VatReturnRow {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    periodStart: String(r.period_start),
    periodEnd: String(r.period_end),
    status: String(r.status) as VatReturnRow["status"],
    boxes: (r.boxes ?? {}) as Record<string, number>,
    detail: (Array.isArray(r.detail) ? r.detail : []) as unknown[],
    adjustments: (r.adjustments ?? {}) as Record<string, number>,
    approvalIssueId: str(r.approval_issue_id),
    approvedBy: str(r.approved_by),
    preparedAt: iso(r.prepared_at),
    lockedAt: iso(r.locked_at),
  };
}

const VAT_COLUMNS = `id, company_id, period_start::text AS period_start, period_end::text AS period_end, status, boxes, detail, adjustments,
  approval_issue_id, approved_by, prepared_at, locked_at`;

export async function upsertVatReturn(db: Db, companyId: string, v: { id: string; periodStart: string; periodEnd: string; boxes: unknown; detail: unknown; adjustments: unknown }, preparedBy: unknown): Promise<boolean> {
  const res = await db.execute(
    `INSERT INTO ${N}.vat_returns AS v (id, company_id, period_start, period_end, boxes, detail, adjustments, prepared_by)
     VALUES ($1, $2, $3::date, $4::date, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb)
     ON CONFLICT (company_id, period_start, period_end) DO UPDATE SET
       boxes = EXCLUDED.boxes, detail = EXCLUDED.detail, adjustments = EXCLUDED.adjustments, prepared_by = EXCLUDED.prepared_by,
       prepared_at = now(), updated_at = now()
     WHERE v.status = 'draft'`,
    [v.id, companyId, v.periodStart, v.periodEnd, json(v.boxes), json(v.detail), json(v.adjustments), json(preparedBy)],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function vatReturnByPeriod(db: Db, companyId: string, start: string, end: string): Promise<VatReturnRow | null> {
  const rows = await db.query<Record<string, unknown>>(`SELECT ${VAT_COLUMNS} FROM ${N}.vat_returns WHERE company_id = $1 AND period_start = $2::date AND period_end = $3::date`, [companyId, start, end]);
  return rows[0] ? mapVat(rows[0]) : null;
}

export async function getVatReturn(db: Db, companyId: string, id: string): Promise<VatReturnRow | null> {
  const rows = await db.query<Record<string, unknown>>(`SELECT ${VAT_COLUMNS} FROM ${N}.vat_returns WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return rows[0] ? mapVat(rows[0]) : null;
}

export async function listVatReturns(db: Db, companyId: string): Promise<VatReturnRow[]> {
  const rows = await db.query<Record<string, unknown>>(`SELECT ${VAT_COLUMNS} FROM ${N}.vat_returns WHERE company_id = $1 ORDER BY period_start DESC LIMIT 100`, [companyId]);
  return rows.map(mapVat);
}

export async function pendingVatReturns(db: Db): Promise<VatReturnRow[]> {
  const rows = await db.query<Record<string, unknown>>(`SELECT ${VAT_COLUMNS} FROM ${N}.vat_returns WHERE status = 'pending_approval' LIMIT 100`);
  return rows.map(mapVat);
}

export async function setVatStatus(db: Db, companyId: string, id: string, from: string, patch: { status: string; approvalIssueId?: string | null; approvedBy?: string | null; lock?: boolean }): Promise<boolean> {
  const res = await db.execute(
    `UPDATE ${N}.vat_returns SET status = $4, approval_issue_id = COALESCE($5, approval_issue_id), approved_by = COALESCE($6, approved_by),
            locked_at = CASE WHEN $7::boolean THEN now() ELSE locked_at END, updated_at = now()
      WHERE company_id = $1 AND id = $2 AND status = $3`,
    [companyId, id, from, patch.status, patch.approvalIssueId ?? null, patch.approvedBy ?? null, Boolean(patch.lock)],
  );
  return (res.rowCount ?? 0) > 0;
}

/** The locked VAT period containing `date`, if any. */
export async function lockedVatPeriodFor(db: Db, companyId: string, date: string): Promise<{ start: string; end: string } | null> {
  const rows = await db.query<{ period_start: string; period_end: string }>(
    `SELECT period_start::text AS period_start, period_end::text AS period_end FROM ${N}.vat_returns
      WHERE company_id = $1 AND status = 'locked' AND period_start <= $2::date AND period_end >= $2::date LIMIT 1`,
    [companyId, date],
  );
  return rows[0] ? { start: String(rows[0].period_start), end: String(rows[0].period_end) } : null;
}

// ---------------------------------------------------------------------------
// Budgets and forecast lines
// ---------------------------------------------------------------------------

export async function saveBudgets(db: Db, companyId: string, rows: Array<{ account_code: string; month: string; amount_minor: number }>): Promise<number> {
  if (rows.length === 0) return 0;
  const res = await db.execute(
    `INSERT INTO ${N}.budgets (company_id, account_code, month, amount_minor)
     SELECT $1, x.account_code, x.month, x.amount_minor FROM jsonb_to_recordset($2::jsonb) AS x(account_code text, month text, amount_minor bigint)
     ON CONFLICT (company_id, account_code, month) DO UPDATE SET amount_minor = EXCLUDED.amount_minor, updated_at = now()`,
    [companyId, json(rows)],
  );
  return res.rowCount ?? 0;
}

export async function listBudgets(db: Db, companyId: string, fromMonth: string, toMonth: string): Promise<Array<{ accountCode: string; month: string; amountMinor: number }>> {
  const rows = await db.query<{ account_code: string; month: string; amount_minor: string }>(
    `SELECT account_code, month, amount_minor FROM ${N}.budgets WHERE company_id = $1 AND month >= $2 AND month <= $3 ORDER BY account_code, month`,
    [companyId, fromMonth, toMonth],
  );
  return rows.map((r) => ({ accountCode: String(r.account_code), month: String(r.month), amountMinor: num(r.amount_minor) }));
}

export interface ForecastLineRow {
  id: string;
  month: string;
  description: string;
  amountMinor: number;
  repeat: "none" | "monthly";
  untilMonth: string | null;
}

export async function listForecastLines(db: Db, companyId: string): Promise<ForecastLineRow[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, month, description, amount_minor, repeat, until_month FROM ${N}.forecast_lines WHERE company_id = $1 ORDER BY month, description`,
    [companyId],
  );
  return rows.map((r) => ({
    id: String(r.id),
    month: String(r.month),
    description: String(r.description),
    amountMinor: num(r.amount_minor),
    repeat: String(r.repeat) as ForecastLineRow["repeat"],
    untilMonth: str(r.until_month),
  }));
}

export async function insertForecastLine(db: Db, companyId: string, l: ForecastLineRow): Promise<void> {
  await db.execute(
    `INSERT INTO ${N}.forecast_lines (id, company_id, month, description, amount_minor, repeat, until_month) VALUES ($1, $2, $3, $4, $5::bigint, $6, $7)`,
    [l.id, companyId, l.month, l.description, l.amountMinor, l.repeat, l.untilMonth],
  );
}

export async function deleteForecastLine(db: Db, companyId: string, id: string): Promise<boolean> {
  const res = await db.execute(`DELETE FROM ${N}.forecast_lines WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return (res.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Fixed assets
// ---------------------------------------------------------------------------

export interface AssetRow {
  id: string;
  companyId: string;
  name: string;
  category: string;
  assetAccountCode: string;
  accumulatedAccountCode: string;
  expenseAccountCode: string;
  costMinor: number;
  residualMinor: number;
  lifeMonths: number;
  acquiredDate: string;
  depreciationStart: string;
  openingAccumulatedMinor: number;
  openingThrough: string | null;
  status: "active" | "disposed";
  disposedDate: string | null;
  disposalProceedsMinor: number | null;
  disposalAccountCode: string | null;
  disposalJournalId: string | null;
}

function mapAsset(r: Record<string, unknown>): AssetRow {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    name: String(r.name),
    category: String(r.category ?? ""),
    assetAccountCode: String(r.asset_account_code),
    accumulatedAccountCode: String(r.accumulated_account_code),
    expenseAccountCode: String(r.expense_account_code),
    costMinor: num(r.cost_minor),
    residualMinor: num(r.residual_minor),
    lifeMonths: num(r.life_months),
    acquiredDate: String(r.acquired_date),
    depreciationStart: String(r.depreciation_start),
    openingAccumulatedMinor: num(r.opening_accumulated_minor),
    openingThrough: str(r.opening_through),
    status: String(r.status) as AssetRow["status"],
    disposedDate: str(r.disposed_date),
    disposalProceedsMinor: numOrNull(r.disposal_proceeds_minor),
    disposalAccountCode: str(r.disposal_account_code),
    disposalJournalId: str(r.disposal_journal_id),
  };
}

const ASSET_COLUMNS = `id, company_id, name, category, asset_account_code, accumulated_account_code, expense_account_code, cost_minor, residual_minor, life_months,
  acquired_date::text AS acquired_date, depreciation_start::text AS depreciation_start, opening_accumulated_minor, opening_through, status,
  disposed_date::text AS disposed_date, disposal_proceeds_minor, disposal_account_code, disposal_journal_id`;

export async function insertAsset(db: Db, a: AssetRow): Promise<void> {
  await db.execute(
    `INSERT INTO ${N}.assets (id, company_id, name, category, asset_account_code, accumulated_account_code, expense_account_code, cost_minor, residual_minor,
       life_months, acquired_date, depreciation_start, opening_accumulated_minor, opening_through)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint, $9::bigint, $10, $11::date, $12::date, $13::bigint, $14)`,
    [a.id, a.companyId, a.name, a.category, a.assetAccountCode, a.accumulatedAccountCode, a.expenseAccountCode, a.costMinor, a.residualMinor, a.lifeMonths, a.acquiredDate, a.depreciationStart, a.openingAccumulatedMinor, a.openingThrough],
  );
}

export async function listAssets(db: Db, companyId: string | null): Promise<AssetRow[]> {
  const rows = companyId
    ? await db.query<Record<string, unknown>>(`SELECT ${ASSET_COLUMNS} FROM ${N}.assets WHERE company_id = $1 ORDER BY acquired_date, name`, [companyId])
    : await db.query<Record<string, unknown>>(`SELECT ${ASSET_COLUMNS} FROM ${N}.assets WHERE status = 'active' ORDER BY company_id, acquired_date`);
  return rows.map(mapAsset);
}

export async function getAsset(db: Db, companyId: string, id: string): Promise<AssetRow | null> {
  const rows = await db.query<Record<string, unknown>>(`SELECT ${ASSET_COLUMNS} FROM ${N}.assets WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return rows[0] ? mapAsset(rows[0]) : null;
}

export async function markAssetDisposed(db: Db, companyId: string, id: string, d: { date: string; proceedsMinor: number; accountCode: string; journalId: string }): Promise<boolean> {
  const res = await db.execute(
    `UPDATE ${N}.assets SET status = 'disposed', disposed_date = $3::date, disposal_proceeds_minor = $4::bigint, disposal_account_code = $5, disposal_journal_id = $6, updated_at = now()
      WHERE company_id = $1 AND id = $2 AND status = 'active'`,
    [companyId, id, d.date, d.proceedsMinor, d.accountCode, d.journalId],
  );
  return (res.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// FX rates and job marks
// ---------------------------------------------------------------------------

export async function saveFxRates(db: Db, base: string, date: string, rates: Map<string, number>, source: string): Promise<number> {
  const rows = [...rates.entries()].map(([currency, rate]) => ({ currency, rate: String(rate) }));
  if (rows.length === 0) return 0;
  const res = await db.execute(
    `INSERT INTO ${N}.fx_rates (base, currency, date, rate, source)
     SELECT $1, x.currency, $2::date, x.rate::numeric, $3 FROM jsonb_to_recordset($4::jsonb) AS x(currency text, rate text)
     ON CONFLICT (base, currency, date) DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source, fetched_at = now()`,
    [base, date, source, json(rows)],
  );
  return res.rowCount ?? 0;
}

/** Latest rate on or before `date` for each currency (book units per 1 foreign unit). */
export async function ratesOnOrBefore(db: Db, base: string, date: string, currencies: string[]): Promise<Map<string, { rate: number; date: string }>> {
  if (currencies.length === 0) return new Map();
  const rows = await db.query<{ currency: string; rate: string; date: string }>(
    `SELECT DISTINCT ON (currency) currency, rate::text AS rate, date::text AS date FROM ${N}.fx_rates
      WHERE base = $1 AND date <= $2::date AND currency IN (SELECT jsonb_array_elements_text($3::jsonb))
      ORDER BY currency, date DESC`,
    [base, date, json(currencies)],
  );
  return new Map(rows.map((r) => [String(r.currency), { rate: Number(r.rate), date: String(r.date) }]));
}

export async function latestRates(db: Db, base: string): Promise<Array<{ currency: string; rate: number; date: string }>> {
  const rows = await db.query<{ currency: string; rate: string; date: string }>(
    `SELECT DISTINCT ON (currency) currency, rate::text AS rate, date::text AS date FROM ${N}.fx_rates WHERE base = $1 ORDER BY currency, date DESC`,
    [base],
  );
  return rows.map((r) => ({ currency: String(r.currency), rate: Number(r.rate), date: String(r.date) }));
}

// ---------------------------------------------------------------------------
// Bank matches sent to Billing (kit outbox rows with `bank:` keys)
// ---------------------------------------------------------------------------

/**
 * Keep Billing's later answer on a match row that its first answer already
 * settled (for example `needs_review`, then a person's `rejected`).
 */
export async function recordOutboxAnswer(db: Db, key: string, result: unknown): Promise<boolean> {
  const res = await db.execute(`UPDATE ${N}.outbox SET result = $2::jsonb, settled_at = now() WHERE key = $1 AND status <> 'pending'`, [key, json(result)]);
  return (res.rowCount ?? 0) > 0;
}

/** Invoices and bills Billing refused for each bank line: line id → open item keys. */
export async function refusedMatches(db: Db, companyId: string): Promise<Map<string, Set<string>>> {
  const rows = await db.query<{ line_id: string | null; item_key: string | null }>(
    `SELECT payload->>'bankTxId' AS line_id, payload->>'openItemKey' AS item_key FROM ${N}.outbox
      WHERE company_id = $1 AND key LIKE 'bank:%' AND result->>'status' = 'rejected'`,
    [companyId],
  );
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.line_id || !r.item_key) continue;
    const set = out.get(r.line_id) ?? new Set<string>();
    set.add(r.item_key);
    out.set(r.line_id, set);
  }
  return out;
}

/** Keys of earlier match requests for one bank line and open item (so a new attempt gets a fresh key). */
export async function matchKeysFor(db: Db, base: string): Promise<string[]> {
  const rows = await db.query<{ key: string }>(`SELECT key FROM ${N}.outbox WHERE key = $1 OR key LIKE $2`, [base, `${base}:%`]);
  return rows.map((r) => String(r.key));
}

/** True the first time a mark is set (used to run a monthly step once). */
export async function setMark(db: Db, companyId: string, mark: string, value: string | null = null): Promise<boolean> {
  const res = await db.execute(
    `INSERT INTO ${N}.job_marks (company_id, mark, value) VALUES ($1, $2, $3) ON CONFLICT (company_id, mark) DO NOTHING`,
    [companyId, mark, value],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function getMark(db: Db, companyId: string, mark: string): Promise<string | null | undefined> {
  const rows = await db.query<{ value: string | null }>(`SELECT value FROM ${N}.job_marks WHERE company_id = $1 AND mark = $2`, [companyId, mark]);
  return rows[0] ? (rows[0].value ?? null) : undefined;
}

export async function clearMark(db: Db, companyId: string, mark: string): Promise<void> {
  await db.execute(`DELETE FROM ${N}.job_marks WHERE company_id = $1 AND mark = $2`, [companyId, mark]);
}

// ---------------------------------------------------------------------------
// The Reviewer's pass on a ledger approval (journal draft, reconciliation, VAT201)
// ---------------------------------------------------------------------------

export type ReviewKind = "draft" | "reconciliation" | "vat";
export type ReviewState = "not_required" | "pending" | "passed" | "changes_needed" | "waived";

export interface ReviewRow {
  companyId: string;
  kind: ReviewKind;
  subjectId: string;
  issueId: string | null;
  state: ReviewState;
  preparedBy: Record<string, unknown> | null;
  reviewer: Record<string, unknown> | null;
  findings: string | null;
  requestedAt: string | null;
  reviewedAt: string | null;
  waivedBy: string | null;
}

function mapReview(r: Record<string, unknown>): ReviewRow {
  return {
    companyId: String(r.company_id),
    kind: String(r.kind) as ReviewKind,
    subjectId: String(r.subject_id),
    issueId: str(r.issue_id),
    state: String(r.state) as ReviewState,
    preparedBy: (r.prepared_by ?? null) as Record<string, unknown> | null,
    reviewer: (r.reviewer ?? null) as Record<string, unknown> | null,
    findings: str(r.findings),
    requestedAt: iso(r.requested_at),
    reviewedAt: iso(r.reviewed_at),
    waivedBy: str(r.waived_by),
  };
}

const REVIEW_COLUMNS = "company_id, kind, subject_id, issue_id, state, prepared_by, reviewer, findings, requested_at, reviewed_at, waived_by";

/** A new approval request starts a fresh review (an earlier pass or send-back for the same subject is replaced). */
export async function startReview(db: Db, row: { companyId: string; kind: ReviewKind; subjectId: string; issueId: string | null; state: ReviewState; preparedBy: Record<string, unknown> | null }): Promise<void> {
  await db.execute(
    `INSERT INTO ${N}.approval_reviews (company_id, kind, subject_id, issue_id, state, prepared_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (company_id, kind, subject_id)
     DO UPDATE SET issue_id = EXCLUDED.issue_id, state = EXCLUDED.state, prepared_by = EXCLUDED.prepared_by, reviewer = NULL, findings = NULL,
                   requested_at = now(), reviewed_at = NULL, waived_by = NULL`,
    [row.companyId, row.kind, row.subjectId, row.issueId, row.state, json(row.preparedBy)],
  );
}

export async function getReview(db: Db, companyId: string, kind: ReviewKind, subjectId: string): Promise<ReviewRow | null> {
  const rows = await db.query<Record<string, unknown>>(`SELECT ${REVIEW_COLUMNS} FROM ${N}.approval_reviews WHERE company_id = $1 AND kind = $2 AND subject_id = $3`, [companyId, kind, subjectId]);
  return rows[0] ? mapReview(rows[0]) : null;
}

export async function reviewsFor(db: Db, companyId: string, kind: ReviewKind, subjectIds: string[]): Promise<Map<string, ReviewRow>> {
  if (subjectIds.length === 0) return new Map();
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${REVIEW_COLUMNS} FROM ${N}.approval_reviews WHERE company_id = $1 AND kind = $2 AND subject_id IN (SELECT jsonb_array_elements_text($3::jsonb))`,
    [companyId, kind, json(subjectIds)],
  );
  return new Map(rows.map((r) => [String(r.subject_id), mapReview(r)]));
}

/** Review rows still waiting on the Reviewer (pending or sent back), oldest first. */
export async function openReviews(db: Db, companyId: string): Promise<ReviewRow[]> {
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${REVIEW_COLUMNS} FROM ${N}.approval_reviews WHERE company_id = $1 AND state IN ('pending', 'changes_needed') ORDER BY requested_at LIMIT 200`,
    [companyId],
  );
  return rows.map(mapReview);
}

/** Move a review from one of the states in `from` to another. Returns false when it was not in one of them. */
export async function setReview(
  db: Db,
  companyId: string,
  kind: ReviewKind,
  subjectId: string,
  from: ReviewState[],
  patch: { state: ReviewState; reviewer?: Record<string, unknown> | null; findings?: string | null; waivedBy?: string | null },
): Promise<boolean> {
  const res = await db.execute(
    `UPDATE ${N}.approval_reviews
        SET state = $4, reviewer = COALESCE($5::jsonb, reviewer), findings = COALESCE($6, findings), waived_by = COALESCE($7, waived_by), reviewed_at = now()
      WHERE company_id = $1 AND kind = $2 AND subject_id = $3 AND state IN (SELECT jsonb_array_elements_text($8::jsonb))`,
    [companyId, kind, subjectId, patch.state, patch.reviewer ? json(patch.reviewer) : null, patch.findings ?? null, patch.waivedBy ?? null, json(from)],
  );
  return (res.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Erasure of one person (POPIA): what the books may drop, and what they must keep
// ---------------------------------------------------------------------------

/** Closed receivables and payables of one client lose the name and the payer references they carry. Open ones (money still owed) stay. */
export async function anonymiseClosedOpenItems(db: Db, companyId: string, clientKind: string, clientRef: string): Promise<number> {
  const res = await db.execute(
    `UPDATE ${N}.open_items SET counterparty_name = '[erased]', refs = '[]'::jsonb
      WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3 AND outstanding_minor = 0 AND counterparty_name <> '[erased]'`,
    [companyId, clientKind, clientRef],
  );
  return res.rowCount ?? 0;
}

export async function countOpenItemsStillOwed(db: Db, companyId: string, clientKind: string, clientRef: string): Promise<number> {
  const rows = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${N}.open_items WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3 AND outstanding_minor > 0`,
    [companyId, clientKind, clientRef],
  );
  return num(rows[0]?.n);
}

/** Posted journals that name the client on a line (kept: accounting records, and the audit hash chain forbids editing them). */
export async function countJournalsForClient(db: Db, companyId: string, clientKind: string, clientRef: string): Promise<number> {
  const rows = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${N}.journals WHERE company_id = $1 AND lines @> $2::jsonb`,
    [companyId, json([{ clientKind, clientRef }])],
  );
  return num(rows[0]?.n);
}

/** Bank lines whose text carries one of these (an email or a phone number). Never edited here: they are statement records. */
export async function countBankLinesMentioning(db: Db, companyId: string, needles: string[]): Promise<number> {
  const list = needles.filter((x) => x.length >= 5);
  if (list.length === 0) return 0;
  const rows = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${N}.bank_lines
      WHERE company_id = $1 AND EXISTS (SELECT 1 FROM jsonb_array_elements_text($2::jsonb) AS needle WHERE lower(description || ' ' || COALESCE(counterparty, '') || ' ' || COALESCE(reference, '')) LIKE '%' || lower(needle) || '%')`,
    [companyId, json(list)],
  );
  return num(rows[0]?.n);
}
