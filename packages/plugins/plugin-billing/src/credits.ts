/**
 * Credit notes (numbered CN-LUM-001, applied to their invoice, the rest kept
 * as customer credit) and customer statements.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { invoiceBalances, iso } from "./balances.js";
import { emailEnabled, loadBilling, privateR2, type BillingSettings } from "./config.js";
import { asObject, getCreditNote, getInvoice, insertCreditNote, table, type CreditNoteRow } from "./db.js";
import { docFileName, renderDocument, statementPdfSpec, type DocView, type StatementEntry, type StatementView } from "./documents.js";
import { BillingError, createCreditNote, daysPastDue } from "./domain.js";
import { creditNoteEmail, parseAddresses, queueMail, statementEmail } from "./mail.js";
import { splitByGroups } from "./money.js";
import { nextDocumentNumber } from "./numbering.js";
import { customerFrom, invoiceView, recipientsFor, requireOwnInvoice, senderFrom, totalsOf } from "./invoices.js";
import { linesFor } from "./db.js";
import { afterCreditNote, creditedOnInvoice } from "./settle.js";
import { documentKey, MAIL_LINK_SECONDS, presignGet, putObject } from "./storage.js";
import { actorLabel, integer, optionalString, readClientScope, requiredCompany, requiredString, requirePerson } from "./util.js";
import { renderDocumentPdf, type ClientRef } from "@partnersinbiz/pib-plugin-kit";

export async function createCreditNoteAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const invoice = await requireOwnInvoice(ctx, companyId, requiredString(params, "invoiceId"));
  if (invoice.status === "draft") throw new BillingError("Credit notes are for sent invoices. Change the draft instead.");
  if (invoice.status === "cancelled") throw new BillingError("This invoice is cancelled");
  const draft = createCreditNote({ companyId, invoiceId: invoice.id, amountMinor: integer(params.amountMinor, "amountMinor"), reason: optionalString(params, "reason") });
  const already = await creditedOnInvoice(ctx, invoice.id);
  if (already + draft.amountMinor > Number(invoice.total_minor)) {
    throw new BillingError(`Credit notes on ${invoice.number} would exceed its total`);
  }
  const { settings } = await loadBilling(ctx, companyId);
  const customer = asObject(invoice.customer_snapshot ?? invoice.customer);
  const number = await nextDocumentNumber(ctx, companyId, "credit_note", { kind: invoice.customer_kind, ref: invoice.customer_ref, name: String(customer.name ?? invoice.customer_ref) }, settings);
  const row: CreditNoteRow = {
    id: draft.id,
    company_id: invoice.company_id,
    invoice_id: invoice.id,
    amount_minor: draft.amountMinor,
    reason: draft.reason,
    status: draft.status,
    created_at: new Date().toISOString(),
    number,
    currency: invoice.currency,
    customer_kind: invoice.customer_kind,
    customer_ref: invoice.customer_ref,
    issued_on: new Date().toISOString().slice(0, 10),
    created_by: actorLabel(context),
  };
  await insertCreditNote(ctx, row);
  const applied = await afterCreditNote(ctx, { id: row.id, number, amount_minor: row.amount_minor, created_at: row.created_at }, invoice, settings, actorLabel(context));
  const fresh = await getCreditNote(ctx, row.id);
  return { ...draft, number, status: fresh?.status ?? draft.status, appliedMinor: applied.appliedMinor, creditMinor: draft.amountMinor - applied.appliedMinor, invoiceStatus: applied.status };
}

export function publicCreditNote(note: CreditNoteRow, invoiceNumber?: string | null) {
  return {
    id: note.id,
    number: note.number ?? null,
    invoiceId: note.invoice_id,
    invoiceNumber: invoiceNumber ?? null,
    amountMinor: Number(note.amount_minor),
    currency: note.currency ?? null,
    reason: note.reason,
    status: note.status,
    createdAt: iso(note.created_at),
    deliveryStatus: note.delivery_status ?? null,
    ledgerStatus: note.ledger_status ?? null,
    journalNumber: note.journal_number ?? null,
  };
}

export async function creditNoteView(ctx: PluginContext, note: CreditNoteRow, settings: BillingSettings): Promise<DocView> {
  const invoice = await getInvoice(ctx, note.invoice_id);
  if (!invoice) throw new BillingError("The credited invoice was not found");
  const totals = totalsOf(await linesFor(ctx, invoice.id), invoice);
  const amount = Number(note.amount_minor);
  const split = splitByGroups(amount, totals.groups);
  const base = await invoiceView(ctx, invoice, settings);
  return {
    ...base,
    kind: "credit_note",
    number: note.number ?? `CN-${note.id.slice(0, 8)}`,
    status: "issued",
    issuedAt: iso(note.created_at),
    dueAt: null,
    lines: [{
      description: note.reason ? `Credit against ${invoice.number}: ${note.reason}` : `Credit against ${invoice.number}`,
      quantity: 1,
      unitAmountMinor: base.pricesIncludeVat ? amount : split.reduce((a, g) => a + g.netMinor, 0),
      taxCode: split.length === 1 ? split[0]!.taxCode : null,
      rateBp: split.length === 1 ? split[0]!.rateBp : 0,
      netMinor: split.reduce((a, g) => a + g.netMinor, 0),
      vatMinor: split.reduce((a, g) => a + g.vatMinor, 0),
      grossMinor: amount,
    }],
    groups: split,
    subtotalMinor: split.reduce((a, g) => a + g.netMinor, 0),
    vatMinor: split.reduce((a, g) => a + g.vatMinor, 0),
    totalMinor: amount,
    legacy: false,
    againstNumber: invoice.number,
    reason: note.reason || null,
    payment: null,
    notes: null,
  };
}

async function requireCreditNote(ctx: PluginContext, companyId: string, id: string): Promise<CreditNoteRow> {
  const note = await getCreditNote(ctx, id);
  if (!note || note.company_id !== companyId) throw new BillingError("Credit note was not found");
  return note;
}

export async function creditNotePdf(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const note = await requireCreditNote(ctx, companyId, requiredString(params, "creditNoteId"));
  const { settings } = await loadBilling(ctx, companyId);
  const view = await creditNoteView(ctx, note, settings);
  const bytes = await renderDocument(view);
  return { filename: docFileName(view), mime: "application/pdf", base64: Buffer.from(bytes).toString("base64") };
}

export async function sendCreditNote(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const createdBy = requirePerson(context, "sending a credit note");
  const companyId = requiredCompany(context);
  const note = await requireCreditNote(ctx, companyId, requiredString(params, "creditNoteId"));
  const invoice = await getInvoice(ctx, note.invoice_id);
  if (!invoice) throw new BillingError("The credited invoice was not found");
  const { settings, resolver } = await loadBilling(ctx, companyId);
  if (!emailEnabled(settings)) throw new BillingError("Email is off in Billing settings");
  const to = "sendTo" in params ? parseAddresses(params.sendTo) : await recipientsFor(ctx, companyId, invoice);
  if (to.length === 0) throw new BillingError("Add an email address for this customer first");
  const view = await creditNoteView(ctx, note, settings);
  const r2 = await privateR2(resolver, settings).catch(() => null);
  let attachment = null;
  if (r2) {
    const bytes = await renderDocument(view);
    const filename = docFileName(view);
    const key = documentKey(r2, companyId, "credit_note", filename, "pdf");
    await putObject(r2, key, bytes, "application/pdf");
    await ctx.db.execute(`UPDATE ${table(ctx, "credit_notes")} SET pdf_key = $2 WHERE id = $1`, [note.id, key]);
    attachment = { url: presignGet(r2, key, MAIL_LINK_SECONDS, filename), filename, mime: "application/pdf", bytes: bytes.byteLength };
  }
  const seq = Number(note.mail_seq ?? 0) + 1;
  const key = await queueMail(ctx, companyId, {
    kind: "credit_note",
    docId: note.id,
    seq,
    to,
    cc: parseAddresses(settings.email?.cc ?? ""),
    from: settings.email?.from?.trim() || null,
    content: creditNoteEmail(view, { hasAttachment: Boolean(attachment), signature: settings.email?.signature }),
    attachments: attachment ? [attachment] : [],
    clientKind: invoice.customer_kind,
    clientRef: invoice.customer_ref,
    createdBy,
  });
  await ctx.db.execute(`UPDATE ${table(ctx, "credit_notes")} SET delivery_key = $2, delivery_status = 'queued', delivery_error = NULL, mail_seq = $3 WHERE id = $1`, [note.id, key, seq]);
  return { key, to, attached: Boolean(attachment) };
}

// ── Statements ─────────────────────────────────────────────────────────────

function dayStr(value: unknown): string {
  return (iso(value) ?? new Date().toISOString()).slice(0, 10);
}

/** A customer's statement for [from, to] in one currency: opening balance, activity, closing and ageing. */
export async function statementData(ctx: PluginContext, companyId: string, client: ClientRef, from: string, to: string, currency: string | null, settings: BillingSettings): Promise<StatementView> {
  const balances = (await invoiceBalances(ctx, companyId, { customerKind: client.kind, customerRef: client.id }))
    .filter((b) => b.invoice.status !== "draft" && b.invoice.status !== "cancelled");
  const cur = currency ?? balances[0]?.invoice.currency ?? settings.defaultCurrency ?? "ZAR";
  const mine = balances.filter((b) => b.invoice.currency === cur);
  const ids = mine.map((b) => b.invoice.id);
  const number = new Map(mine.map((b) => [b.invoice.id, b.invoice.number]));
  const entries: StatementEntry[] = [];
  let opening = 0;
  const push = (entry: StatementEntry) => {
    if (entry.date < from) opening += entry.debitMinor - entry.creditMinor;
    else if (entry.date <= to) entries.push(entry);
  };
  for (const b of mine) push({ date: dayStr(b.invoice.sent_at ?? b.invoice.created_at), kind: "invoice", reference: b.invoice.number, description: "Invoice", debitMinor: Number(b.invoice.total_minor), creditMinor: 0 });
  if (ids.length) {
    const payments = await ctx.db.query<{ invoice_id: string; amount_minor: string | number; paid_at: unknown; reference: string | null }>(
      `SELECT invoice_id, amount_minor, paid_at, reference FROM ${table(ctx, "payments")} WHERE invoice_id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
      [JSON.stringify(ids)],
    );
    for (const p of payments) push({ date: dayStr(p.paid_at), kind: "payment", reference: number.get(p.invoice_id) ?? "", description: `Payment${p.reference ? ` (${p.reference})` : ""}`, debitMinor: 0, creditMinor: Number(p.amount_minor) });
    const notes = await ctx.db.query<{ invoice_id: string; amount_minor: string | number; created_at: unknown; number: string | null }>(
      `SELECT invoice_id, amount_minor, created_at, number FROM ${table(ctx, "credit_notes")} WHERE invoice_id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
      [JSON.stringify(ids)],
    );
    for (const n of notes) push({ date: dayStr(n.created_at), kind: "credit_note", reference: n.number ?? "", description: `Credit note against ${number.get(n.invoice_id) ?? ""}`, debitMinor: 0, creditMinor: Number(n.amount_minor) });
    const writeOffs = await ctx.db.query<{ invoice_id: string; amount_minor: string | number; created_at: unknown }>(
      `SELECT invoice_id, amount_minor, created_at FROM ${table(ctx, "credit_applications")} WHERE source_kind = 'write_off' AND invoice_id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
      [JSON.stringify(ids)],
    );
    for (const w of writeOffs) push({ date: dayStr(w.created_at), kind: "write_off", reference: number.get(w.invoice_id) ?? "", description: "Written off", debitMinor: 0, creditMinor: Number(w.amount_minor) });
  }
  const now = new Date(`${to}T23:59:59Z`);
  const ageing = { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0 };
  for (const b of mine) {
    if (b.outstandingMinor <= 0) continue;
    const due = iso(b.invoice.due_at);
    const days = due && Date.parse(due) < now.getTime() ? daysPastDue(due, now) : -1;
    if (days < 0) ageing.current += b.outstandingMinor;
    else if (days <= 30) ageing.d30 += b.outstandingMinor;
    else if (days <= 60) ageing.d60 += b.outstandingMinor;
    else if (days <= 90) ageing.d90 += b.outstandingMinor;
    else ageing.d90plus += b.outstandingMinor;
  }
  const customer = mine[0] ? asObject(mine[0].invoice.customer_snapshot ?? mine[0].invoice.customer) : await customerFrom(ctx, companyId, client.kind, client.id, undefined).catch(() => ({ name: client.id }));
  return { currency: cur, from, to, sender: senderFrom(settings, undefined), customer, openingMinor: opening, entries, ageing, payment: settings.payment ?? null };
}

function statementRange(params: Record<string, unknown>): { from: string; to: string } {
  const to = optionalString(params, "to") ?? new Date().toISOString().slice(0, 10);
  const from = optionalString(params, "from") ?? new Date(Date.parse(`${to}T00:00:00Z`) - 90 * 86_400_000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new BillingError("from and to must be dates (YYYY-MM-DD), from before to");
  return { from, to };
}

function requireClient(params: Record<string, unknown>): ClientRef {
  const scope = readClientScope(params);
  if (!scope) throw new BillingError("client is required (company:<id> or contact:<id>)");
  return scope;
}

export async function statementPdf(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const client = requireClient(params);
  const { from, to } = statementRange(params);
  const { settings } = await loadBilling(ctx, companyId);
  const view = await statementData(ctx, companyId, client, from, to, optionalString(params, "currency") ?? null, settings);
  const bytes = await renderDocumentPdf(statementPdfSpec(view));
  return { filename: `Statement-${from}-${to}.pdf`, mime: "application/pdf", base64: Buffer.from(bytes).toString("base64"), openingMinor: view.openingMinor, entries: view.entries.length };
}

export async function sendStatement(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const createdBy = requirePerson(context, "sending a statement");
  const companyId = requiredCompany(context);
  const client = requireClient(params);
  const { from, to } = statementRange(params);
  const { settings, resolver } = await loadBilling(ctx, companyId);
  if (!emailEnabled(settings)) throw new BillingError("Email is off in Billing settings");
  const view = await statementData(ctx, companyId, client, from, to, optionalString(params, "currency") ?? null, settings);
  const recipients = "sendTo" in params
    ? parseAddresses(params.sendTo)
    : await recipientsFor(ctx, companyId, { customer_kind: client.kind, customer_ref: client.id, customer: view.customer });
  if (recipients.length === 0) throw new BillingError("Add an email address for this customer first");
  const bytes = await renderDocumentPdf(statementPdfSpec(view));
  const filename = `Statement-${from}-${to}.pdf`;
  const r2 = await privateR2(resolver, settings).catch(() => null);
  let attachment = null;
  if (r2) {
    const key = documentKey(r2, companyId, "statement", filename, "pdf");
    await putObject(r2, key, bytes, "application/pdf");
    attachment = { url: presignGet(r2, key, MAIL_LINK_SECONDS, filename), filename, mime: "application/pdf", bytes: bytes.byteLength };
  }
  const closing = view.openingMinor + view.entries.reduce((a, e) => a + e.debitMinor - e.creditMinor, 0);
  const docId = `${client.kind}-${client.id}-${to}`;
  const seqRows = await ctx.db.query<{ n: string | number }>(`SELECT count(*) AS n FROM ${table(ctx, "deliveries")} WHERE company_id = $1 AND doc_kind = 'statement' AND doc_id = $2`, [companyId, docId]);
  const key = await queueMail(ctx, companyId, {
    kind: "statement",
    docId,
    seq: Number(seqRows[0]?.n ?? 0) + 1,
    to: recipients,
    cc: parseAddresses(settings.email?.cc ?? ""),
    from: settings.email?.from?.trim() || null,
    content: statementEmail({ customer: view.customer, sender: view.sender, from, to, dueMinor: closing, currency: view.currency, payment: settings.payment, signature: settings.email?.signature, hasAttachment: Boolean(attachment) }),
    attachments: attachment ? [attachment] : [],
    clientKind: client.kind,
    clientRef: client.id,
    createdBy,
  });
  return { key, to: recipients, attached: Boolean(attachment), closingMinor: closing };
}

export { randomUUID };
