/**
 * Hosted-client retainers: on the first of each month, a draft invoice with one
 * retainer line for every CRM company that has a hosted Paperclip company
 * (`hostedCompanyId`), priced from its plan label. The CRM sends both with
 * `company.upserted` (the `hosted` column of `crm_companies`).
 *
 * Draft only: nothing here sends. A person sends the draft like any other.
 * Idempotent by `recurring_key` (CRM company + month), so a rerun creates
 * nothing twice. An unknown or missing plan label skips that client and logs it.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { defaultTaxCode, loadBilling } from "./config.js";
import { insertInvoice, insertLine, table, type InvoiceRow } from "./db.js";
import { customerFrom, defaultDueAt, defaultTax, describePeriod, recomputeInvoice, senderFrom } from "./invoices.js";
import { nextDocumentNumber } from "./numbering.js";

/** Monthly retainer per plan label, ZAR cents, excluding VAT (Peet, PAR-5300). The one place prices live. */
export const HOSTED_PLAN_PRICES_MINOR = {
  starter: 195_000,
  growth: 450_000,
  business: 750_000,
} as const;

export const HOSTED_RETAINER_CURRENCY = "ZAR";

export type HostedPlan = keyof typeof HOSTED_PLAN_PRICES_MINOR;

interface HostedClientRow {
  id: string;
  name: string;
  hosted: { companyId?: string | null; plan?: string | null } | null;
}

export function hostedPlan(label: unknown): HostedPlan | null {
  const key = typeof label === "string" ? label.trim().toLowerCase() : "";
  return Object.prototype.hasOwnProperty.call(HOSTED_PLAN_PRICES_MINOR, key) ? (key as HostedPlan) : null;
}

export function hostedRetainerKey(crmCompanyId: string, periodStart: Date): string {
  return `hosted-retainer:${crmCompanyId}:${periodStart.toISOString().slice(0, 7)}`;
}

function planTitle(plan: HostedPlan): string {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

/** Paperclip companies with at least one hosted CRM client. Not `billingCompanyIds`: a company with no document yet must still be visited. */
export async function hostedRetainerCompanyIds(ctx: PluginContext): Promise<string[]> {
  const rows = await ctx.db.query<{ company_id: string }>(
    `SELECT DISTINCT company_id FROM ${table(ctx, "crm_companies")} WHERE deleted = false AND NULLIF(hosted->>'companyId', '') IS NOT NULL`,
  );
  return rows.map((row) => row.company_id).filter(Boolean);
}

/**
 * One draft per hosted client for the month `now` falls in. Returns the ids it
 * created and the clients it skipped (no or unknown plan label).
 */
export async function runHostedRetainers(
  ctx: PluginContext,
  companyId: string,
  now = new Date(),
): Promise<{ created: Array<{ crmCompanyId: string; invoiceId: string; plan: HostedPlan }>; skipped: Array<{ crmCompanyId: string; reason: string }> }> {
  const created: Array<{ crmCompanyId: string; invoiceId: string; plan: HostedPlan }> = [];
  const skipped: Array<{ crmCompanyId: string; reason: string }> = [];
  const clients = await ctx.db.query<HostedClientRow>(
    `SELECT id, name, hosted FROM ${table(ctx, "crm_companies")}
      WHERE company_id = $1 AND deleted = false AND NULLIF(hosted->>'companyId', '') IS NOT NULL
      ORDER BY lower(name)`,
    [companyId],
  );
  if (clients.length === 0) return { created, skipped };
  const { settings } = await loadBilling(ctx, companyId);
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  for (const client of clients) {
    try {
      const plan = hostedPlan(client.hosted?.plan);
      if (!plan) {
        const reason = client.hosted?.plan ? `unknown plan label "${String(client.hosted.plan)}"` : "no plan label";
        skipped.push({ crmCompanyId: client.id, reason });
        ctx.logger.warn("Hosted retainer skipped", { crmCompanyId: client.id, reason });
        continue;
      }
      const key = hostedRetainerKey(client.id, periodStart);
      const existing = await ctx.db.query<{ id: string }>(`SELECT id FROM ${table(ctx, "invoices")} WHERE recurring_key = $1`, [key]);
      if (existing[0]) continue;
      const customer = await customerFrom(ctx, companyId, "company", client.id, client.name).catch(() => ({ name: client.name, refKind: "company", refId: client.id }));
      const taxCode = defaultTaxCode(settings);
      const invoice: InvoiceRow = {
        id: randomUUID(),
        company_id: companyId,
        number: await nextDocumentNumber(ctx, companyId, "invoice", { kind: "company", ref: client.id, name: String(customer.name) }, settings),
        status: "draft",
        currency: HOSTED_RETAINER_CURRENCY,
        customer_kind: "company",
        customer_ref: client.id,
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
        default_tax_code: taxCode,
        prices_include_vat: false,
        notes: settings.invoiceNotes ?? null,
        recurring_key: key,
      };
      if ((await insertInvoice(ctx, invoice)) === 0) continue;
      await insertLine(ctx, {
        companyId,
        invoiceId: invoice.id,
        description: `Hosted platform retainer, ${planTitle(plan)} plan (${describePeriod(periodStart, "monthly")})`,
        quantity: 1,
        unitAmountMinor: HOSTED_PLAN_PRICES_MINOR[plan],
        taxCode,
      });
      await recomputeInvoice(ctx, invoice);
      created.push({ crmCompanyId: client.id, invoiceId: invoice.id, plan });
    } catch (error) {
      ctx.logger.error("Hosted retainer failed", { crmCompanyId: client.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { created, skipped };
}
