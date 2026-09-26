/**
 * Retainers: plans (price, period, VAT code) and client subscriptions that
 * create an invoice each period. A new invoice stays a draft for a person
 * to send, unless the subscription says `autoSend` (set by a person).
 */
import { randomUUID } from "node:crypto";
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { iso } from "./balances.js";
import { defaultTaxCode, loadBilling } from "./config.js";
import { insertInvoice, insertLine, table, type InvoiceRow } from "./db.js";
import { BillingError } from "./domain.js";
import { customerFrom, defaultDueAt, defaultTax, describePeriod, recomputeInvoice, senderFrom, startInvoiceSend } from "./invoices.js";
import { assertTaxCode } from "./money.js";
import { nextDocumentNumber } from "./numbering.js";
import { actorLabel, currencyCode, integer, optionalBoolean, optionalDate, optionalString, readClientScope, requiredCompany, requiredString, requirePerson } from "./util.js";
import { nextRunDate, type RecurringFrequency } from "./domain.js";

const PERIODS = ["monthly", "quarterly", "yearly"] as const;

function period(value: unknown, fallback = "monthly"): RecurringFrequency {
  const text = String(value ?? fallback);
  if (!(PERIODS as readonly string[]).includes(text)) throw new BillingError("period must be monthly, quarterly or yearly");
  return text as RecurringFrequency;
}

export interface PlanRow {
  id: string;
  company_id: string;
  name: string;
  description: string | null;
  price_minor: number | string;
  currency: string;
  period: string;
  tax_code: string | null;
  active: boolean;
}

export interface SubscriptionRow {
  id: string;
  company_id: string;
  plan_id: string | null;
  customer_kind: string;
  customer_ref: string;
  customer_name: string | null;
  description: string;
  price_minor: number | string;
  currency: string;
  period: string;
  tax_code: string | null;
  status: string;
  auto_send: boolean;
  started_at: unknown;
  next_invoice_at: unknown;
  cancelled_at: unknown;
  last_invoice_id: string | null;
}

const SUB_COLUMNS = "id, company_id, plan_id, customer_kind, customer_ref, customer_name, description, price_minor, currency, period, tax_code, status, auto_send, started_at, next_invoice_at, cancelled_at, last_invoice_id";

export async function createPlan(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const { settings } = await loadBilling(ctx, companyId);
  const price = integer(params.priceMinor, "priceMinor");
  if (price <= 0) throw new BillingError("priceMinor must be a positive integer");
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "retainer_plans")} (id, company_id, name, description, price_minor, currency, period, tax_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, companyId, requiredString(params, "name"), optionalString(params, "description") ?? null, price, currencyCode(params.currency ?? settings.defaultCurrency ?? "ZAR"), period(params.period), params.taxCode ? assertTaxCode(params.taxCode) : defaultTaxCode(settings)],
  );
  return publicPlan((await getPlan(ctx, id))!);
}

export async function updatePlan(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const plan = await getPlan(ctx, requiredString(params, "planId"));
  if (!plan || plan.company_id !== companyId) throw new BillingError("Plan was not found");
  await ctx.db.execute(
    `UPDATE ${table(ctx, "retainer_plans")} SET name = $2, description = $3, price_minor = $4, active = $5, updated_at = now() WHERE id = $1`,
    [plan.id, optionalString(params, "name") ?? plan.name, "description" in params ? optionalString(params, "description") ?? null : plan.description, params.priceMinor != null ? integer(params.priceMinor, "priceMinor") : Number(plan.price_minor), optionalBoolean(params, "active") ?? plan.active],
  );
  return publicPlan((await getPlan(ctx, plan.id))!);
}

