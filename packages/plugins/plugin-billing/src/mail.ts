/**
 * Email through the Mailbox plugin (Peet's Gmail): invoices, quotes, credit
 * notes, statements and payment reminders.
 *
 * Billing enqueues `mail.send.requested` in its outbox under
 * `billing:mail:<kind>:<id>:<n>` (n = send number, so a retry after a
 * permanent failure gets a fresh key the Mailbox has not seen). The Mailbox
 * answers with `mail.send.result`; `settleMailResult` records it.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  enqueue,
  formatMoneyMinor,
  MAIL_EVENTS,
  PIB_PLUGINS,
  settleOutbox,
  type MailAddress,
  type MailAttachmentRef,
  type MailSendRequested,
  type MailSendResult,
} from "@partnersinbiz/pib-plugin-kit";
import { table } from "./db.js";
import { BillingError } from "./domain.js";
import { paymentLines, type DocView } from "./documents.js";

export type MailKind = "invoice" | "quote" | "credit_note" | "statement" | "reminder";

export const BILLING_LABELS = ["PiB/Invoices"];

export function mailKey(kind: MailKind, id: string, n: number): string {
  return `billing:mail:${kind}:${id}:${n}`;
}

export function parseMailKey(key: string): { kind: MailKind; id: string; n: number } | null {
  const match = /^billing:mail:([a-z_]+):(.+):(\d+)$/.exec(key);
  if (!match) return null;
  return { kind: match[1] as MailKind, id: match[2]!, n: Number(match[3]) };
}

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

export function isEmail(value: unknown): value is string {
  return typeof value === "string" && EMAIL_RE.test(value.trim());
}

/** "a@x.com, B <b@y.com>" → addresses (invalid entries dropped). */
export function parseAddresses(value: unknown): MailAddress[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;\n]+/) : [];
  const out: MailAddress[] = [];
  for (const item of items) {
    if (item && typeof item === "object" && isEmail((item as MailAddress).email)) {
      const address = item as MailAddress;
      out.push({ email: address.email.trim().toLowerCase(), name: address.name ?? null });
      continue;
    }
    const raw = String(item ?? "").trim();
    if (!raw) continue;
    const angle = /^(.*)<([^>]+)>\s*$/.exec(raw);
    const email = (angle ? angle[2]! : raw).trim().toLowerCase();
    if (!isEmail(email)) continue;
    const name = angle ? angle[1]!.trim().replace(/^"|"$/g, "") || null : null;
    if (!out.some((a) => a.email === email)) out.push({ email, name });
  }
  return out;
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (whole, name: string) => (name in vars ? vars[name]! : whole));
}

