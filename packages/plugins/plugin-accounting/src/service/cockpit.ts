/**
 * Company Cockpit snapshot for Accounting (`GET /cockpit`, pushed hourly as
 * `cockpit.snapshot`): cash, this month's P&L, VAT due, bank lines to
 * reconcile, job and posting health, approvals waiting on a board user,
 * recent activity and how often people corrected the categorisation.
 *
 * Read-only and cheap: SELECTs only (no book is created, nothing is
 * verified here). The journal hash chain is verified by the daily month-end
 * job and its last result is read from plugin state. Each part is wrapped so
 * one failing query never breaks the whole snapshot.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  configSaved,
  decisionStats,
  emptySnapshot,
  formatMoneyMinor,
  isModuleEnabled,
  jobHealth,
  outboxHealth,
  publishCockpitSnapshot,
  type CockpitSnapshot,
  type Tone,
} from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import { vatPeriodFor } from "../domain/periods.js";
import { netProfit, profitAndLoss } from "../domain/reports.js";
import { monthOf, todayIso } from "../domain/util.js";
import { NAMESPACE, PLUGIN_ID } from "../namespace.js";
import { loadChart } from "./books.js";
import { BOOK_CURRENCY, errorMessage, readSettings } from "./common.js";
import { verifyJournalChain } from "./journals.js";
import { computeForPeriod } from "./vat.js";

const N = NAMESPACE;

/** Scheduled jobs and their interval in minutes (from the manifest schedules). */
export const ACCOUNTING_JOBS: Array<{ key: string; title: string; everyMinutes: number }> = [
  { key: "redeliver", title: "Bank matches and approval checks", everyMinutes: 5 },
  { key: "month-end", title: "Depreciation and month-end", everyMinutes: 1440 },
  { key: "fx-rates", title: "FX rates", everyMinutes: 1440 },
];

const PAGE = "/accounting";
const issueHref = (issueId: string) => `/issues/${issueId}`;
const money = (minor: number) => formatMoneyMinor(minor, BOOK_CURRENCY);
const n = (value: unknown) => Number(value ?? 0) || 0;
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const iso = (value: unknown): string | null => {
  if (value == null || value === "") return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// ── Hash-chain result (written by the daily job, read by the snapshot) ────

export interface ChainState {
  ok: boolean;
  checked: number;
  problem: string | null;
  firstBadSeq: number | null;
  at: string;
}

const CHAIN_STATE = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "pib-accounting-cockpit", stateKey: `chain:${companyId}` });

export async function recordChainCheck(ctx: PluginContext, companyId: string): Promise<ChainState> {
  const result = await verifyJournalChain(ctx, companyId);
  const state: ChainState = { ok: result.ok, checked: result.checked, problem: result.problem ?? null, firstBadSeq: result.firstBadSeq ?? null, at: new Date().toISOString() };
  await ctx.state.set(CHAIN_STATE(companyId), state).catch(() => undefined);
  return state;
}

async function lastChainCheck(ctx: PluginContext, companyId: string): Promise<ChainState | null> {
  try {
    return ((await ctx.state.get(CHAIN_STATE(companyId))) as ChainState | null) ?? null;
  } catch {
    return null;
  }
}

// ── Snapshot ──────────────────────────────────────────────────────────────

