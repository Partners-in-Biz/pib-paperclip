/**
 * Billing records limited to a person's own companies (access stage B-4, plan B-D6 on PAR-12581).
 *
 * Only under `enforce`, and only for a limited person whose grant is scope `linked`, does the guard hand a list of
 * companies to a handler: the CRM companies he manages, read from Billing's CRM copy (`listManagedCrmCompanyIds`).
 * A record is his when its customer resolves through the copy to one of them: a `company` customer is the CRM company
 * itself, a `contact` customer is his when any of the contact's `account_ids` is. A customer the copy does not know is
 * not his. Switch `off` and `report`, an owner, an admin or a grant with scope `all`: no limit (`null`), so nothing
 * here changes what anyone sees today.
 *
 * Before a scoped action runs, `customerRefusal` checks every record the call names (by its id parameter) and the
 * client or customer it names; lists filter their rows with `seesCustomer`. Which keys are scoped is decided in
 * `access-table.ts` (`SCOPED_ACTION_KEYS`); `CUSTOMER_RULES` must name the same keys (the access spec checks it).
 */
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { textArrayParam, type AccessCheck } from "@partnersinbiz/pib-plugin-kit";
import { table } from "./db.js";
import { followUpSubject } from "./notes.js";
import { ownerOf } from "./time.js";
import { optionalString, readClientScope } from "./util.js";

export interface CustomerScope {
  /** The CRM companies he manages. */
  companyIds: ReadonlySet<string>;
  /** The CRM contacts linked to one of them. */
  contactIds: ReadonlySet<string>;
}

/** One answer for "not his" and "not there", so a guessed id learns nothing. */
export const OUTSIDE_SCOPE = "Your access is limited to your own companies, and this is not one of them";
export const SCOPE_UNVERIFIED = "Cannot verify your access";

/** His companies and their contacts, or `null` when the call is not limited. */
export async function customerScopeOf(ctx: PluginContext, companyId: string | null | undefined, check: AccessCheck | undefined): Promise<CustomerScope | null> {
  const decision = check?.decision;
  if (!decision || decision.scope !== "linked") return null;
  const companyIds = new Set(decision.companyIds);
  if (!companyId || companyIds.size === 0) return { companyIds, contactIds: new Set() };
  const rows = await ctx.db.query<{ id: string }>(
    `SELECT id FROM ${ctx.db.namespace}.crm_contacts WHERE company_id = $1 AND deleted = false AND account_ids && ${textArrayParam(2)}`,
    [companyId, JSON.stringify([...companyIds])],
  );
  return { companyIds, contactIds: new Set(rows.map((row) => row.id)) };
}

/** Whether a customer is his; always true without a limit. */
export function seesCustomer(scope: CustomerScope | null, kind: unknown, ref: unknown): boolean {
  if (scope === null) return true;
  if (typeof ref !== "string" || !ref) return false;
  if (kind === "company") return scope.companyIds.has(ref);
  if (kind === "contact") return scope.contactIds.has(ref);
  return false;
}

/** This company's own invoices that are his (a partner's shared invoice never is). */
export async function visibleInvoiceIds(ctx: PluginContext, companyId: string, scope: CustomerScope): Promise<Set<string>> {
  const rows = await ctx.db.query<{ id: string; customer_kind: string; customer_ref: string }>(
    `SELECT id, customer_kind, customer_ref FROM ${table(ctx, "invoices")} WHERE company_id = $1`,
    [companyId],
  );
  return new Set(rows.filter((row) => seesCustomer(scope, row.customer_kind, row.customer_ref)).map((row) => row.id));
}

type RecordKind = "invoice" | "quote" | "creditNote" | "pop" | "link" | "timeEntry" | "recurring" | "subscription";
type Need = "required" | "optional";

/**
 * What one call names. A `required` id or client that is missing is refused (a list without it would be the whole
 * book); an `optional` one is checked when given.
 */
export type Subject =
  | { record: RecordKind; param: string; need?: Need }
  | { client: Need }
  /** `customerKind` + `customerRef` of a new invoice or quote. */
  | { customer: true }
  /** `kind` (invoice, quote, credit_note) + `id`. */
  | { document: true }
  /** An array of time entry ids. */
  | { timeEntries: string }
  /** `log-follow-up`: an invoice or a quote (a bill or a deal is not a customer record). */
  | { followUp: true }
  /** `stop-timer`: `entryId`, or the running timer of the person it stops. */
  | { runningTimer: true }
  /** `upload-url`: only a proof of payment upload (receipts and bills are company costs). */
  | { uploadPurpose: "pop" };

