/**
 * Data access. Host rules: every table is `<namespace>.<table>`, one
 * statement per call, `query` for SELECT only, `execute` for one
 * INSERT / UPDATE (no transactions), params are JSON-encoded. Dates are read
 * back as text. Sealed personal details are selected only by `getSealed`.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { textArrayParam } from "@partnersinbiz/pib-plugin-kit";
import type { ComponentDefinition, ComponentKind } from "./components.js";
import type { RunKind, RunStatus } from "./domain.js";
import type { PeriodInput, PeriodResult, RetirementFund, WorkerCategory } from "./engine.js";
import type { LeaveStatus, LeaveType } from "./leave.js";
import { EMPTY_RUN_TOTALS, type RunTotals } from "./ledger.js";
import { EMPTY_MASKS, type PiiMasks } from "./pii.js";
import type { PayFrequency, RuleVersion } from "./rules.js";

type Db = Pick<PluginContext, "db">;

export function table(ctx: Db, name: string): string {
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace)) throw new Error("Unsafe namespace");
  if (!/^[a-z_]+$/.test(name)) throw new Error("Unsafe table");
  return `${ctx.db.namespace}.${name}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function json<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function num(value: unknown): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function text(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function day(value: unknown): string | null {
  const t = text(value);
  return t ? t.slice(0, 10) : null;
}

/** Builds `SET a = $n, b = $n+1` from a whitelisted patch. */
function setClause(patch: Record<string, unknown>, allowed: ReadonlySet<string>, jsonColumns: ReadonlySet<string>, start: number): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (!allowed.has(key)) throw new Error(`Column ${key} cannot be updated`);
    params.push(jsonColumns.has(key) ? JSON.stringify(value) : value);
    parts.push(`${key} = $${start + params.length - 1}${jsonColumns.has(key) ? "::jsonb" : ""}`);
  }
  if (!parts.length) throw new Error("Nothing to update");
  return { sql: parts.join(", "), params };
}

// ---------------------------------------------------------------------------
// Rule versions
// ---------------------------------------------------------------------------

export async function listRuleVersions(ctx: Db): Promise<RuleVersion[]> {
  const rows = await ctx.db.query<Record<string, unknown>>(
    `SELECT id, tax_year, version, effective_from::text AS effective_from, effective_to::text AS effective_to, status, rules, sources, unverified, notes, content_hash
       FROM ${table(ctx, "rule_versions")} ORDER BY effective_from DESC, version DESC`,
  );
  return rows.map((r) => ({
    id: String(r.id),
    taxYear: String(r.tax_year),
    version: num(r.version),
    effectiveFrom: day(r.effective_from)!,
    effectiveTo: day(r.effective_to)!,
    status: r.status === "draft" ? "draft" : "published",
    rules: json(r.rules, {} as RuleVersion["rules"]),
    sources: json(r.sources, []),
    unverified: json(r.unverified, []),
    notes: json(r.notes, []),
    contentHash: String(r.content_hash),
  }));
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export interface Employee {
  id: string;
  companyId: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  name: string;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  dateOfBirth: string | null;
  startDate: string;
  endDate: string | null;
  status: "active" | "terminated";
  taxResidency: "resident" | "non_resident";
  masks: PiiMasks;
  hasIdentity: boolean;
  hasTax: boolean;
  hasBank: boolean;
  etiEligible: boolean;
  etiMonthsBefore: number;
}

const EMPLOYEE_COLUMNS = `id, company_id, employee_number, first_name, last_name, email, phone, job_title, date_of_birth::text AS date_of_birth,
  start_date::text AS start_date, end_date::text AS end_date, status, tax_residency, pii_masks,
  (sealed_identity IS NOT NULL) AS has_identity, (sealed_tax IS NOT NULL) AS has_tax, (sealed_bank IS NOT NULL) AS has_bank,
  eti_eligible, eti_months_before`;

function mapEmployee(r: Record<string, unknown>): Employee {
  const first = String(r.first_name ?? "");
  const last = String(r.last_name ?? "");
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    employeeNumber: String(r.employee_number),
    firstName: first,
    lastName: last,
    name: `${first} ${last}`.trim(),
    email: text(r.email),
    phone: text(r.phone),
    jobTitle: text(r.job_title),
    dateOfBirth: day(r.date_of_birth),
    startDate: day(r.start_date)!,
    endDate: day(r.end_date),
    status: r.status === "terminated" ? "terminated" : "active",
    taxResidency: r.tax_residency === "non_resident" ? "non_resident" : "resident",
    masks: { ...EMPTY_MASKS, ...json<Partial<PiiMasks>>(r.pii_masks, {}) },
    hasIdentity: r.has_identity === true,
    hasTax: r.has_tax === true,
    hasBank: r.has_bank === true,
    etiEligible: r.eti_eligible === true,
    etiMonthsBefore: num(r.eti_months_before),
  };
}

export async function listEmployees(ctx: Db, companyId: string, options: { status?: "active" | "terminated" } = {}): Promise<Employee[]> {
  const params: unknown[] = [companyId];
  let where = "company_id = $1";
  if (options.status) {
    params.push(options.status);
    where += ` AND status = $2`;
  }
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT ${EMPLOYEE_COLUMNS} FROM ${table(ctx, "employees")} WHERE ${where} ORDER BY last_name, first_name`, params);
  return rows.map(mapEmployee);
}

export async function getEmployee(ctx: Db, companyId: string, id: string): Promise<Employee | null> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT ${EMPLOYEE_COLUMNS} FROM ${table(ctx, "employees")} WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return rows[0] ? mapEmployee(rows[0]) : null;
}

export async function getEmployeeByNumber(ctx: Db, companyId: string, employeeNumber: string): Promise<Employee | null> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT ${EMPLOYEE_COLUMNS} FROM ${table(ctx, "employees")} WHERE company_id = $1 AND employee_number = $2`, [companyId, employeeNumber]);
  return rows[0] ? mapEmployee(rows[0]) : null;
}

