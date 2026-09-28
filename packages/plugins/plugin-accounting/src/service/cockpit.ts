/**
 * Company Cockpit snapshot for Accounting (`GET /cockpit`, pushed hourly as
 * `cockpit.snapshot`): cash, this month's P&L, VAT due, bank lines to
 * reconcile, job and posting health, approvals waiting on a board user,
 * recent activity, how often people corrected the categorisation, and the
 * Bookkeeper it staffs (`team`).
 *
 * Read-only and cheap: SELECTs only (no book is created, nothing is
 * verified here). The journal hash chain is verified by the daily month-end
 * job and its last result is read from plugin state. Each part is wrapped so
 * one failing query never breaks the whole snapshot.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  cleanFlowReports,
  configSaved,
  decisionStats,
  emptySnapshot,
  formatMoneyMinor,
  isModuleEnabled,
  jobHealth,
  outboxHealth,
  publishCockpitSnapshot,
  type CockpitSnapshot,
  type FlowStageReport,
  type Tone,
} from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import { vatPeriodFor } from "../domain/periods.js";
import { netProfit, profitAndLoss } from "../domain/reports.js";
import { periodLabel } from "../domain/dates.js";
import { cleanMemo } from "../domain/memo.js";
import { dayText, monthOf, todayIso } from "../domain/util.js";
import { NAMESPACE, PLUGIN_ID } from "../namespace.js";
import { bookkeeper } from "./agent.js";
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

/** `27 Sep` (the year only when it is not this year). */
function shortDay(date: string, today = todayIso()): string {
  const full = dayText(date);
  return date.slice(0, 4) === today.slice(0, 4) ? full.replace(/ \d{4}$/, "") : full;
}

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

// ── Flows (kit FLOWS: bank.match, books.statements, books.approval) ───────

/** Bank lines waiting longer than this since they were imported are stuck. */
export const BANK_LINE_STUCK_DAYS = 7;
/** Statement emails not imported after this long are stuck. */
export const STATEMENT_STUCK_DAYS = 2;
/** Approvals waiting longer than this for a person are stuck. */
export const APPROVAL_STUCK_DAYS = 3;

const wholeDaysSince = (value: unknown, now = Date.now()): number | null => {
  const at = iso(value);
  return at ? Math.max(0, Math.floor((now - Date.parse(at)) / 86_400_000)) : null;
};

/**
 * One report per stage Accounting owns. The same definitions as the rest of
 * the snapshot and the Bank page:
 * - `bank.match`: open bank lines (unreconciled, or sent to Billing and not
 *   settled yet), the "Bank lines to reconcile" KPI. Stuck: waiting more
 *   than 7 days since import, or dated after today (a person checks the date).
 * - `books.statements`: statement emails from the Mailbox not imported yet
 *   (nor recorded as a duplicate or not a statement). Stuck: over 2 days old.
 * - `books.approval`: manual journals, bank reconciliations and VAT201
 *   returns waiting for a person's approval (the "waiting" items). Stuck:
 *   waiting more than 3 days.
 */
