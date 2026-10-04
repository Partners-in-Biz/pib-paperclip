/**
 * Company Cockpit snapshot for Billing (`GET /cockpit`, pushed hourly as
 * `cockpit.snapshot`): the money a founder checks, job and delivery health,
 * the approvals and checks waiting on a person, recent activity and quality,
 * and live numbers for Billing's stages of the lead-to-cash flow (`flows`),
 * each from the same query as its KPI.
 *
 * Read-only and cheap: a handful of SELECTs, no external calls. Each part is
 * wrapped so one failing query never breaks the whole snapshot.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  cleanFlowReports,
  configSaved,
  decisionStats,
  emptySnapshot,
  flowStagesFor,
  formatMoneyMinor,
  jobHealth,
  outboxHealth,
  publishCockpitSnapshot,
  rolesCopyHealth,
  type CockpitSnapshot,
  type FlowStageReport,
  type Tone,
} from "@partnersinbiz/pib-plugin-kit";
import { AS_AT_CUTOFF_SQL, asAtDate, invoiceBalances, iso, statusAsAtToday } from "./balances.js";
import { isCanaryCustomer, isCanarySql } from "./canary.js";
import { billingSettings } from "./config.js";
import { stuckAcceptances } from "./accepted-store.js";
import { asObject, table } from "./db.js";
import { daysPastDue, shortDayText } from "./domain.js";
import { PLUGIN_ID } from "./namespace.js";
import { providerStates } from "./pay/settings.js";
import { billingOn, knownCompanyIds } from "./setup.js";

/** Scheduled jobs and their interval in minutes (from the manifest schedules). */
export const BILLING_JOBS: Array<{ key: string; title: string; everyMinutes: number }> = [
  { key: "mark-overdue", title: "Mark overdue invoices", everyMinutes: 60 },
  { key: "run-recurring", title: "Recurring invoices and retainers", everyMinutes: 1440 },
  { key: "dunning", title: "Payment reminders", everyMinutes: 1440 },
  { key: "redeliver", title: "Re-send to Mailbox and Accounting", everyMinutes: 5 },
  { key: "emit-open-items", title: "Share receivables and payables", everyMinutes: 15 },
  { key: "emit-open-items-all", title: "Share all open items (nightly)", everyMinutes: 1440 },
  { key: "fx-rates", title: "FX rates", everyMinutes: 1440 },
  { key: "drafts-to-send", title: "Drafts to send (daily issue)", everyMinutes: 1440 },
  { key: "overdue-invoices", title: "Overdue invoices (weekly issue)", everyMinutes: 10080 },
  { key: "post-missing-journals", title: "Journals missed while Accounting was off", everyMinutes: 1440 },
  { key: "privacy-retention", title: "Erasure retention periods", everyMinutes: 1440 },
  { key: "sync-skills-all", title: "Skills for every company", everyMinutes: 360 },
];

const PAGE = "/billing";
const issueHref = (issueId: string) => `/issues/${issueId}`;

type Sums = Map<string, number>;

function addTo(sums: Sums, currency: string, minor: number) {
  sums.set(currency, (sums.get(currency) ?? 0) + minor);
}

/** "R 1,200.00 + $300.00", main currency first. */
export function sumsText(sums: Sums, main: string): string {
  const entries = [...sums.entries()].filter(([, v]) => v !== 0).sort(([a], [b]) => (a === main ? -1 : b === main ? 1 : a.localeCompare(b)));
  if (!entries.length) return formatMoneyMinor(0, main);
  return entries.map(([cur, v]) => formatMoneyMinor(v, cur)).join(" + ");
}

const n = (value: unknown) => Number(value ?? 0) || 0;

/** "1–27 Sep" (or "1 Oct" on the first): the part of this month a month-to-date figure covers. */
export function monthToDate(today: string): string {
  const day = Number(today.slice(8, 10));
  const short = shortDayText(today);
  return day <= 1 ? short : `1–${short}`;
}
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** A stage's money: the sum when every item is in one currency (0 in the main currency when empty), else none. */
export function stageMoney(sums: Sums, main: string): { amountMinor: number | null; currency: string | null } {
  const entries = [...sums.entries()].filter(([, minor]) => minor !== 0);
  if (entries.length === 0) return { amountMinor: 0, currency: main };
  if (entries.length === 1) return { amountMinor: entries[0]![1], currency: entries[0]![0] };
  return { amountMinor: null, currency: null };
}

/** Whole days from `at` to now (0 when unknown). */
function daysSince(at: unknown, now = Date.now()): number {
  const time = Date.parse(String(iso(at) ?? ""));
  return Number.isFinite(time) ? Math.max(0, Math.floor((now - time) / 86_400_000)) : 0;
}

/** Keeps the stage order of the company graph (kit `FLOWS`). */
function inFlowOrder(reports: FlowStageReport[]): FlowStageReport[] {
  const order = flowStagesFor(PLUGIN_ID).map((stage) => stage.key);
  return [...reports].sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage));
}