export interface SealedRow {
  sealedIdentity: string | null;
  sealedTax: string | null;
  sealedBank: string | null;
}

/** The only query that reads sealed columns. Callers open them with the keyring and never persist the result. */
export async function getSealed(ctx: Db, companyId: string, ids: string[]): Promise<Map<string, SealedRow>> {
  if (!ids.length) return new Map();
  const rows = await ctx.db.query<Record<string, unknown>>(
    `SELECT id, sealed_identity, sealed_tax, sealed_bank FROM ${table(ctx, "employees")} WHERE company_id = $1 AND id = ANY(${textArrayParam(2)})`,
    [companyId, JSON.stringify(ids)],
  );
  return new Map(rows.map((r) => [String(r.id), { sealedIdentity: text(r.sealed_identity), sealedTax: text(r.sealed_tax), sealedBank: text(r.sealed_bank) }]));
}

export async function nextEmployeeNumber(ctx: Db, companyId: string): Promise<string> {
  const rows = await ctx.db.query<{ n: unknown }>(`SELECT COUNT(*) AS n FROM ${table(ctx, "employees")} WHERE company_id = $1`, [companyId]);
  return `E${String(num(rows[0]?.n) + 1).padStart(3, "0")}`;
}

export interface EmployeeWrite {
  id: string;
  companyId: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  dateOfBirth: string | null;
  startDate: string;
  endDate: string | null;
  taxResidency: "resident" | "non_resident";
  etiEligible: boolean;
  etiMonthsBefore: number;
}

export async function insertEmployee(ctx: Db, e: EmployeeWrite): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "employees")} (id, company_id, employee_number, first_name, last_name, email, phone, job_title, date_of_birth, start_date, end_date, tax_residency, eti_eligible, eti_months_before)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::date, $11::date, $12, $13, $14)`,
    [e.id, e.companyId, e.employeeNumber, e.firstName, e.lastName, e.email, e.phone, e.jobTitle, e.dateOfBirth, e.startDate, e.endDate, e.taxResidency, e.etiEligible, e.etiMonthsBefore],
  );
}

const EMPLOYEE_UPDATABLE = new Set([
  "employee_number", "first_name", "last_name", "email", "phone", "job_title", "date_of_birth", "start_date", "end_date", "status", "tax_residency",
  "sealed_identity", "sealed_tax", "sealed_bank", "pii_masks", "key_version", "eti_eligible", "eti_months_before",
]);

export async function updateEmployee(ctx: Db, companyId: string, id: string, patch: Record<string, unknown>): Promise<number> {
  const set = setClause(patch, EMPLOYEE_UPDATABLE, new Set(["pii_masks"]), 3);
  const res = await ctx.db.execute(`UPDATE ${table(ctx, "employees")} SET ${set.sql}, updated_at = now() WHERE company_id = $1 AND id = $2`, [companyId, id, ...set.params]);
  return res.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Employment terms (versioned)
// ---------------------------------------------------------------------------

export interface Terms {
  id: string;
  employeeId: string;
  version: number;
  effectiveFrom: string;
  frequency: PayFrequency;
  workerCategory: WorkerCategory;
  rateMinor: number;
  standardHoursCenti: number;
  hoursPerDayCenti: number;
  daysPerWeek: number;
  overtimeMultiplierBp: number;
  uifApplicable: boolean;
  sdlApplicable: boolean;
  medical: { members: number; employeeContributionMinor: number; employerContributionMinor: number } | null;
  retirement: { fund: RetirementFund; employeeContributionMinor: number; employerContributionMinor: number } | null;
  travel: { amountMinor: number; businessUseAtLeast80: boolean } | null;
  annualLeaveDays: number | null;
  createdBy: string | null;
  createdAt: string | null;
}

const TERMS_COLUMNS = `id, employee_id, version, effective_from::text AS effective_from, frequency, worker_category, rate_minor, standard_hours_centi, hours_per_day_centi,
  days_per_week, overtime_multiplier_bp, uif_applicable, sdl_applicable, medical, retirement, travel, annual_leave_days, created_by, created_at`;

function mapTerms(r: Record<string, unknown>): Terms {
  return {
    id: String(r.id),
    employeeId: String(r.employee_id),
    version: num(r.version),
    effectiveFrom: day(r.effective_from)!,
    frequency: (r.frequency as PayFrequency) ?? "monthly",
    workerCategory: r.worker_category === "hourly" ? "hourly" : "salaried",
    rateMinor: num(r.rate_minor),
    standardHoursCenti: num(r.standard_hours_centi),
    hoursPerDayCenti: num(r.hours_per_day_centi) || 800,
    daysPerWeek: num(r.days_per_week) || 5,
    overtimeMultiplierBp: num(r.overtime_multiplier_bp) || 15_000,
    uifApplicable: r.uif_applicable !== false,
    sdlApplicable: r.sdl_applicable !== false,
    medical: json(r.medical, null),
    retirement: json(r.retirement, null),
    travel: json(r.travel, null),
    annualLeaveDays: r.annual_leave_days == null ? null : num(r.annual_leave_days),
    createdBy: text(r.created_by),
    createdAt: text(r.created_at),
  };
}

export async function listTerms(ctx: Db, companyId: string, employeeId: string): Promise<Terms[]> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT ${TERMS_COLUMNS} FROM ${table(ctx, "employment_terms")} WHERE company_id = $1 AND employee_id = $2 ORDER BY version DESC`, [companyId, employeeId]);
  return rows.map(mapTerms);
}

/** The terms in force on `onDate` per employee (latest version effective on or before it). */
export async function termsOn(ctx: Db, companyId: string, onDate: string): Promise<Map<string, Terms>> {
  const rows = await ctx.db.query<Record<string, unknown>>(
    `SELECT DISTINCT ON (employee_id) ${TERMS_COLUMNS} FROM ${table(ctx, "employment_terms")}
      WHERE company_id = $1 AND effective_from <= $2::date
      ORDER BY employee_id, effective_from DESC, version DESC`,
    [companyId, onDate],
  );
  return new Map(rows.map((r) => [String(r.employee_id), mapTerms(r)]));
}

