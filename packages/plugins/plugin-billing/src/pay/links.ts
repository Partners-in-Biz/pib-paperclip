/**
 * Payment links: making one hosted checkout link per invoice and provider, reusing it while its amount
 * is right, and withdrawing it when the invoice changes. A link exists only while a provider is
 * enabled; EFT stays the default and an invoice with no link is paid exactly as before.
 *
 * A link failing never blocks a document: the invoice goes out with its EFT details, the failure is
 * stored on the link (`last_error`) and shown on the Cockpit, and the next send tries again.
 */
import { randomUUID } from "node:crypto";
import { SecretResolver } from "@partnersinbiz/pib-plugin-kit";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { invoiceBalance } from "../balances.js";
import { isCanaryCustomer } from "../canary.js";
import type { BillingSettings } from "../config.js";
import { asObject, type InvoiceRow } from "../db.js";
import { MockProvider } from "./mock.js";
import { buildProvider, enabledProviderKeys } from "./settings.js";
import { StripeProvider } from "./stripe.js";
import { insertLink, linksForCompany, linksForInvoice, markLinkRemoteOff, retireStaleLinks, setLinkCreated, setLinkStatus, type PaymentLinkRow } from "./store.js";
import { PROVIDER_LABELS, type PaymentProvider, type ProviderKey } from "./types.js";

/** What a document shows: where to pay online, and with which provider. */
export interface PaymentLinkView {
  id: string;
  provider: ProviderKey;
  label: string;
  url: string;
  amountMinor: number;
}

const OPEN_FOR_LINKS = new Set(["draft", "sent", "viewed", "overdue", "partially_paid", "payment_pending_verification"]);

export function linkView(row: PaymentLinkRow): PaymentLinkView | null {
  return row.url && row.status === "active" ? { id: row.id, provider: row.provider, label: PROVIDER_LABELS[row.provider] ?? row.provider, url: row.url, amountMinor: Number(row.amount_minor) } : null;
}

/**
 * The active links an invoice shows today (none for a paid, cancelled or written-off invoice). A test-provider link
 * (pay.invalid) is for the canary journey only: it is never shown on a real customer's email, reminder or PDF, even
 * when someone made one by hand on a real invoice to rehearse the books.
 */
export async function activePaymentLinks(ctx: PluginContext, invoice: InvoiceRow): Promise<PaymentLinkView[]> {
  if (!OPEN_FOR_LINKS.has(invoice.status)) return [];
  const canary = isCanaryCustomer(invoice);
  const rows = (await linksForInvoice(ctx, invoice.id, ["active"])).filter((row) => canary || row.provider !== "mock");
  return rows.map(linkView).filter((view): view is PaymentLinkView => Boolean(view));
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 300);
}

export interface EnsureResult {
  links: PaymentLinkView[];
  /** One line per provider that could not make a link, for the person or agent who asked. */
  problems: string[];
}

/**
 * The links for an invoice, one per enabled provider, made when missing. The amount is what the invoice
 * owes now (its total while it is still a draft). A link with another amount is withdrawn and replaced.
 * Never throws.
 */
