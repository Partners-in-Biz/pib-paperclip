/**
 * The Billing invoice card on a Planning Canvas board (PAR-14420; plan PAR-14389 C.2).
 *
 * Billing has no kit guard, so `registerCanvasCards` registers through `ctx.actions.register` itself. Each answer is
 * built on what the page uses: `requireInvoice` (company and shares), `listInvoices` for a client, `balanceOut`'s status.
 * Nothing on the board vouches for an id: every `resolve` checks every id again.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { formatClientParam, registerCanvasCards, type CanvasCardInput, type CanvasCardKind, type ClientRef } from "@partnersinbiz/pib-plugin-kit";
import { invoiceBalance, iso, statusAsAtToday } from "./balances.js";
import { listInvoices, searchInvoices, type InvoiceRow } from "./db.js";
import { BillingError, dayText, formatMoney } from "./domain.js";
import { customerNameOf, requireInvoice } from "./invoices.js";
import { invoiceNumberLabel } from "./invoice-number.js";

import { INVOICE_CARD } from "./canvas-cards-key.js";
export { INVOICE_CARD };
const CRM_PLUGIN = "partnersinbiz.crm";
const OF_KIND: Record<string, ClientRef["kind"]> = { "card-company": "company", "card-contact": "contact" };

async function cardOf(ctx: PluginContext, invoice: InvoiceRow): Promise<CanvasCardInput> {
  const balance = await invoiceBalance(ctx, invoice.id);
  const currency = invoice.currency;
  const meta = [{ label: "Total", value: formatMoney(Number(invoice.total_minor), currency) }];
  if (balance) meta.push({ label: "Outstanding", value: formatMoney(balance.outstandingMinor, currency) });
  const due = dayText(iso(invoice.due_at));
  if (due !== "–") meta.push({ label: "Due", value: due });
  return {
    id: invoice.id,
    title: `Invoice ${invoiceNumberLabel(invoice.number)}`,
    subtitle: customerNameOf(invoice.customer_snapshot ?? invoice.customer),
    status: balance ? statusAsAtToday(balance) : invoice.status,
    meta,
    // No single-invoice link exists: the page opens on the client's work.
    href: `/billing?client=${encodeURIComponent(formatClientParam({ kind: invoice.customer_kind as ClientRef["kind"], id: invoice.customer_ref }))}`,
  };
}

async function cardsOf(ctx: PluginContext, rows: InvoiceRow[]): Promise<CanvasCardInput[]> {
  const cards: CanvasCardInput[] = [];
  for (const row of rows) cards.push(await cardOf(ctx, row));
  return cards;
}

export function invoiceCardKind(ctx: PluginContext): CanvasCardKind {
  return {
    type: INVOICE_CARD,
    async resolve(ids, { companyId }) {
      const rows: InvoiceRow[] = [];
      for (const id of ids) {
        try {
          rows.push(await requireInvoice(ctx, companyId, id));
        } catch (error) {
          // Missing, deleted, another company's: all "no". Anything else is a real fault.
          if (!(error instanceof BillingError)) throw error;
        }
      }
      return cardsOf(ctx, rows);
    },
    async search({ q, limit }, { companyId }) {
      return cardsOf(ctx, await searchInvoices(ctx, companyId, q, limit));
    },
    async related({ of, limit }, { companyId }) {
      const kind = OF_KIND[of.type];
      if (of.plugin !== CRM_PLUGIN || !kind || !of.id) return [];
      // Exactly the page's list filtered to the client; the page does not ask the CRM either.
      const rows = await listInvoices(ctx, companyId, { kind, id: of.id });
      if (!rows.length) return [];
      return [{ relation: "invoice", label: "Invoices", cards: await cardsOf(ctx, rows.slice(0, limit)), more: rows.length > limit }];
    },
  };
}

export function registerBillingCanvasCards(ctx: PluginContext): void {
  registerCanvasCards({ register: (key, handler) => ctx.actions.register(key, handler), kinds: [invoiceCardKind(ctx)] });
}
