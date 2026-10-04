/**
 * Signed documents become draft invoices (audit Q1b-2 lead to cash, Q1b-11 e-sign).
 *
 * When a client signs a proposal, quote or agreement on the CRM's e-sign page, the CRM (0.14.0) tells Billing twice:
 * `deal.accepted` for every signature, and `quote.accepted` as well when the document names a Billing quote. Both carry
 * the same document id and the same facts. Billing drafts the invoice for that signature, once:
 *
 * - **A quote** (`quoteId`): the CRM cannot read Billing's tables and the id was typed by an agent when it made the
 *   document, so Billing checks it before anything is drafted: the quote exists, it is this company's, it is for the same
 *   client, the signed amount and currency equal its total, and it belongs to the same deal. Any difference means no invoice
 *   and a work issue for the Account Manager that says exactly what differs. A match marks the quote accepted (the client's
 *   signature is the acceptance, so the CRM is not told again) and converts it into a draft invoice.
 * - **A deal with no quote**: when the deal has no invoice and no live quote, one line for the signed amount is drafted. The
 *   prices include VAT, so the invoice total is exactly what the client signed. A deal that has a quote the document does not
 *   name is not guessed at: that is an issue too.
 *
 * Nothing is sent. The draft goes through the usual send request (the Reviewer first, then a person). The canary client gets
 * its draft too (the acceptance journey is quote to invoice) but no issue and nobody is woken.
 *
 * One signature, one invoice: the work is claimed per document (`accepted-store.ts`), so the two events, a repeat delivery
 * (the CRM sends each hand-off again hourly for a day) and a retry after a crash all meet on one row. The invoice id is chosen
 * when the row is claimed, and every step can be repeated, so a retry finishes a half-made draft instead of making another.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { formatMoneyMinor, PIB_PLUGINS, pluginEvent } from "@partnersinbiz/pib-plugin-kit";
import { claimAcceptance, finishAcceptance, noteAcceptanceError, type AcceptanceStatus } from "./accepted-store.js";
import { isCanaryRef } from "./canary.js";
import { defaultTaxCode, loadBilling } from "./config.js";
import { asObject, getInvoice, getQuote, insertInvoice, insertLine, linesFor, saveQuoteStatus, table, type InvoiceRow, type QuoteRow } from "./db.js";
import { dealWonKey } from "./followups.js";
import { convertQuoteRow, customerFrom, customerNameOf, defaultDueAt, defaultTax, recomputeInvoice, senderFrom } from "./invoices.js";
import { computeDocument } from "./money.js";
import { nextDocumentNumber } from "./numbering.js";
import { WORK_ORIGINS } from "./origins.js";
import { billingPath, companyPrefix, workRoute } from "./routing.js";
import { billingOn } from "./setup.js";
import { closeStandingIssue, upsertStandingIssue } from "./workissues.js";

/**
 * The CRM's e-sign hand-offs, as the host delivers them (the CRM emits `deal.accepted` and `quote.accepted`). The kit has no
 * names for them yet: it will export them, and these two lines then become imports. Billing's own `quote.accepted` (kit
 * `HANDOFF_EVENTS.quoteAccepted`, sent to the CRM) is a different event, under Billing's key.
 */
export const CRM_DEAL_ACCEPTED_EVENT = pluginEvent(PIB_PLUGINS.crm, "deal.accepted");
export const CRM_QUOTE_ACCEPTED_EVENT = pluginEvent(PIB_PLUGINS.crm, "quote.accepted");

export type AcceptanceSource = "deal" | "quote";

/** What one hand-off says, read defensively: the payload crossed a plugin boundary and some of it was typed by an agent. */
export interface Acceptance {
  source: AcceptanceSource;
  /** The signed document: one signature, however many events carry it. */
  documentId: string;
  title: string | null;
  dealId: string | null;
  quoteId: string | null;
  quoteNumber: string | null;
  clientKind: "company" | "contact" | null;
  clientRef: string | null;
  clientName: string | null;
  /** What the client signed for, in cents (`valueMinor` of deal.accepted, `totalMinor` of quote.accepted). */
  amountMinor: number | null;
  currency: string | null;
  signerName: string | null;
  signedAt: string | null;
  contentSha256: string | null;
  auditHead: string | null;
}

const text = (value: unknown, max: number): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
const cents = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