export async function flowReports(ctx: PluginContext, companyId: string, today = todayIso()): Promise<FlowStageReport[]> {
  const reports: FlowStageReport[] = [];

  const lines = await ctx.db.query<{ open: string; future: string; waiting: string; oldest: unknown }>(
    `SELECT count(*)::text AS open,
            count(*) FILTER (WHERE date > $2::date)::text AS future,
            count(*) FILTER (WHERE date <= $2::date AND created_at < now() - interval '${BANK_LINE_STUCK_DAYS} days')::text AS waiting,
            min(created_at) FILTER (WHERE date <= $2::date) AS oldest
       FROM ${N}.bank_lines WHERE company_id = $1 AND status IN ('unreconciled', 'matching')`,
    [companyId, today],
  );
  const open = n(lines[0]?.open);
  const future = n(lines[0]?.future);
  const waiting = n(lines[0]?.waiting);
  const why = [waiting ? `${waiting} waiting over ${BANK_LINE_STUCK_DAYS} days` : "", future ? `${future} dated in the future (check the date)` : ""].filter(Boolean).join(", ");
  reports.push({ stage: "bank.match", count: open, stuck: waiting + future, stuckReason: why || null, oldestDays: wholeDaysSince(lines[0]?.oldest) });

  const emails = await ctx.db.query<{ n: string; old: string; oldest: unknown }>(
    `SELECT count(*)::text AS n,
            count(*) FILTER (WHERE COALESCE(received_at, created_at) < now() - interval '${STATEMENT_STUCK_DAYS} days')::text AS old,
            min(COALESCE(received_at, created_at)) AS oldest
       FROM ${N}.statement_emails WHERE company_id = $1 AND status = 'received'`,
    [companyId],
  );
  const old = n(emails[0]?.old);
  reports.push({ stage: "books.statements", count: n(emails[0]?.n), stuck: old, stuckReason: old ? `${old} over ${STATEMENT_STUCK_DAYS} days old` : null, oldestDays: wholeDaysSince(emails[0]?.oldest) });

  const approvals = await ctx.db.query<{ n: string; old: string; oldest: unknown }>(
    `SELECT count(*)::text AS n,
            count(*) FILTER (WHERE since < now() - interval '${APPROVAL_STUCK_DAYS} days')::text AS old,
            min(since) AS oldest
       FROM (
         SELECT d.updated_at AS since FROM ${N}.journal_drafts d WHERE d.company_id = $1 AND d.status = 'pending_approval' AND d.approval_issue_id IS NOT NULL
         UNION ALL
         SELECT r.updated_at AS since FROM ${N}.reconciliations r WHERE r.company_id = $1 AND r.status = 'pending_approval' AND r.approval_issue_id IS NOT NULL
         UNION ALL
         SELECT v.updated_at AS since FROM ${N}.vat_returns v WHERE v.company_id = $1 AND v.status = 'pending_approval' AND v.approval_issue_id IS NOT NULL
       ) w`,
    [companyId],
  );
  const late = n(approvals[0]?.old);
  reports.push({ stage: "books.approval", count: n(approvals[0]?.n), stuck: late, stuckReason: late ? `${late} waiting over ${APPROVAL_STUCK_DAYS} days` : null, oldestDays: wholeDaysSince(approvals[0]?.oldest) });

  return reports;
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
      // As at today, like every money figure: a journal dated later counts nowhere yet (flagged under health).
      snap.kpis.push({ key: "cash", label: "Cash in bank", value: money(cash), raw: cash, tone: cash < 0 ? "bad" : "neutral", delta: `as at ${shortDay(today)}`, href: `${PAGE}?tab=bank`, group: "money" });
    });

    await part("month", async () => {
      const month = monthOf(today);
      const totals = await db.accountTotals(ctx.db, companyId, { from: `${month}-01`, to: today });
      const pnl = profitAndLoss(chart.accounts, totals);
      const revenue = pnl.totalRevenueMinor + pnl.totalOtherIncomeMinor;
      const expenses = pnl.totalCostOfSalesMinor + pnl.totalExpensesMinor;
      const profit = netProfit(chart.accounts, totals);
      const href = `${PAGE}?tab=reports`;
      const toDate = Number(today.slice(8, 10)) <= 1 ? shortDay(today) : `1–${shortDay(today)}`;
      snap.kpis.push({ key: "month_revenue", label: "Revenue this month", value: money(revenue), raw: revenue, tone: "neutral", delta: toDate, href, group: "money" });
      snap.kpis.push({ key: "month_expenses", label: "Expenses this month", value: money(expenses), raw: expenses, tone: "neutral", delta: toDate, href, group: "money" });
      snap.kpis.push({ key: "month_profit", label: "Profit this month", value: money(profit), raw: profit, tone: profit < 0 ? "warn" : "ok", delta: toDate, href, group: "money" });
    });

    await part("vat", async () => {
      const period = vatPeriodFor(today, settings.vatCategory, settings.yearEndMonth);
      if (!period) return;
      const saved = await db.vatReturnByPeriod(ctx.db, companyId, period.start, period.end);
      const result = await computeForPeriod(ctx, companyId, period.start, period.end, (saved?.adjustments ?? {}) as Record<string, number>);
      const due = n(result.boxes.f20);
      snap.kpis.push({
        key: "vat_due",
        label: due < 0 ? `VAT refund (${periodLabel(period.start, period.end)})` : `VAT due (${periodLabel(period.start, period.end)})`,
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

  await part("future dates", async () => {
    const dated = await db.datedAfter(ctx.db, companyId, today, 5);
    const first = dated.items[0]?.date ?? null;
    const what = [dated.bankLines ? plural(dated.bankLines, "bank line") : "", dated.journals ? plural(dated.journals, "journal") : ""].filter(Boolean).join(" and ");
    snap.health.push(dated.bankLines + dated.journals > 0
      ? { key: "future_dates", title: "Dated in the future", status: "warn", detail: `${what} dated after today (first ${first ? shortDay(first) : "?"}). They count in no balance until then. Check the date.`, href: `${PAGE}?tab=bank`, fix: "Open Accounting → Bank and check the statement dates. A date in the future is usually the day and month swapped on import." }
      : { key: "future_dates", title: "Dated in the future", status: "ok" });
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
    const href = book?.rejectionIssueId ? issueHref(book.rejectionIssueId) : `${PAGE}?tab=rejected`;
    snap.health.push(open > 0
      ? { key: "rejections", title: "Rejected postings", status: "bad", detail: `${plural(open, "posting")} from other plugins could not be posted, so the books are missing them.`, href, fix: "Open Accounting → Journals → Rejected, fix the cause (account role or closed period) and click Retry.", since: iso(rows[0]?.oldest) }
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
      : book.cutoverSkippedAt
        ? { key: "opening_balances", title: "Opening balances", status: "ok", detail: "Not needed: the business started on these books." }
        : { key: "opening_balances", title: "Opening balances", status: "warn", detail: "No opening balances yet, so the balance sheet only covers what was posted here.", href: `${PAGE}?tab=cutover`, fix: "Bring over the balances from your previous books under Accounting → Books setup → Cut-over. If the business started on these books, click We started on these books there instead." });
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
      snap.waiting.push({ key: `approval:${r.approval_issue_id}`, title: `Approve bank reconciliation ${dayText(String(r.period_start))} to ${dayText(String(r.period_end))}`, why: "Approving locks the bank lines for the period; a board user signs it off.", href: issueHref(r.approval_issue_id), issueId: r.approval_issue_id, kind: "money", since: iso(r.updated_at) });
    }
    const vats = await ctx.db.query<{ approval_issue_id: string; period_start: unknown; period_end: unknown; updated_at: unknown }>(
      `SELECT approval_issue_id, period_start::text AS period_start, period_end::text AS period_end, updated_at FROM ${N}.vat_returns
        WHERE company_id = $1 AND status = 'pending_approval' AND approval_issue_id IS NOT NULL ORDER BY updated_at LIMIT 25`,
      [companyId],
    );
    for (const v of vats) {
      snap.waiting.push({ key: `approval:${v.approval_issue_id}`, title: `Approve the VAT return (VAT201) for ${periodLabel(String(v.period_start), String(v.period_end))}`, why: "The VAT return is filed with SARS; a board user approves and locks it.", href: issueHref(v.approval_issue_id), issueId: v.approval_issue_id, kind: "legal", since: iso(v.updated_at) });
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
         SELECT 'reconciliation' AS kind, r.locked_at AS at, r.period_start::text AS label, r.period_end::text AS extra
           FROM ${N}.reconciliations r WHERE r.company_id = $1 AND r.status = 'locked' AND r.locked_at IS NOT NULL
       ) a ORDER BY at DESC LIMIT 10`,
      [companyId],
    );
    for (const row of rows) {
      const memo = row.extra ? cleanMemo(row.extra) : "";
      const text = row.kind === "journal"
        ? `Posted ${row.label}${memo ? ` (${memo.slice(0, 80)})` : ""}`
        : row.kind === "statement"
          ? `Imported statement ${row.label} (${plural(n(row.extra), "new line")})`
          : `Locked the bank reconciliation for ${dayText(row.label)} to ${dayText(row.extra)}`;
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

  // ── Team: the Bookkeeper this plugin staffs (the Cockpit shares it in roles.updated for routeWork) ──
  await part("team", async () => {
    const agent = await bookkeeper(ctx, companyId);
    snap.team = [{ role: "bookkeeper", agentId: agent?.id ?? null, status: agent?.status ?? null }];
  });

  // ── Flows: live numbers for the company-graph stages Accounting owns ──
  await part("flows", async () => {
    snap.flows = cleanFlowReports(PLUGIN_ID, await flowReports(ctx, companyId, today));
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
