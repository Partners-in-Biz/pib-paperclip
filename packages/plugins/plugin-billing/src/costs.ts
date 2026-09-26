/**
 * Money out: suppliers' bills (accounts payable) and expenses with receipts.
 *
 * Bills: draft with lines and VAT codes → approve (a person, or an approval
 * issue for agents' drafts) → journal (expense + input VAT / AP) → pay
 * (settleBill; journal AP / bank). Suppliers are CRM companies or contacts,
 * or typed by hand.
 *
 * Expenses: recorded directly (journal expense + input VAT / bank) or drafted
 * from a receipt upload, read by Claude when a key is set, with Jev choosing
 * the category and whether VAT is claimable.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { correctDecision, createWorkIssue, getCrmCompany, getCrmContact, isModuleEnabled, PIB_PLUGINS, type TaxCode } from "@partnersinbiz/pib-plugin-kit";
import { anthropicConfig, defaultTaxCode, expenseCategories, jevFor, loadBilling, privateR2, type BillingSettings } from "./config.js";
import { getExpense, insertExpense, table, type ExpenseRow } from "./db.js";
import { BillingError, createExpense } from "./domain.js";
import { billJournal, postJournal, reverseJournal } from "./ledger.js";
import { assertTaxCode, computeDocument, isTaxCodeValue } from "./money.js";
import { emitBillItem } from "./openitems.js";
import { postBill, postExpense, type ExpenseForPosting } from "./posting.js";
import { decideExpense, expenseState, extractReceipt, ruleVatClaimable, type ReceiptFields } from "./receipts.js";
import { billColumns, billPaidMinor, BILL_COLUMNS, getBill, settleBill, type BillRow } from "./settle.js";
import { assertOwnKey, assertUploadable, documentKey, getObject, presignGet, presignPut } from "./storage.js";
import { actorLabel, currencyCode, dayOf, integer, optionalBoolean, optionalDate, optionalInteger, optionalString, requiredCompany, requiredString, requirePerson } from "./util.js";

// ── Bills ──────────────────────────────────────────────────────────────────

interface BillLineRow {
  id: string;
  description: string;
  quantity: number;
  unit_amount_minor: number | string;
  tax_code: string | null;
  category: string | null;
  net_minor: number | string | null;
  vat_minor: number | string | null;
  gross_minor: number | string | null;
}

export async function billLines(ctx: PluginContext, billId: string): Promise<BillLineRow[]> {
  return ctx.db.query<BillLineRow>(
    `SELECT id, description, quantity, unit_amount_minor, tax_code, category, net_minor, vat_minor, gross_minor
       FROM ${table(ctx, "bill_lines")} WHERE bill_id = $1 ORDER BY created_at, id`,
    [billId],
  );
}

async function requireBill(ctx: PluginContext, companyId: string, id: string): Promise<BillRow> {
  const bill = await getBill(ctx, id);
  if (!bill || bill.company_id !== companyId) throw new BillingError("Bill was not found");
  return bill;
}

function normCategory(value: unknown, settings: BillingSettings, fallback = "other"): string {
  const category = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  if (!category) return fallback;
  return expenseCategories(settings).includes(category) ? category : category.slice(0, 60);
}

async function supplierFrom(ctx: PluginContext, companyId: string, params: Record<string, unknown>): Promise<{ kind: "company" | "contact" | "text"; ref: string | null; name: string; email: string | null }> {
  const kind = (optionalString(params, "supplierKind") ?? "text") as "company" | "contact" | "text";
  if (!["company", "contact", "text"].includes(kind)) throw new BillingError("supplierKind is company, contact or text");
  const ref = optionalString(params, "supplierRef") ?? null;
  let name = optionalString(params, "supplierName") ?? "";
  let email = optionalString(params, "supplierEmail") ?? null;
  if (kind === "company" && ref) {
    const record = await getCrmCompany(ctx, ctx.db.namespace, companyId, ref).catch(() => null);
    if (record && !name) name = record.name;
  }
  if (kind === "contact" && ref) {
    const record = await getCrmContact(ctx, ctx.db.namespace, companyId, ref).catch(() => null);
    if (record) {
      if (!name) name = record.name;
      if (!email && record.emails[0]) email = record.emails[0];
    }
  }
  if (!name) throw new BillingError("supplierName is required");
  if (kind !== "text" && !ref) throw new BillingError("supplierRef is required for a CRM supplier");
  return { kind, ref: kind === "text" ? null : ref, name, email };
}

export async function createBill(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const { settings } = await loadBilling(ctx, companyId);
  const supplier = await supplierFrom(ctx, companyId, params);
  const id = randomUUID();
  const issueDate = optionalDate(params, "issueDate")?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const dueDate = optionalDate(params, "dueDate")?.slice(0, 10) ?? new Date(Date.parse(`${issueDate}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "bills")}
      (id, company_id, supplier_kind, supplier_ref, supplier_name, supplier_email, supplier_reference, currency, prices_include_vat,
       default_tax_code, category, issue_date, due_date, notes, source, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'manual', $15)`,
    [
      id,
      companyId,
      supplier.kind,
      supplier.ref,
      supplier.name,
      supplier.email,
      optionalString(params, "supplierReference") ?? null,
      currencyCode(params.currency ?? settings.defaultCurrency ?? "ZAR"),
      optionalBoolean(params, "pricesIncludeVat") ?? true,
      params.taxCode ? assertTaxCode(params.taxCode) : defaultTaxCode(settings),
      normCategory(params.category, settings),
      issueDate,
      dueDate,
      optionalString(params, "notes") ?? null,
      actorLabel(context),
    ],
  );
  return publicBill((await getBill(ctx, id))!, []);
}

async function recomputeBill(ctx: PluginContext, bill: BillRow): Promise<void> {
  const lines = await billLines(ctx, bill.id);
  const totals = computeDocument(
    lines.map((l) => ({ quantity: Number(l.quantity), unitAmountMinor: Number(l.unit_amount_minor), taxCode: l.tax_code ?? bill.default_tax_code ?? "za_out_of_scope" })),
    { pricesIncludeVat: Boolean(bill.prices_include_vat), taxRatePercent: 0 },
  );
  for (let i = 0; i < lines.length; i += 1) {
    const a = totals.lines[i]!;
    await ctx.db.execute(`UPDATE ${table(ctx, "bill_lines")} SET net_minor = $2, vat_minor = $3, gross_minor = $4 WHERE id = $1`, [lines[i]!.id, a.netMinor, a.vatMinor, a.grossMinor]);
  }
  await ctx.db.execute(
    `UPDATE ${table(ctx, "bills")} SET subtotal_minor = $2, vat_minor = $3, total_minor = $4, updated_at = now() WHERE id = $1`,
    [bill.id, totals.subtotalMinor, totals.vatMinor, totals.totalMinor],
  );
}

function assertDraftBill(bill: BillRow): void {
  if (bill.status !== "draft") throw new BillingError("Only a draft bill can change");
}

export async function addBillLine(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const bill = await requireBill(ctx, companyId, requiredString(params, "billId"));
  assertDraftBill(bill);
  const { settings } = await loadBilling(ctx, companyId);
  const quantity = params.quantity == null ? 1 : integer(params.quantity, "quantity");
  const unit = integer(params.unitAmountMinor, "unitAmountMinor");
  if (quantity < 1 || unit < 0) throw new BillingError("Quantity must be positive and the amount not negative");
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "bill_lines")} (id, company_id, bill_id, description, quantity, unit_amount_minor, tax_code, category)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      randomUUID(),
      companyId,
      bill.id,
      requiredString(params, "description"),
      quantity,
      unit,
      params.taxCode ? assertTaxCode(params.taxCode) : bill.default_tax_code ?? defaultTaxCode(settings),
      params.category ? normCategory(params.category, settings) : null,
    ],
  );
  await recomputeBill(ctx, bill);
  return billDetail(ctx, companyId, bill.id);
}

export async function removeBillLine(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const bill = await requireBill(ctx, companyId, requiredString(params, "billId"));
  assertDraftBill(bill);
  await ctx.db.execute(`DELETE FROM ${table(ctx, "bill_lines")} WHERE id = $1 AND bill_id = $2`, [requiredString(params, "lineId"), bill.id]);
  await recomputeBill(ctx, bill);
  return billDetail(ctx, companyId, bill.id);
}

export async function updateBill(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const bill = await requireBill(ctx, companyId, requiredString(params, "billId"));
  const { settings } = await loadBilling(ctx, companyId);
  const draftFields = ["supplierName", "supplierReference", "currency", "pricesIncludeVat", "category", "issueDate", "supplierKind", "supplierRef"].some((k) => k in params);
  if (draftFields) assertDraftBill(bill);
  let supplier = { kind: bill.supplier_kind as "company" | "contact" | "text", ref: bill.supplier_ref, name: bill.supplier_name, email: bill.supplier_email };
  if ("supplierKind" in params || "supplierRef" in params || "supplierName" in params) {
    supplier = await supplierFrom(ctx, companyId, { supplierKind: bill.supplier_kind, supplierRef: bill.supplier_ref, supplierName: bill.supplier_name, supplierEmail: bill.supplier_email, ...params });
  }
  await ctx.db.execute(
    `UPDATE ${table(ctx, "bills")}
        SET supplier_kind = $2, supplier_ref = $3, supplier_name = $4, supplier_email = $5, supplier_reference = $6, currency = $7,
            prices_include_vat = $8, category = $9, issue_date = $10, due_date = $11, notes = $12, updated_at = now()
      WHERE id = $1`,
    [
      bill.id,
      supplier.kind,
      supplier.ref,
      supplier.name,
      "supplierEmail" in params ? optionalString(params, "supplierEmail") ?? null : supplier.email,
      "supplierReference" in params ? optionalString(params, "supplierReference") ?? null : bill.supplier_reference,
      "currency" in params ? currencyCode(params.currency) : bill.currency,
      optionalBoolean(params, "pricesIncludeVat") ?? Boolean(bill.prices_include_vat),
      "category" in params ? normCategory(params.category, settings) : bill.category,
      "issueDate" in params ? optionalDate(params, "issueDate")?.slice(0, 10) ?? null : dayOf(bill.issue_date),
      "dueDate" in params ? optionalDate(params, "dueDate")?.slice(0, 10) ?? null : dayOf(bill.due_date),
      "notes" in params ? optionalString(params, "notes") ?? null : bill.notes,
    ],
  );
  const fresh = (await getBill(ctx, bill.id))!;
  if (fresh.status === "draft") await recomputeBill(ctx, fresh);
  else await emitBillItem(ctx, bill.id);
  return billDetail(ctx, companyId, bill.id);
}

/** Approve a bill: it becomes payable and posts to the books. */
export async function approveBill(ctx: PluginContext, companyId: string, billId: string): Promise<BillRow> {
  const bill = await requireBill(ctx, companyId, billId);
  if (bill.status !== "draft") throw new BillingError("Only a draft bill can be approved");
  if (Number(bill.total_minor) <= 0) throw new BillingError("Add the bill's lines before approving it");
  const { settings } = await loadBilling(ctx, companyId);
  await ctx.db.execute(
    `UPDATE ${table(ctx, "bills")} SET status = 'approved', approved_at = now(), pending_action = NULL, updated_at = now() WHERE id = $1 AND status = 'draft'`,
    [bill.id],
  );
  const fresh = (await getBill(ctx, bill.id))!;
  await postBill(ctx, fresh, await billLines(ctx, bill.id), settings);
  await emitBillItem(ctx, bill.id);
  return fresh;
}