export async function insertTerms(ctx: Db, companyId: string, t: Omit<Terms, "version" | "createdAt">): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "employment_terms")} (id, company_id, employee_id, version, effective_from, frequency, worker_category, rate_minor, standard_hours_centi,
       hours_per_day_centi, days_per_week, overtime_multiplier_bp, uif_applicable, sdl_applicable, medical, retirement, travel, annual_leave_days, created_by)
     SELECT $1, $2, $3, COALESCE(MAX(version), 0) + 1, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16::jsonb, $17, $18
       FROM ${table(ctx, "employment_terms")} WHERE employee_id = $3`,
    [
      t.id, companyId, t.employeeId, t.effectiveFrom, t.frequency, t.workerCategory, t.rateMinor, t.standardHoursCenti, t.hoursPerDayCenti, t.daysPerWeek,
      t.overtimeMultiplierBp, t.uifApplicable, t.sdlApplicable, JSON.stringify(t.medical), JSON.stringify(t.retirement), JSON.stringify(t.travel), t.annualLeaveDays, t.createdBy,
    ],
  );
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export async function listCustomComponents(ctx: Db, companyId: string): Promise<ComponentDefinition[]> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT code, name, kind, sars_code, taxable, irregular, uif, sdl, active FROM ${table(ctx, "components")} WHERE company_id = $1`, [companyId]);
  return rows.map((r) => ({
    code: String(r.code),
    name: String(r.name),
    kind: r.kind as ComponentKind,
    sarsCode: text(r.sars_code),
    taxable: r.taxable === true,
    irregular: r.irregular === true,
    uif: r.uif === true,
    sdl: r.sdl === true,
    builtIn: false,
    active: r.active !== false,
  }));
}

export async function upsertComponent(ctx: Db, companyId: string, c: ComponentDefinition): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "components")} (company_id, code, name, kind, sars_code, taxable, irregular, uif, sdl, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (company_id, code) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, sars_code = EXCLUDED.sars_code, taxable = EXCLUDED.taxable,
       irregular = EXCLUDED.irregular, uif = EXCLUDED.uif, sdl = EXCLUDED.sdl, active = EXCLUDED.active, updated_at = now()`,
    [companyId, c.code, c.name, c.kind, c.sarsCode, c.taxable, c.irregular, c.uif, c.sdl, c.active],
  );
}

export interface Recurring {
  id: string;
  employeeId: string;
  code: string;
  amountMinor: number;
  label: string | null;
  active: boolean;
}

export async function listRecurring(ctx: Db, companyId: string, employeeId?: string): Promise<Recurring[]> {
  const params: unknown[] = [companyId];
  let where = "company_id = $1";
  if (employeeId) {
    params.push(employeeId);
    where += " AND employee_id = $2";
  }
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT id, employee_id, code, amount_minor, label, active FROM ${table(ctx, "recurring_components")} WHERE ${where} ORDER BY code`, params);
  return rows.map((r) => ({ id: String(r.id), employeeId: String(r.employee_id), code: String(r.code), amountMinor: num(r.amount_minor), label: text(r.label), active: r.active !== false }));
}

export async function upsertRecurring(ctx: Db, companyId: string, r: Omit<Recurring, "id"> & { id?: string }): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "recurring_components")} (id, company_id, employee_id, code, amount_minor, label, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (employee_id, code) DO UPDATE SET amount_minor = EXCLUDED.amount_minor, label = EXCLUDED.label, active = EXCLUDED.active, updated_at = now()`,
    [r.id ?? newId("rc"), companyId, r.employeeId, r.code, r.amountMinor, r.label, r.active],
  );
}

// ---------------------------------------------------------------------------
// Pay runs
// ---------------------------------------------------------------------------

export interface PayRun {
  id: string;
  companyId: string;
  number: string;
  kind: RunKind;
  frequency: PayFrequency;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  taxYear: string;
  ruleVersionId: string | null;
  status: RunStatus;
  preparedByUserId: string | null;
  preparedByAgentId: string | null;
  preparedAt: string | null;
  approverUserId: string | null;
  approvalIssueId: string | null;
  approvalRequestedAt: string | null;
  approvedByUserId: string | null;
  approvedAt: string | null;
  lockedByUserId: string | null;
  lockedAt: string | null;
  reversesRunId: string | null;
  correctsRunId: string | null;
  reversedByRunId: string | null;
  ledgerStatus: "none" | "pending" | "posted" | "rejected" | "failed";
  journalId: string | null;
  journalNumber: string | null;
  ledgerError: string | null;
  totals: RunTotals;
  warnings: string[];
  notes: string | null;
  createdAt: string | null;
}

const RUN_COLUMNS = `id, company_id, number, kind, frequency, period_start::text AS period_start, period_end::text AS period_end, pay_date::text AS pay_date, tax_year,
  rule_version_id, status, prepared_by_user_id, prepared_by_agent_id, prepared_at, approver_user_id, approval_issue_id, approval_requested_at, approved_by_user_id,
  approved_at, locked_by_user_id, locked_at, reverses_run_id, corrects_run_id, reversed_by_run_id, ledger_status, journal_id, journal_number, ledger_error,
  totals, warnings, notes, created_at`;

function mapRun(r: Record<string, unknown>): PayRun {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    number: String(r.number),
    kind: (r.kind as RunKind) ?? "regular",
    frequency: (r.frequency as PayFrequency) ?? "monthly",
    periodStart: day(r.period_start)!,
    periodEnd: day(r.period_end)!,
    payDate: day(r.pay_date)!,
    taxYear: String(r.tax_year),
    ruleVersionId: text(r.rule_version_id),
    status: r.status as RunStatus,
    preparedByUserId: text(r.prepared_by_user_id),
    preparedByAgentId: text(r.prepared_by_agent_id),
    preparedAt: text(r.prepared_at),
    approverUserId: text(r.approver_user_id),
    approvalIssueId: text(r.approval_issue_id),
    approvalRequestedAt: text(r.approval_requested_at),
    approvedByUserId: text(r.approved_by_user_id),
    approvedAt: text(r.approved_at),
    lockedByUserId: text(r.locked_by_user_id),
    lockedAt: text(r.locked_at),
    reversesRunId: text(r.reverses_run_id),
    correctsRunId: text(r.corrects_run_id),
    reversedByRunId: text(r.reversed_by_run_id),
    ledgerStatus: (r.ledger_status as PayRun["ledgerStatus"]) ?? "none",
    journalId: text(r.journal_id),
    journalNumber: text(r.journal_number),
    ledgerError: text(r.ledger_error),
    totals: { ...EMPTY_RUN_TOTALS, ...json<Partial<RunTotals>>(r.totals, {}) },
    warnings: json(r.warnings, []),
    notes: text(r.notes),
    createdAt: text(r.created_at),
  };
}

export async function listRuns(ctx: Db, companyId: string, limit = 50): Promise<PayRun[]> {
  const rows = await ctx.db.query<Record<string, unknown>>(
    `SELECT ${RUN_COLUMNS} FROM ${table(ctx, "pay_runs")} WHERE company_id = $1 ORDER BY pay_date DESC, created_at DESC LIMIT ${Math.max(1, Math.min(limit, 500))}`,
    [companyId],
  );
  return rows.map(mapRun);
}

export async function getRun(ctx: Db, companyId: string, id: string): Promise<PayRun | null> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT ${RUN_COLUMNS} FROM ${table(ctx, "pay_runs")} WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function getRunByApprovalIssue(ctx: Db, companyId: string, issueId: string): Promise<PayRun | null> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT ${RUN_COLUMNS} FROM ${table(ctx, "pay_runs")} WHERE company_id = $1 AND approval_issue_id = $2`, [companyId, issueId]);
  return rows[0] ? mapRun(rows[0]) : null;
}

