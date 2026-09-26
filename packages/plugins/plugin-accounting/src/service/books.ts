/**
 * Book setup: the first time a company touches Accounting (settings saved,
 * page opened or a posting arrives) the SA chart, the role map and the VAT
 * codes are seeded. Every seed is ON CONFLICT DO NOTHING and the book row is
 * written last, so an interrupted setup simply runs again.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ACCOUNT_ROLES, TAX_CODES } from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import {
  CHART_TEMPLATE_ID,
  chartSeedRows,
  isKnownRoleName,
  normaliseRole,
  roleSeedRows,
  validateAccountInput,
  type Account,
} from "../domain/chart.js";
import type { ChartIndex } from "../domain/journal.js";
import { PERIOD_STATUSES, type PeriodStatus } from "../domain/periods.js";
import { AccountingError, requireMonth } from "../domain/util.js";
import { BOOK_CURRENCY, newId, withLock, type Actor } from "./common.js";

const ready = new Set<string>();

const TAX_KIND: Record<string, string> = {
  za_std_15: "standard",
  za_capital_15: "capital",
  za_zero: "zero",
  za_export_zero: "export",
  za_exempt: "exempt",
  za_out_of_scope: "out_of_scope",
};

/** Seeded VAT codes. 15% from 1 April 2018 (Rates and Monetary Amounts Act 2018, VAT Act s7(1)). */
export function taxRateSeedRows() {
  return Object.entries(TAX_CODES).map(([code, info]) => ({
    code,
    version: 1,
    label: info.label,
    kind: TAX_KIND[code] ?? "out_of_scope",
    rate_bps: Math.round(info.rate * 10_000),
    effective_from: info.rate > 0 ? "2018-04-01" : "1991-09-30",
    source: info.rate > 0 ? "VAT Act s7(1)(a): 15% from 2018-04-01" : "VAT Act s11 / s12 (zero-rated, exempt) or outside the VAT Act",
  }));
}

export async function ensureBook(ctx: PluginContext, companyId: string): Promise<db.BookRow> {
  if (ready.has(companyId)) {
    const book = await db.getBook(ctx.db, companyId);
    if (book) return book;
    ready.delete(companyId);
  }
  return withLock(`book:${companyId}`, async () => {
    const existing = await db.getBook(ctx.db, companyId);
    if (existing) {
      if (existing.chartTemplate !== CHART_TEMPLATE_ID) {
        // A newer template: add its new accounts and roles; nothing a person changed is overwritten.
        await db.seedAccounts(ctx.db, companyId, chartSeedRows(newId));
        await db.seedRoles(ctx.db, companyId, roleSeedRows());
        await db.seedTaxRates(ctx.db, companyId, taxRateSeedRows());
        await db.setChartTemplate(ctx.db, companyId, CHART_TEMPLATE_ID);
        ctx.logger.info("Accounting chart topped up", { companyId, from: existing.chartTemplate, to: CHART_TEMPLATE_ID });
      }
      ready.add(companyId);
      return existing;
    }
    await db.seedAccounts(ctx.db, companyId, chartSeedRows(newId));
    await db.seedRoles(ctx.db, companyId, roleSeedRows());
    await db.seedTaxRates(ctx.db, companyId, taxRateSeedRows());
    await db.insertBook(ctx.db, companyId, BOOK_CURRENCY, CHART_TEMPLATE_ID);
    ctx.logger.info("Accounting book set up", { companyId });
    ready.add(companyId);
    const book = await db.getBook(ctx.db, companyId);
    if (!book) throw new AccountingError("The book could not be set up");
    return book;
  });
}

export interface Chart extends ChartIndex {
  accounts: Account[];
  byId: ReadonlyMap<string, Account>;
}

export async function loadChart(ctx: PluginContext, companyId: string): Promise<Chart> {
  const [accounts, roles] = await Promise.all([db.listAccounts(ctx.db, companyId), db.listRoles(ctx.db, companyId)]);
  return {
    accounts,
    roles,
    byCode: new Map(accounts.map((a) => [a.code, a])),
    byId: new Map(accounts.map((a) => [a.id, a])),
  };
}

export function roleAccount(chart: Chart, role: string): Account | null {
  const code = chart.roles.get(role);
  return code ? chart.byCode.get(code) ?? null : null;
}