function paragraphs(textBody: string): string {
  return textBody
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

function wrap(inner: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a;max-width:600px">${inner}</div>`;
}

function eftTable(payment: Record<string, unknown> | null | undefined, reference: string): { html: string; text: string } {
  const lines = paymentLines(payment, reference);
  if (!lines.length) return { html: "", text: "" };
  const rows = lines
    .map((line) => {
      const at = line.indexOf(":");
      return `<tr><td style="padding:2px 16px 2px 0;color:#666">${esc(line.slice(0, at))}</td><td style="padding:2px 0"><strong>${esc(line.slice(at + 1).trim())}</strong></td></tr>`;
    })
    .join("");
  return {
    html: `<p style="margin:18px 0 6px;font-weight:600">EFT payment details</p><table style="border-collapse:collapse;font-size:14px">${rows}</table>`,
    text: `EFT payment details\n${lines.join("\n")}`,
  };
}

function day(value: string | null | undefined): string {
  return value ? String(value).slice(0, 10) : "";
}

function greeting(customer: Record<string, unknown>): string {
  const name = typeof customer.contactName === "string" && customer.contactName.trim()
    ? customer.contactName.trim()
    : typeof customer.name === "string" && customer.name.trim() ? customer.name.trim() : "there";
  return `Hi ${name.split(/\s+/)[0]},`;
}

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

function signOff(sender: Record<string, unknown>, signature?: string | null): string {
  return (signature && signature.trim()) || `Thank you,\n${typeof sender.name === "string" && sender.name ? sender.name : "Partners in Biz"}`;
}

/** The invoice email: amount, due date, EFT details and "reply with proof of payment". */
export function invoiceEmail(view: DocView, options: { hasAttachment: boolean; signature?: string | null }): EmailContent {
  const amount = formatMoneyMinor(view.outstandingMinor ?? view.totalMinor, view.currency);
  const due = day(view.dueAt);
  const intro = `${greeting(view.customer)}\n\n${options.hasAttachment ? "Please find" : "Here is"} invoice ${view.number} for ${amount}${due ? `, due on ${due}` : ""}.${options.hasAttachment ? " The PDF is attached." : ""}`;
  const how = `Please pay by EFT and use ${view.number} as the payment reference. When you have paid, reply to this email with your proof of payment.`;
  const eft = eftTable(view.payment, view.number);
  const lines = options.hasAttachment ? "" : view.lines.map((l) => `- ${l.description}: ${formatMoneyMinor(view.pricesIncludeVat ? l.grossMinor : l.netMinor, view.currency)}`).join("\n");
  const textBody = [intro, lines, how, eft.text, view.notes ?? "", signOff(view.sender, options.signature)].filter(Boolean).join("\n\n");
  const html = wrap(`${paragraphs(intro)}${lines ? paragraphs(lines) : ""}${paragraphs(how)}${eft.html}${view.notes ? `<div style="margin-top:16px">${paragraphs(view.notes)}</div>` : ""}<div style="margin-top:18px">${paragraphs(signOff(view.sender, options.signature))}</div>`);
  return { subject: `Invoice ${view.number} from ${String(view.sender.name ?? "Partners in Biz")}`, html, text: textBody };
}

export function quoteEmail(view: DocView, options: { hasAttachment: boolean; signature?: string | null }): EmailContent {
  const amount = formatMoneyMinor(view.totalMinor, view.currency);
  const until = day(view.dueAt);
  const intro = `${greeting(view.customer)}\n\n${options.hasAttachment ? "Please find" : "Here is"} quote ${view.number} for ${amount}${until ? `, valid until ${until}` : ""}.${options.hasAttachment ? " The PDF is attached." : ""}\n\nReply to this email to accept it or to ask a question.`;
  const textBody = [intro, signOff(view.sender, options.signature)].join("\n\n");
  return { subject: `Quote ${view.number} from ${String(view.sender.name ?? "Partners in Biz")}`, html: wrap(paragraphs(textBody)), text: textBody };
}

export function creditNoteEmail(view: DocView, options: { hasAttachment: boolean; signature?: string | null }): EmailContent {
  const amount = formatMoneyMinor(view.totalMinor, view.currency);
  const intro = `${greeting(view.customer)}\n\nWe have issued credit note ${view.number} for ${amount}${view.againstNumber ? ` against invoice ${view.againstNumber}` : ""}.${options.hasAttachment ? " The PDF is attached." : ""}`;
  const textBody = [intro, view.reason ? `Reason: ${view.reason}` : "", signOff(view.sender, options.signature)].filter(Boolean).join("\n\n");
  return { subject: `Credit note ${view.number}`, html: wrap(paragraphs(textBody)), text: textBody };
}

export function statementEmail(input: { customer: Record<string, unknown>; sender: Record<string, unknown>; from: string; to: string; dueMinor: number; currency: string; payment?: Record<string, unknown> | null; signature?: string | null; hasAttachment: boolean }): EmailContent {
  const intro = `${greeting(input.customer)}\n\n${input.hasAttachment ? "Attached is" : "Here is"} your statement for ${input.from} to ${input.to}. The amount due is ${formatMoneyMinor(input.dueMinor, input.currency)}.`;
  const reference = typeof input.customer.name === "string" ? input.customer.name : "your invoice numbers";
  const eft = eftTable(input.payment, reference);
  const textBody = [intro, "Please use the invoice numbers as payment references, and reply with proof of payment once paid.", eft.text, signOff(input.sender, input.signature)].filter(Boolean).join("\n\n");
  return {
    subject: `Statement from ${String(input.sender.name ?? "Partners in Biz")}`,
    html: wrap(`${paragraphs(intro)}${paragraphs("Please use the invoice numbers as payment references, and reply with proof of payment once paid.")}${eft.html}<div style="margin-top:18px">${paragraphs(signOff(input.sender, input.signature))}</div>`),
    text: textBody,
  };
}

export function reminderEmail(stage: { subject: string; body: string }, vars: Record<string, string>, payment: Record<string, unknown> | null | undefined, reference: string): EmailContent {
  const subject = renderTemplate(stage.subject, vars);
  const body = renderTemplate(stage.body, vars);
  const eft = eftTable(payment, reference);
  return { subject, html: wrap(`${paragraphs(body)}${eft.html}`), text: [body, eft.text].filter(Boolean).join("\n\n") };
}

export interface QueueMailInput {
  kind: MailKind;
  docId: string;
  seq: number;
  to: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  from?: string | null;
  content: EmailContent;
  attachments?: MailAttachmentRef[];
  clientKind?: string | null;
  clientRef?: string | null;
  threadId?: string | null;
  createdBy?: string | null;
}

/** Record the delivery and enqueue the request for the Mailbox. Returns the outbox key. */
export async function queueMail(ctx: PluginContext, companyId: string, input: QueueMailInput): Promise<string> {
  if (input.to.length === 0) throw new BillingError("No email address to send to");
  const key = mailKey(input.kind, input.docId, input.seq);
  const payload: MailSendRequested = {
    key,
    from: input.from ?? null,
    to: input.to,
    ...(input.cc?.length ? { cc: input.cc } : {}),
    ...(input.bcc?.length ? { bcc: input.bcc } : {}),
    subject: input.content.subject,
    html: input.content.html,
    text: input.content.text,
    attachments: input.attachments ?? [],
    threadId: input.threadId ?? null,
    context: {
      plugin: PIB_PLUGINS.billing,
      kind: input.kind,
      id: input.docId,
      clientKind: input.clientKind ?? null,
      clientRef: input.clientRef ?? null,
    },
    labels: BILLING_LABELS,
  };
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "deliveries")} (key, company_id, doc_kind, doc_id, seq, recipients, subject, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'queued', $8)
     ON CONFLICT (key) DO NOTHING`,
    [key, companyId, input.kind, input.docId, input.seq, JSON.stringify(input.to), input.content.subject, input.createdBy ?? null],
  );
  await enqueue(ctx, companyId, MAIL_EVENTS.sendRequested, payload as unknown as { key: string } & Record<string, unknown>);
  return key;
}

export interface DeliveryRow {
  key: string;
  company_id: string;
  doc_kind: MailKind;
  doc_id: string;
  seq: number;
  recipients: unknown;
  subject: string;
  status: "queued" | "sent" | "failed";
  error: string | null;
  message_id: string | null;
  thread_id: string | null;
  sent_at: unknown;
  created_at: unknown;
}

export async function getDelivery(ctx: PluginContext, key: string): Promise<DeliveryRow | null> {
  const rows = await ctx.db.query<DeliveryRow>(
    `SELECT key, company_id, doc_kind, doc_id, seq, recipients, subject, status, error, message_id, thread_id, sent_at, created_at
       FROM ${table(ctx, "deliveries")} WHERE key = $1`,
    [key],
  );
  return rows[0] ?? null;
}

export async function deliveriesFor(ctx: PluginContext, companyId: string, kind: MailKind, docId: string): Promise<DeliveryRow[]> {
  return ctx.db.query<DeliveryRow>(
    `SELECT key, company_id, doc_kind, doc_id, seq, recipients, subject, status, error, message_id, thread_id, sent_at, created_at
       FROM ${table(ctx, "deliveries")} WHERE company_id = $1 AND doc_kind = $2 AND doc_id = $3 ORDER BY created_at DESC`,
    [companyId, kind, docId],
  );
}

/**
 * Apply a `mail.send.result`. A transient failure only records the error
 * (the outbox keeps re-sending); `sent` and permanent failures settle the
 * outbox and the delivery. Returns the delivery when this call finished it.
 */
export async function settleMailResult(ctx: PluginContext, result: MailSendResult): Promise<{ delivery: DeliveryRow; status: "sent" | "failed" } | null> {
  if (!result?.key || result.context?.plugin !== PIB_PLUGINS.billing) return null;
  const delivery = await getDelivery(ctx, result.key);
  if (!delivery) return null;
  if (result.status === "failed" && !result.permanent) {
    await ctx.db.execute(
      `UPDATE ${table(ctx, "deliveries")} SET error = $2, updated_at = now() WHERE key = $1 AND status = 'queued'`,
      [result.key, String(result.error ?? "Sending failed; retrying")],
    );
    return null;
  }
  const status = result.status === "sent" ? "sent" : "failed";
  await settleOutbox(ctx, result.key, result as unknown as Record<string, unknown>, status === "sent" ? "done" : "failed");
  const res = await ctx.db.execute(
    `UPDATE ${table(ctx, "deliveries")}
        SET status = $2, error = $3, message_id = $4, thread_id = $5, sent_at = $6, updated_at = now()
      WHERE key = $1 AND status = 'queued'`,
    [
      result.key,
      status,
      status === "failed" ? String(result.error ?? "Sending failed") : null,
      result.messageId ?? null,
      result.threadId ?? null,
      status === "sent" ? result.sentAt ?? new Date().toISOString() : null,
    ],
  );
  if ((res.rowCount ?? 0) === 0) return null;
  return { delivery: { ...delivery, status }, status };
}

/** The outbox gave up (no answer for ~3 days): mark the delivery failed. */
export async function failStaleDeliveries(ctx: PluginContext): Promise<DeliveryRow[]> {
  const rows = await ctx.db.query<DeliveryRow & { last_error: string | null }>(
    `SELECT d.key, d.company_id, d.doc_kind, d.doc_id, d.seq, d.recipients, d.subject, d.status, d.error, d.message_id, d.thread_id,
            d.sent_at, d.created_at, o.last_error
       FROM ${table(ctx, "deliveries")} d
       JOIN ${table(ctx, "outbox")} o ON o.key = d.key
      WHERE d.status = 'queued' AND o.status = 'failed'`,
  );
  const out: DeliveryRow[] = [];
  for (const row of rows) {
    const res = await ctx.db.execute(
      `UPDATE ${table(ctx, "deliveries")} SET status = 'failed', error = $2, updated_at = now() WHERE key = $1 AND status = 'queued'`,
      [row.key, row.last_error ?? "The Mailbox did not answer. Check that it is installed and connected."],
    );
    if ((res.rowCount ?? 0) > 0) out.push({ ...row, status: "failed" });
  }
  return out;
}