/** Runs locked but not yet answered by Accounting, or missing payslips (for the backstop job). */
export async function runsNeedingFollowUp(ctx: Db): Promise<Array<{ id: string; companyId: string }>> {
  const rows = await ctx.db.query<Record<string, unknown>>(
    `SELECT r.id, r.company_id FROM ${table(ctx, "pay_runs")} r
      WHERE r.status = 'locked' AND r.kind <> 'reversal'
        AND EXISTS (SELECT 1 FROM ${table(ctx, "pay_run_items")} i WHERE i.run_id = r.id AND i.status = 'ok'
          AND NOT EXISTS (SELECT 1 FROM ${table(ctx, "payslips")} p WHERE p.run_id = r.id AND p.employee_id = i.employee_id AND p.status <> 'pending'))
      ORDER BY r.locked_at LIMIT 20`,
  );
  return rows.map((r) => ({ id: String(r.id), companyId: String(r.company_id) }));
}

export async function countRuns(ctx: Db, companyId: string, month: string, frequency: PayFrequency, kind: RunKind): Promise<number> {
  const rows = await ctx.db.query<{ n: unknown }>(
    `SELECT COUNT(*) AS n FROM ${table(ctx, "pay_runs")} WHERE company_id = $1 AND to_char(pay_date, 'YYYY-MM') = $2 AND frequency = $3 AND kind = $4`,
    [companyId, month, frequency, kind],
  );
  return num(rows[0]?.n);
}

export async function insertRun(ctx: Db, run: PayRun): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "pay_runs")} (id, company_id, number, kind, frequency, period_start, period_end, pay_date, tax_year, rule_version_id, status,
       prepared_by_user_id, prepared_by_agent_id, prepared_at, reverses_run_id, corrects_run_id, totals, warnings, notes)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8::date, $9, $10, $11, $12, $13, $14::timestamptz, $15, $16, $17::jsonb, $18::jsonb, $19)`,
    [
      run.id, run.companyId, run.number, run.kind, run.frequency, run.periodStart, run.periodEnd, run.payDate, run.taxYear, run.ruleVersionId, run.status,
      run.preparedByUserId, run.preparedByAgentId, run.preparedAt, run.reversesRunId, run.correctsRunId, JSON.stringify(run.totals), JSON.stringify(run.warnings), run.notes,
    ],
  );
}

const RUN_UPDATABLE = new Set([
  "status", "rule_version_id", "prepared_by_user_id", "prepared_by_agent_id", "prepared_at", "approver_user_id", "approval_issue_id", "approval_requested_at",
  "approved_by_user_id", "approved_at", "locked_by_user_id", "locked_at", "reversed_by_run_id", "ledger_status", "journal_id", "journal_number", "ledger_error",
  "totals", "warnings", "notes",
]);

/**
 * Updates a run; with `expectStatus` the update only happens while the run
 * is still in one of those statuses (guards double clicks and races).
 */
export async function updateRun(ctx: Db, companyId: string, id: string, patch: Record<string, unknown>, expectStatus?: RunStatus[]): Promise<number> {
  const set = setClause(patch, RUN_UPDATABLE, new Set(["totals", "warnings"]), 3);
  let guard = "";
  const params = [companyId, id, ...set.params];
  if (expectStatus?.length) {
    params.push(JSON.stringify(expectStatus));
    guard = ` AND status = ANY(${textArrayParam(params.length)})`;
  }
  const res = await ctx.db.execute(`UPDATE ${table(ctx, "pay_runs")} SET ${set.sql}, updated_at = now() WHERE company_id = $1 AND id = $2${guard}`, params);
  return res.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Run inputs and items
// ---------------------------------------------------------------------------

export interface RunInputs {
  excluded?: boolean;
  ordinaryHours?: number;
  overtimeHours?: number;
  doubleTimeHours?: number;
  paidLeaveHours?: number;
  /** Extra unpaid hours on top of approved unpaid leave. */
  unpaidHours?: number;
  /** One-off components for this run (bonus, commission, back pay...), rand in cents. */
  components?: Array<{ code: string; amountMinor: number; label?: string | null }>;
  note?: string | null;
}

export async function getInputs(ctx: Db, runId: string): Promise<Map<string, RunInputs>> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT employee_id, inputs FROM ${table(ctx, "pay_run_inputs")} WHERE run_id = $1`, [runId]);
  return new Map(rows.map((r) => [String(r.employee_id), json<RunInputs>(r.inputs, {})]));
}