async function getPlan(ctx: PluginContext, id: string): Promise<PlanRow | null> {
  const rows = await ctx.db.query<PlanRow>(`SELECT id, company_id, name, description, price_minor, currency, period, tax_code, active FROM ${table(ctx, "retainer_plans")} WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export function publicPlan(plan: PlanRow) {
  return { id: plan.id, name: plan.name, description: plan.description, priceMinor: Number(plan.price_minor), currency: plan.currency, period: plan.period, taxCode: plan.tax_code, active: plan.active };
}

export function publicSubscription(sub: SubscriptionRow) {
  return {
    id: sub.id,
    planId: sub.plan_id,
    customerKind: sub.customer_kind,
    customerRef: sub.customer_ref,
    customerName: sub.customer_name,
    description: sub.description,
    priceMinor: Number(sub.price_minor),
    currency: sub.currency,
    period: sub.period,
    taxCode: sub.tax_code,
    status: sub.status,
    autoSend: sub.auto_send,
    startedAt: iso(sub.started_at),
    nextInvoiceAt: iso(sub.next_invoice_at),
    cancelledAt: iso(sub.cancelled_at),
    lastInvoiceId: sub.last_invoice_id,
  };
}

export async function createSubscription(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const client = readClientScope(params);
  if (!client) throw new BillingError("client is required (company:<id> or contact:<id>)");
  const autoSend = optionalBoolean(params, "autoSend") ?? false;
  if (autoSend) requirePerson(context, "turning on automatic sending");
  const { settings } = await loadBilling(ctx, companyId);
  const planId = optionalString(params, "planId") ?? null;
  const plan = planId ? await getPlan(ctx, planId) : null;
  if (planId && (!plan || plan.company_id !== companyId)) throw new BillingError("Plan was not found");
  const customer = await customerFrom(ctx, companyId, client.kind, client.id, optionalString(params, "customerName"));
  const price = params.priceMinor != null ? integer(params.priceMinor, "priceMinor") : Number(plan?.price_minor ?? 0);
  if (price <= 0) throw new BillingError("priceMinor must be a positive integer (or pick a plan)");
  const start = optionalDate(params, "startAt") ?? new Date().toISOString();
  const id = randomUUID();
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "subscriptions")}
      (id, company_id, plan_id, customer_kind, customer_ref, customer_name, description, price_minor, currency, period, tax_code, status, auto_send, started_at, next_invoice_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', $12, $13, $13, $14)`,
    [
      id,
      companyId,
      plan?.id ?? null,
      client.kind,
      client.id,
      String(customer.name),
      optionalString(params, "description") ?? plan?.name ?? "Retainer",
      price,
      currencyCode(params.currency ?? plan?.currency ?? settings.defaultCurrency ?? "ZAR"),
      period(params.period ?? plan?.period),
      params.taxCode ? assertTaxCode(params.taxCode) : plan?.tax_code ?? defaultTaxCode(settings),
      autoSend,
      new Date(start).toISOString(),
      actorLabel(context),
    ],
  );
  return publicSubscription((await getSubscription(ctx, id))!);
}