export async function ensurePaymentLinks(
  ctx: PluginContext,
  invoice: InvoiceRow,
  settings: BillingSettings,
  options: { createdBy?: string | null; providers?: ProviderKey[]; resolver?: SecretResolver } = {},
): Promise<EnsureResult> {
  const result: EnsureResult = { links: [], problems: [] };
  try {
    if (!OPEN_FOR_LINKS.has(invoice.status)) return result;
    // The canary rehearses with the test provider only: a real link for a test client is a real charge waiting to happen.
    // And the other way round: sending or reminding a real customer never makes a test link (a pay.invalid address in a real email).
    // A person can still ask for one on purpose (providers: ["mock"]) to rehearse the books; it is never shown to the customer.
    const canary = isCanaryCustomer(invoice);
    const keys = (options.providers ?? enabledProviderKeys(settings).filter((key) => canary || key !== "mock")).filter((key) => (canary ? key === "mock" : true));
    if (keys.length === 0) return result;
    const amount = invoice.status === "draft" ? Number(invoice.total_minor) : (await invoiceBalance(ctx, invoice.id))?.outstandingMinor ?? 0;
    if (amount <= 0) return result;
    const existing = await linksForInvoice(ctx, invoice.id, ["active"]);
    const resolver = options.resolver ?? new SecretResolver(ctx, invoice.company_id, settings as Record<string, unknown>);
    for (const key of keys) {
      const mine = existing.filter((row) => row.provider === key);
      const reusable = mine.find((row) => Number(row.amount_minor) === amount && row.currency === invoice.currency && row.url);
      for (const stale of mine.filter((row) => row !== reusable)) await retireLink(ctx, stale, settings, resolver);
      if (reusable) {
        const view = linkView(reusable);
        if (view) result.links.push(view);
        continue;
      }
      const provider = await buildProvider(ctx, invoice.company_id, settings, key, resolver);
      if (!provider) {
        result.problems.push(`${PROVIDER_LABELS[key]} is not ready`);
        continue;
      }
      const id = randomUUID();
      await insertLink(ctx, { id, companyId: invoice.company_id, invoiceId: invoice.id, provider: key, amountMinor: amount, currency: invoice.currency, createdBy: options.createdBy ?? null });
      try {
        const created = await provider.createLink({ linkId: id, invoiceNumber: invoice.number, amountMinor: amount, currency: invoice.currency, description: `Invoice ${invoice.number}` });
        await setLinkCreated(ctx, id, created);
        result.links.push({ id, provider: key, label: PROVIDER_LABELS[key], url: created.url, amountMinor: amount });
      } catch (error) {
        const message = safeMessage(error);
        await setLinkStatus(ctx, id, ["active"], "failed", message);
        result.problems.push(`${PROVIDER_LABELS[key]}: ${message}`);
        ctx.logger.info("Payment link not made", { invoiceId: invoice.id, provider: key, error: message });
      }
    }
  } catch (error) {
    result.problems.push(safeMessage(error));
    ctx.logger.info("Payment links skipped", { invoiceId: invoice.id, error: safeMessage(error) });
  }
  return result;
}

/** Withdraw one link: it stops showing, and the provider is told (best effort; the hourly job retries a failure). */
export async function retireLink(ctx: PluginContext, link: PaymentLinkRow, settings: BillingSettings, resolver?: SecretResolver): Promise<void> {
  if (!(await setLinkStatus(ctx, link.id, ["active"], "cancelled"))) return;
  await deactivateRemote(ctx, link, settings, resolver);
}

async function deactivateRemote(ctx: PluginContext, link: PaymentLinkRow, settings: BillingSettings, resolver?: SecretResolver): Promise<boolean> {
  if (!link.provider_ref) {
    await markLinkRemoteOff(ctx, link.id);
    return true;
  }
  try {
    // The provider may have been switched off since: its secret key is still saved, so a withdrawn link is still switched off there.
    const secrets = resolver ?? new SecretResolver(ctx, link.company_id, settings as Record<string, unknown>);
    let provider: PaymentProvider | null = null;
    if (link.provider === "mock") provider = new MockProvider();
    else if (link.provider === "stripe") {
      const secretKey = await secrets.get("payments.stripe.secretKey");
      provider = secretKey ? new StripeProvider({ secretKey, webhookSecret: "" }) : null;
    }
    if (!provider) return false;
    await provider.deactivateLink({ providerRef: link.provider_ref });
    await markLinkRemoteOff(ctx, link.id);
    return true;
  } catch (error) {
    ctx.logger.info("Could not switch a payment link off at the provider", { linkId: link.id, error: safeMessage(error) });
    return false;
  }
}

/** The invoice no longer takes payment (paid in full, cancelled, written off): its active links stop showing. SQL only. */
export async function retireInvoiceLinks(ctx: PluginContext, invoiceId: string): Promise<number> {
  let n = 0;
  for (const row of await linksForInvoice(ctx, invoiceId, ["active"])) if (await setLinkStatus(ctx, row.id, ["active"], "cancelled")) n += 1;
  return n;
}

/** A payment or credit changed what the invoice owes: a link for another amount would take the wrong money, so it stops showing. */
export async function retireLinksForOtherAmount(ctx: PluginContext, invoiceId: string, outstandingMinor: number): Promise<number> {
  return retireStaleLinks(ctx, invoiceId, outstandingMinor);
}

/** Hourly: switch off at the provider the links withdrawn since the last run (an invoice paid another way, cancelled, re-priced). */
export async function housekeepPaymentLinks(ctx: PluginContext, companyId: string, settings: BillingSettings): Promise<{ switchedOff: number }> {
  let switchedOff = 0;
  const resolver = new SecretResolver(ctx, companyId, settings as Record<string, unknown>);
  for (const link of await linksForCompany(ctx, companyId, ["cancelled"], 30)) {
    if (link.provider === "payfast" || !link.provider_ref || link.remote_off_at) continue;
    if (await deactivateRemote(ctx, link, settings, resolver)) switchedOff += 1;
  }
  return { switchedOff };
}