export async function upsertInputs(ctx: Db, companyId: string, runId: string, employeeId: string, inputs: RunInputs, by: { userId: string | null; agentId: string | null }): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "pay_run_inputs")} (run_id, employee_id, company_id, inputs, updated_by_user_id, updated_by_agent_id)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (run_id, employee_id) DO UPDATE SET inputs = EXCLUDED.inputs, updated_by_user_id = EXCLUDED.updated_by_user_id,
       updated_by_agent_id = EXCLUDED.updated_by_agent_id, updated_at = now()`,
    [runId, employeeId, companyId, JSON.stringify(inputs), by.userId, by.agentId],
  );
}

export interface ItemSnapshot {
  name: string;
  employeeNumber: string;
  jobTitle: string | null;
  email: string | null;
  frequency: PayFrequency;
  termsVersion: number | null;
  accountMask: string | null;
  bankName: string | null;
  taxReferenceMask: string | null;
}

export interface RunItem {
  id: string;
  runId: string;
  employeeId: string;
  termsId: string | null;
  status: "ok" | "error" | "excluded";
  error: string | null;
  snapshot: ItemSnapshot;
  input: Partial<PeriodInput>;
  result: PeriodResult | null;
  grossMinor: number;
  taxableMinor: number;
  payeMinor: number;
  uifEmployeeMinor: number;
  uifEmployerMinor: number;
  sdlMinor: number;
  etiMinor: number;
  deductionsMinor: number;
  employerContributionsMinor: number;
  netMinor: number;
  employerCostMinor: number;
}

const ITEM_COLUMNS = `id, run_id, employee_id, terms_id, status, error, snapshot, input, result, gross_minor, taxable_minor, paye_minor, uif_employee_minor,
  uif_employer_minor, sdl_minor, eti_minor, deductions_minor, employer_contributions_minor, net_minor, employer_cost_minor`;

function mapItem(r: Record<string, unknown>): RunItem {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    employeeId: String(r.employee_id),
    termsId: text(r.terms_id),
    status: (r.status as RunItem["status"]) ?? "ok",
    error: text(r.error),
    snapshot: json(r.snapshot, {} as ItemSnapshot),
    input: json(r.input, {}),
    result: json(r.result, null),
    grossMinor: num(r.gross_minor),
    taxableMinor: num(r.taxable_minor),
    payeMinor: num(r.paye_minor),
    uifEmployeeMinor: num(r.uif_employee_minor),
    uifEmployerMinor: num(r.uif_employer_minor),
    sdlMinor: num(r.sdl_minor),
    etiMinor: num(r.eti_minor),
    deductionsMinor: num(r.deductions_minor),
    employerContributionsMinor: num(r.employer_contributions_minor),
    netMinor: num(r.net_minor),
    employerCostMinor: num(r.employer_cost_minor),
  };
}

export async function listItems(ctx: Db, companyId: string, runId: string): Promise<RunItem[]> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT ${ITEM_COLUMNS} FROM ${table(ctx, "pay_run_items")} WHERE company_id = $1 AND run_id = $2 ORDER BY snapshot->>'name'`, [companyId, runId]);
  return rows.map(mapItem);
}

export async function upsertItem(ctx: Db, companyId: string, item: RunItem): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "pay_run_items")} (id, company_id, run_id, employee_id, terms_id, status, error, snapshot, input, result, gross_minor, taxable_minor, paye_minor,
       uif_employee_minor, uif_employer_minor, sdl_minor, eti_minor, deductions_minor, employer_contributions_minor, net_minor, employer_cost_minor)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (run_id, employee_id) DO UPDATE SET terms_id = EXCLUDED.terms_id, status = EXCLUDED.status, error = EXCLUDED.error, snapshot = EXCLUDED.snapshot,
       input = EXCLUDED.input, result = EXCLUDED.result, gross_minor = EXCLUDED.gross_minor, taxable_minor = EXCLUDED.taxable_minor, paye_minor = EXCLUDED.paye_minor,
       uif_employee_minor = EXCLUDED.uif_employee_minor, uif_employer_minor = EXCLUDED.uif_employer_minor, sdl_minor = EXCLUDED.sdl_minor, eti_minor = EXCLUDED.eti_minor,
       deductions_minor = EXCLUDED.deductions_minor, employer_contributions_minor = EXCLUDED.employer_contributions_minor, net_minor = EXCLUDED.net_minor,
       employer_cost_minor = EXCLUDED.employer_cost_minor, updated_at = now()`,
    [
      item.id, companyId, item.runId, item.employeeId, item.termsId, item.status, item.error, JSON.stringify(item.snapshot), JSON.stringify(item.input),
      JSON.stringify(item.result), item.grossMinor, item.taxableMinor, item.payeMinor, item.uifEmployeeMinor, item.uifEmployerMinor, item.sdlMinor, item.etiMinor,
      item.deductionsMinor, item.employerContributionsMinor, item.netMinor, item.employerCostMinor,
    ],
  );
}

/** Marks items of employees no longer in the run as excluded. */
export async function excludeItemsNotIn(ctx: Db, companyId: string, runId: string, employeeIds: string[]): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "pay_run_items")} SET status = 'excluded', error = NULL, updated_at = now()
      WHERE company_id = $1 AND run_id = $2 AND NOT (employee_id = ANY(${textArrayParam(3)}))`,
    [companyId, runId, JSON.stringify(employeeIds)],
  );
}