async function getSubscription(ctx: PluginContext, id: string): Promise<SubscriptionRow | null> {
  const rows = await ctx.db.query<SubscriptionRow>(`SELECT ${SUB_COLUMNS} FROM ${table(ctx, "subscriptions")} WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function setSubscriptionStatus(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const sub = await getSubscription(ctx, requiredString(params, "subscriptionId"));
  if (!sub || sub.company_id !== companyId) throw new BillingError("Subscription was not found");
  const status = requiredString(params, "status");
  if (!["active", "paused", "cancelled"].includes(status)) throw new BillingError("status is active, paused or cancelled");
  if (sub.status === "cancelled" && status !== "cancelled") throw new BillingError("A cancelled subscription cannot restart; create a new one");
  const autoSend = optionalBoolean(params, "autoSend");
  if (autoSend) requirePerson(context, "turning on automatic sending");
  await ctx.db.execute(
    `UPDATE ${table(ctx, "subscriptions")} SET status = $2, auto_send = $3, cancelled_at = CASE WHEN $2 = 'cancelled' THEN COALESCE(cancelled_at, now()) ELSE cancelled_at END, updated_at = now() WHERE id = $1`,
    [sub.id, status, autoSend ?? sub.auto_send],
  );
  return publicSubscription((await getSubscription(ctx, sub.id))!);
}

export async function listRetainers(ctx: PluginContext, companyId: string, client: { kind: string; id: string } | null = null) {
  const plans = await ctx.db.query<PlanRow>(`SELECT id, company_id, name, description, price_minor, currency, period, tax_code, active FROM ${table(ctx, "retainer_plans")} WHERE company_id = $1 ORDER BY lower(name)`, [companyId]);
  const subs = client
    ? await ctx.db.query<SubscriptionRow>(`SELECT ${SUB_COLUMNS} FROM ${table(ctx, "subscriptions")} WHERE company_id = $1 AND customer_kind = $2 AND customer_ref = $3 ORDER BY created_at DESC`, [companyId, client.kind, client.id])
    : await ctx.db.query<SubscriptionRow>(`SELECT ${SUB_COLUMNS} FROM ${table(ctx, "subscriptions")} WHERE company_id = $1 ORDER BY created_at DESC`, [companyId]);
  return { plans: plans.map(publicPlan), subscriptions: subs.map(publicSubscription) };
}

export async function allSubscriptions(ctx: PluginContext, companyId: string): Promise<SubscriptionRow[]> {
  return ctx.db.query<SubscriptionRow>(`SELECT ${SUB_COLUMNS} FROM ${table(ctx, "subscriptions")} WHERE company_id = $1`, [companyId]);
}

/**
 * Job: an invoice for each subscription whose period has come. Idempotent by
 * `recurring_key` (subscription + period start), so a retried run creates
 * nothing twice. One period per run.
 */
export async function runSubscriptions(ctx: PluginContext, companyId: string, now = new Date()): Promise<number> {
  const due = await ctx.db.query<SubscriptionRow>(
    `SELECT ${SUB_COLUMNS} FROM ${table(ctx, "subscriptions")} WHERE company_id = $1 AND status = 'active' AND next_invoice_at <= $2`,
    [companyId, now.toISOString()],
  );
  let created = 0;
  const { settings } = await loadBilling(ctx, companyId);
  for (const sub of due) {
    try {
      const periodStart = new Date(String(iso(sub.next_invoice_at)));
      const key = `subscription:${sub.id}:${periodStart.toISOString().slice(0, 10)}`;
      const existing = await ctx.db.query<{ id: string }>(`SELECT id FROM ${table(ctx, "invoices")} WHERE recurring_key = $1`, [key]);
      if (existing[0]) {
        await ctx.db.execute(
          `UPDATE ${table(ctx, "subscriptions")} SET next_invoice_at = $2, updated_at = now() WHERE id = $1 AND next_invoice_at = $3`,
          [sub.id, nextRunDate(periodStart, period(sub.period)).toISOString(), periodStart.toISOString()],
        );
        continue;
      }
      const customer = await customerFrom(ctx, companyId, sub.customer_kind as "company" | "contact", sub.customer_ref, sub.customer_name ?? undefined).catch(() => ({ name: sub.customer_name ?? sub.customer_ref, refKind: sub.customer_kind, refId: sub.customer_ref }));
      const invoice: InvoiceRow = {
        id: randomUUID(),
        company_id: companyId,
        number: await nextDocumentNumber(ctx, companyId, "invoice", { kind: sub.customer_kind, ref: sub.customer_ref, name: String(customer.name) }, settings),
        status: "draft",
        currency: sub.currency,
        customer_kind: sub.customer_kind,
        customer_ref: sub.customer_ref,
        sender: senderFrom(settings, undefined),
        customer,
        sender_snapshot: null,
        customer_snapshot: null,
        total_minor: 0,
        tax_rate: defaultTax(settings),
        due_at: defaultDueAt(settings, now.getTime()),
        approval_issue_id: null,
        pending_action: null,
        sent_at: null,
        default_tax_code: sub.tax_code,
        prices_include_vat: Boolean(settings.pricesIncludeVat),
        notes: settings.invoiceNotes ?? null,
        recurring_key: key,
        subscription_id: sub.id,
      };
      const inserted = await insertInvoice(ctx, invoice);
      const next = nextRunDate(periodStart, period(sub.period));
      if (inserted > 0) {
        await insertLine(ctx, {
          companyId,
          invoiceId: invoice.id,
          description: `${sub.description} (${describePeriod(periodStart, sub.period)})`,
          quantity: 1,
          unitAmountMinor: Number(sub.price_minor),
          taxCode: sub.tax_code,
        });
        await recomputeInvoice(ctx, invoice);
        created += 1;
      }
      await ctx.db.execute(
        `UPDATE ${table(ctx, "subscriptions")} SET next_invoice_at = $2, last_invoice_id = COALESCE($3, last_invoice_id), updated_at = now() WHERE id = $1 AND next_invoice_at = $4`,
        [sub.id, next.toISOString(), inserted > 0 ? invoice.id : null, periodStart.toISOString()],
      );
      if (inserted > 0 && sub.auto_send) await startInvoiceSend(ctx, invoice.id, "subscription");
    } catch (error) {
      ctx.logger.error("Retainer invoice failed", { subscriptionId: sub.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return created;
}