export async function cockpitSnapshot(ctx: PluginContext, companyId: string): Promise<CockpitSnapshot> {
  const snap = emptySnapshot(PLUGIN_ID, "Accounting");
  const failed: string[] = [];
  const part = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      failed.push(`${label}: ${errorMessage(error)}`);
    }
  };

  const [saved, settings, book] = await Promise.all([configSaved(ctx, companyId).catch(() => false), readSettings(ctx, companyId), db.getBook(ctx.db, companyId).catch(() => null)]);
  if (!saved) {
    snap.health.push({
      key: "settings",
      title: "Accounting settings",
      status: "warn",
      detail: "Accounting settings were never saved for this company, so its scheduled jobs skip it.",
      href: "/setup",
      fix: "Open Setup (or Accounting settings), fill in the legal name, VAT details and year-end, and click Save Configuration.",
    });
  }
  if (!book) {
    snap.health.push({ key: "book", title: "Books", status: "warn", detail: "The chart of accounts is not set up yet.", href: PAGE, fix: "Open the Accounting page once; it sets up the South African chart of accounts." });
  }

  const today = todayIso();
  const chart = book ? await loadChart(ctx, companyId).catch(() => null) : null;

  // ── KPIs ────────────────────────────────────────────────────────────────
  if (book && chart) {
    await part("cash", async () => {
      const [totals, banks] = await Promise.all([db.accountTotals(ctx.db, companyId, { to: today }), db.listBankAccounts(ctx.db, companyId)]);
      const codes = new Set(banks.filter((b) => b.active).map((b) => b.accountCode));
      const ids = new Set(chart.accounts.filter((a) => (codes.size ? codes.has(a.code) : a.cashFlow === "cash")).map((a) => a.id));
      const cash = totals.filter((t) => ids.has(t.accountId)).reduce((s, t) => s + t.debitMinor - t.creditMinor, 0);
      snap.kpis.push({ key: "cash", label: "Cash in bank", value: money(cash), raw: cash, tone: cash < 0 ? "bad" : "neutral", href: `${PAGE}?tab=bank`, group: "money" });
    });

    await part("month", async () => {
      const month = monthOf(today);
      const totals = await db.accountTotals(ctx.db, companyId, { from: `${month}-01`, to: today });
      const pnl = profitAndLoss(chart.accounts, totals);
      const revenue = pnl.totalRevenueMinor + pnl.totalOtherIncomeMinor;
      const expenses = pnl.totalCostOfSalesMinor + pnl.totalExpensesMinor;
      const profit = netProfit(chart.accounts, totals);
      const href = `${PAGE}?tab=reports`;
      snap.kpis.push({ key: "month_revenue", label: "Revenue this month", value: money(revenue), raw: revenue, tone: "neutral", href, group: "money" });
      snap.kpis.push({ key: "month_expenses", label: "Expenses this month", value: money(expenses), raw: expenses, tone: "neutral", href, group: "money" });
      snap.kpis.push({ key: "month_profit", label: "Profit this month", value: money(profit), raw: profit, tone: profit < 0 ? "warn" : "ok", href, group: "money" });
    });

    await part("vat", async () => {
      const period = vatPeriodFor(today, settings.vatCategory, settings.yearEndMonth);
      if (!period) return;
      const saved = await db.vatReturnByPeriod(ctx.db, companyId, period.start, period.end);
      const result = await computeForPeriod(ctx, companyId, period.start, period.end, (saved?.adjustments ?? {}) as Record<string, number>);
      const due = n(result.boxes.f20);
      snap.kpis.push({
        key: "vat_due",
        label: due < 0 ? `VAT refund (${period.start} to ${period.end})` : `VAT due (${period.start} to ${period.end})`,
        value: money(Math.abs(due)),
        raw: due,
        tone: "neutral",
        href: `${PAGE}?tab=vat`,
        group: "money",
      });
    });
  }

  await part("bank lines", async () => {
    const rows = await ctx.db.query<{ open: string; old: string; oldest: unknown }>(
      `SELECT count(*)::text AS open,
              count(*) FILTER (WHERE date < current_date - 14)::text AS old,
              min(date) FILTER (WHERE date < current_date - 14) AS oldest
         FROM ${N}.bank_lines WHERE company_id = $1 AND status IN ('unreconciled', 'matching')`,
      [companyId],
    );
    const open = n(rows[0]?.open);
    const old = n(rows[0]?.old);
    snap.kpis.push({ key: "unreconciled", label: "Bank lines to reconcile", value: String(open), raw: open, tone: old > 0 ? "warn" : "ok", href: `${PAGE}?tab=bank`, group: "money" });
    snap.health.push(old > 0
      ? { key: "unreconciled_old", title: "Old bank lines", status: "warn", detail: `${plural(old, "bank line")} older than 14 days not reconciled.`, href: `${PAGE}?tab=bank`, fix: "Categorise or match them on the Bank tab (the Bookkeeper does this when hired).", since: iso(rows[0]?.oldest) }
      : { key: "unreconciled_old", title: "Old bank lines", status: "ok" });
  });

  // ── Health ──────────────────────────────────────────────────────────────
  await part("jobs", async () => {
    for (const job of ACCOUNTING_JOBS) snap.health.push(await jobHealth(ctx, job.key, job.title, job.everyMinutes));
  });
  await part("outbox", async () => {
    snap.health.push({ ...(await outboxHealth(ctx, companyId)), href: PAGE });
  });

  await part("rejections", async () => {
    const rows = await ctx.db.query<{ open: string; closed: string; oldest: unknown }>(
      `SELECT count(*)::text AS open,
              count(*) FILTER (WHERE error ILIKE '%is closed%' OR error ILIKE '%soft-closed%' OR error ILIKE '%is locked%')::text AS closed,
              min(first_at) AS oldest
         FROM ${N}.posting_rejections WHERE company_id = $1 AND status = 'open'`,
      [companyId],
    );
    const open = n(rows[0]?.open);
    const closed = n(rows[0]?.closed);
    const href = book?.rejectionIssueId ? issueHref(book.rejectionIssueId) : `${PAGE}?tab=journals`;
    snap.health.push(open > 0
      ? { key: "rejections", title: "Rejected postings", status: "bad", detail: `${plural(open, "posting")} from other plugins could not be posted, so the books are missing them.`, href, fix: "Open Accounting → Journals → Rejected, fix the cause (role, period) and click Retry.", since: iso(rows[0]?.oldest) }
      : { key: "rejections", title: "Rejected postings", status: "ok" });
    snap.health.push(closed > 0
      ? { key: "closed_period", title: "Postings into closed periods", status: "warn", detail: `${plural(closed, "posting")} refused because the period is closed or its VAT return is locked.`, href: `${PAGE}?tab=journals`, fix: "Reopen the period if the posting belongs there, or correct the document date in the sending plugin." }
      : { key: "closed_period", title: "Postings into closed periods", status: "ok" });
  });

  await part("chain", async () => {
    const chain = await lastChainCheck(ctx, companyId);
    snap.health.push(!chain
      ? { key: "hash_chain", title: "Journal audit chain", status: "ok", detail: "Not checked yet (checked daily)." }
      : chain.ok
        ? { key: "hash_chain", title: "Journal audit chain", status: "ok", detail: `${plural(chain.checked, "journal")} checked.` }
        : { key: "hash_chain", title: "Journal audit chain", status: "bad", detail: chain.problem ?? `The chain breaks at journal ${chain.firstBadSeq ?? "?"}.`, since: chain.at, href: `${PAGE}?tab=journals`, fix: "Someone changed a posted journal outside the plugin. Stop posting and ask the accountant to compare against the last accountant pack." });
  });

  if (book) {
    snap.health.push(book.openingJournalId || book.cutoverDate
      ? { key: "opening_balances", title: "Opening balances", status: "ok" }
      : { key: "opening_balances", title: "Opening balances", status: "warn", detail: "No opening balances posted, so balances only cover what was posted here.", href: `${PAGE}?tab=cutover`, fix: "Post the trial balance from your previous books on the Cut-over tab (skip if the business started on these books)." });
  }

  // ── Waiting on a person ─────────────────────────────────────────────────
  await part("approvals", async () => {
    const drafts = await ctx.db.query<{ id: string; memo: string; approval_issue_id: string; updated_at: unknown }>(
      `SELECT id, memo, approval_issue_id, updated_at FROM ${N}.journal_drafts
        WHERE company_id = $1 AND status = 'pending_approval' AND approval_issue_id IS NOT NULL ORDER BY updated_at LIMIT 25`,
      [companyId],
    );
    for (const d of drafts) {
      snap.waiting.push({ key: `approval:${d.approval_issue_id}`, title: `Approve manual journal${d.memo ? `: ${d.memo.slice(0, 60)}` : ""}`, why: "A manual journal changes the books; a board user approves it.", href: issueHref(d.approval_issue_id), issueId: d.approval_issue_id, kind: "money", since: iso(d.updated_at) });
    }
    const recs = await ctx.db.query<{ approval_issue_id: string; period_start: unknown; period_end: unknown; updated_at: unknown }>(
      `SELECT approval_issue_id, period_start::text AS period_start, period_end::text AS period_end, updated_at FROM ${N}.reconciliations
        WHERE company_id = $1 AND status = 'pending_approval' AND approval_issue_id IS NOT NULL ORDER BY updated_at LIMIT 25`,
      [companyId],
    );
    for (const r of recs) {
      snap.waiting.push({ key: `approval:${r.approval_issue_id}`, title: `Approve bank reconciliation ${String(r.period_start)} to ${String(r.period_end)}`, why: "Approving locks the bank lines for the period; a board user signs it off.", href: issueHref(r.approval_issue_id), issueId: r.approval_issue_id, kind: "money", since: iso(r.updated_at) });
    }
    const vats = await ctx.db.query<{ approval_issue_id: string; period_start: unknown; period_end: unknown; updated_at: unknown }>(
      `SELECT approval_issue_id, period_start::text AS period_start, period_end::text AS period_end, updated_at FROM ${N}.vat_returns
        WHERE company_id = $1 AND status = 'pending_approval' AND approval_issue_id IS NOT NULL ORDER BY updated_at LIMIT 25`,
      [companyId],
    );
    for (const v of vats) {
      snap.waiting.push({ key: `approval:${v.approval_issue_id}`, title: `Approve VAT201 ${String(v.period_start)} to ${String(v.period_end)}`, why: "The VAT return is filed with SARS; a board user approves and locks it.", href: issueHref(v.approval_issue_id), issueId: v.approval_issue_id, kind: "legal", since: iso(v.updated_at) });
    }
    if (book?.rejectionIssueId) {
      const open = await ctx.db.query<{ n: string; oldest: unknown }>(`SELECT count(*)::text AS n, min(first_at) AS oldest FROM ${N}.posting_rejections WHERE company_id = $1 AND status = 'open'`, [companyId]);
      if (n(open[0]?.n) > 0) {
        snap.waiting.push({ key: `rejections:${book.rejectionIssueId}`, title: `Fix ${plural(n(open[0]?.n), "rejected posting")}`, why: "The books are missing these journals until someone fixes the cause and retries.", href: issueHref(book.rejectionIssueId), issueId: book.rejectionIssueId, kind: "judgement", since: iso(open[0]?.oldest) });
      }
    }
  });

  // ── Activity ────────────────────────────────────────────────────────────
  await part("activity", async () => {
    const rows = await ctx.db.query<{ kind: string; at: unknown; label: string; extra: string | null }>(
      `SELECT * FROM (
         SELECT 'journal' AS kind, j.created_at AS at, j.number AS label, j.memo AS extra
           FROM ${N}.journals j WHERE j.company_id = $1
         UNION ALL
         SELECT 'statement' AS kind, s.created_at AS at, COALESCE(NULLIF(s.file_name, ''), s.format) AS label, s.new_count::text AS extra
           FROM ${N}.statements s WHERE s.company_id = $1
         UNION ALL
         SELECT 'reconciliation' AS kind, r.locked_at AS at, r.period_start::text || ' to ' || r.period_end::text AS label, NULL AS extra
           FROM ${N}.reconciliations r WHERE r.company_id = $1 AND r.status = 'locked' AND r.locked_at IS NOT NULL
       ) a ORDER BY at DESC LIMIT 10`,
      [companyId],
    );
    for (const row of rows) {
      const text = row.kind === "journal"
        ? `Posted ${row.label}${row.extra ? ` (${row.extra.slice(0, 80)})` : ""}`
        : row.kind === "statement"
          ? `Imported statement ${row.label} (${plural(n(row.extra), "new line")})`
          : `Locked the bank reconciliation for ${row.label}`;
      snap.activity.push({ at: iso(row.at) ?? new Date().toISOString(), text, href: `${PAGE}?tab=${row.kind === "journal" ? "journals" : "bank"}` });
    }
  });

  // ── Quality ─────────────────────────────────────────────────────────────
  await part("quality", async () => {
    const stats = (await decisionStats(ctx, companyId, 30)).filter((s) => s.purpose === "bank_line_category");
    const total = stats.reduce((s, r) => s + n(r.total), 0);
    const corrected = stats.reduce((s, r) => s + n(r.corrected), 0);
    const rate = total ? corrected / total : 0;
    const tone: Tone = rate > 0.25 ? "bad" : rate > 0.1 ? "warn" : "ok";
    snap.quality.push({ key: "categorisation_corrected", label: "Bank categorisation corrected by people (30 days)", value: total ? `${corrected} of ${total}` : "None", raw: corrected, tone });
  });

  if (failed.length) {
    snap.health.push({ key: "snapshot", title: "Cockpit numbers", status: "warn", detail: `Some numbers could not be read: ${failed.join("; ").slice(0, 400)}` });
  }
  snap.checkedAt = new Date().toISOString();
  return snap;
}

// ── Hourly push ───────────────────────────────────────────────────────────

const PUSH_EVERY_MS = 60 * 60 * 1000;
const lastPushed = new Map<string, number>();

/** Push at most once an hour per company (module on, settings saved); never throws. */
export async function publishCockpitThrottled(ctx: PluginContext, companyId: string, now = Date.now()): Promise<boolean> {
  const last = lastPushed.get(companyId);
  if (last != null && now - last < PUSH_EVERY_MS) return false;
  lastPushed.set(companyId, now);
  try {
    if (!(await isModuleEnabled(ctx, companyId, PLUGIN_ID)) || !(await configSaved(ctx, companyId))) return false;
    await publishCockpitSnapshot(ctx, companyId, await cockpitSnapshot(ctx, companyId));
    return true;
  } catch (error) {
    ctx.logger.info("Accounting cockpit snapshot failed", { companyId, error: errorMessage(error) });
    return false;
  }
}

/** Test hook: forget the push times. */
export function resetCockpitThrottle(): void {
  lastPushed.clear();
}