/** Roles with no account, or mapped to a missing/inactive account. */
export function roleGaps(chart: Chart): string[] {
  const gaps: string[] = [];
  for (const role of ACCOUNT_ROLES) {
    const account = roleAccount(chart, role);
    if (!account || !account.active) gaps.push(role);
  }
  return gaps;
}

export async function saveAccount(ctx: PluginContext, companyId: string, input: Record<string, unknown>): Promise<Account> {
  const valid = validateAccountInput(input);
  const chart = await loadChart(ctx, companyId);
  const id = typeof input.id === "string" && input.id ? input.id : null;
  const clash = chart.byCode.get(valid.code);
  if (!id) {
    if (clash) throw new AccountingError(`Account code ${valid.code} is already used by ${clash.name}`, "conflict");
    const account: Account = { id: newId(), ...valid, description: typeof input.description === "string" ? input.description.trim() : "", system: false, active: true };
    await db.insertAccount(ctx.db, companyId, account);
    return account;
  }
  const current = chart.byId.get(id);
  if (!current) throw new AccountingError("Account not found", "not_found");
  if (clash && clash.id !== id) throw new AccountingError(`Account code ${valid.code} is already used by ${clash.name}`, "conflict");
  const active = input.active === undefined ? current.active : input.active !== false;
  if (valid.code !== current.code && (await db.accountHasPostings(ctx.db, companyId, id))) {
    throw new AccountingError("This account already has postings, so its code cannot change. Rename it instead.", "conflict");
  }
  if (!active && current.system) throw new AccountingError("System accounts back a role and cannot be switched off. Map the role elsewhere first.", "conflict");
  if (!active && [...chart.roles.values()].includes(current.code)) {
    throw new AccountingError("A role still points at this account. Map the role to another account first.", "conflict");
  }
  if (valid.type !== current.type && (await db.accountHasPostings(ctx.db, companyId, id))) {
    throw new AccountingError("This account already has postings, so it cannot move to another section (asset, liability, …).", "conflict");
  }
  const updated: Account = {
    ...current,
    ...valid,
    description: typeof input.description === "string" ? input.description.trim() : current.description,
    active,
  };
  await db.updateAccount(ctx.db, companyId, id, updated);
  // Keep role map entries pointing at the renamed code.
  if (valid.code !== current.code) {
    for (const [role, code] of chart.roles) if (code === current.code) await db.setRole(ctx.db, companyId, role, valid.code);
  }
  return updated;
}

export async function mapRole(ctx: PluginContext, companyId: string, roleInput: unknown, codeInput: unknown): Promise<{ role: string; accountCode: string | null }> {
  const role = typeof roleInput === "string" ? normaliseRole(roleInput) : "";
  if (!role || !isKnownRoleName(role)) throw new AccountingError("Role must be a kit role (e.g. ar, vat_output) or expense:<category> / revenue:<category>");
  if (codeInput == null || codeInput === "") {
    if ((ACCOUNT_ROLES as readonly string[]).includes(role)) throw new AccountingError("Core roles cannot be removed; map them to another account instead.");
    await db.deleteRole(ctx.db, companyId, role);
    return { role, accountCode: null };
  }
  const code = String(codeInput).trim();
  const chart = await loadChart(ctx, companyId);
  const account = chart.byCode.get(code);
  if (!account) throw new AccountingError(`Unknown account ${code}`, "unknown_account");
  if (!account.active) throw new AccountingError(`Account ${code} is inactive`, "inactive_account");
  await db.setRole(ctx.db, companyId, role, code);
  return { role, accountCode: code };
}

export async function setPeriod(ctx: PluginContext, companyId: string, period: unknown, status: unknown, actor: Actor): Promise<{ period: string; status: PeriodStatus }> {
  const p = requireMonth(period, "period");
  if (!(PERIOD_STATUSES as readonly string[]).includes(String(status))) throw new AccountingError("status must be open, soft_closed or closed");
  const by = actor.kind === "user" ? actor.userId : actor.kind;
  await db.setPeriodStatus(ctx.db, companyId, p, String(status), by);
  return { period: p, status: String(status) as PeriodStatus };
}
