/**
 * Proof of payment (EFT). A POP arrives by email (Mailbox `mail.received`)
 * or by upload. It is matched to an invoice deterministically — the email
 * thread of an invoice we sent, an invoice number in the subject, snippet or
 * file names, or the only open invoice of a known sender — and the invoice
 * waits on verification. A person confirms it (then `settle()` runs) or
 * rejects it. Money is never recorded from an email alone.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createWorkIssue, formatMoneyMinor, PIB_PLUGINS, type MailReceived } from "@partnersinbiz/pib-plugin-kit";
import { invoiceBalance, invoiceBalances, refreshInvoiceStatus, type InvoiceBalance } from "./balances.js";
import type { BillingSettings } from "./config.js";
import { asObject, table } from "./db.js";
import { BillingError, isOpenStatus } from "./domain.js";
import { emitInvoiceItem } from "./openitems.js";
import { settle, type SettleResult } from "./settle.js";

export type MatchBasis = "thread" | "number" | "sender" | "upload" | "none";

/** "LUM-001" / "lum 1" / "LUM001" → "LUM-1"; null when it is not a document number. */
export function referenceKey(value: string): string | null {
  const match = /^([A-Za-z]{2,4})[\s_-]*0*(\d{1,6})$/.exec(String(value ?? "").trim());
  return match ? `${match[1]!.toUpperCase()}-${Number(match[2])}` : null;
}

/** Invoice-number-like references in free text (quote and credit-note numbers are skipped). */
export function findReferences(text: string): string[] {
  const out = new Set<string>();
  const re = /(?<![A-Za-z0-9]-)(?<![A-Za-z0-9])([A-Za-z]{2,4})[\s_-]?(\d{2,6})(?![0-9])/g;
  for (const match of String(text ?? "").matchAll(re)) {
    out.add(`${match[1]!.toUpperCase()}-${Number(match[2])}`);
  }
  return [...out];
}

/** Open invoices whose number appears in the text. */
export function matchByNumber<T extends { number: string }>(text: string, invoices: T[]): T[] {
  const refs = new Set(findReferences(text));
  if (refs.size === 0) return [];
  return invoices.filter((invoice) => {
    const key = referenceKey(invoice.number);
    return key != null && refs.has(key);
  });
}

export interface PopMatch {
  invoiceId: string | null;
  basis: MatchBasis;
  others: string[];
}

/**
 * Pick the invoice a POP belongs to. Order: the invoice thread we sent,
 * then invoice numbers in the text (first match wins, the rest are listed),
 * then the sender's only open invoice.
 */
export function choosePopInvoice(input: {
  threadInvoiceId?: string | null;
  text: string;
  open: Array<{ id: string; number: string; customerKind: string; customerRef: string }>;
  senderClients?: Array<{ kind: string; ref: string }>;
}): PopMatch {
  if (input.threadInvoiceId && input.open.some((invoice) => invoice.id === input.threadInvoiceId)) {
    return { invoiceId: input.threadInvoiceId, basis: "thread", others: [] };
  }
  const numbered = matchByNumber(input.text, input.open);
  if (numbered.length > 0) return { invoiceId: numbered[0]!.id, basis: "number", others: numbered.slice(1).map((i) => i.id) };
  const clients = input.senderClients ?? [];
  if (clients.length > 0) {
    const theirs = input.open.filter((invoice) => clients.some((c) => c.kind === invoice.customerKind && c.ref === invoice.customerRef));
    if (theirs.length === 1) return { invoiceId: theirs[0]!.id, basis: "sender", others: [] };
  }
  return { invoiceId: null, basis: "none", others: [] };
}

export interface PopRow {
  id: string;
  company_id: string;
  invoice_id: string | null;
  source: string;
  match_basis: string | null;
  status: string;
  amount_minor: number | string | null;
  reference: string | null;
  from_email: string | null;
  from_name: string | null;
  subject: string | null;
  snippet: string | null;
  mail_message_id: string | null;
  mail_thread_id: string | null;
  attachments: unknown;
  file_key: string | null;
  file_name: string | null;
  file_mime: string | null;
  issue_id: string | null;
  payment_id: string | null;
  reviewed_by: string | null;
  reviewed_at: unknown;
  reject_reason: string | null;
  received_at: unknown;
}

const POP_COLUMNS = `id, company_id, invoice_id, source, match_basis, status, amount_minor, reference, from_email, from_name, subject, snippet,
          mail_message_id, mail_thread_id, attachments, file_key, file_name, file_mime, issue_id, payment_id, reviewed_by, reviewed_at,
          reject_reason, received_at`;