export async function cockpitSnapshot(ctx: PluginContext, companyId: string): Promise<CockpitSnapshot> {
  const snap = emptySnapshot(PLUGIN_ID, "Billing");
  // Live numbers for the stages Billing owns in the company graph (kit FLOWS), from the same queries as the KPIs.
  const flows: FlowStageReport[] = [];
  const failed: string[] = [];
  const part = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      failed.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const [saved, settings] = await Promise.all([configSaved(ctx, companyId).catch(() => false), billingSettings(ctx, companyId)]);
  const main = String(settings.defaultCurrency ?? "ZAR").toUpperCase();
  if (!saved) {
    snap.health.push({
      key: "settings",
      title: "Billing settings",
      status: "warn",
      detail: "Billing settings were never saved for this company, so its scheduled jobs skip it.",
      href: "/setup",
      fix: "Open Setup (or Billing settings), fill in your business and EFT details, and click Save Configuration.",
    });
  }

  // ── KPIs ────────────────────────────────────────────────────────────────
  // Every money figure is "as at today", the same as the Billing page, the CRM card and Accounting:
  // a payment dated after today counts nowhere yet and is flagged under health instead.
  const today = asAtDate();
  const asAt = `as at ${shortDayText(today)}`;
  await part("receivables", async () => {
    const open = await invoiceBalances(ctx, companyId, { openOnly: true });
    const outstanding: Sums = new Map();
    const overdue: Sums = new Map();
    let overdueCount = 0;
    let openCount = 0;
    let oldestOverdue = 0;
    const now = Date.now();
    for (const b of open) {
      if (b.outstandingMinor <= 0) continue;
      openCount += 1;
      addTo(outstanding, b.invoice.currency, b.outstandingMinor);
      const due = iso(b.invoice.due_at);
      // The canary's invoice is counted as owed but never as overdue: "stuck" is what the Operator wakes agents for, and nobody chases a test client.
      if (!isCanaryCustomer(b.invoice) && (statusAsAtToday(b) === "overdue" || (due && Date.parse(due) < now))) {
        overdueCount += 1;
        addTo(overdue, b.invoice.currency, b.outstandingMinor);
        oldestOverdue = Math.max(oldestOverdue, daysPastDue(due, new Date(now)));
      }
    }
    // invoice.open: owed as at today (the Outstanding KPI); stuck = overdue (the Overdue KPI).
    flows.push({
      stage: "invoice.open",
      count: openCount,
      stuck: overdueCount,
      stuckReason: overdueCount ? `${overdueCount} overdue (${sumsText(overdue, main)}), ${asAt}` : null,
      ...stageMoney(outstanding, main),
      oldestDays: overdueCount ? oldestOverdue : null,
    });
    snap.kpis.push({ key: "outstanding", label: "Outstanding", value: sumsText(outstanding, main), raw: outstanding.get(main) ?? 0, tone: "neutral", delta: openCount ? `${plural(openCount, "invoice")}, ${asAt}` : asAt, href: `${PAGE}?tab=invoices`, group: "money" });
    snap.kpis.push({
      key: "overdue",
      label: "Overdue",
      value: overdueCount ? sumsText(overdue, main) : "None",
      raw: overdue.get(main) ?? 0,
      tone: overdueCount > 0 ? "bad" : "ok",
      delta: overdueCount ? `${plural(overdueCount, "invoice")}, ${asAt}` : asAt,
      href: `${PAGE}?tab=invoices`,
      group: "money",
    });
  });

  await part("received", async () => {
    const rows = await ctx.db.query<{ currency: string | null; total: string }>(
      `SELECT p.currency, COALESCE(sum(p.amount_minor), 0)::text AS total FROM ${table(ctx, "payments")} p
        WHERE p.company_id = $1 AND p.paid_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND p.paid_at < ${AS_AT_CUTOFF_SQL}
        GROUP BY p.currency`,
      [companyId],
    );
    const sums: Sums = new Map();
    for (const r of rows) addTo(sums, (r.currency ?? main).toUpperCase(), n(r.total));
    snap.kpis.push({ key: "received_month", label: "Received this month", value: sumsText(sums, main), raw: sums.get(main) ?? 0, tone: "neutral", delta: monthToDate(today), href: `${PAGE}?tab=payments`, group: "money" });
  });

  await part("signed documents", async () => {
    // A client signed and Billing could not draft the invoice for hours (the CRM sends the hand-off again hourly for a day, so this is a real fault).
    const stuck = await stuckAcceptances(ctx, companyId, 2);
    snap.health.push(stuck.length > 0
      ? {
          key: "signed:stuck",
          title: "A signed document has no invoice draft",
          status: "warn",
          detail: `${plural(stuck.length, "signed document")} could not be turned into a draft invoice: ${stuck.slice(0, 3).map((row) => `${row.documentId}${row.error ? ` (${row.error})` : ""}`).join("; ")}.`.slice(0, 600),
          href: PAGE,
          fix: "Ask the Account Manager to draft the invoice by hand for each (the CRM shows the document under the client's Agreements). Billing keeps trying while the CRM sends the hand-off again; after a day it stops, and the reason above says what to fix first (often: the client is not in Billing yet).",
        }
      : { key: "signed:stuck", title: "Signed documents", status: "ok" });
  });

  await part("future payments", async () => {
    const rows = await ctx.db.query<{ n: string; first: unknown }>(
      `SELECT count(*)::text AS n, min(p.paid_at) AS first FROM ${table(ctx, "payments")} p WHERE p.company_id = $1 AND p.paid_at >= ${AS_AT_CUTOFF_SQL}`,
      [companyId],
    );
    const future = n(rows[0]?.n);
    snap.health.push(future > 0
      ? { key: "future_payments", title: "Payments dated in the future", status: "warn", detail: `${plural(future, "payment")} dated after today (first on ${shortDayText(iso(rows[0]?.first))}). ${future === 1 ? "It counts" : "They count"} in no total until then. Check the date.`, href: `${PAGE}?tab=payments`, fix: "Open Billing → Payments and check the date against the bank statement. A wrong date is usually a statement imported with the day and month swapped." }
      : { key: "future_payments", title: "Payments dated in the future", status: "ok" });
  });

  await part("mrr", async () => {
    // Active retainers plus active recurring invoice schedules, as a monthly amount.
    const rows = await ctx.db.query<{ currency: string; total: string }>(
      `SELECT currency, COALESCE(sum(monthly), 0)::text AS total FROM (
         SELECT s.currency,
                CASE s.period WHEN 'quarterly' THEN round(s.price_minor / 3.0) WHEN 'yearly' THEN round(s.price_minor / 12.0) ELSE s.price_minor END AS monthly
           FROM ${table(ctx, "subscriptions")} s WHERE s.company_id = $1 AND s.status = 'active' AND s.started_at < ${AS_AT_CUTOFF_SQL}
         UNION ALL
         SELECT i.currency,
                CASE r.frequency WHEN 'quarterly' THEN round(COALESCE(i.subtotal_minor, i.total_minor) / 3.0) WHEN 'yearly' THEN round(COALESCE(i.subtotal_minor, i.total_minor) / 12.0) ELSE COALESCE(i.subtotal_minor, i.total_minor) END AS monthly
           FROM ${table(ctx, "recurring_invoices")} r JOIN ${table(ctx, "invoices")} i ON i.id = r.template_invoice_id
          WHERE r.company_id = $1 AND r.is_active = true AND (r.ends_at IS NULL OR r.ends_at > now())
       ) m GROUP BY currency`,
      [companyId],
    );
    const sums: Sums = new Map();
    for (const r of rows) addTo(sums, r.currency.toUpperCase(), n(r.total));
    snap.kpis.push({ key: "mrr", label: "Monthly recurring", value: sumsText(sums, main), raw: sums.get(main) ?? 0, tone: "neutral", delta: `excl. VAT, ${asAt}`, href: `${PAGE}?tab=retainers`, group: "money" });
  });

  await part("quotes", async () => {
    const rows = await ctx.db.query<{ currency: string; count: string; total: string }>(
      `SELECT currency, count(*)::text AS count, COALESCE(sum(total_minor), 0)::text AS total FROM ${table(ctx, "quotes")}
        WHERE company_id = $1 AND status IN ('draft', 'sent') AND (valid_until IS NULL OR valid_until >= now()) GROUP BY currency`,
      [companyId],
    );
    const sums: Sums = new Map();
    let count = 0;
    for (const r of rows) {
      count += n(r.count);
      addTo(sums, r.currency.toUpperCase(), n(r.total));
    }
    snap.kpis.push({ key: "open_quotes", label: "Open quotes", value: count ? sumsText(sums, main) : "None", hint: count ? `${count} ${count === 1 ? "quote" : "quotes"}` : null, raw: count, tone: "neutral", href: `${PAGE}?tab=quotes`, group: "pipeline" });
  });

  await part("drafts", async () => {
    // Drafts nobody asked to send yet (the Account Manager's daily "Drafts to send" issue lists the ones over a day old).
    // A canary draft is counted but is never "over a day old": the daily issue leaves it out, and the Operator wakes agents for what is stuck.
    const rows = await ctx.db.query<{ kind: "invoice" | "quote"; currency: string; count: string; stale: string; total: string; oldest_stale: unknown }>(
      `SELECT kind, currency, count(*)::text AS count, count(*) FILTER (WHERE created_at < now() - interval '1 day' AND NOT canary)::text AS stale,
              COALESCE(sum(total_minor), 0)::text AS total, min(created_at) FILTER (WHERE created_at < now() - interval '1 day' AND NOT canary) AS oldest_stale FROM (
         SELECT 'invoice' AS kind, i.currency, i.created_at, i.total_minor, ${isCanarySql("i")} AS canary FROM ${table(ctx, "invoices")} i
          WHERE i.company_id = $1 AND i.status = 'draft' AND i.pending_action IS NULL AND COALESCE(i.delivery_status, '') <> 'queued'
            AND NOT EXISTS (SELECT 1 FROM ${table(ctx, "recurring_invoices")} r WHERE r.template_invoice_id = i.id AND r.is_active = true)
         UNION ALL
         SELECT 'quote' AS kind, q.currency, q.created_at, q.total_minor, ${isCanarySql("q")} AS canary FROM ${table(ctx, "quotes")} q
          WHERE q.company_id = $1 AND q.status = 'draft' AND q.pending_action IS NULL AND COALESCE(q.delivery_status, '') <> 'queued'
       ) d GROUP BY kind, currency`,
      [companyId],
    );
    const sums: Sums = new Map();
    let count = 0;
    let stale = 0;
    const byKind = { invoice: { count: 0, stale: 0, sums: new Map() as Sums, oldest: null as unknown }, quote: { count: 0, stale: 0, sums: new Map() as Sums, oldest: null as unknown } };
    for (const r of rows) {
      const kind = byKind[r.kind === "quote" ? "quote" : "invoice"];
      count += n(r.count);
      stale += n(r.stale);
      addTo(sums, r.currency.toUpperCase(), n(r.total));
      kind.count += n(r.count);
      kind.stale += n(r.stale);
      addTo(kind.sums, r.currency.toUpperCase(), n(r.total));
      if (r.oldest_stale && (!kind.oldest || Date.parse(String(iso(r.oldest_stale))) < Date.parse(String(iso(kind.oldest))))) kind.oldest = r.oldest_stale;
    }
    const what = [byKind.invoice.count ? plural(byKind.invoice.count, "invoice") : null, byKind.quote.count ? plural(byKind.quote.count, "quote") : null].filter(Boolean).join(" and ");
    snap.kpis.push({
      key: "drafts",
      label: "Drafts to send",
      value: count ? sumsText(sums, main) : "None",
      hint: count ? `${what}${stale ? (stale >= count ? (count === 1 ? ", over a day old" : ", all over a day old") : `, ${stale} over a day old`) : ""}` : null,
      raw: count,
      tone: stale > 0 ? "warn" : "neutral",
      href: `${PAGE}?tab=invoices`,
      group: "pipeline",
    });
    // quote.draft / invoice.draft: the same drafts split by kind; stuck = over a day old (on the Drafts to send issue).
    for (const [stage, kind] of [["quote.draft", byKind.quote], ["invoice.draft", byKind.invoice]] as const) {
      flows.push({
        stage,
        count: kind.count,
        stuck: kind.stale,
        stuckReason: kind.stale ? `${kind.stale} over a day old` : null,
        ...stageMoney(kind.sums, main),
        oldestDays: kind.stale ? daysSince(kind.oldest) : null,
      });
    }
  });

  await part("stages", async () => {
    // quote.approval / invoice.approval: a send approval is open (as in Waiting on you).
    // quote.sent: sent, not being re-sent and still valid (the Open quotes KPI without drafts); stuck = no answer after 14 days.
    const rows = await ctx.db.query<{ stage: string; currency: string; count: string; total: string; stuck: string; oldest: unknown }>(
      `SELECT stage, currency, count(*)::text AS count, COALESCE(sum(total_minor), 0)::text AS total,
              count(*) FILTER (WHERE stuck)::text AS stuck, min(since) FILTER (WHERE stuck) AS oldest FROM (
         SELECT 'quote.approval' AS stage, q.currency, q.total_minor, false AS stuck, NULL::timestamptz AS since FROM ${table(ctx, "quotes")} q
          WHERE q.company_id = $1 AND q.pending_action = 'send' AND q.approval_issue_id IS NOT NULL
         UNION ALL
         SELECT 'invoice.approval' AS stage, i.currency, i.total_minor, false AS stuck, NULL::timestamptz AS since FROM ${table(ctx, "invoices")} i
          WHERE i.company_id = $1 AND i.pending_action = 'send' AND i.approval_issue_id IS NOT NULL
         UNION ALL
         SELECT 'quote.sent' AS stage, q.currency, q.total_minor,
                (COALESCE(q.sent_at, q.updated_at) < now() - interval '14 days' AND NOT (${isCanarySql("q")})
                  AND NOT EXISTS (SELECT 1 FROM ${table(ctx, "work_issues")} w WHERE w.company_id = q.company_id AND w.kind = 'quote_reply' AND w.subject_id = q.id)) AS stuck,
                COALESCE(q.sent_at, q.updated_at) AS since FROM ${table(ctx, "quotes")} q
          WHERE q.company_id = $1 AND q.status = 'sent' AND q.pending_action IS NULL AND (q.valid_until IS NULL OR q.valid_until >= now())
       ) s GROUP BY stage, currency`,
      [companyId],
    );
    for (const stage of ["quote.approval", "quote.sent", "invoice.approval"] as const) {
      const mine = rows.filter((r) => r.stage === stage);
      const sums: Sums = new Map();
      let count = 0;
      let stuck = 0;
      let oldest: unknown = null;
      for (const r of mine) {
        count += n(r.count);
        stuck += n(r.stuck);
        addTo(sums, r.currency.toUpperCase(), n(r.total));
        if (r.oldest && (!oldest || Date.parse(String(iso(r.oldest))) < Date.parse(String(iso(oldest))))) oldest = r.oldest;
      }
      flows.push({
        stage,
        count,
        stuck,
        stuckReason: stuck ? `${stuck} with no answer after 14 days` : null,
        ...stageMoney(sums, main),
        oldestDays: stuck ? daysSince(oldest) : null,
      });
    }
  });

  await part("bills", async () => {
    const rows = await ctx.db.query<{ currency: string; count: string; late: string; total: string }>(
      `SELECT b.currency, count(*)::text AS count,
              count(*) FILTER (WHERE b.due_date < current_date)::text AS late,
              COALESCE(sum(b.total_minor - COALESCE((SELECT sum(p.allocated_minor) FROM ${table(ctx, "bill_payments")} p WHERE p.bill_id = b.id), 0)), 0)::text AS total
         FROM ${table(ctx, "bills")} b
        WHERE b.company_id = $1 AND b.status IN ('approved', 'partially_paid') AND b.due_date IS NOT NULL AND b.due_date <= current_date + 7
        GROUP BY b.currency`,
      [companyId],
    );
    const sums: Sums = new Map();
    let count = 0;
    let late = 0;
    for (const r of rows) {
      count += n(r.count);
      late += n(r.late);
      addTo(sums, r.currency.toUpperCase(), n(r.total));
    }
    const tone: Tone = late > 0 ? "bad" : count > 0 ? "warn" : "ok";
    snap.kpis.push({
      key: "bills_due",
      label: "Bills due in 7 days",
      value: count ? sumsText(sums, main) : "None",
      hint: count ? `${count} ${count === 1 ? "bill" : "bills"}${late ? `, ${late} late` : ""}` : null,
      raw: sums.get(main) ?? 0,
      tone,
      href: `${PAGE}?tab=bills`,
      group: "money",
    });
  });

  // ── Health ──────────────────────────────────────────────────────────────
  await part("jobs", async () => {
    for (const job of BILLING_JOBS) snap.health.push(await jobHealth(ctx, job.key, job.title, job.everyMinutes));
  });
  await part("outbox", async () => {
    snap.health.push({ ...(await outboxHealth(ctx, companyId)), href: PAGE });
  });

  await part("send failures", async () => {
    const rows = await ctx.db.query<{ failed: string; oldest: unknown }>(
      `SELECT count(*)::text AS failed, min(updated_at) AS oldest FROM ${table(ctx, "deliveries")}
        WHERE company_id = $1 AND status = 'failed' AND updated_at >= now() - interval '7 days'`,
      [companyId],
    );
    const failedSends = n(rows[0]?.failed);
    snap.health.push(failedSends > 0
      ? { key: "sends", title: "Document emails", status: "warn", detail: `${plural(failedSends, "email")} failed in the last 7 days.`, href: `${PAGE}?tab=invoices`, fix: "Check Gmail is connected in the Mailbox, then press Retry on the document.", since: iso(rows[0]?.oldest) }
      : { key: "sends", title: "Document emails", status: "ok" });
  });

  await part("ledger", async () => {
    const rows = await ctx.db.query<{ n: string }>(
      `SELECT ((SELECT count(*) FROM ${table(ctx, "invoices")} WHERE company_id = $1 AND ledger_status = 'rejected')
             + (SELECT count(*) FROM ${table(ctx, "payments")} WHERE company_id = $1 AND ledger_status = 'rejected')
             + (SELECT count(*) FROM ${table(ctx, "credit_notes")} WHERE company_id = $1 AND ledger_status = 'rejected')
             + (SELECT count(*) FROM ${table(ctx, "bills")} WHERE company_id = $1 AND ledger_status = 'rejected')
             + (SELECT count(*) FROM ${table(ctx, "bill_payments")} WHERE company_id = $1 AND ledger_status = 'rejected')
             + (SELECT count(*) FROM ${table(ctx, "expenses")} WHERE company_id = $1 AND ledger_status = 'rejected'))::text AS n`,
      [companyId],
    );
    const rejected = n(rows[0]?.n);
    snap.health.push(rejected > 0
      ? { key: "ledger", title: "Journals to Accounting", status: "bad", detail: `${plural(rejected, "journal")} rejected by Accounting.`, href: "/accounting", fix: "Check the Accounting chart of accounts and open periods, then retry the journal on the document." }
      : { key: "ledger", title: "Journals to Accounting", status: "ok" });
  });

  await part("pops", async () => {
    const rows = await ctx.db.query<{ n: string; oldest: unknown }>(
      `SELECT count(*)::text AS n, min(received_at) AS oldest FROM ${table(ctx, "pops")}
        WHERE company_id = $1 AND status = 'pending' AND received_at < now() - interval '3 days'`,
      [companyId],
    );
    const old = n(rows[0]?.n);
    snap.health.push(old > 0
      ? { key: "pops", title: "Proof of payment checks", status: "warn", detail: `${plural(old, "proof")} of payment waiting over 3 days.`, href: `${PAGE}?tab=payments`, fix: "Check each proof against the bank statement and confirm or reject it.", since: iso(rows[0]?.oldest) }
      : { key: "pops", title: "Proof of payment checks", status: "ok" });
  });

  // Online payments (only said while a provider is on, or something needs a person): notifications that failed to apply,
  // links a provider refused, and money that arrived and waits on a decision.
  await part("online payments", async () => {
    const on = providerStates(settings).filter((state) => state.enabled && state.key !== "mock");
    const rows = await ctx.db.query<{ failed_events: string; needs_attention: string; failed_links: string; oldest: unknown }>(
      `SELECT (SELECT count(*) FROM ${table(ctx, "payment_events")} WHERE company_id = $1 AND result = 'failed' AND received_at > now() - interval '3 days')::text AS failed_events,
              (SELECT count(*) FROM ${table(ctx, "payment_links")} WHERE company_id = $1 AND status = 'needs_attention')::text AS needs_attention,
              (SELECT count(*) FROM ${table(ctx, "payment_links")} WHERE company_id = $1 AND status = 'failed' AND created_at > now() - interval '7 days')::text AS failed_links,
              (SELECT min(created_at) FROM ${table(ctx, "payment_links")} WHERE company_id = $1 AND status = 'needs_attention') AS oldest`,
      [companyId],
    );
    const failedEvents = n(rows[0]?.failed_events);
    const attention = n(rows[0]?.needs_attention);
    const failedLinks = n(rows[0]?.failed_links);
    if (on.length === 0 && failedEvents + attention + failedLinks === 0) return;
    snap.health.push(failedEvents > 0
      ? { key: "payments:notifications", title: "Online payment notifications", status: "bad", detail: `${plural(failedEvents, "payment notification")} from a provider could not be applied in the last 3 days. A customer may have paid and the invoice still shows unpaid.`, href: `${PAGE}?tab=payments`, fix: "The provider retries for up to 3 days. Open the Billing page → Payments → Online payments to see the error, fix its cause (usually the signing secret or Accounting's clearing account) and the next retry applies it." }
      : { key: "payments:notifications", title: "Online payment notifications", status: "ok" });
    snap.health.push(attention > 0
      ? { key: "payments:attention", title: "Online payments waiting on a person", status: "warn", detail: `${plural(attention, "online payment")} arrived that Billing did not record by itself (wrong amount, or an invoice that cannot take it).`, href: `${PAGE}?tab=payments`, fix: "Open each issue titled Check an online payment and record it or refund it.", since: iso(rows[0]?.oldest) }
      : { key: "payments:attention", title: "Online payments waiting on a person", status: "ok" });
    if (failedLinks > 0) {
      snap.health.push({ key: "payments:links", title: "Payment links", status: "warn", detail: `${plural(failedLinks, "payment link")} could not be made in the last week, so those invoices went out with EFT details only.`, href: `${PAGE}?tab=payments`, fix: "Open Billing → Payments → Online payments for the provider's error (a wrong key, or a currency the provider does not take)." });
    }
  });

  await part("approval routing", async () => {
    const copy = await rolesCopyHealth(ctx, companyId);
    if (copy) snap.health.push(copy);
  });

  // ── Waiting on a person ─────────────────────────────────────────────────
  await part("approvals", async () => {
    // Titles name the client and the amount; a draft has no number to show yet (it gets one when it is sent).
    const invoices = await ctx.db.query<{ id: string; number: string; pending_action: string; approval_issue_id: string; currency: string; total_minor: string; name: string | null; customer_ref: string; updated_at: unknown }>(
      `SELECT id, number, pending_action, approval_issue_id, currency, total_minor::text AS total_minor, COALESCE(customer_snapshot->>'name', customer->>'name') AS name, customer_ref, updated_at AS updated_at FROM ${table(ctx, "invoices")}
        WHERE company_id = $1 AND pending_action IS NOT NULL AND approval_issue_id IS NOT NULL ORDER BY updated_at LIMIT 25`,
      [companyId],
    );
    for (const row of invoices) {
      const pay = row.pending_action === "pay";
      const amount = formatMoneyMinor(n(row.total_minor), row.currency);
      const who = row.name || "a client";
      snap.waiting.push({
        key: `approval:${row.approval_issue_id}`,
        title: pay ? `Approve payment of ${row.number} (${who}, ${amount})` : `Approve sending invoice to ${who} (${amount})`,
        why: pay ? "Confirming money received needs a person." : `Emailing an invoice of ${amount} to a client needs a person's approval.`,
        href: issueHref(row.approval_issue_id),
        issueId: row.approval_issue_id,
        kind: pay ? "money" : "review",
        since: iso(row.updated_at),
      });
    }
    const quotes = await ctx.db.query<{ approval_issue_id: string; currency: string; total_minor: string; name: string | null; updated_at: unknown }>(
      `SELECT approval_issue_id, currency, total_minor::text AS total_minor, customer->>'name' AS name, updated_at AS updated_at FROM ${table(ctx, "quotes")}
        WHERE company_id = $1 AND pending_action = 'send' AND approval_issue_id IS NOT NULL ORDER BY updated_at LIMIT 25`,
      [companyId],
    );
    for (const row of quotes) {
      snap.waiting.push({ key: `approval:${row.approval_issue_id}`, title: `Approve sending quote to ${row.name || "a client"} (${formatMoneyMinor(n(row.total_minor), row.currency)})`, why: "Sending a quote to a client needs a person's approval.", href: issueHref(row.approval_issue_id), issueId: row.approval_issue_id, kind: "review", since: iso(row.updated_at) });
    }
    const bills = await ctx.db.query<{ supplier_name: string; currency: string; total_minor: string; approval_issue_id: string; updated_at: unknown }>(
      `SELECT supplier_name, currency, total_minor::text AS total_minor, approval_issue_id, updated_at AS updated_at FROM ${table(ctx, "bills")}
        WHERE company_id = $1 AND pending_action = 'approve' AND approval_issue_id IS NOT NULL ORDER BY updated_at LIMIT 25`,
      [companyId],
    );
    for (const row of bills) {
      snap.waiting.push({ key: `approval:${row.approval_issue_id}`, title: `Approve bill from ${row.supplier_name}`, why: `A ${formatMoneyMinor(n(row.total_minor), row.currency)} bill goes into the books once a person approves it.`, href: issueHref(row.approval_issue_id), issueId: row.approval_issue_id, kind: "money", since: iso(row.updated_at) });
    }
    const checks = await ctx.db.query<{ issue_id: string; kind: string; payload: unknown; created_at: unknown }>(
      `SELECT issue_id, kind, payload, created_at AS created_at FROM ${table(ctx, "decision_issues")}
        WHERE company_id = $1 AND status = 'open' AND kind IN ('pop', 'bank_match', 'payment', 'credit_note', 'reminder') ORDER BY created_at LIMIT 25`,
      [companyId],
    );
    for (const row of checks) {
      const p = asObject(row.payload);
      const money = p.amountMinor != null ? formatMoneyMinor(n(p.amountMinor), String(p.currency ?? main)) : "";
      const number = String(p.number ?? "");
      const item = row.kind === "pop"
        ? { title: "Check a proof of payment", why: "A person confirms the money is in the bank before the invoice is paid.", kind: "money" as const }
        : row.kind === "bank_match"
          ? { title: "Check a bank match", why: "Billing was not sure the bank line pays this document; a person confirms it.", kind: "money" as const }
          : row.kind === "payment"
            ? { title: `Record payment of ${money} on ${number}?`, why: "An agent reported money received; a person checks the bank before it is recorded.", kind: "money" as const }
            : row.kind === "credit_note"
              ? { title: `Issue credit note of ${money} on ${number}?`, why: "Crediting a customer changes what they owe; a person decides.", kind: "money" as const }
              : { title: `Approve payment reminder ${n(p.stage) + 1} for ${number}`, why: "A reminder email goes to the customer; a person approves it.", kind: "review" as const };
      snap.waiting.push({ key: `${row.kind}:${row.issue_id}`, ...item, href: issueHref(row.issue_id), issueId: row.issue_id, since: iso(row.created_at) });
    }
  });

  // ── Activity ────────────────────────────────────────────────────────────
  await part("activity", async () => {
    const rows = await ctx.db.query<{ kind: string; at: unknown; number: string; name: string | null; currency: string | null; amount: string | null; stage: number | null }>(
      `SELECT * FROM (
         SELECT 'sent' AS kind, i.sent_at AS at, i.number, i.customer->>'name' AS name, i.currency, i.total_minor::text AS amount, NULL::int AS stage
           FROM ${table(ctx, "invoices")} i WHERE i.company_id = $1 AND i.sent_at IS NOT NULL
         UNION ALL
         SELECT 'paid' AS kind, p.paid_at AS at, i.number, i.customer->>'name' AS name, COALESCE(p.currency, i.currency) AS currency, p.amount_minor::text AS amount, NULL::int AS stage
           FROM ${table(ctx, "payments")} p JOIN ${table(ctx, "invoices")} i ON i.id = p.invoice_id WHERE p.company_id = $1 AND p.paid_at < ${AS_AT_CUTOFF_SQL}
         UNION ALL
         SELECT 'reminder' AS kind, r.created_at AS at, i.number, i.customer->>'name' AS name, i.currency, NULL AS amount, r.stage
           FROM ${table(ctx, "reminders")} r JOIN ${table(ctx, "invoices")} i ON i.id = r.invoice_id WHERE r.company_id = $1 AND r.status IN ('queued', 'sent')
       ) a ORDER BY at DESC LIMIT 10`,
      [companyId],
    );
    for (const row of rows) {
      const who = row.name ? ` to ${row.name}` : "";
      const money = row.amount != null && row.currency ? formatMoneyMinor(n(row.amount), row.currency) : "";
      const text = row.kind === "sent"
        ? `Sent invoice ${row.number}${who} (${money})`
        : row.kind === "paid"
          ? `Received ${money} for invoice ${row.number}${row.name ? ` from ${row.name}` : ""}`
          : `Sent reminder ${n(row.stage) + 1} for invoice ${row.number}${who}`;
      snap.activity.push({ at: iso(row.at) ?? new Date().toISOString(), text, href: `${PAGE}?tab=${row.kind === "paid" ? "payments" : "invoices"}` });
    }
  });

  // ── Quality ─────────────────────────────────────────────────────────────
  await part("quality", async () => {
    // Approvals a person turned down (cancelled issue) in the last 30 days, of all approvals decided.
    const rows = await ctx.db.query<{ rejected: string; decided: string }>(
      `SELECT (
          (SELECT count(*) FROM ${table(ctx, "invoices")} WHERE company_id = $1 AND approval_issue_id IS NOT NULL AND pending_action IS NULL AND status = 'draft' AND delivery_status IS NULL AND updated_at >= now() - interval '30 days')
        + (SELECT count(*) FROM ${table(ctx, "quotes")} WHERE company_id = $1 AND approval_issue_id IS NOT NULL AND pending_action IS NULL AND status = 'draft' AND delivery_status IS NULL AND updated_at >= now() - interval '30 days')
        + (SELECT count(*) FROM ${table(ctx, "bills")} WHERE company_id = $1 AND approval_issue_id IS NOT NULL AND pending_action IS NULL AND status = 'draft' AND updated_at >= now() - interval '30 days')
        + (SELECT count(*) FROM ${table(ctx, "decision_issues")} WHERE company_id = $1 AND status = 'dismissed' AND resolved_at >= now() - interval '30 days')
       )::text AS rejected,
       (
          (SELECT count(*) FROM ${table(ctx, "invoices")} WHERE company_id = $1 AND approval_issue_id IS NOT NULL AND pending_action IS NULL AND updated_at >= now() - interval '30 days')
        + (SELECT count(*) FROM ${table(ctx, "quotes")} WHERE company_id = $1 AND approval_issue_id IS NOT NULL AND pending_action IS NULL AND updated_at >= now() - interval '30 days')
        + (SELECT count(*) FROM ${table(ctx, "bills")} WHERE company_id = $1 AND approval_issue_id IS NOT NULL AND pending_action IS NULL AND updated_at >= now() - interval '30 days')
        + (SELECT count(*) FROM ${table(ctx, "decision_issues")} WHERE company_id = $1 AND status IN ('resolved', 'dismissed') AND resolved_at >= now() - interval '30 days')
       )::text AS decided`,
      [companyId],
    );
    const rejected = n(rows[0]?.rejected);
    const decided = n(rows[0]?.decided);
    const rate = decided ? rejected / decided : 0;
    snap.quality.push({
      key: "approvals_rejected",
      label: "Approvals turned down (30 days)",
      value: decided ? `${rejected} of ${decided}` : "None decided",
      raw: rejected,
      tone: rate > 0.25 ? "bad" : rate > 0.1 ? "warn" : "ok",
    });
    const stats = await decisionStats(ctx, companyId, 30);
    const total = stats.reduce((sum, s) => sum + n(s.total), 0);
    const corrected = stats.reduce((sum, s) => sum + n(s.corrected), 0);
    const cRate = total ? corrected / total : 0;
    snap.quality.push({
      key: "decisions_corrected",
      label: "Receipt and smart suggestions corrected (30 days)",
      value: total ? `${corrected} of ${total}` : "None",
      raw: corrected,
      tone: cRate > 0.25 ? "bad" : cRate > 0.1 ? "warn" : "ok",
    });
  });

  if (failed.length) {
    snap.health.push({ key: "snapshot", title: "Cockpit numbers", status: "warn", detail: `Some numbers could not be read: ${failed.join("; ").slice(0, 400)}` });
  }
  // A stage whose numbers could not be read is left out rather than shown as zero.
  snap.flows = inFlowOrder(cleanFlowReports(PLUGIN_ID, flows));
  snap.checkedAt = new Date().toISOString();
  return snap;
}

/** Companies with billing data, plus any whose Billing settings are saved (a new company has no data yet). */
async function reportingCompanyIds(ctx: PluginContext): Promise<string[]> {
  const ids = new Set(await knownCompanyIds(ctx).catch(() => [] as string[]));
  try {
    for (const company of await ctx.companies.list({ limit: 100 })) ids.add(company.id);
  } catch (error) {
    ctx.logger.info("Company list unavailable for the Cockpit push", { error: error instanceof Error ? error.message : String(error) });
  }
  return [...ids];
}

/** Hourly push to the Cockpit for companies with Billing on and settings saved. Never throws. */
export async function publishAllCockpit(ctx: PluginContext): Promise<number> {
  let published = 0;
  for (const companyId of await reportingCompanyIds(ctx)) {
    try {
      if (!(await billingOn(ctx, companyId)) || !(await configSaved(ctx, companyId))) continue;
      await publishCockpitSnapshot(ctx, companyId, await cockpitSnapshot(ctx, companyId));
      published += 1;
    } catch (error) {
      ctx.logger.info("Cockpit snapshot skipped", { companyId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return published;
}