export async function approveBillAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  requirePerson(context, "approving a bill");
  const companyId = requiredCompany(context);
  await approveBill(ctx, companyId, requiredString(params, "billId"));
  return billDetail(ctx, companyId, requiredString(params, "billId"));
}

/** Agents (and people who want a second pair of eyes) ask for approval on an issue. */
export async function requestBillApproval(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const bill = await requireBill(ctx, companyId, requiredString(params, "billId"));
  if (bill.status !== "draft") throw new BillingError("Only a draft bill can be approved");
  const { settings } = await loadBilling(ctx, companyId);
  const issue = await createWorkIssue(ctx, {
    companyId,
    title: `Approve bill from ${bill.supplier_name}${bill.supplier_reference ? ` (${bill.supplier_reference})` : ""}`,
    description: `Open Billing → Bills, check the bill's lines and VAT against the supplier's invoice, then mark this issue done. The plugin then approves the bill and posts it to the books. Cancel this issue to leave it as a draft.`,
    originKind: `plugin:${PIB_PLUGINS.billing}`,
    originId: bill.id,
    ...(settings.reviewerUserId ? { assigneeUserId: settings.reviewerUserId } : {}),
  });
  await ctx.db.execute(`UPDATE ${table(ctx, "bills")} SET approval_issue_id = $2, pending_action = 'approve', updated_at = now() WHERE id = $1`, [bill.id, issue.id]);
  return { billId: bill.id, issueId: issue.id };
}