export async function getPop(ctx: PluginContext, id: string): Promise<PopRow | null> {
  const rows = await ctx.db.query<PopRow>(`SELECT ${POP_COLUMNS} FROM ${table(ctx, "pops")} WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listPops(ctx: PluginContext, companyId: string, filter: { status?: string; invoiceIds?: string[] } = {}): Promise<PopRow[]> {
  const where = ["company_id = $1"];
  const params: unknown[] = [companyId];
  if (filter.status) {
    params.push(filter.status);
    where.push(`status = $${params.length}`);
  }
  if (filter.invoiceIds) {
    params.push(JSON.stringify(filter.invoiceIds));
    where.push(`invoice_id IN (SELECT jsonb_array_elements_text($${params.length}::jsonb))`);
  }
  return ctx.db.query<PopRow>(`SELECT ${POP_COLUMNS} FROM ${table(ctx, "pops")} WHERE ${where.join(" AND ")} ORDER BY received_at DESC LIMIT 500`, params);
}

export interface NewPop {
  companyId: string;
  invoiceId: string | null;
  source: "email" | "upload";
  basis: MatchBasis;
  amountMinor?: number | null;
  reference?: string | null;
  fromEmail?: string | null;
  fromName?: string | null;
  subject?: string | null;
  snippet?: string | null;
  mailMessageId?: string | null;
  mailThreadId?: string | null;
  attachments?: unknown[];
  fileKey?: string | null;
  fileName?: string | null;
  fileMime?: string | null;
  receivedAt?: string | null;
  others?: string[];
  createdBy?: string | null;
}

/**
 * Store a POP (idempotent per Gmail message), move the invoice to
 * "payment pending verification" and open a verification issue for a person.
 */
export async function recordPop(ctx: PluginContext, pop: NewPop, settings: BillingSettings): Promise<{ popId: string; created: boolean; issueId: string | null }> {
  const id = randomUUID();
  const res = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "pops")}
      (id, company_id, invoice_id, source, match_basis, status, amount_minor, reference, from_email, from_name, subject, snippet,
       mail_message_id, mail_thread_id, attachments, file_key, file_name, file_mime, received_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18)
     ON CONFLICT DO NOTHING`,
    [
      id,
      pop.companyId,
      pop.invoiceId,
      pop.source,
      pop.basis,
      pop.amountMinor ?? null,
      pop.reference ?? null,
      pop.fromEmail ?? null,
      pop.fromName ?? null,
      (pop.subject ?? "").slice(0, 500) || null,
      (pop.snippet ?? "").slice(0, 1000) || null,
      pop.mailMessageId ?? null,
      pop.mailThreadId ?? null,
      JSON.stringify(pop.attachments ?? []),
      pop.fileKey ?? null,
      pop.fileName ?? null,
      pop.fileMime ?? null,
      pop.receivedAt ?? new Date().toISOString(),
    ],
  );
  if ((res.rowCount ?? 0) === 0) {
    const rows = await ctx.db.query<{ id: string; issue_id: string | null }>(
      `SELECT id, issue_id FROM ${table(ctx, "pops")} WHERE company_id = $1 AND mail_message_id = $2`,
      [pop.companyId, pop.mailMessageId ?? ""],
    );
    return { popId: rows[0]?.id ?? id, created: false, issueId: rows[0]?.issue_id ?? null };
  }
  let balance: InvoiceBalance | null = null;
  if (pop.invoiceId) {
    await refreshInvoiceStatus(ctx, pop.invoiceId);
    balance = await invoiceBalance(ctx, pop.invoiceId);
    await emitInvoiceItem(ctx, pop.invoiceId);
  }
  const issueId = await openPopIssue(ctx, { ...pop, id }, balance, settings).catch((error) => {
    ctx.logger.info("POP verification issue not opened", { popId: id, error: error instanceof Error ? error.message : String(error) });
    return null;
  });
  return { popId: id, created: true, issueId };
}