export interface PostedItem extends RunItem {
  runNumber: string;
  runKind: RunKind;
  payDate: string;
  frequency: PayFrequency;
  runStatus: RunStatus;
}

/**
 * Items of locked (and later reversed) runs in a date range: the basis for
 * YTD, EMP201 and certificates. Reversal runs carry negated amounts.
 */
export async function postedItems(ctx: Db, companyId: string, from: string, to: string, employeeId?: string): Promise<PostedItem[]> {
  const params: unknown[] = [companyId, from, to];
  let extra = "";
  if (employeeId) {
    params.push(employeeId);
    extra = ` AND i.employee_id = $4`;
  }
  const rows = await ctx.db.query<Record<string, unknown>>(
    `SELECT i.id, i.run_id, i.employee_id, i.terms_id, i.status, i.error, i.snapshot, i.input, i.result, i.gross_minor, i.taxable_minor, i.paye_minor,
            i.uif_employee_minor, i.uif_employer_minor, i.sdl_minor, i.eti_minor, i.deductions_minor, i.employer_contributions_minor, i.net_minor, i.employer_cost_minor,
            r.number AS run_number, r.kind AS run_kind, r.pay_date::text AS pay_date, r.frequency AS run_frequency, r.status AS run_status
       FROM ${table(ctx, "pay_run_items")} i JOIN ${table(ctx, "pay_runs")} r ON r.id = i.run_id
      WHERE i.company_id = $1 AND r.status IN ('locked', 'reversed') AND i.status = 'ok' AND r.pay_date >= $2::date AND r.pay_date <= $3::date${extra}
      ORDER BY r.pay_date, r.number`,
    params,
  );
  return rows.map((r) => ({
    ...mapItem(r),
    runNumber: String(r.run_number),
    runKind: r.run_kind as RunKind,
    payDate: day(r.pay_date)!,
    frequency: r.run_frequency as PayFrequency,
    runStatus: r.run_status as RunStatus,
  }));
}

/** Months in which ETI was claimed for each employee before `beforeDate` (locked, not reversed). */
export async function etiMonthsClaimed(ctx: Db, companyId: string, beforeDate: string): Promise<Map<string, number>> {
  const rows = await ctx.db.query<Record<string, unknown>>(
    `SELECT i.employee_id, COUNT(DISTINCT to_char(r.pay_date, 'YYYY-MM')) AS months
       FROM ${table(ctx, "pay_run_items")} i JOIN ${table(ctx, "pay_runs")} r ON r.id = i.run_id
      WHERE i.company_id = $1 AND r.status = 'locked' AND r.kind <> 'reversal' AND i.status = 'ok' AND i.eti_minor > 0 AND r.pay_date < $2::date
      GROUP BY i.employee_id`,
    [companyId, beforeDate],
  );
  return new Map(rows.map((r) => [String(r.employee_id), num(r.months)]));
}

// ---------------------------------------------------------------------------
// Payslips
// ---------------------------------------------------------------------------

export interface Payslip {
  id: string;
  runId: string;
  employeeId: string;
  number: string;
  status: "pending" | "ready" | "sending" | "sent" | "failed";
  r2Key: string | null;
  bytes: number;
  sha256: string | null;
  mailKey: string | null;
  emailedTo: string | null;
  emailedAt: string | null;
  error: string | null;
  createdAt: string | null;
}

const PAYSLIP_COLUMNS = "id, run_id, employee_id, number, status, r2_key, bytes, sha256, mail_key, emailed_to, emailed_at, error, created_at";

function mapPayslip(r: Record<string, unknown>): Payslip {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    employeeId: String(r.employee_id),
    number: String(r.number),
    status: r.status as Payslip["status"],
    r2Key: text(r.r2_key),
    bytes: num(r.bytes),
    sha256: text(r.sha256),
    mailKey: text(r.mail_key),
    emailedTo: text(r.emailed_to),
    emailedAt: text(r.emailed_at),
    error: text(r.error),
    createdAt: text(r.created_at),
  };
}

export async function listPayslips(ctx: Db, companyId: string, runId?: string): Promise<Payslip[]> {
  const params: unknown[] = [companyId];
  let where = "company_id = $1";
  if (runId) {
    params.push(runId);
    where += " AND run_id = $2";
  }
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT ${PAYSLIP_COLUMNS} FROM ${table(ctx, "payslips")} WHERE ${where} ORDER BY created_at DESC LIMIT 500`, params);
  return rows.map(mapPayslip);
}

export async function getPayslip(ctx: Db, companyId: string, id: string): Promise<Payslip | null> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT ${PAYSLIP_COLUMNS} FROM ${table(ctx, "payslips")} WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return rows[0] ? mapPayslip(rows[0]) : null;
}

export async function getPayslipByMailKey(ctx: Db, mailKey: string): Promise<(Payslip & { companyId: string }) | null> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT ${PAYSLIP_COLUMNS}, company_id FROM ${table(ctx, "payslips")} WHERE mail_key = $1`, [mailKey]);
  return rows[0] ? { ...mapPayslip(rows[0]), companyId: String(rows[0].company_id) } : null;
}