export async function billByApproval(ctx: PluginContext, issueId: string): Promise<BillRow | null> {
  const rows = await ctx.db.query<BillRow>(`SELECT ${BILL_COLUMNS} FROM ${table(ctx, "bills")} WHERE approval_issue_id = $1`, [issueId]);
  return rows[0] ?? null;
}

export async function payBill(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const createdBy = requirePerson(context, "paying a bill");
  const companyId = requiredCompany(context);
  const bill = await requireBill(ctx, companyId, requiredString(params, "billId"));
  const { settings } = await loadBilling(ctx, companyId);
  const outstanding = Math.max(0, Number(bill.total_minor) - (await billPaidMinor(ctx, bill.id)));
  const amount = optionalInteger(params, "amountMinor") ?? outstanding;
  return settleBill(ctx, {
    companyId,
    billId: bill.id,
    amountMinor: amount,
    sourceKey: `manual:${optionalString(params, "paymentKey") ?? randomUUID()}`,
    source: "manual",
    paidAt: optionalDate(params, "paidAt") ?? null,
    method: optionalString(params, "method") ?? "eft",
    reference: optionalString(params, "reference") ?? null,
    createdBy,
  }, settings);
}

export async function cancelBill(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  requirePerson(context, "cancelling a bill");
  const companyId = requiredCompany(context);
  const bill = await requireBill(ctx, companyId, requiredString(params, "billId"));
  if (bill.status === "cancelled") return billDetail(ctx, companyId, bill.id);
  if ((await billPaidMinor(ctx, bill.id)) > 0) throw new BillingError("This bill has payments; it cannot be cancelled");
  const wasApproved = bill.status !== "draft";
  await ctx.db.execute(`UPDATE ${table(ctx, "bills")} SET status = 'cancelled', pending_action = NULL, updated_at = now() WHERE id = $1`, [bill.id]);
  // No reversal is sent while the company has Accounting switched off.
  if (wasApproved && bill.ledger_status && (await isModuleEnabled(ctx, companyId, PIB_PLUGINS.accounting))) {
    const lines = await billLines(ctx, bill.id);
    const original = billJournal({
      id: bill.id,
      supplierName: bill.supplier_name,
      supplierReference: bill.supplier_reference,
      date: bill.issue_date ?? bill.approved_at ?? new Date(),
      currency: bill.currency,
      fxRate: bill.fx_rate == null ? null : Number(bill.fx_rate),
      totalMinor: Number(bill.total_minor),
      supplierKind: bill.supplier_kind,
      supplierRef: bill.supplier_ref,
      lines: lines.map((l) => ({ category: l.category || bill.category, taxCode: (l.tax_code as TaxCode | null) ?? null, netMinor: Number(l.net_minor ?? 0), vatMinor: Number(l.vat_minor ?? 0) })),
    });
    await postJournal(ctx, companyId, reverseJournal(original, new Date()));
    await emitBillItem(ctx, bill.id);
  }
  return billDetail(ctx, companyId, bill.id);
}