async function openPopIssue(ctx: PluginContext, pop: NewPop & { id: string }, balance: InvoiceBalance | null, settings: BillingSettings): Promise<string> {
  const invoice = balance?.invoice ?? null;
  const owed = balance ? formatMoneyMinor(balance.outstandingMinor, invoice!.currency) : null;
  const claimed = pop.amountMinor ? formatMoneyMinor(pop.amountMinor, invoice?.currency ?? "ZAR") : null;
  const from = pop.fromEmail ? `${pop.fromName ? `${pop.fromName} ` : ""}<${pop.fromEmail}>` : "an upload";
  const title = invoice ? `Check proof of payment for ${invoice.number}` : `Match a proof of payment from ${pop.fromEmail ?? "an upload"}`;
  const lines = [
    `A proof of payment came in from ${from}${pop.subject ? ` ("${pop.subject}")` : ""}.`,
    invoice
      ? `It is linked to invoice ${invoice.number} (${owed} still owed)${pop.basis === "number" ? " by the invoice number it quotes" : pop.basis === "thread" ? " because it is a reply to that invoice" : pop.basis === "sender" ? " because it is the sender's only open invoice" : ""}.`
      : "No open invoice matched it. Open Billing → Payments → Proof of payment and pick the invoice.",
    claimed ? `The customer says they paid ${claimed}.` : "",
    pop.others?.length ? `It also mentions ${pop.others.length} other open invoice(s); check whether it covers them too.` : "",
    "",
    "Check the bank account. Only when the money is in:",
    invoice
      ? `- Mark this issue done to record ${claimed ?? owed} against ${invoice.number}, or use Confirm on the Billing page to enter a different amount.`
      : "- Confirm it on the Billing page once you have picked the invoice.",
    "- Cancel this issue to reject the proof of payment (the invoice goes back to unpaid).",
    "",
    "Billing never records a payment from an email alone.",
  ].filter((line) => line !== "");
  const issue = await createWorkIssue(ctx, {
    companyId: pop.companyId,
    title,
    description: lines.join("\n"),
    originKind: `plugin:${PIB_PLUGINS.billing}`,
    originId: pop.id,
    ...(settings.reviewerUserId ? { assigneeUserId: settings.reviewerUserId } : {}),
  });
  await ctx.db.execute(`UPDATE ${table(ctx, "pops")} SET issue_id = $2 WHERE id = $1`, [pop.id, issue.id]);
  await recordDecisionIssue(ctx, { issueId: issue.id, companyId: pop.companyId, kind: "pop", subjectKind: "pop", subjectId: pop.id, payload: { invoiceId: pop.invoiceId } });
  return issue.id;
}