/** Reads a hand-off. Null when it names no signed document (nothing could be made idempotent without one). */
export function parseAcceptance(source: AcceptanceSource, payload: unknown): Acceptance | null {
  const body = asObject(payload);
  // Never cut to size: two long ids that start alike must not become one document.
  const documentId = typeof body.documentId === "string" ? body.documentId.trim() : "";
  if (!documentId || documentId.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(documentId)) return null;
  const kind = body.clientKind === "company" || body.clientKind === "contact" ? body.clientKind : null;
  // The CRM's quote.accepted says "quote" when the document named no number.
  const numberRaw = text(source === "quote" ? body.number : body.quoteNumber, 60);
  const currency = typeof body.currency === "string" && /^[A-Z]{3}$/.test(body.currency) ? body.currency : null;
  const signedAt = text(source === "quote" ? body.acceptedAt : body.signedAt, 40);
  return {
    source,
    documentId,
    title: text(body.title, 200),
    dealId: text(body.dealId, 200),
    quoteId: text(body.quoteId, 120),
    quoteNumber: numberRaw === "quote" ? null : numberRaw,
    clientKind: kind,
    clientRef: kind ? text(body.clientRef, 200) : null,
    clientName: text(body.clientName, 200),
    amountMinor: cents(source === "quote" ? body.totalMinor : body.valueMinor),
    currency,
    signerName: text(body.signerName, 120),
    signedAt: signedAt && !Number.isNaN(Date.parse(signedAt)) ? new Date(signedAt).toISOString() : null,
    contentSha256: text(body.contentSha256, 80),
    auditHead: text(body.auditHead, 80),
  };
}

// ---------------------------------------------------------------------------
// What differs between the signed document and the quote (pure)
// ---------------------------------------------------------------------------

export type QuoteFacts = Pick<QuoteRow, "number" | "customer_kind" | "customer_ref" | "total_minor" | "currency"> & { subtotal_minor?: QuoteRow["subtotal_minor"]; deal_id?: string | null };

