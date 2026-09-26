/**
 * Company Cockpit snapshot for Billing (`GET /cockpit`, pushed hourly as
 * `cockpit.snapshot`): the money a founder checks, job and delivery health,
 * the approvals and checks waiting on a person, recent activity and quality.
 *
 * Read-only and cheap: a handful of SELECTs, no external calls. Each part is
 * wrapped so one failing query never breaks the whole snapshot.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  configSaved,
  decisionStats,
  emptySnapshot,
  formatMoneyMinor,
  jobHealth,
  outboxHealth,
  publishCockpitSnapshot,
  type CockpitSnapshot,
  type Tone,
} from "@partnersinbiz/pib-plugin-kit";
import { invoiceBalances, iso } from "./balances.js";
import { billingSettings } from "./config.js";
import { table } from "./db.js";
import { PLUGIN_ID } from "./namespace.js";
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
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export async function cockpitSnapshot(ctx: PluginContext, companyId: string): Promise<CockpitSnapshot> {
  const snap = emptySnapshot(PLUGIN_ID, "Billing");
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
  await part("receivables", async () => {
    const open = await invoiceBalances(ctx, companyId, { openOnly: true });
    const outstanding: Sums = new Map();
    const overdue: Sums = new Map();
    let overdueCount = 0;
    const now = Date.now();
    for (const b of open) {
      if (b.outstandingMinor <= 0) continue;
      addTo(outstanding, b.invoice.currency, b.outstandingMinor);
      const due = iso(b.invoice.due_at);
      if (b.invoice.status === "overdue" || (due && Date.parse(due) < now)) {
        overdueCount += 1;
        addTo(overdue, b.invoice.currency, b.outstandingMinor);
      }
    }
    snap.kpis.push({ key: "outstanding", label: "Outstanding", value: sumsText(outstanding, main), raw: outstanding.get(main) ?? 0, tone: "neutral", href: `${PAGE}?tab=invoices`, group: "money" });
    snap.kpis.push({
      key: "overdue",
      label: "Overdue",
      value: overdueCount ? `${overdueCount} · ${sumsText(overdue, main)}` : "None",
      raw: overdue.get(main) ?? 0,
      tone: overdueCount > 0 ? "bad" : "ok",
      href: `${PAGE}?tab=invoices`,
      group: "money",
    });
  });

  await part("received", async () => {
    const rows = await ctx.db.query<{ currency: string | null; total: string }>(
      `SELECT p.currency, COALESCE(sum(p.amount_minor), 0)::text AS total FROM ${table(ctx, "payments")} p
        WHERE p.company_id = $1 AND p.paid_at >= date_trunc('month', now()) GROUP BY p.currency`,
      [companyId],
    );
    const sums: Sums = new Map();
    for (const r of rows) addTo(sums, (r.currency ?? main).toUpperCase(), n(r.total));
    snap.kpis.push({ key: "received_month", label: "Received this month", value: sumsText(sums, main), raw: sums.get(main) ?? 0, tone: "neutral", href: `${PAGE}?tab=payments`, group: "money" });
  });

  await part("mrr", async () => {
    // Active retainers plus active recurring invoice schedules, as a monthly amount.
    const rows = await ctx.db.query<{ currency: string; total: string }>(
      `SELECT currency, COALESCE(sum(monthly), 0)::text AS total FROM (
         SELECT s.currency,
                CASE s.period WHEN 'quarterly' THEN s.price_minor / 3 WHEN 'yearly' THEN s.price_minor / 12 ELSE s.price_minor END AS monthly
           FROM ${table(ctx, "subscriptions")} s WHERE s.company_id = $1 AND s.status = 'active'
         UNION ALL
         SELECT i.currency,
                CASE r.frequency WHEN 'quarterly' THEN i.total_minor / 3 WHEN 'yearly' THEN i.total_minor / 12 ELSE i.total_minor END AS monthly
           FROM ${table(ctx, "recurring_invoices")} r JOIN ${table(ctx, "invoices")} i ON i.id = r.template_invoice_id
          WHERE r.company_id = $1 AND r.is_active = true AND (r.ends_at IS NULL OR r.ends_at > now())
       ) m GROUP BY currency`,
      [companyId],
    );
    const sums: Sums = new Map();
    for (const r of rows) addTo(sums, r.currency.toUpperCase(), n(r.total));
    snap.kpis.push({ key: "mrr", label: "Monthly recurring", value: sumsText(sums, main), raw: sums.get(main) ?? 0, tone: "neutral", href: `${PAGE}?tab=retainers`, group: "money" });
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
    snap.kpis.push({ key: "open_quotes", label: "Open quotes", value: count ? `${count} · ${sumsText(sums, main)}` : "None", raw: count, tone: "neutral", href: `${PAGE}?tab=quotes`, group: "pipeline" });
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
      value: count ? `${count} · ${sumsText(sums, main)}${late ? ` (${late} late)` : ""}` : "None",
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

  // ── Waiting on a person ─────────────────────────────────────────────────
  await part("approvals", async () => {
    const invoices = await ctx.db.query<{ id: string; number: string; pending_action: string; approval_issue_id: string; currency: string; total_minor: string; updated_at: unknown }>(
      `SELECT id, number, pending_action, approval_issue_id, currency, total_minor::text AS total_minor, updated_at AS updated_at FROM ${table(ctx, "invoices")}
        WHERE company_id = $1 AND pending_action IS NOT NULL AND approval_issue_id IS NOT NULL ORDER BY updated_at LIMIT 25`,
      [companyId],
    );
    for (const row of invoices) {
      const pay = row.pending_action === "pay";
      snap.waiting.push({
        key: `approval:${row.approval_issue_id}`,
        title: pay ? `Approve payment of invoice ${row.number}` : `Approve sending invoice ${row.number}`,
        why: pay ? "Confirming money received needs a person." : `Emailing ${formatMoneyMinor(n(row.total_minor), row.currency)} to a customer needs a person's approval.`,
        href: issueHref(row.approval_issue_id),
        issueId: row.approval_issue_id,
        kind: pay ? "money" : "review",
        since: iso(row.updated_at),
      });
    }
    const quotes = await ctx.db.query<{ number: string; approval_issue_id: string; updated_at: unknown }>(
      `SELECT number, approval_issue_id, updated_at AS updated_at FROM ${table(ctx, "quotes")}
        WHERE company_id = $1 AND pending_action = 'send' AND approval_issue_id IS NOT NULL ORDER BY updated_at LIMIT 25`,
      [companyId],
    );
    for (const row of quotes) {
      snap.waiting.push({ key: `approval:${row.approval_issue_id}`, title: `Approve sending quote ${row.number}`, why: "Sending a quote to a customer needs a person's approval.", href: issueHref(row.approval_issue_id), issueId: row.approval_issue_id, kind: "review", since: iso(row.updated_at) });
    }
    const bills = await ctx.db.query<{ supplier_name: string; currency: string; total_minor: string; approval_issue_id: string; updated_at: unknown }>(
      `SELECT supplier_name, currency, total_minor::text AS total_minor, approval_issue_id, updated_at AS updated_at FROM ${table(ctx, "bills")}
        WHERE company_id = $1 AND pending_action = 'approve' AND approval_issue_id IS NOT NULL ORDER BY updated_at LIMIT 25`,
      [companyId],
    );
    for (const row of bills) {
      snap.waiting.push({ key: `approval:${row.approval_issue_id}`, title: `Approve bill from ${row.supplier_name}`, why: `A ${formatMoneyMinor(n(row.total_minor), row.currency)} bill goes into the books once a person approves it.`, href: issueHref(row.approval_issue_id), issueId: row.approval_issue_id, kind: "money", since: iso(row.updated_at) });
    }
    const checks = await ctx.db.query<{ issue_id: string; kind: string; created_at: unknown }>(
      `SELECT issue_id, kind, created_at AS created_at FROM ${table(ctx, "decision_issues")}
        WHERE company_id = $1 AND status = 'open' AND kind IN ('pop', 'bank_match') ORDER BY created_at LIMIT 25`,
      [companyId],
    );
    for (const row of checks) {
      const pop = row.kind === "pop";
      snap.waiting.push({
        key: `${row.kind}:${row.issue_id}`,
        title: pop ? "Check a proof of payment" : "Check a bank match",
        why: pop ? "A person confirms the money is in the bank before the invoice is paid." : "Billing was not sure the bank line pays this document; a person confirms it.",
        href: issueHref(row.issue_id),
        issueId: row.issue_id,
        kind: "money",
        since: iso(row.created_at),
      });
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
           FROM ${table(ctx, "payments")} p JOIN ${table(ctx, "invoices")} i ON i.id = p.invoice_id WHERE p.company_id = $1
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
      label: "Receipt and Jev suggestions corrected (30 days)",
      value: total ? `${corrected} of ${total}` : "None",
      raw: corrected,
      tone: cRate > 0.25 ? "bad" : cRate > 0.1 ? "warn" : "ok",
    });
  });

  if (failed.length) {
    snap.health.push({ key: "snapshot", title: "Cockpit numbers", status: "warn", detail: `Some numbers could not be read: ${failed.join("; ").slice(0, 400)}` });
  }
  snap.checkedAt = new Date().toISOString();
  return snap;
}

/** Hourly push to the Cockpit for companies with Billing on and settings saved. Never throws. */
export async function publishAllCockpit(ctx: PluginContext): Promise<number> {
  let published = 0;
  for (const companyId of await knownCompanyIds(ctx).catch(() => [] as string[])) {
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