export async function recordDecisionIssue(
  ctx: PluginContext,
  input: { issueId: string; companyId: string; kind: string; subjectKind: string; subjectId: string; payload?: Record<string, unknown> },
): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "decision_issues")} (issue_id, company_id, kind, subject_kind, subject_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (issue_id) DO NOTHING`,
    [input.issueId, input.companyId, input.kind, input.subjectKind, input.subjectId, JSON.stringify(input.payload ?? {})],
  );
}

/** A person confirms the money is in: settle() with the POP as source. */
export async function confirmPop(
  ctx: PluginContext,
  input: { companyId: string; popId: string; invoiceId?: string | null; amountMinor?: number | null; paidAt?: string | null; reference?: string | null; createdBy?: string | null },
  settings: BillingSettings,
): Promise<SettleResult> {
  const pop = await getPop(ctx, input.popId);
  if (!pop || pop.company_id !== input.companyId) throw new BillingError("Proof of payment was not found");
  if (pop.status === "rejected") throw new BillingError("This proof of payment was rejected");
  const invoiceId = input.invoiceId ?? pop.invoice_id;
  if (!invoiceId) throw new BillingError("Pick the invoice this proof of payment is for");
  if (invoiceId !== pop.invoice_id) {
    await ctx.db.execute(`UPDATE ${table(ctx, "pops")} SET invoice_id = $2, match_basis = 'manual' WHERE id = $1 AND status = 'pending'`, [pop.id, invoiceId]);
    if (pop.invoice_id) await refreshInvoiceStatus(ctx, pop.invoice_id);
  }
  const balance = await invoiceBalance(ctx, invoiceId);
  if (!balance || balance.invoice.company_id !== input.companyId) throw new BillingError("Invoice was not found");
  const amount = input.amountMinor ?? (pop.amount_minor != null ? Number(pop.amount_minor) : balance.outstandingMinor);
  if (!amount || amount <= 0) throw new BillingError("Enter the amount that was paid");
  return settle(ctx, {
    companyId: input.companyId,
    invoiceId,
    amountMinor: amount,
    sourceKey: `pop:${pop.id}`,
    source: "pop",
    popId: pop.id,
    paidAt: input.paidAt ?? null,
    method: "eft",
    reference: input.reference ?? pop.reference ?? pop.subject ?? null,
    createdBy: input.createdBy ?? null,
  }, settings);
}

export async function rejectPop(ctx: PluginContext, input: { companyId: string; popId: string; reason?: string | null; reviewedBy?: string | null }): Promise<{ status: string | null }> {
  const pop = await getPop(ctx, input.popId);
  if (!pop || pop.company_id !== input.companyId) throw new BillingError("Proof of payment was not found");
  if (pop.status === "confirmed") throw new BillingError("This proof of payment is already confirmed");
  await ctx.db.execute(
    `UPDATE ${table(ctx, "pops")} SET status = 'rejected', reject_reason = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1 AND status = 'pending'`,
    [pop.id, input.reason ?? null, input.reviewedBy ?? null],
  );
  if (!pop.invoice_id) return { status: null };
  const refreshed = await refreshInvoiceStatus(ctx, pop.invoice_id);
  await emitInvoiceItem(ctx, pop.invoice_id);
  return { status: refreshed?.status ?? null };
}

// ── Mailbox: inbound mail ──────────────────────────────────────────────────

const NOT_POP = new Set(["spam", "newsletter", "notification", "invoice_or_bill", "bank_statement", "lead"]);

export interface SenderLookup {
  /** CRM clients this address belongs to (contact, and the contact's companies). */
  clients: Array<{ kind: string; ref: string; name: string }>;
}

export async function lookupSender(ctx: PluginContext, companyId: string, email: string): Promise<SenderLookup> {
  const address = email.trim().toLowerCase();
  if (!address) return { clients: [] };
  const contacts = await ctx.db.query<{ id: string; name: string; account_ids: string[] | null }>(
    `SELECT id, name, account_ids FROM ${table(ctx, "crm_contacts")}
      WHERE company_id = $1 AND deleted = false AND $2 = ANY(SELECT lower(e) FROM unnest(emails) AS e)`,
    [companyId, address],
  );
  const clients: SenderLookup["clients"] = [];
  for (const contact of contacts) {
    clients.push({ kind: "contact", ref: contact.id, name: contact.name });
    for (const account of contact.account_ids ?? []) clients.push({ kind: "company", ref: account, name: "" });
  }
  const domain = address.split("@")[1] ?? "";
  if (domain && !/^(gmail|googlemail|outlook|hotmail|yahoo|icloud|live|me|mweb|telkomsa|vodamail)\./.test(domain)) {
    const companies = await ctx.db.query<{ id: string; name: string }>(
      `SELECT id, name FROM ${table(ctx, "crm_companies")} WHERE company_id = $1 AND deleted = false AND lower(domain) = $2`,
      [companyId, domain],
    );
    for (const company of companies) if (!clients.some((c) => c.kind === "company" && c.ref === company.id)) clients.push({ kind: "company", ref: company.id, name: company.name });
  }
  return { clients };
}

/** Is this inbound email a proof of payment for us? Deterministic, from triage + open invoice numbers. */
export function looksLikePop(mail: Pick<MailReceived, "triage" | "subject" | "snippet" | "attachments" | "replyTo">, openNumbers: Array<{ number: string }>): boolean {
  const category = mail.triage?.category ?? null;
  if (category === "proof_of_payment") return true;
  if (category && NOT_POP.has(category)) return false;
  const text = `${mail.subject ?? ""}\n${mail.snippet ?? ""}\n${(mail.attachments ?? []).map((a) => a.filename).join("\n")}`;
  return matchByNumber(text, openNumbers).length > 0;
}

export function mailText(mail: Pick<MailReceived, "subject" | "snippet" | "attachments">): string {
  return `${mail.subject ?? ""}\n${mail.snippet ?? ""}\n${(mail.attachments ?? []).map((a) => a.filename).join("\n")}`;
}

export function threadInvoiceId(mail: Pick<MailReceived, "replyTo">): string | null {
  const ctx = mail.replyTo;
  if (!ctx || ctx.plugin !== PIB_PLUGINS.billing) return null;
  if (ctx.kind === "invoice" || ctx.kind === "reminder") return ctx.id;
  return null;
}

/** Open invoices as matching candidates. */
export async function openInvoiceCandidates(ctx: PluginContext, companyId: string) {
  const open = await invoiceBalances(ctx, companyId, { openOnly: true });
  return open
    .filter((b) => isOpenStatus(b.invoice.status))
    .map((b) => ({ id: b.invoice.id, number: b.invoice.number, customerKind: b.invoice.customer_kind, customerRef: b.invoice.customer_ref, customerName: String(asObject(b.invoice.customer).name ?? "") }));
}