const invoice = (param = "invoiceId", need: Need = "required"): Subject => ({ record: "invoice", param, need });
const quote: Subject = { record: "quote", param: "quoteId" };
const pop: Subject = { record: "pop", param: "popId" };
const clientRequired: Subject = { client: "required" };
const clientOptional: Subject = { client: "optional" };

/**
 * The scoped Billing keys and what each call must name of his. A list key (`clientOptional` only) also filters its
 * rows in the handler. Everything else in Billing stays closed to a `linked` grant.
 */
export const CUSTOMER_RULES: Readonly<Record<string, readonly Subject[]>> = Object.freeze({
  // Lists: filtered in the handler; a client, when given, must be his.
  "billing.load": [clientOptional],
  "billing.open-invoices": [clientOptional],
  "billing.list-quotes": [clientOptional],
  "billing.list-credit-notes": [],
  "billing.pops": [],
  "billing.list-time": [clientOptional],
  "billing.list-recurring": [],
  "billing.retainers": [clientOptional],
  // One invoice.
  ...Object.fromEntries(
    [
      "invoice-html", "invoice-detail", "invoice-pdf", "invoice-payments", "add-line", "update-line", "remove-line", "update-invoice",
      "set-invoice-tax", "request-send", "request-pay", "request-payment-check", "request-reminder-send", "mark-sent", "cancel-invoice",
      "delete-draft-invoice", "record-payment", "create-credit-note", "apply-credit", "write-off", "record-refund", "create-payment-link",
      "payment-links", "register-pop",
    ].map((key) => [`billing.${key}`, [invoice()]]),
  ),
  "billing.document-pdf": [{ document: true }],
  "billing.retry-send": [{ document: true }],
  "billing.log-follow-up": [{ followUp: true }],
  "billing.bill-time": [invoice(), { timeEntries: "entryIds" }],
  "billing.create-recurring": [invoice("templateInvoiceId")],
  "billing.create-invoice": [{ customer: true }],
  "billing.upload-url": [{ uploadPurpose: "pop" }],
  // Quotes.
  ...Object.fromEntries(
    [
      "quote-html", "quote-detail", "add-quote-line", "update-quote-line", "remove-quote-line", "update-quote", "set-quote-status",
      "request-quote-send", "delete-draft-quote", "convert-quote",
    ].map((key) => [`billing.${key}`, [quote]]),
  ),
  "billing.create-quote": [{ customer: true }],
  // Credit notes, statements, customer credit.
  "billing.credit-note-pdf": [{ record: "creditNote", param: "creditNoteId" }],
  "billing.send-credit-note": [{ record: "creditNote", param: "creditNoteId" }],
  "billing.statement-pdf": [clientRequired],
  "billing.send-statement": [clientRequired],
  "billing.customer-credit": [clientRequired],
  // Proofs of payment and payment links.
  "billing.pop-file": [pop],
  "billing.reject-pop": [pop],
  "billing.confirm-pop": [pop, invoice("invoiceId", "optional")],
  "billing.link-pop": [pop, invoice()],
  "billing.cancel-payment-link": [{ record: "link", param: "linkId" }],
  // Time.
  "billing.start-timer": [clientRequired],
  "billing.log-time": [clientRequired],
  "billing.stop-timer": [{ runningTimer: true }],
  "billing.delete-time-entry": [{ record: "timeEntry", param: "entryId" }],
  // Recurring invoices and subscriptions.
  "billing.pause-recurring": [{ record: "recurring", param: "recurringId" }],
  "billing.resume-recurring": [{ record: "recurring", param: "recurringId" }],
  "billing.update-recurring": [{ record: "recurring", param: "recurringId" }, invoice("templateInvoiceId", "optional")],
  "billing.create-subscription": [clientRequired],
  "billing.set-subscription-status": [{ record: "subscription", param: "subscriptionId" }],
});

/** The customer of one record of this company, through its invoice where it has none of its own. */
function recordSql(ctx: PluginContext, kind: RecordKind): string {
  const t = (name: string) => table(ctx, name);
  const own = (name: string) => `SELECT customer_kind, customer_ref FROM ${t(name)} WHERE id = $1 AND company_id = $2`;
  const viaInvoice = (name: string, column: string) =>
    `SELECT i.customer_kind, i.customer_ref FROM ${t(name)} x JOIN ${t("invoices")} i ON i.id = x.${column} WHERE x.id = $1 AND x.company_id = $2 AND i.company_id = $2`;
  switch (kind) {
    case "invoice": return own("invoices");
    case "quote": return own("quotes");
    case "creditNote": return own("credit_notes");
    case "timeEntry": return own("time_entries");
    case "subscription": return own("subscriptions");
    case "pop": return viaInvoice("pops", "invoice_id");
    case "link": return viaInvoice("payment_links", "invoice_id");
    case "recurring": return viaInvoice("recurring_invoices", "template_invoice_id");
  }
}