export function publicBill(bill: BillRow, lines: BillLineRow[], paidMinor = 0) {
  const total = Number(bill.total_minor);
  return {
    id: bill.id,
    supplierKind: bill.supplier_kind,
    supplierRef: bill.supplier_ref,
    supplierName: bill.supplier_name,
    supplierEmail: bill.supplier_email,
    supplierReference: bill.supplier_reference,
    status: bill.status,
    currency: bill.currency,
    pricesIncludeVat: Boolean(bill.prices_include_vat),
    defaultTaxCode: bill.default_tax_code,
    category: bill.category,
    subtotalMinor: Number(bill.subtotal_minor),
    vatMinor: Number(bill.vat_minor),
    totalMinor: total,
    paidMinor,
    outstandingMinor: bill.status === "approved" || bill.status === "partially_paid" ? Math.max(0, total - paidMinor) : 0,
    issueDate: dayOf(bill.issue_date),
    dueDate: dayOf(bill.due_date),
    notes: bill.notes,
    source: bill.source,
    hasFile: Boolean(bill.file_key),
    fileName: bill.file_name,
    pendingAction: bill.pending_action,
    approvalIssueId: bill.approval_issue_id,
    ledgerStatus: bill.ledger_status,
    ledgerError: bill.ledger_error,
    journalNumber: bill.journal_number,
    lines: lines.map((l) => ({
      id: l.id,
      description: l.description,
      quantity: Number(l.quantity),
      unitAmountMinor: Number(l.unit_amount_minor),
      taxCode: l.tax_code,
      category: l.category,
      netMinor: Number(l.net_minor ?? 0),
      vatMinor: Number(l.vat_minor ?? 0),
      grossMinor: Number(l.gross_minor ?? 0),
    })),
  };
}

export async function billDetail(ctx: PluginContext, companyId: string, billId: string) {
  const bill = await requireBill(ctx, companyId, billId);
  const [lines, paid, payments] = await Promise.all([
    billLines(ctx, bill.id),
    billPaidMinor(ctx, bill.id),
    ctx.db.query<{ id: string; amount_minor: string | number; allocated_minor: string | number; paid_at: unknown; method: string; reference: string | null; bank_tx_id: string | null; ledger_status: string | null; journal_number: string | null }>(
      `SELECT id, amount_minor, allocated_minor, paid_at, method, reference, bank_tx_id, ledger_status, journal_number FROM ${table(ctx, "bill_payments")} WHERE bill_id = $1 ORDER BY paid_at`,
      [bill.id],
    ),
  ]);
  return {
    ...publicBill(bill, lines, paid),
    payments: payments.map((p) => ({ id: p.id, amountMinor: Number(p.amount_minor), allocatedMinor: Number(p.allocated_minor), paidAt: dayOf(p.paid_at), method: p.method, reference: p.reference, bankTxId: p.bank_tx_id, ledgerStatus: p.ledger_status, journalNumber: p.journal_number })),
  };
}

export async function listBills(ctx: PluginContext, companyId: string) {
  const rows = await ctx.db.query<BillRow & { paid_minor: string | number | null }>(
    `SELECT ${billColumns("b")},
            COALESCE((SELECT sum(p.allocated_minor) FROM ${table(ctx, "bill_payments")} p WHERE p.bill_id = b.id), 0) AS paid_minor
       FROM ${table(ctx, "bills")} b WHERE b.company_id = $1 ORDER BY b.created_at DESC LIMIT 500`,
    [companyId],
  );
  return rows.map((row) => publicBill(row, [], Number(row.paid_minor ?? 0)));
}