/** Every way the signed document disagrees with the quote it names, in words. Empty: they agree and the invoice may be drafted. */
export function quoteDifferences(acc: Acceptance, quote: QuoteFacts): string[] {
  const out: string[] = [];
  const label = `quote ${quote.number}`;
  const total = Number(quote.total_minor);
  if (!acc.clientKind || !acc.clientRef) out.push(`The signed document names no client, so Billing cannot check that it is for ${label}'s client (${quote.customer_kind}:${quote.customer_ref}).`);
  else if (acc.clientKind !== quote.customer_kind || acc.clientRef !== quote.customer_ref) out.push(`The document was signed for ${acc.clientKind}:${acc.clientRef}, but ${label} is for ${quote.customer_kind}:${quote.customer_ref}.`);
  if (acc.quoteNumber && acc.quoteNumber !== quote.number) out.push(`The document names quote ${acc.quoteNumber}, but that quote id is ${label}.`);
  if (acc.amountMinor == null) out.push(`The signed document states no amount (or R 0.00), so ${label}'s total of ${formatMoneyMinor(total, quote.currency)} cannot be checked.`);
  else if (acc.amountMinor !== total || (acc.currency != null && acc.currency !== quote.currency)) {
    const signed = formatMoneyMinor(acc.amountMinor, acc.currency ?? quote.currency);
    const exVat = quote.subtotal_minor != null && Number(quote.subtotal_minor) !== total && acc.amountMinor === Number(quote.subtotal_minor);
    out.push(`The client signed ${signed}, but ${label} totals ${formatMoneyMinor(total, quote.currency)}${exVat ? " (the signed amount is the quote's total without VAT: the document must state the total with VAT)" : ""}.`);
  }
  if (total <= 0 && acc.amountMinor !== 0) out.push(`${label} has no amount yet (no lines), so there is nothing to invoice.`);
  if (quote.deal_id && acc.dealId && quote.deal_id !== acc.dealId) out.push(`The document belongs to deal ${acc.dealId}, but ${label} belongs to deal ${quote.deal_id}.`);
  return out;
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

type Decision =
  | { status: "drafted"; invoice: InvoiceRow; quote: QuoteRow | null }
  | { status: "already_invoiced"; invoiceId: string | null; reason: string }
  | { status: "needs_attention"; differences: string[]; quote: QuoteRow | null; reason: string }
  | { status: "skipped"; reason: string };

const attention = (differences: string[], quote: QuoteRow | null = null): Decision => ({ status: "needs_attention", differences, quote, reason: differences.join(" ").slice(0, 900) });

async function findQuote(ctx: PluginContext, companyId: string, acc: Acceptance): Promise<QuoteRow | null> {
  if (acc.quoteId) {
    const quote = await getQuote(ctx, acc.quoteId);
    return quote && quote.company_id === companyId ? quote : null;
  }
  if (!acc.quoteNumber) return null;
  const rows = await ctx.db.query<{ id: string }>(`SELECT id FROM ${table(ctx, "quotes")} WHERE company_id = $1 AND number = $2 LIMIT 2`, [companyId, acc.quoteNumber]);
  return rows.length === 1 ? getQuote(ctx, rows[0]!.id) : null;
}

async function invoicesOf(ctx: PluginContext, companyId: string, column: "quote_id" | "deal_id", value: string): Promise<Array<{ id: string; number: string; status: string }>> {
  return ctx.db.query(
    `SELECT id, number, status FROM ${table(ctx, "invoices")} WHERE company_id = $1 AND ${column} = $2 AND status <> 'cancelled' ORDER BY created_at, id`,
    [companyId, value],
  );
}

async function decideFromQuote(ctx: PluginContext, companyId: string, acc: Acceptance, invoiceId: string): Promise<Decision> {
  const quote = await findQuote(ctx, companyId, acc);
  if (!quote) return attention([`Billing has no quote ${acc.quoteId ? `with id ${acc.quoteId}` : acc.quoteNumber}${acc.quoteId && acc.quoteNumber ? ` (the document calls it ${acc.quoteNumber})` : ""} in this company, so the signed document cannot be matched to one. Check the quote id typed into the document.`]);
  const invoices = await invoicesOf(ctx, companyId, "quote_id", quote.id);
  const ours = invoices.find((invoice) => invoice.id === invoiceId);
  // A first try made the invoice and stopped before it finished: finish it (the same invoice, its lines once).
  if (ours) return { status: "drafted", ...(await convertQuoteRow(ctx, quote, { invoiceId, dealId: acc.dealId })) };
  const other = invoices[0];
  if (other || quote.status === "converted") {
    const id = other?.id ?? quote.converted_invoice_id ?? null;
    return { status: "already_invoiced", invoiceId: id, reason: `Quote ${quote.number} already has invoice ${other?.number ?? id ?? "(not found)"}, so no second one was drafted.` };
  }
  const differences = quoteDifferences(acc, quote);
  if (quote.status === "declined") differences.push(`Quote ${quote.number} is marked declined in Billing, but the client signed it. Someone recorded a "no" and the client later said yes: a person decides which is true.`);
  if (differences.length) return attention(differences, quote);
  // The client's signature is the acceptance: mark it (the CRM already knows, so Billing does not tell it again), then invoice it.
  if (quote.status !== "accepted") {
    quote.status = "accepted";
    quote.accepted_at = acc.signedAt ?? new Date().toISOString();
    await saveQuoteStatus(ctx, quote);
  }
  return { status: "drafted", ...(await convertQuoteRow(ctx, quote, { invoiceId, dealId: acc.dealId })) };
}

async function decideFromDeal(ctx: PluginContext, companyId: string, acc: Acceptance, invoiceId: string): Promise<Decision> {
  const amount = acc.amountMinor ?? 0;
  if (!acc.dealId) {
    if (amount <= 0) return { status: "skipped", reason: "The signed document has no amount and no deal or quote, so there is nothing to invoice." };
    return attention([`The client signed ${formatMoneyMinor(amount, acc.currency ?? "ZAR")}, but the document is linked to neither a deal nor a Billing quote, so Billing cannot tell what to invoice.`]);
  }
  const invoices = await invoicesOf(ctx, companyId, "deal_id", acc.dealId);
  const ours = invoices.find((invoice) => invoice.id === invoiceId);
  if (!ours && invoices.length) {
    return { status: "already_invoiced", invoiceId: invoices[0]!.id, reason: `Deal ${acc.dealId} already has invoice ${invoices[0]!.number}, so no second one was drafted.` };
  }
  if (!ours) {
    if (amount <= 0) return { status: "skipped", reason: "The signed document states no amount, so there is nothing to invoice. The won-deal issue covers what to bill." };
    const live = await ctx.db.query<{ number: string; status: string; total_minor: string | number; currency: string }>(
      `SELECT number, status, total_minor, currency FROM ${table(ctx, "quotes")} WHERE company_id = $1 AND deal_id = $2 AND status IN ('draft', 'sent', 'accepted', 'expired') ORDER BY created_at`,
      [companyId, acc.dealId],
    );
    if (live.length) {
      return attention([`Deal ${acc.dealId} has ${live.length === 1 ? "a quote" : "quotes"} in Billing (${live.map((q) => `${q.number}, ${q.status}, ${formatMoneyMinor(Number(q.total_minor), q.currency)}`).join("; ")}), but the signed document names none of them. Billing will not guess which one the client agreed to; the client signed ${formatMoneyMinor(amount, acc.currency ?? "ZAR")}.`]);
    }
  }
  if (!acc.clientKind || !acc.clientRef) return attention(["The signed document names no client, so Billing cannot say who to invoice."]);
  const currency = acc.currency ?? "ZAR";
  const { settings } = await loadBilling(ctx, companyId);
  const taxCode = defaultTaxCode(settings);
  // Prices include VAT, so the invoice is for exactly what the client signed; checked before anything is made.
  if (computeDocument([{ quantity: 1, unitAmountMinor: amount, taxCode }], { pricesIncludeVat: true, taxRatePercent: defaultTax(settings) }).totalMinor !== amount) {
    return attention([`Billing could not draft an invoice that totals exactly the signed ${formatMoneyMinor(amount, currency)}.`]);
  }
  const lineId = `${invoiceId}:document`;
  let invoice = await getInvoice(ctx, invoiceId);
  if (!invoice || invoice.company_id !== companyId) {
    const customer = await customerFrom(ctx, companyId, acc.clientKind, acc.clientRef, acc.clientName ?? undefined);
    invoice = {
      id: invoiceId,
      company_id: companyId,
      number: await nextDocumentNumber(ctx, companyId, "invoice", { kind: acc.clientKind, ref: acc.clientRef, name: String(customer.name) }, settings),
      status: "draft",
      currency,
      customer_kind: acc.clientKind,
      customer_ref: acc.clientRef,
      sender: senderFrom(settings, undefined),
      customer,
      sender_snapshot: null,
      customer_snapshot: null,
      total_minor: 0,
      tax_rate: defaultTax(settings),
      due_at: defaultDueAt(settings),
      approval_issue_id: null,
      pending_action: null,
      sent_at: null,
      default_tax_code: taxCode,
      prices_include_vat: true,
      notes: null,
      send_to: null,
      deal_id: acc.dealId,
    };
    await insertInvoice(ctx, invoice);
  }
  if (!(await linesFor(ctx, invoice.id)).some((line) => line.id === lineId)) {
    await insertLine(ctx, { id: lineId, companyId, invoiceId: invoice.id, description: (acc.title ?? "Signed agreement").slice(0, 200), quantity: 1, unitAmountMinor: amount, taxCode });
  }
  await recomputeInvoice(ctx, invoice);
  return { status: "drafted", invoice, quote: null };
}

// ---------------------------------------------------------------------------
// The issue for the Account Manager
// ---------------------------------------------------------------------------

const day = (at: string | null): string => (at ? at.slice(0, 10) : "today");

/** What was signed, in a few words: the document's title, else the quote. */
function whatWasSigned(acc: Acceptance, quote: QuoteRow | null): string {
  if (acc.title) return `"${acc.title}"`;
  const number = quote?.number ?? acc.quoteNumber;
  return number ? `quote ${number}` : "the document";
}

function evidenceLine(acc: Acceptance): string {
  return `Document \`${acc.documentId}\`${acc.contentSha256 ? `, SHA-256 starting ${acc.contentSha256.slice(0, 16)}` : ""}${acc.auditHead ? `, audit fingerprint ${acc.auditHead.slice(0, 12)}` : ""}. The CRM's \`verify-sign-document\` checks the record; never change it.`;
}

export function signedInvoiceIssue(input: { acc: Acceptance; client: string; clientRef: string; invoice: InvoiceRow; quote: QuoteRow | null; prefix: string | null }): { title: string; description: string } {
  const { acc, invoice, quote, client } = input;
  const what = whatWasSigned(acc, quote);
  const total = formatMoneyMinor(Number(invoice.total_minor), invoice.currency);
  const title = `Signed: ${what} for ${client}: check invoice ${invoice.number} and ask for approval to send`;
  const basis = quote
    ? `Quote ${quote.number} (\`${quote.id}\`) matched the signed amount and client, was marked accepted by the signature and converted.`
    : `The document named no Billing quote, so the invoice has one line for the signed amount${acc.dealId ? ` and is linked to deal \`${acc.dealId}\`` : ""}. Its prices include VAT, so the total is exactly what was signed.`;
  const description = [
    `${acc.signerName ?? "The client"} signed ${what} for ${client} on ${day(acc.signedAt)}. Billing drafted invoice ${invoice.number} (${total}) automatically. **It is a draft: nothing was sent.**`,
    "",
    "What was signed",
    `- ${basis}`,
    `- ${evidenceLine(acc)}`,
    "",
    "What to do",
    `1. \`invoice-detail\` (invoiceId \`${invoice.id}\`): check the client, lines, VAT codes, due date and recipients against the signed document.`,
    "2. `request-invoice-send`: a person approves the email (the Reviewer checks first). Never email it yourself, and never draft a second invoice for this document.",
    "3. Wrong lines or VAT: fix the draft (`update-line`, `update-invoice`) before asking. An invoice that must not go out: say why with `log-follow-up` (invoiceId, note) and ask the owner with `partnersinbiz.cockpit:ask-owner`.",
    "",
    `Billing for this client: ${billingPath(input.prefix, { client: input.clientRef })} · Quotes: ${billingPath(input.prefix, { tab: "quotes", client: input.clientRef })}`,
    "Done when the invoice is waiting for approval (or sent, or cancelled with a note saying why). Billing checks that when you close this issue.",
  ].join("\n");
  return { title: title.length > 240 ? `${title.slice(0, 237)}…` : title, description };
}