export async function upsertPayslip(ctx: Db, companyId: string, p: Payslip): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "payslips")} (id, company_id, run_id, employee_id, number, status, r2_key, bytes, sha256, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (run_id, employee_id) DO UPDATE SET status = EXCLUDED.status, r2_key = EXCLUDED.r2_key, bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256,
       error = EXCLUDED.error, updated_at = now()
     WHERE ${table(ctx, "payslips")}.status IN ('pending', 'ready', 'failed')`,
    [p.id, companyId, p.runId, p.employeeId, p.number, p.status, p.r2Key, p.bytes, p.sha256, p.error],
  );
}

/** Moves a payslip to `sending` only from the given statuses (one sender wins). */
export async function claimPayslip(ctx: Db, companyId: string, id: string, from: string[], mailKey: string, emailedTo: string): Promise<boolean> {
  const res = await ctx.db.execute(
    `UPDATE ${table(ctx, "payslips")} SET status = 'sending', mail_key = $3, emailed_to = $4, error = NULL, updated_at = now()
      WHERE company_id = $1 AND id = $2 AND status = ANY(${textArrayParam(5)})`,
    [companyId, id, mailKey, emailedTo, JSON.stringify(from)],
  );
  return (res.rowCount ?? 0) > 0;
}

const PAYSLIP_UPDATABLE = new Set(["status", "mail_key", "emailed_to", "emailed_at", "error"]);

export async function updatePayslip(ctx: Db, companyId: string, id: string, patch: Record<string, unknown>): Promise<number> {
  const set = setClause(patch, PAYSLIP_UPDATABLE, new Set(), 3);
  const res = await ctx.db.execute(`UPDATE ${table(ctx, "payslips")} SET ${set.sql}, updated_at = now() WHERE company_id = $1 AND id = $2`, [companyId, id, ...set.params]);
  return res.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

export interface LeaveRequest {
  id: string;
  employeeId: string;
  type: LeaveType;
  startDate: string;
  endDate: string;
  daysCenti: number;
  status: LeaveStatus;
  reason: string | null;
  approvalIssueId: string | null;
  requestedByUserId: string | null;
  requestedByAgentId: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
  createdAt: string | null;
}

const LEAVE_COLUMNS = `id, employee_id, leave_type, start_date::text AS start_date, end_date::text AS end_date, days_centi, status, reason, approval_issue_id,
  requested_by_user_id, requested_by_agent_id, decided_by_user_id, decided_at, created_at`;

function mapLeave(r: Record<string, unknown>): LeaveRequest {
  return {
    id: String(r.id),
    employeeId: String(r.employee_id),
    type: r.leave_type as LeaveType,
    startDate: day(r.start_date)!,
    endDate: day(r.end_date)!,
    daysCenti: num(r.days_centi),
    status: r.status as LeaveStatus,
    reason: text(r.reason),
    approvalIssueId: text(r.approval_issue_id),
    requestedByUserId: text(r.requested_by_user_id),
    requestedByAgentId: text(r.requested_by_agent_id),
    decidedByUserId: text(r.decided_by_user_id),
    decidedAt: text(r.decided_at),
    createdAt: text(r.created_at),
  };
}

export async function listLeave(ctx: Db, companyId: string, options: { employeeId?: string; status?: LeaveStatus } = {}): Promise<LeaveRequest[]> {
  const params: unknown[] = [companyId];
  let where = "company_id = $1";
  if (options.employeeId) {
    params.push(options.employeeId);
    where += ` AND employee_id = $${params.length}`;
  }
  if (options.status) {
    params.push(options.status);
    where += ` AND status = $${params.length}`;
  }
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT ${LEAVE_COLUMNS} FROM ${table(ctx, "leave_requests")} WHERE ${where} ORDER BY start_date DESC LIMIT 1000`, params);
  return rows.map(mapLeave);
}

export async function getLeave(ctx: Db, companyId: string, id: string): Promise<LeaveRequest | null> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT ${LEAVE_COLUMNS} FROM ${table(ctx, "leave_requests")} WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return rows[0] ? mapLeave(rows[0]) : null;
}

export async function getLeaveByIssue(ctx: Db, companyId: string, issueId: string): Promise<LeaveRequest | null> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT ${LEAVE_COLUMNS} FROM ${table(ctx, "leave_requests")} WHERE company_id = $1 AND approval_issue_id = $2`, [companyId, issueId]);
  return rows[0] ? mapLeave(rows[0]) : null;
}

export async function insertLeave(ctx: Db, companyId: string, l: LeaveRequest): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "leave_requests")} (id, company_id, employee_id, leave_type, start_date, end_date, days_centi, status, reason, requested_by_user_id, requested_by_agent_id)
     VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10, $11)`,
    [l.id, companyId, l.employeeId, l.type, l.startDate, l.endDate, l.daysCenti, l.status, l.reason, l.requestedByUserId, l.requestedByAgentId],
  );
}

const LEAVE_UPDATABLE = new Set(["status", "approval_issue_id", "decided_by_user_id", "decided_at"]);

export async function updateLeave(ctx: Db, companyId: string, id: string, patch: Record<string, unknown>, expectStatus?: LeaveStatus): Promise<number> {
  const set = setClause(patch, LEAVE_UPDATABLE, new Set(), 3);
  const params = [companyId, id, ...set.params];
  let guard = "";
  if (expectStatus) {
    params.push(expectStatus);
    guard = ` AND status = $${params.length}`;
  }
  const res = await ctx.db.execute(`UPDATE ${table(ctx, "leave_requests")} SET ${set.sql}, updated_at = now() WHERE company_id = $1 AND id = $2${guard}`, params);
  return res.rowCount ?? 0;
}

export interface LeaveOpeningRow {
  employeeId: string;
  type: LeaveType;
  daysCenti: number;
  asOf: string;
}

export async function listLeaveOpenings(ctx: Db, companyId: string): Promise<LeaveOpeningRow[]> {
  const rows = await ctx.db.query<Record<string, unknown>>(`SELECT employee_id, leave_type, days_centi, as_of::text AS as_of FROM ${table(ctx, "leave_openings")} WHERE company_id = $1`, [companyId]);
  return rows.map((r) => ({ employeeId: String(r.employee_id), type: r.leave_type as LeaveType, daysCenti: num(r.days_centi), asOf: day(r.as_of)! }));
}

