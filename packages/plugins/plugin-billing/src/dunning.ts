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
import { formatMoneyMinor, type SecretResolver } from "@partnersinbiz/pib-plugin-kit";
import { invoiceBalances, iso, type InvoiceBalance } from "./balances.js";
import { dunningStages, emailEnabled, loadBilling, privateR2, type BillingSettings, type DunningStage, type PrivateR2 } from "./config.js";
import { asObject, table } from "./db.js";
import { docFileName, renderDocument } from "./documents.js";
import { dayText, daysPastDue } from "./domain.js";
import { invoiceView, recipientsFor } from "./invoices.js";
import { parseAddresses, queueMail, reminderEmail } from "./mail.js";
import { ensurePaymentLinks } from "./pay/links.js";
import { documentKey, MAIL_LINK_SECONDS, presignGet, putObject } from "./storage.js";

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
    // A payment dated in the future is on the invoice: a person checks that date before anyone chases the customer.
    if ((balance.futurePaidMinor ?? 0) > 0) continue;
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
    // Customers read this: "10 Oct 2026", not 2026-10-10.
    dueDate: dayText(iso(invoice.due_at)),
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

export type RequestStage =
  | { stage: number }
  | { stage: null; reason: "all_sent"; sent: number }
  | { stage: null; reason: "not_due"; nextStage: number; dueInDays: number };

/**
 * The stage an agent may ask a person to send now: the latest stage that is
 * due and not sent yet (like the automatic run). When the next stage is not
 * due yet, or every stage went out, there is nothing to send.
 */
export function requestStage(stages: DunningStage[], daysOverdue: number, sent: number[]): RequestStage {
  const highest = sent.length ? Math.max(...sent) : -1;
  if (highest >= stages.length - 1) return { stage: null, reason: "all_sent", sent: stages.length };
  const due = stageToSend(stages, daysOverdue, sent);
  if (due != null) return { stage: due };
  const next = highest + 1;
  return { stage: null, reason: "not_due", nextStage: next, dueInDays: Math.max(0, stages[next]!.daysAfterDue - daysOverdue) };
}

export interface ReminderOutcome {
  status: "queued" | "skipped" | "failed" | "already";
  deliveryKey?: string;
  error?: string;
}

/**
 * Send one reminder stage for one invoice through the Mailbox (with the
 * invoice PDF when private storage is set up). The (invoice, stage) claim
 * makes sure a stage goes out once, whoever asks.
 */
export async function queueReminderStage(
  ctx: PluginContext,
  input: { companyId: string; balance: InvoiceBalance; stageIndex: number; daysOverdue: number; settings: BillingSettings; r2: PrivateR2 | null; createdBy: string; resolver?: SecretResolver },
): Promise<ReminderOutcome> {
  const stages = dunningStages(input.settings);
  const stage = stages[input.stageIndex];
  if (!stage) return { status: "skipped", error: "That reminder stage no longer exists" };
  const reminderId = await claimReminder(ctx, input.companyId, { invoiceId: input.balance.invoice.id, stage: input.stageIndex, daysOverdue: input.daysOverdue });
  if (!reminderId) return { status: "already" };
  try {
    const to = await recipientsFor(ctx, input.companyId, input.balance.invoice);
    if (to.length === 0) {
      await setReminderStatus(ctx, reminderId, "skipped", { error: "No email address for this customer" });
      return { status: "skipped", error: "No email address for this customer" };
    }
    const vars = reminderVars(input.balance, input.daysOverdue, input.settings);
    const payment = asObject(asObject(input.balance.invoice.sender_snapshot).payment ?? input.settings.payment ?? {});
    // An online payment link goes in the reminder too, when a provider is on (for what is owed now).
    const links = (await ensurePaymentLinks(ctx, input.balance.invoice, input.settings, { createdBy: input.createdBy, ...(input.resolver ? { resolver: input.resolver } : {}) })).links;
    const content = reminderEmail(stage, vars, Object.keys(payment).length ? payment : null, input.balance.invoice.number, links);
    let attachments: Array<{ url: string; filename: string; mime: string; bytes: number }> = [];
    if (input.r2) {
      const view = await invoiceView(ctx, input.balance.invoice, input.settings);
      const bytes = await renderDocument(view);
      const filename = docFileName(view);
      const key = documentKey(input.r2, input.companyId, "invoice", filename, "pdf");
      await putObject(input.r2, key, bytes, "application/pdf");
      attachments = [{ url: presignGet(input.r2, key, MAIL_LINK_SECONDS, filename), filename, mime: "application/pdf", bytes: bytes.byteLength }];
    }
    const deliveryKey = await queueMail(ctx, input.companyId, {
      kind: "reminder",
      docId: input.balance.invoice.id,
      seq: input.stageIndex + 1,
      to,
      cc: parseAddresses(input.settings.email?.cc ?? ""),
      from: input.settings.email?.from?.trim() || null,
      content,
      attachments,
      clientKind: input.balance.invoice.customer_kind,
      clientRef: input.balance.invoice.customer_ref,
      threadId: null,
      createdBy: input.createdBy,
    });
    await setReminderStatus(ctx, reminderId, "queued", { deliveryKey });
    return { status: "queued", deliveryKey };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setReminderStatus(ctx, reminderId, "failed", { error: message });
    return { status: "failed", error: message };
  }
}

/** Send today's reminders for one company. `force` runs even when the schedule is off (a person pressed "Send now"). */
export async function runDunningFor(ctx: PluginContext, companyId: string, force = false): Promise<{ sent: number; skipped: number; reason?: string }> {
  const { settings, resolver } = await loadBilling(ctx, companyId);
  if (!force && settings.dunning?.enabled !== true) return { sent: 0, skipped: 0, reason: "Reminders are off" };
  if (!emailEnabled(settings)) return { sent: 0, skipped: 0, reason: "Email is off" };
  const { balances, plans } = await plannedReminders(ctx, companyId, settings);
  const byId = new Map(balances.map((b) => [b.invoice.id, b]));
  const r2 = settings.dunning?.attachInvoice === false ? null : await privateR2(resolver, settings).catch(() => null);
  let sent = 0;
  let skipped = 0;
  for (const plan of plans) {
    const balance = byId.get(plan.invoiceId);
    if (!balance) continue;
    // One resolver for the whole run: every reminder reuses the Stripe key it resolved once (the host allows 30 secret resolves a minute per company).
    const outcome = await queueReminderStage(ctx, { companyId, balance, stageIndex: plan.stage, daysOverdue: plan.daysOverdue, settings, r2, createdBy: "dunning", resolver });
    if (outcome.status === "queued") sent += 1;
    else if (outcome.status === "skipped") skipped += 1;
  }
  return { sent, skipped };
}