export function signedMismatchIssue(input: { acc: Acceptance; client: string; clientRef: string | null; differences: string[]; quote: QuoteRow | null; prefix: string | null }): { title: string; description: string } {
  const { acc, quote, client, differences } = input;
  const what = whatWasSigned(acc, quote);
  const title = `Signed: ${what} for ${client}: no invoice drafted, it does not match Billing`;
  const description = [
    `${acc.signerName ?? "The client"} signed ${what} for ${client} on ${day(acc.signedAt)}, but Billing did **not** draft an invoice: the signed document and Billing disagree. Billing never invoices something it cannot match to what the client signed.`,
    "",
    "What differs",
    ...differences.map((line) => `- ${line}`),
    "",
    `- ${evidenceLine(acc)}`,
    "",
    "What to do",
    quote
      ? `1. Look at the quote (\`quote-detail\`, quoteId \`${quote.id}\`) and at the signed text in the CRM (\`get-sign-document\` with includeContent, documentId \`${acc.documentId}\`).`
      : "1. Look at the signed text in the CRM (`get-sign-document` with includeContent, documentId `" + acc.documentId + "`) and at what Billing holds for this client and deal (`list-quotes`, `list-open-invoices`).",
    "2. The signed document is the agreement: never edit it. If it states what the client really agreed to, make Billing match it: a new quote with those lines for the same deal, `set-quote-status` `accepted`, `convert-quote`, then `request-invoice-send`.",
    "3. If it is not clear what the client agreed to, or the signed text looks wrong, ask the owner with `partnersinbiz.cockpit:ask-owner` (quote the lines above) and leave this issue blocked until they answer.",
    "",
    `Billing for this client: ${input.clientRef ? billingPath(input.prefix, { client: input.clientRef }) : billingPath(input.prefix)}`,
    "Done when an invoice exists for the quote or deal, or a `log-follow-up` note (quoteId or dealId) says why none will be made. Billing checks that when you close this issue.",
  ].join("\n");
  return { title: title.length > 240 ? `${title.slice(0, 237)}…` : title, description };
}