type Customer = { customer_kind: string | null; customer_ref: string | null };

async function recordIsHis(ctx: PluginContext, companyId: string, scope: CustomerScope, kind: RecordKind, id: unknown): Promise<boolean> {
  if (typeof id !== "string" || !id.trim()) return false;
  const rows = await ctx.db.query<Customer>(recordSql(ctx, kind), [id.trim(), companyId]);
  return rows.length === 1 && seesCustomer(scope, rows[0]!.customer_kind, rows[0]!.customer_ref);
}

const given = (params: Record<string, unknown>, name: string) => params[name] !== undefined && params[name] !== null && params[name] !== "";

async function subjectIsHis(ctx: PluginContext, companyId: string, scope: CustomerScope, subject: Subject, params: Record<string, unknown>, context: PluginPerformActionContext): Promise<boolean> {
  if ("record" in subject) {
    if (!given(params, subject.param)) return subject.need === "optional";
    return recordIsHis(ctx, companyId, scope, subject.record, params[subject.param]);
  }
  if ("client" in subject) {
    const client = readClientScope(params);
    if (!client) return subject.client === "optional";
    return seesCustomer(scope, client.kind, client.id);
  }
  if ("customer" in subject) return seesCustomer(scope, optionalString(params, "customerKind"), optionalString(params, "customerRef"));
  if ("document" in subject) {
    const kind = optionalString(params, "kind");
    const record: RecordKind | null = kind === "invoice" ? "invoice" : kind === "quote" ? "quote" : kind === "credit_note" ? "creditNote" : null;
    return record !== null && recordIsHis(ctx, companyId, scope, record, params.id);
  }
  if ("timeEntries" in subject) {
    const raw = params[subject.timeEntries];
    if (!Array.isArray(raw)) return false;
    const ids = [...new Set(raw.map((id) => String(id).trim()).filter(Boolean))];
    if (ids.length === 0 || ids.length > 400) return false;
    const rows = await ctx.db.query<Customer>(
      `SELECT customer_kind, customer_ref FROM ${table(ctx, "time_entries")} WHERE company_id = $1 AND id IN (SELECT jsonb_array_elements_text($2::jsonb))`,
      [companyId, JSON.stringify(ids)],
    );
    return rows.length === ids.length && rows.every((row) => seesCustomer(scope, row.customer_kind, row.customer_ref));
  }
  if ("followUp" in subject) {
    const target = followUpSubject(params);
    if (target.kind === "invoice") return recordIsHis(ctx, companyId, scope, "invoice", target.id);
    if (target.kind === "quote") return recordIsHis(ctx, companyId, scope, "quote", target.id);
    return false;
  }
  if ("runningTimer" in subject) {
    if (given(params, "entryId")) return recordIsHis(ctx, companyId, scope, "timeEntry", params.entryId);
    const rows = await ctx.db.query<Customer>(
      `SELECT customer_kind, customer_ref FROM ${table(ctx, "time_entries")} WHERE company_id = $1 AND owner = $2 AND ended_at IS NULL`,
      [companyId, ownerOf(context, params)],
    );
    return rows.length > 0 && rows.every((row) => seesCustomer(scope, row.customer_kind, row.customer_ref));
  }
  return params.purpose === subject.uploadPurpose;
}

/**
 * Why a limited call may not run (`OUTSIDE_SCOPE`), or null. A key with no rule is refused: the guard only lets a
 * `linked` call reach a scoped key, so this is the backstop for a row marked scoped without a rule.
 */
export async function customerRefusal(
  ctx: PluginContext,
  companyId: string,
  key: string,
  params: Record<string, unknown>,
  context: PluginPerformActionContext,
  scope: CustomerScope,
): Promise<string | null> {
  const subjects = Object.hasOwn(CUSTOMER_RULES, key) ? CUSTOMER_RULES[key]! : null;
  if (!subjects) return OUTSIDE_SCOPE;
  for (const subject of subjects) {
    let his: boolean;
    try {
      his = await subjectIsHis(ctx, companyId, scope, subject, params, context);
    } catch {
      // A malformed client or follow-up subject: refused here rather than reaching the handler unchecked.
      his = false;
    }
    if (!his) return OUTSIDE_SCOPE;
  }
  return null;
}