export async function upsertLeaveOpening(ctx: Db, companyId: string, o: LeaveOpeningRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "leave_openings")} (company_id, employee_id, leave_type, days_centi, as_of) VALUES ($1, $2, $3, $4, $5::date)
     ON CONFLICT (employee_id, leave_type) DO UPDATE SET days_centi = EXCLUDED.days_centi, as_of = EXCLUDED.as_of, updated_at = now()`,
    [companyId, o.employeeId, o.type, o.daysCenti, o.asOf],
  );
}

// ---------------------------------------------------------------------------
// YTD openings (cut-over)
// ---------------------------------------------------------------------------

export interface YtdRow {
  employeeId: string;
  taxYear: string;
  codes: Record<string, number>;
  grossMinor: number;
  payeMinor: number;
  uifMinor: number;
  sdlMinor: number;
  etiMinor: number;
}

export async function listYtd(ctx: Db, companyId: string, taxYear: string): Promise<YtdRow[]> {
  const rows = await ctx.db.query<Record<string, unknown>>(
    `SELECT employee_id, tax_year, codes, gross_minor, paye_minor, uif_minor, sdl_minor, eti_minor FROM ${table(ctx, "ytd_openings")} WHERE company_id = $1 AND tax_year = $2`,
    [companyId, taxYear],
  );
  return rows.map((r) => ({
    employeeId: String(r.employee_id),
    taxYear: String(r.tax_year),
    codes: json(r.codes, {}),
    grossMinor: num(r.gross_minor),
    payeMinor: num(r.paye_minor),
    uifMinor: num(r.uif_minor),
    sdlMinor: num(r.sdl_minor),
    etiMinor: num(r.eti_minor),
  }));
}

export async function upsertYtd(ctx: Db, companyId: string, y: YtdRow, userId: string | null): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "ytd_openings")} (company_id, employee_id, tax_year, codes, gross_minor, paye_minor, uif_minor, sdl_minor, eti_minor, imported_by_user_id)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (employee_id, tax_year) DO UPDATE SET codes = EXCLUDED.codes, gross_minor = EXCLUDED.gross_minor, paye_minor = EXCLUDED.paye_minor,
       uif_minor = EXCLUDED.uif_minor, sdl_minor = EXCLUDED.sdl_minor, eti_minor = EXCLUDED.eti_minor, imported_by_user_id = EXCLUDED.imported_by_user_id, imported_at = now()`,
    [companyId, y.employeeId, y.taxYear, JSON.stringify(y.codes), y.grossMinor, y.payeMinor, y.uifMinor, y.sdlMinor, y.etiMinor, userId],
  );
}

// ---------------------------------------------------------------------------
// Exports and audit
// ---------------------------------------------------------------------------

export interface ExportRow {
  id: string;
  kind: string;
  ref: string;
  fileName: string;
  contentType: string;
  r2Key: string | null;
  bytes: number;
  sha256: string | null;
  rowCount: number;
  createdByUserId: string | null;
  createdAt: string | null;
}

export async function insertExport(ctx: Db, companyId: string, e: ExportRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "exports")} (id, company_id, kind, ref, file_name, content_type, r2_key, bytes, sha256, row_count, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [e.id, companyId, e.kind, e.ref, e.fileName, e.contentType, e.r2Key, e.bytes, e.sha256, e.rowCount, e.createdByUserId],
  );
}

export async function listExports(ctx: Db, companyId: string): Promise<ExportRow[]> {
  const rows = await ctx.db.query<Record<string, unknown>>(
    `SELECT id, kind, ref, file_name, content_type, r2_key, bytes, sha256, row_count, created_by_user_id, created_at FROM ${table(ctx, "exports")} WHERE company_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [companyId],
  );
  return rows.map((r) => ({
    id: String(r.id),
    kind: String(r.kind),
    ref: String(r.ref),
    fileName: String(r.file_name),
    contentType: String(r.content_type),
    r2Key: text(r.r2_key),
    bytes: num(r.bytes),
    sha256: text(r.sha256),
    rowCount: num(r.row_count),
    createdByUserId: text(r.created_by_user_id),
    createdAt: text(r.created_at),
  }));
}

export async function getExport(ctx: Db, companyId: string, id: string): Promise<ExportRow | null> {
  return (await listExports(ctx, companyId)).find((e) => e.id === id) ?? null;
}

export async function audit(
  ctx: Db,
  companyId: string,
  actor: { userId: string | null; agentId: string | null },
  action: string,
  entityKind: string,
  entityId: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "audit")} (id, company_id, actor_user_id, actor_agent_id, action, entity_kind, entity_id, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [newId("au"), companyId, actor.userId, actor.agentId, action, entityKind, entityId, JSON.stringify(detail)],
  );
}

export async function listAudit(ctx: Db, companyId: string, limit = 50): Promise<Array<{ at: string | null; actorUserId: string | null; actorAgentId: string | null; action: string; entityKind: string; entityId: string; detail: Record<string, unknown> }>> {
  const rows = await ctx.db.query<Record<string, unknown>>(
    `SELECT at, actor_user_id, actor_agent_id, action, entity_kind, entity_id, detail FROM ${table(ctx, "audit")} WHERE company_id = $1 ORDER BY at DESC LIMIT ${Math.max(1, Math.min(limit, 200))}`,
    [companyId],
  );
  return rows.map((r) => ({ at: text(r.at), actorUserId: text(r.actor_user_id), actorAgentId: text(r.actor_agent_id), action: String(r.action), entityKind: String(r.entity_kind), entityId: String(r.entity_id), detail: json(r.detail, {}) }));
}

/** Companies that have payroll rows (jobs have no company scope). */
export async function companiesWithRuns(ctx: Db): Promise<string[]> {
  const rows = await ctx.db.query<{ company_id: unknown }>(`SELECT DISTINCT company_id FROM ${table(ctx, "pay_runs")}`);
  return rows.map((r) => String(r.company_id));
}