/** Who the client is, in words: the name the CRM sent, else the one on the invoice or quote, else the ref. */
function clientLabel(acc: Acceptance, invoice: InvoiceRow | null, quote: QuoteRow | null): string {
  const name = acc.clientName ?? customerNameOf(invoice?.customer ?? quote?.customer);
  return name ?? (acc.clientRef ? `${acc.clientKind}:${acc.clientRef}` : "the client");
}

/** The Account Manager's issue for this signature, and the won-deal issue it replaces. Safe to repeat: both are keyed. */
async function announce(ctx: PluginContext, companyId: string, acc: Acceptance, decision: Decision, canary: boolean): Promise<void> {
  if (canary) return;
  const prefix = await companyPrefix(ctx, companyId);
  const key = `${WORK_ORIGINS.signed}${acc.documentId}`;
  const route = await workRoute(ctx, companyId);
  if (decision.status === "drafted") {
    const name = clientLabel(acc, decision.invoice, decision.quote);
    const { title, description } = signedInvoiceIssue({ acc, client: name, clientRef: `${decision.invoice.customer_kind}:${decision.invoice.customer_ref}`, invoice: decision.invoice, quote: decision.quote, prefix });
    const issue = await upsertStandingIssue(ctx, {
      key,
      companyId,
      kind: "signed_document",
      subjectId: acc.documentId,
      title,
      description,
      fingerprint: `${acc.documentId}:drafted`,
      route,
      wake: true,
      comment: null,
      wakeReason: "A client signed: an invoice was drafted",
      reopen: false,
      detail: { documentId: acc.documentId, invoiceId: decision.invoice.id },
    });
    // The won-deal issue told the Account Manager to draft what Billing has just drafted: close it, so nobody makes a second invoice.
    if (acc.dealId) {
      await closeStandingIssue(ctx, dealWonKey(acc.dealId), companyId, `Billing drafted invoice ${decision.invoice.number} from the document the client signed, so there is nothing left to draft here. The work continues in the issue for that signature (${issue.issueId}): check the invoice there and ask for it to be sent. Do not draft another invoice.`);
    }
    return;
  }
  if (decision.status === "needs_attention") {
    const name = clientLabel(acc, null, decision.quote);
    const { title, description } = signedMismatchIssue({ acc, client: name, clientRef: acc.clientRef ? `${acc.clientKind}:${acc.clientRef}` : null, differences: decision.differences, quote: decision.quote, prefix });
    await upsertStandingIssue(ctx, {
      key,
      companyId,
      kind: "signed_document",
      subjectId: acc.documentId,
      title,
      description,
      fingerprint: `${acc.documentId}:needs_attention`,
      route,
      wake: true,
      comment: null,
      wakeReason: "A signed document does not match Billing",
      reopen: false,
      detail: { documentId: acc.documentId },
    });
  }
}