/** A supplier's invoice arrived by email from a known supplier: a draft bill for a person to complete. */
export async function draftBillFromEmail(
  ctx: PluginContext,
  companyId: string,
  input: { supplier: { kind: "company" | "contact"; ref: string; name: string }; fromEmail: string; subject: string; messageId: string; threadId: string; receivedAt: string; reference: string | null },
  settings: BillingSettings,
): Promise<{ billId: string; created: boolean }> {
  const id = randomUUID();
  const res = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "bills")}
      (id, company_id, supplier_kind, supplier_ref, supplier_name, supplier_email, supplier_reference, currency, prices_include_vat,
       default_tax_code, category, issue_date, due_date, notes, source, mail_message_id, mail_thread_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, 'other', $10, $11, $12, 'email', $13, $14, 'mailbox')
     ON CONFLICT DO NOTHING`,
    [
      id,
      companyId,
      input.supplier.kind,
      input.supplier.ref,
      input.supplier.name || input.fromEmail,
      input.fromEmail,
      input.reference,
      settings.defaultCurrency ?? "ZAR",
      defaultTaxCode(settings),
      input.receivedAt.slice(0, 10),
      new Date(Date.parse(input.receivedAt) + 30 * 86_400_000).toISOString().slice(0, 10),
      `From email: ${input.subject}`.slice(0, 500),
      input.messageId,
      input.threadId,
    ],
  );
  if ((res.rowCount ?? 0) === 0) return { billId: id, created: false };
  try {
    await createWorkIssue(ctx, {
      companyId,
      title: `Complete the bill from ${input.supplier.name || input.fromEmail}`,
      description: `A supplier invoice arrived by email ("${input.subject}"). Billing drafted a bill for it. Open Billing → Bills, add the lines and VAT from the attachment in the Mailbox, then approve it.`,
      originKind: `plugin:${PIB_PLUGINS.billing}`,
      originId: id,
      ...(settings.reviewerUserId ? { assigneeUserId: settings.reviewerUserId } : {}),
    });
  } catch (error) {
    ctx.logger.info("Draft bill issue not opened", { billId: id, error: error instanceof Error ? error.message : String(error) });
  }
  return { billId: id, created: true };
}

// ── Uploads (bills, receipts, POPs) ────────────────────────────────────────

export async function uploadUrl(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const purpose = requiredString(params, "purpose");
  if (!["receipt", "pop", "bill"].includes(purpose)) throw new BillingError("purpose is receipt, pop or bill");
  const mime = requiredString(params, "mime");
  const ext = assertUploadable(mime, Number(params.bytes));
  const { settings, resolver } = await loadBilling(ctx, companyId);
  const r2 = await privateR2(resolver, settings);
  if (!r2) throw new BillingError("Uploads need the private R2 bucket. Fill in the R2 section of the Billing settings.");
  const key = documentKey(r2, companyId, purpose as "receipt" | "pop" | "bill", optionalString(params, "fileName") ?? purpose, ext);
  return { uploadUrl: presignPut(r2, key), key, headers: { "Content-Type": mime }, expiresInSeconds: 900 };
}

export async function fileUrl(ctx: PluginContext, companyId: string, key: string | null, name: string | null) {
  if (!key) throw new BillingError("No file is attached");
  const { settings, resolver } = await loadBilling(ctx, companyId);
  const r2 = await privateR2(resolver, settings);
  if (!r2) throw new BillingError("The private R2 bucket is not configured");
  assertOwnKey(r2, companyId, key);
  return { url: presignGet(r2, key, 900, name ?? undefined) };
}

export async function attachBillFile(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const bill = await requireBill(ctx, companyId, requiredString(params, "billId"));
  const key = requiredString(params, "key");
  const { settings, resolver } = await loadBilling(ctx, companyId);
  const r2 = await privateR2(resolver, settings);
  if (!r2) throw new BillingError("The private R2 bucket is not configured");
  assertOwnKey(r2, companyId, key, "bill");
  await ctx.db.execute(`UPDATE ${table(ctx, "bills")} SET file_key = $2, file_name = $3, file_mime = $4, updated_at = now() WHERE id = $1`, [bill.id, key, optionalString(params, "fileName") ?? null, optionalString(params, "mime") ?? null]);
  return billDetail(ctx, companyId, bill.id);
}

// ── Expenses ───────────────────────────────────────────────────────────────

function forPosting(row: ExpenseRow): ExpenseForPosting {
  return {
    id: row.id,
    company_id: row.company_id,
    description: row.description,
    vendor: row.vendor ?? null,
    incurred_on: row.incurred_on,
    currency: row.currency,
    amount_minor: row.amount_minor,
    vat_minor: row.vat_minor ?? 0,
    vat_claimable: row.vat_claimable ?? false,
    tax_code: row.tax_code ?? null,
    category: row.category,
    paid_from: row.paid_from ?? "bank",
    fx_rate: row.fx_rate ?? null,
  };
}

export function publicExpense(expense: ExpenseRow) {
  const extraction = expense.extraction && typeof expense.extraction === "object" ? expense.extraction : typeof expense.extraction === "string" ? JSON.parse(expense.extraction) : null;
  return {
    id: expense.id,
    description: expense.description,
    amountMinor: Number(expense.amount_minor),
    currency: expense.currency,
    category: expense.category,
    incurredOn: dayOf(expense.incurred_on),
    vendor: expense.vendor ?? null,
    supplierKind: expense.supplier_kind ?? null,
    supplierRef: expense.supplier_ref ?? null,
    taxCode: expense.tax_code ?? null,
    vatMinor: Number(expense.vat_minor ?? 0),
    vatClaimable: Boolean(expense.vat_claimable),
    paidFrom: expense.paid_from ?? "bank",
    status: expense.status ?? "recorded",
    hasReceipt: Boolean(expense.receipt_key),
    receiptName: expense.receipt_name ?? null,
    extraction,
    needsReview: Boolean(expense.needs_review),
    billable: Boolean(expense.billable),
    customerKind: expense.customer_kind ?? null,
    customerRef: expense.customer_ref ?? null,
    ledgerStatus: expense.ledger_status ?? null,
    journalNumber: expense.journal_number ?? null,
  };
}

async function decideCategory(ctx: PluginContext, companyId: string, settings: BillingSettings, resolver: Awaited<ReturnType<typeof loadBilling>>["resolver"], expense: { id: string; vendor: string | null; description: string; amountMinor: number; currency: string; vatMinor: number }) {
  const categories = expenseCategories(settings);
  const decision = await decideExpense(
    ctx,
    companyId,
    await jevFor(resolver, settings),
    expense.id,
    expenseState({ ...expense, senderVatRegistered: Boolean(String((settings.sender as Record<string, unknown> | undefined)?.vatNumber ?? "").trim()) }),
    categories,
  );
  return { decision, categories };
}

/** `create-expense`: record a paid expense now (journal posted). Category and VAT come from the caller, Jev, or the rules. */
export async function createExpenseAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const { settings, resolver } = await loadBilling(ctx, companyId);
  const draft = createExpense({
    companyId,
    description: requiredString(params, "description"),
    amountMinor: integer(params.amountMinor, "amountMinor"),
    currency: optionalString(params, "currency"),
    category: optionalString(params, "category"),
    incurredOn: optionalString(params, "incurredOn") ?? null,
  });
  const vatMinor = optionalInteger(params, "vatMinor") ?? 0;
  if (vatMinor < 0 || vatMinor > draft.amountMinor) throw new BillingError("vatMinor must be between 0 and the amount");
  const registered = Boolean(String((settings.sender as Record<string, unknown> | undefined)?.vatNumber ?? "").trim());
  let category = params.category ? normCategory(params.category, settings) : draft.category;
  let vatClaimable = optionalBoolean(params, "vatClaimable");
  let needsReview = false;
  let jev: Record<string, unknown> | null = null;
  if (!params.category || vatClaimable == null) {
    const { decision } = await decideCategory(ctx, companyId, settings, resolver, { id: draft.id, vendor: optionalString(params, "vendor") ?? null, description: draft.description, amountMinor: draft.amountMinor, currency: draft.currency, vatMinor });
    if (Object.keys(decision.decisionIds).length) jev = { category: decision.category, categoryConfident: decision.categoryConfident, vatClaimable: decision.vatClaimable, vatConfident: decision.vatConfident, ids: decision.decisionIds };
    if (!params.category && decision.category) {
      if (decision.categoryConfident) category = decision.category;
      else needsReview = true;
    }
    if (vatClaimable == null) {
      vatClaimable = decision.vatClaimable != null && decision.vatConfident ? decision.vatClaimable && registered && vatMinor > 0 : ruleVatClaimable({ vatMinor, senderVatRegistered: registered, category });
    }
  }
  const row: ExpenseRow = {
    id: draft.id,
    company_id: companyId,
    description: draft.description,
    amount_minor: draft.amountMinor,
    currency: draft.currency,
    category,
    incurred_on: draft.incurredOn ?? new Date().toISOString().slice(0, 10),
    vendor: optionalString(params, "vendor") ?? null,
    supplier_kind: optionalString(params, "supplierKind") ?? null,
    supplier_ref: optionalString(params, "supplierRef") ?? null,
    tax_code: vatMinor > 0 ? (params.taxCode ? assertTaxCode(params.taxCode) : "za_std_15") : params.taxCode ? assertTaxCode(params.taxCode) : null,
    vat_minor: vatMinor,
    vat_claimable: Boolean(vatClaimable),
    paid_from: expensePaidFrom(params.paidFrom),
    status: "recorded",
    needs_review: needsReview,
    extraction: jev ? { fields: null, error: null, jev } : null,
    billable: optionalBoolean(params, "billable") ?? false,
    customer_kind: optionalString(params, "customerKind") ?? null,
    customer_ref: optionalString(params, "customerRef") ?? null,
    created_by: actorLabel(context),
  };
  await insertExpense(ctx, row);
  await postExpense(ctx, forPosting(row), 1, settings, null);
  return publicExpense((await getExpense(ctx, row.id)) ?? row);
}

function expensePaidFrom(value: unknown): string {
  const text = String(value ?? "bank").toLowerCase();
  return ["bank", "card", "cash", "owner"].includes(text) ? text : "bank";
}

/**
 * A receipt was uploaded: read it (Claude, when a key is set), let Jev pick
 * the category and VAT, and save a draft expense for a person to confirm —
 * or attach it to an existing expense.
 */
export async function receiptToExpense(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const key = requiredString(params, "key");
  const { settings, resolver } = await loadBilling(ctx, companyId);
  const r2 = await privateR2(resolver, settings);
  if (!r2) throw new BillingError("The private R2 bucket is not configured");
  assertOwnKey(r2, companyId, key, "receipt");
  const mime = requiredString(params, "mime");
  const fileName = optionalString(params, "fileName") ?? "receipt";
  const existingId = optionalString(params, "expenseId");
  let fields: ReceiptFields | null = null;
  let readError: string | null = null;
  const claude = await anthropicConfig(resolver, settings).catch(() => null);
  if (claude) {
    try {
      fields = await extractReceipt(claude, await getObject(r2, key));
    } catch (error) {
      readError = error instanceof Error ? error.message : String(error);
    }
  }
  if (existingId) {
    const expense = await getExpense(ctx, existingId);
    if (!expense || expense.company_id !== companyId) throw new BillingError("Expense was not found");
    await ctx.db.execute(
      `UPDATE ${table(ctx, "expenses")} SET receipt_key = $2, receipt_name = $3, receipt_mime = $4, extraction = $5::jsonb, updated_at = now() WHERE id = $1`,
      [expense.id, key, fileName, mime, JSON.stringify({ fields, error: readError })],
    );
    return publicExpense((await getExpense(ctx, expense.id))!);
  }
  const id = randomUUID();
  const amount = fields?.totalMinor ?? 0;
  const vat = fields?.vatMinor ?? 0;
  const description = fields?.vendor ? `${fields.vendor}` : fileName.replace(/\.[^.]+$/, "");
  const { decision } = await decideCategory(ctx, companyId, settings, resolver, { id, vendor: fields?.vendor ?? null, description, amountMinor: amount, currency: fields?.currency ?? settings.defaultCurrency ?? "ZAR", vatMinor: vat });
  const registered = Boolean(String((settings.sender as Record<string, unknown> | undefined)?.vatNumber ?? "").trim());
  const category = decision.category ?? "other";
  const row: ExpenseRow = {
    id,
    company_id: companyId,
    description,
    amount_minor: amount,
    currency: fields?.currency ?? settings.defaultCurrency ?? "ZAR",
    category,
    incurred_on: fields?.date ?? new Date().toISOString().slice(0, 10),
    vendor: fields?.vendor ?? null,
    tax_code: vat > 0 ? "za_std_15" : null,
    vat_minor: vat,
    vat_claimable: decision.vatClaimable != null && decision.vatConfident ? decision.vatClaimable && registered && vat > 0 : ruleVatClaimable({ vatMinor: vat, senderVatRegistered: registered, category }),
    paid_from: expensePaidFrom(params.paidFrom),
    status: "draft",
    receipt_key: key,
    receipt_name: fileName,
    receipt_mime: mime,
    extraction: { fields, error: readError, jev: { category: decision.category, categoryConfident: decision.categoryConfident, vatClaimable: decision.vatClaimable, vatConfident: decision.vatConfident, ids: decision.decisionIds } },
    needs_review: true,
    created_by: actorLabel(context),
  };
  await insertExpense(ctx, row);
  return publicExpense((await getExpense(ctx, id)) ?? row);
}

/** Change an expense. A recorded expense whose money fields change posts a new version (the old one reversed). */
export async function updateExpense(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const companyId = requiredCompany(context);
  const expense = await getExpense(ctx, requiredString(params, "expenseId"));
  if (!expense || expense.company_id !== companyId) throw new BillingError("Expense was not found");
  if (expense.status === "void") throw new BillingError("This expense was voided");
  const { settings } = await loadBilling(ctx, companyId);
  const next: ExpenseRow = { ...expense };
  if ("description" in params) next.description = requiredString(params, "description");
  if ("amountMinor" in params) next.amount_minor = integer(params.amountMinor, "amountMinor");
  if ("vatMinor" in params) next.vat_minor = integer(params.vatMinor, "vatMinor");
  if ("currency" in params) next.currency = currencyCode(params.currency);
  if ("category" in params) next.category = normCategory(params.category, settings);
  if ("incurredOn" in params) next.incurred_on = optionalDate(params, "incurredOn")?.slice(0, 10) ?? null;
  if ("vendor" in params) next.vendor = optionalString(params, "vendor") ?? null;
  if ("vatClaimable" in params) next.vat_claimable = Boolean(optionalBoolean(params, "vatClaimable"));
  if ("paidFrom" in params) next.paid_from = expensePaidFrom(params.paidFrom);
  if ("taxCode" in params) next.tax_code = params.taxCode ? assertTaxCode(params.taxCode) : null;
  if ("billable" in params) next.billable = Boolean(optionalBoolean(params, "billable"));
  if (Number(next.amount_minor) < 0 || Number(next.vat_minor ?? 0) < 0 || Number(next.vat_minor ?? 0) > Number(next.amount_minor)) {
    throw new BillingError("Amounts must be positive and VAT no more than the total");
  }
  if (Number(next.vat_minor ?? 0) > 0 && !isTaxCodeValue(next.tax_code)) next.tax_code = "za_std_15";
  const record = optionalBoolean(params, "record") === true || expense.status === "recorded";
  if (record && Number(next.amount_minor) <= 0) throw new BillingError("Enter the amount before saving the expense");
  next.status = record ? "recorded" : expense.status ?? "draft";
  next.needs_review = false;
  await ctx.db.execute(
    `UPDATE ${table(ctx, "expenses")}
        SET description = $2, amount_minor = $3, vat_minor = $4, currency = $5, category = $6, incurred_on = $7, vendor = $8,
            vat_claimable = $9, paid_from = $10, tax_code = $11, billable = $12, status = $13, needs_review = false, updated_at = now()
      WHERE id = $1`,
    [next.id, next.description, Number(next.amount_minor), Number(next.vat_minor ?? 0), next.currency, next.category, next.incurred_on ?? null, next.vendor ?? null, Boolean(next.vat_claimable), next.paid_from ?? "bank", next.tax_code ?? null, Boolean(next.billable), next.status],
  );
  const moneyChanged = ["amount_minor", "vat_minor", "currency", "category", "incurred_on", "vat_claimable", "paid_from", "tax_code"].some(
    (k) => String((expense as unknown as Record<string, unknown>)[k] ?? "") !== String((next as unknown as Record<string, unknown>)[k] ?? ""),
  );
  await recordCorrections(ctx, companyId, expense, next, context.actor.userId ?? null);
  const version = Number(expense.ledger_version ?? 0);
  if (record && (version === 0 || moneyChanged)) {
    await postExpense(ctx, forPosting(next), version + 1, settings, version > 0 ? forPosting(expense) : null);
  }
  return publicExpense((await getExpense(ctx, expense.id))!);
}

/** A person changed what Jev chose: log it as a correction (labelled data for tuning). */
async function recordCorrections(ctx: PluginContext, companyId: string, before: ExpenseRow, after: ExpenseRow, userId: string | null): Promise<void> {
  const raw = typeof before.extraction === "string" ? JSON.parse(before.extraction) : before.extraction;
  const jev = (raw && typeof raw === "object" ? (raw as { jev?: { category?: string | null; vatClaimable?: boolean | null; ids?: Record<string, string> } }).jev : null) ?? null;
  if (!jev?.ids) return;
  try {
    if (jev.ids.category && jev.category && after.category !== jev.category) await correctDecision(ctx, companyId, jev.ids.category, after.category, userId);
    if (jev.ids.vat_claimable && jev.vatClaimable != null && Boolean(after.vat_claimable) !== jev.vatClaimable) {
      await correctDecision(ctx, companyId, jev.ids.vat_claimable, after.vat_claimable ? "1" : "0", userId);
    }
  } catch (error) {
    ctx.logger.info("Decision correction not logged", { error: error instanceof Error ? error.message : String(error) });
  }
}

export async function voidExpense(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  requirePerson(context, "voiding an expense");
  const companyId = requiredCompany(context);
  const expense = await getExpense(ctx, requiredString(params, "expenseId"));
  if (!expense || expense.company_id !== companyId) throw new BillingError("Expense was not found");
  if (expense.status === "void") return publicExpense(expense);
  const { settings } = await loadBilling(ctx, companyId);
  await ctx.db.execute(`UPDATE ${table(ctx, "expenses")} SET status = 'void', updated_at = now() WHERE id = $1`, [expense.id]);
  const version = Number(expense.ledger_version ?? 0);
  if (version > 0) await postExpense(ctx, { ...forPosting(expense), amount_minor: 0 }, version + 1, settings, forPosting(expense));
  return publicExpense((await getExpense(ctx, expense.id))!);
}
