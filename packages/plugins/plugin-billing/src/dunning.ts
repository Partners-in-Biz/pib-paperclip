/**
 * Payment reminders (dunning). Off until `dunning.enabled` is saved.
 *
 * Stages default to 1, 7 and 14 days after the due date. Each run sends at
 * most one reminder per invoice: the latest stage that is due and not sent
 * yet (a missed earlier stage is skipped, never sent late in a burst). A
 * unique (invoice, stage) row makes sure a stage is sent once. Invoices
 * waiting on a proof-of-payment check, and clients who opted out, get none.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { formatMoneyMinor } from "@partnersinbiz/pib-plugin-kit";
import { invoiceBalances, iso, type InvoiceBalance } from "./balances.js";
import { dunningStages, type BillingSettings, type DunningStage } from "./config.js";
import { asObject, table } from "./db.js";
import { daysPastDue } from "./domain.js";

export const DUNNABLE = new Set(["sent", "viewed", "overdue", "partially_paid"]);

/** Index of the stage to send now, or null. `sent` holds stage indexes already sent. */
export function stageToSend(stages: DunningStage[], daysOverdue: number, sent: number[]): number | null {
  let due: number | null = null;
  stages.forEach((stage, index) => {
    if (daysOverdue >= stage.daysAfterDue) due = index;
  });
  if (due == null) return null;
  const highestSent = sent.length ? Math.max(...sent) : -1;
  if (due <= highestSent) return null;
  return due;
}

export interface ReminderPlan {
  invoiceId: string;
  stage: number;
  daysOverdue: number;
}

/** Which invoices get which reminder today (pure). */
export function planReminders(input: {
  balances: InvoiceBalance[];
  stages: DunningStage[];
  sentByInvoice: Map<string, number[]>;
  optedOut: Set<string>;
  now: Date;
}): ReminderPlan[] {
  const plans: ReminderPlan[] = [];
  for (const balance of input.balances) {
    const invoice = balance.invoice;
    if (!DUNNABLE.has(invoice.status) || balance.outstandingMinor <= 0) continue;
    if (input.optedOut.has(`${invoice.customer_kind}:${invoice.customer_ref}`)) continue;
    const dueAt = iso(invoice.due_at);
    if (!dueAt || Date.parse(dueAt) >= input.now.getTime()) continue;
    const days = daysPastDue(dueAt, input.now);
    const stage = stageToSend(input.stages, days, input.sentByInvoice.get(invoice.id) ?? []);
    if (stage != null) plans.push({ invoiceId: invoice.id, stage, daysOverdue: days });
  }
  return plans;
}

export function reminderVars(balance: InvoiceBalance, daysOverdue: number, settings: BillingSettings): Record<string, string> {
  const invoice = balance.invoice;
  const customer = asObject(invoice.customer_snapshot ?? invoice.customer);
  const sender = asObject(invoice.sender_snapshot ?? invoice.sender);
  return {
    invoiceNumber: invoice.number,
    amount: formatMoneyMinor(balance.outstandingMinor, invoice.currency),
    total: formatMoneyMinor(Number(invoice.total_minor), invoice.currency),
    clientName: typeof customer.name === "string" && customer.name ? customer.name : "there",
    orgName: typeof customer.name === "string" && customer.name ? customer.name : "there",
    dueDate: (iso(invoice.due_at) ?? "").slice(0, 10),
    daysOverdue: String(daysOverdue),
    businessName: typeof sender.name === "string" && sender.name ? sender.name : String(asObject(settings.sender).name ?? "Partners in Biz"),
  };
}

export async function optedOutClients(ctx: PluginContext, companyId: string): Promise<Set<string>> {
  const rows = await ctx.db.query<{ customer_kind: string; customer_ref: string }>(
    `SELECT customer_kind, customer_ref FROM ${table(ctx, "dunning_optouts")} WHERE company_id = $1`,
    [companyId],
  );
  return new Set(rows.map((row) => `${row.customer_kind}:${row.customer_ref}`));
}

export async function sentStages(ctx: PluginContext, companyId: string): Promise<Map<string, number[]>> {
  const rows = await ctx.db.query<{ invoice_id: string; stage: number }>(
    `SELECT invoice_id, stage FROM ${table(ctx, "reminders")} WHERE company_id = $1`,
    [companyId],
  );
  const map = new Map<string, number[]>();
  for (const row of rows) map.set(row.invoice_id, [...(map.get(row.invoice_id) ?? []), Number(row.stage)]);
  return map;
}

/** Claim a stage for an invoice (unique). True when this run should send it. */
export async function claimReminder(ctx: PluginContext, companyId: string, plan: ReminderPlan): Promise<string | null> {
  const id = randomUUID();
  const res = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "reminders")} (id, company_id, invoice_id, stage, days_overdue, status)
     VALUES ($1, $2, $3, $4, $5, 'queued')
     ON CONFLICT (invoice_id, stage) DO NOTHING`,
    [id, companyId, plan.invoiceId, plan.stage, plan.daysOverdue],
  );
  return (res.rowCount ?? 0) > 0 ? id : null;
}

export async function setReminderStatus(ctx: PluginContext, id: string, status: "queued" | "sent" | "failed" | "skipped", extra: { deliveryKey?: string | null; error?: string | null } = {}): Promise<void> {
  await ctx.db.execute(
    `UPDATE ${table(ctx, "reminders")} SET status = $2, delivery_key = COALESCE($3, delivery_key), error = $4 WHERE id = $1`,
    [id, status, extra.deliveryKey ?? null, extra.error ?? null],
  );
}

export async function plannedReminders(ctx: PluginContext, companyId: string, settings: BillingSettings, now = new Date()) {
  const stages = dunningStages(settings);
  const balances = await invoiceBalances(ctx, companyId, { openOnly: true });
  const plans = planReminders({ balances, stages, sentByInvoice: await sentStages(ctx, companyId), optedOut: await optedOutClients(ctx, companyId), now });
  return { stages, balances, plans };
}