// ---------------------------------------------------------------------------
// Handling a hand-off
// ---------------------------------------------------------------------------

export interface AcceptanceResult {
  /** `duplicate`: another event or an earlier delivery already handled (or is handling) this signature. */
  status: AcceptanceStatus | "duplicate";
  invoiceId?: string | null;
  reason?: string | null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One signed document, once. The claim makes the second event, a redelivery and a retry harmless; a failure leaves the claim for the retry. */
export async function handleAcceptance(ctx: PluginContext, companyId: string, acc: Acceptance): Promise<AcceptanceResult> {
  const canary = isCanaryRef(acc.clientRef);
  const claim = await claimAcceptance(ctx, {
    companyId,
    documentId: acc.documentId,
    firstEvent: acc.source === "deal" ? "deal.accepted" : "quote.accepted",
    quoteId: acc.quoteId,
    quoteNumber: acc.quoteNumber,
    dealId: acc.dealId,
    clientKind: acc.clientKind,
    clientRef: acc.clientRef,
    amountMinor: acc.amountMinor,
    currency: acc.currency,
    contentSha256: acc.contentSha256,
    auditHead: acc.auditHead,
    canary,
  });
  if (!claim.claimed) return { status: "duplicate", invoiceId: claim.row?.invoice_id ?? null };
  try {
    const decision = acc.quoteId || acc.quoteNumber ? await decideFromQuote(ctx, companyId, acc, claim.invoiceId) : await decideFromDeal(ctx, companyId, acc, claim.invoiceId);
    await announce(ctx, companyId, acc, decision, canary);
    const invoiceId = decision.status === "drafted" ? decision.invoice.id : decision.status === "already_invoiced" ? decision.invoiceId : null;
    const reason = decision.status === "drafted" ? null : decision.reason;
    await finishAcceptance(ctx, companyId, acc.documentId, { status: decision.status, invoiceId, reason });
    // Ids and the outcome only: no client, signer or amount in a log line.
    ctx.logger.info("Billing handled a signed document", { documentId: acc.documentId, outcome: decision.status, canary, first: acc.source });
    return { status: decision.status, invoiceId, reason };
  } catch (error) {
    await noteAcceptanceError(ctx, companyId, acc.documentId, message(error)).catch(() => undefined);
    throw error;
  }
}

/** CRM `deal.accepted` and `quote.accepted`: the same signature, so the same handler. */
export async function onSignedDocument(ctx: PluginContext, event: PluginEvent, source: AcceptanceSource): Promise<void> {
  const companyId = event.companyId;
  if (!companyId) return;
  const acc = parseAcceptance(source, event.payload);
  if (!acc) {
    ctx.logger.info("Billing ignored a signed-document hand-off that names no document", { event: event.eventType });
    return;
  }
  if (!(await billingOn(ctx, companyId))) return;
  await handleAcceptance(ctx, companyId, acc);
}
