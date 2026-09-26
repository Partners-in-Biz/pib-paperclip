/**
 * Journals Billing asks Accounting to post (`ledger.post.requested`).
 *
 * Builders are pure and use account roles only (Accounting maps roles to
 * its chart). Every payload is checked with `isBalanced` before it is
 * enqueued. Source keys are stable, so a retry never posts twice:
 * - `billing:invoice:<id>:issue`, `…:void` (reverseKey = issue), `…:write_off`
 * - `billing:payment:<id>` and `billing:payment:<id>:fx` (realised FX)
 * - `billing:credit_note:<id>:issue`
 * - `billing:bill:<id>:approve`, `billing:bill_payment:<id>`
 * - `billing:expense:<id>:v<n>` (and `…:v<n>:reverse` when edited)
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { enqueue, isBalanced, LEDGER_EVENTS, PIB_PLUGINS, type LedgerLine, type LedgerPostRequested, type TaxCode } from "@partnersinbiz/pib-plugin-kit";
import { BillingError } from "./domain.js";
import type { TaxGroup } from "./money.js";

type Client = { clientKind?: "company" | "contact" | null; clientRef?: string | null };

export function ymd(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value ?? "");
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString().slice(0, 10) : parsed.toISOString().slice(0, 10);
}

function clientOf(kind: string | null | undefined, ref: string | null | undefined): Client {
  if (!ref) return {};
  return { clientKind: kind === "contact" ? "contact" : "company", clientRef: ref };
}

function line(role: LedgerLine["role"], debitMinor: number, creditMinor: number, extra: Partial<LedgerLine> = {}): LedgerLine {
  return { role, debitMinor, creditMinor, ...extra };
}

function nonZero(lines: LedgerLine[]): LedgerLine[] {
  return lines.filter((l) => l.debitMinor > 0 || l.creditMinor > 0);
}

function request(input: Omit<LedgerPostRequested, "source"> & { kind: string; id: string }): LedgerPostRequested {
  const { kind, id, ...rest } = input;
  const payload: LedgerPostRequested = { ...rest, lines: nonZero(rest.lines), source: { plugin: PIB_PLUGINS.billing, kind, id } };
  if (!isBalanced(payload.lines)) throw new BillingError(`Journal ${payload.key} does not balance`);
  return payload;
}

function taxExtra(code: TaxCode | null, baseMinor: number): Partial<LedgerLine> {
  return code ? { taxCode: code, taxBaseMinor: baseMinor } : {};
}

export interface IssueInput {
  id: string;
  number: string;
  date: unknown;
  currency: string;
  fxRate?: number | null;
  customerKind: string;
  customerRef: string;
  customerName: string;
  totalMinor: number;
  groups: TaxGroup[];
}

/**
 * Invoice issued: Dr AR (total) / Cr revenue (net per VAT code) + Cr output
 * VAT (per code). Revenue and VAT lines both carry the VAT code and the net
 * as `taxBaseMinor`; VAT201 reads supplies from revenue lines and tax from
 * vat_output lines.
 */
export function invoiceIssueJournal(input: IssueInput): LedgerPostRequested {
  const client = clientOf(input.customerKind, input.customerRef);
  const lines: LedgerLine[] = [line("ar", input.totalMinor, 0, { ...client, memo: `${input.number} ${input.customerName}` })];
  for (const group of input.groups) {
    lines.push(line("revenue", 0, group.netMinor, { ...client, ...taxExtra(group.taxCode, group.netMinor) }));
    if (group.vatMinor > 0) lines.push(line("vat_output", 0, group.vatMinor, { ...client, ...taxExtra(group.taxCode ?? "za_std_15", group.netMinor) }));
  }
  return request({
    key: `billing:invoice:${input.id}:issue`,
    kind: "invoice",
    id: input.id,
    date: ymd(input.date),
    memo: `Invoice ${input.number} to ${input.customerName}`,
    currency: input.currency,
    fxRate: input.fxRate ?? null,
    lines,
  });
}

/** Void a sent invoice: reverse the issue journal (lines are the mirror, for receivers that post them). */
export function invoiceVoidJournal(issue: LedgerPostRequested, input: { id: string; number: string; date: unknown }): LedgerPostRequested {
  return request({
    key: `billing:invoice:${input.id}:void`,
    kind: "invoice",
    id: input.id,
    date: ymd(input.date),
    memo: `Void invoice ${input.number}`,
    currency: issue.currency,
    fxRate: issue.fxRate ?? null,
    lines: issue.lines.map((l) => ({ ...l, debitMinor: l.creditMinor, creditMinor: l.debitMinor })),
    reverseKey: issue.key,
  });
}

export interface PaymentInput {
  id: string;
  invoiceNumber: string;
  date: unknown;
  currency: string;
  fxRate?: number | null;
  amountMinor: number;
  customerKind: string;
  customerRef: string;
  bankTxId?: string | null;
  bankAccountRole?: "bank" | "cash";
  /** The bank account Accounting matched the line on (so the line reconciles). */
  bankAccountCode?: string | null;
  method: string;
  reference?: string | null;
  /** Appended to the key, e.g. `bank:<txId>` when a payment is re-posted against its bank line. */
  keySuffix?: string | null;
}

function bankSide(role: "bank" | "cash" | undefined, code: string | null | undefined): Partial<LedgerLine> & { role: LedgerLine["role"] } {
  return code ? { role: role ?? "bank", accountCode: code } : { role: role ?? "bank" };
}

/**
 * Payment received: Dr bank / Cr AR for the whole amount (an overpayment
 * leaves the customer in credit). From a bank match the bank line carries
 * the matched account code and `dimensions.bankTxId`.
 */
export function paymentJournal(input: PaymentInput): LedgerPostRequested {
  const client = clientOf(input.customerKind, input.customerRef);
  const dims: Record<string, string> = { invoice: input.invoiceNumber, method: input.method };
  if (input.bankTxId) dims.bankTxId = input.bankTxId;
  const memo = `Payment for ${input.invoiceNumber}${input.reference ? ` (${input.reference})` : ""}${input.bankTxId ? ` bank tx ${input.bankTxId}` : ""}`;
  const bank = bankSide(input.bankAccountRole, input.bankAccountCode);
  return request({
    key: `billing:payment:${input.id}${input.keySuffix ? `:${input.keySuffix}` : ""}`,
    kind: "payment",
    id: input.id,
    date: ymd(input.date),
    memo,
    currency: input.currency,
    fxRate: input.fxRate ?? null,
    lines: [
      line(bank.role, input.amountMinor, 0, { ...bank, memo, dimensions: dims }),
      line("ar", 0, input.amountMinor, { ...client, memo, dimensions: dims }),
    ],
  });
}

/**
 * Realised FX on a foreign-currency receipt, in the book currency. AR was
 * raised at the issue rate; the payment cleared it at the payment rate, so
 * the difference goes to FX gain or loss. Null when there is none.
 */
export function realisedFxJournal(input: {
  paymentId: string;
  invoiceNumber: string;
  date: unknown;
  bookCurrency: string;
  allocatedMinor: number;
  issueRate: number;
  paymentRate: number;
  customerKind: string;
  customerRef: string;
}): LedgerPostRequested | null {
  const atIssue = Math.round(input.allocatedMinor * input.issueRate);
  const atPayment = Math.round(input.allocatedMinor * input.paymentRate);
  const diff = atPayment - atIssue;
  if (diff === 0 || !Number.isFinite(diff)) return null;
  const client = clientOf(input.customerKind, input.customerRef);
  const memo = `Realised FX on ${input.invoiceNumber}`;
  const lines = diff > 0
    ? [line("ar", diff, 0, { ...client, memo }), line("fx_gain", 0, diff, { memo })]
    : [line("fx_loss", -diff, 0, { memo }), line("ar", 0, -diff, { ...client, memo })];
  return request({
    key: `billing:payment:${input.paymentId}:fx`,
    kind: "payment",
    id: input.paymentId,
    date: ymd(input.date),
    memo,
    currency: input.bookCurrency,
    fxRate: null,
    lines,
  });
}

/** Credit note: reverse revenue and output VAT in proportion to the invoice's VAT groups, Cr AR. */
export function creditNoteJournal(input: {
  id: string;
  number: string;
  invoiceNumber: string;
  date: unknown;
  currency: string;
  fxRate?: number | null;
  amountMinor: number;
  customerKind: string;
  customerRef: string;
  split: TaxGroup[];
}): LedgerPostRequested {
  const client = clientOf(input.customerKind, input.customerRef);
  const lines: LedgerLine[] = [];
  for (const group of input.split) {
    lines.push(line("revenue", group.netMinor, 0, { ...client, ...taxExtra(group.taxCode, group.netMinor) }));
    if (group.vatMinor > 0) lines.push(line("vat_output", group.vatMinor, 0, { ...client, ...taxExtra(group.taxCode ?? "za_std_15", group.netMinor) }));
  }
  lines.push(line("ar", 0, input.amountMinor, { ...client, memo: `${input.number} against ${input.invoiceNumber}` }));
  return request({
    key: `billing:credit_note:${input.id}:issue`,
    kind: "credit_note",
    id: input.id,
    date: ymd(input.date),
    memo: `Credit note ${input.number} against ${input.invoiceNumber}`,
    currency: input.currency,
    fxRate: input.fxRate ?? null,
    lines,
  });
}

/**
 * Write off what is left on an invoice: Dr bad debts (net) + Dr output VAT
 * (the VAT share, with its code and tax base, for the VAT201 bad-debt
 * adjustment) / Cr AR. `split` is the outstanding amount spread over the
 * invoice's VAT groups (`splitByGroups`); without it all goes to bad debts.
 */
export function writeOffJournal(input: {
  invoiceId: string;
  invoiceNumber: string;
  date: unknown;
  currency: string;
  fxRate?: number | null;
  amountMinor: number;
  customerKind: string;
  customerRef: string;
  reason?: string | null;
  split?: TaxGroup[];
}): LedgerPostRequested {
  const client = clientOf(input.customerKind, input.customerRef);
  const memo = `Write-off ${input.invoiceNumber}${input.reason ? `: ${input.reason}` : ""}`;
  const groups = input.split && input.split.reduce((a, g) => a + g.grossMinor, 0) === input.amountMinor ? input.split : null;
  const lines: LedgerLine[] = [];
  if (groups) {
    const net = groups.reduce((a, g) => a + g.netMinor, 0);
    lines.push(line("bad_debts", net, 0, { memo }));
    for (const group of groups) {
      if (group.vatMinor > 0) lines.push(line("vat_output", group.vatMinor, 0, { ...client, memo, ...taxExtra(group.taxCode ?? "za_std_15", group.netMinor) }));
    }
  } else {
    lines.push(line("bad_debts", input.amountMinor, 0, { memo }));
  }
  lines.push(line("ar", 0, input.amountMinor, { ...client, memo }));
  return request({
    key: `billing:invoice:${input.invoiceId}:write_off`,
    kind: "invoice",
    id: input.invoiceId,
    date: ymd(input.date),
    memo,
    currency: input.currency,
    fxRate: input.fxRate ?? null,
    lines,
  });
}

export interface BillJournalLine {
  category: string;
  taxCode: TaxCode | null;
  netMinor: number;
  vatMinor: number;
}

/** Bill approved: Dr expense:<category> (net) + Dr input VAT / Cr AP (total). */
export function billJournal(input: {
  id: string;
  supplierName: string;
  supplierReference?: string | null;
  date: unknown;
  currency: string;
  fxRate?: number | null;
  totalMinor: number;
  lines: BillJournalLine[];
  supplierKind?: string | null;
  supplierRef?: string | null;
}): LedgerPostRequested {
  const supplier = input.supplierRef ? clientOf(input.supplierKind, input.supplierRef) : {};
  const memo = `Bill ${input.supplierReference ?? ""} from ${input.supplierName}`.replace(/\s+/g, " ").trim();
  const byCategory = new Map<string, { net: number; vat: Map<string, { vat: number; base: number }> }>();
  for (const l of input.lines) {
    const entry = byCategory.get(l.category) ?? { net: 0, vat: new Map() };
    entry.net += l.netMinor;
    if (l.vatMinor > 0) {
      const code = l.taxCode ?? "za_std_15";
      const vat = entry.vat.get(code) ?? { vat: 0, base: 0 };
      vat.vat += l.vatMinor;
      vat.base += l.netMinor;
      entry.vat.set(code, vat);
    }
    byCategory.set(l.category, entry);
  }
  const lines: LedgerLine[] = [];
  const vatTotals = new Map<string, { vat: number; base: number }>();
  for (const [category, entry] of byCategory) {
    lines.push(line(`expense:${category}`, entry.net, 0, { memo }));
    for (const [code, v] of entry.vat) {
      const total = vatTotals.get(code) ?? { vat: 0, base: 0 };
      total.vat += v.vat;
      total.base += v.base;
      vatTotals.set(code, total);
    }
  }
  for (const [code, v] of vatTotals) lines.push(line("vat_input", v.vat, 0, { taxCode: code as TaxCode, taxBaseMinor: v.base, memo }));
  lines.push(line("ap", 0, input.totalMinor, { ...supplier, memo }));
  return request({
    key: `billing:bill:${input.id}:approve`,
    kind: "bill",
    id: input.id,
    date: ymd(input.date),
    memo,
    currency: input.currency,
    fxRate: input.fxRate ?? null,
    lines,
  });
}

/** Bill paid: Dr AP / Cr bank. */
export function billPaymentJournal(input: {
  id: string;
  supplierName: string;
  date: unknown;
  currency: string;
  fxRate?: number | null;
  amountMinor: number;
  bankTxId?: string | null;
  bankAccountRole?: "bank" | "cash";
  bankAccountCode?: string | null;
  supplierKind?: string | null;
  supplierRef?: string | null;
}): LedgerPostRequested {
  const supplier = input.supplierRef ? clientOf(input.supplierKind, input.supplierRef) : {};
  const memo = `Payment to ${input.supplierName}${input.bankTxId ? ` bank tx ${input.bankTxId}` : ""}`;
  const dims = input.bankTxId ? { bankTxId: input.bankTxId } : undefined;
  const bank = bankSide(input.bankAccountRole, input.bankAccountCode);
  return request({
    key: `billing:bill_payment:${input.id}`,
    kind: "bill_payment",
    id: input.id,
    date: ymd(input.date),
    memo,
    currency: input.currency,
    fxRate: input.fxRate ?? null,
    lines: [
      line("ap", input.amountMinor, 0, { ...supplier, memo, ...(dims ? { dimensions: dims } : {}) }),
      line(bank.role, 0, input.amountMinor, { ...bank, memo, ...(dims ? { dimensions: dims } : {}) }),
    ],
  });
}

/** Where an expense was paid from → the credited account role. */
export function paidFromRole(paidFrom: string | null | undefined): LedgerLine["role"] {
  if (paidFrom === "cash") return "cash";
  if (paidFrom === "owner") return "owner_equity";
  return "bank";
}

/** Expense paid: Dr expense:<category> (net, or gross when VAT is not claimable) + Dr input VAT / Cr bank (or cash, or owner). */
export function expenseJournal(input: {
  id: string;
  version: number;
  description: string;
  vendor?: string | null;
  date: unknown;
  currency: string;
  fxRate?: number | null;
  amountMinor: number;
  vatMinor: number;
  vatClaimable: boolean;
  taxCode?: TaxCode | null;
  category: string;
  paidFrom?: string | null;
}): LedgerPostRequested {
  const vat = input.vatClaimable ? Math.max(0, Math.min(input.vatMinor, input.amountMinor)) : 0;
  const net = input.amountMinor - vat;
  const memo = `${input.description}${input.vendor ? ` (${input.vendor})` : ""}`;
  const lines: LedgerLine[] = [line(`expense:${input.category || "other"}`, net, 0, { memo })];
  if (vat > 0) lines.push(line("vat_input", vat, 0, { taxCode: input.taxCode ?? "za_std_15", taxBaseMinor: net, memo }));
  lines.push(line(paidFromRole(input.paidFrom), 0, input.amountMinor, { memo, dimensions: { paidFrom: input.paidFrom ?? "bank" } }));
  return request({
    key: `billing:expense:${input.id}:v${input.version}`,
    kind: "expense",
    id: input.id,
    date: ymd(input.date),
    memo,
    currency: input.currency,
    fxRate: input.fxRate ?? null,
    lines,
  });
}

/** Reverse an earlier expense version (the expense changed). */
export function reverseJournal(original: LedgerPostRequested, date: unknown): LedgerPostRequested {
  return request({
    key: `${original.key}:reverse`,
    kind: original.source.kind,
    id: original.source.id,
    date: ymd(date),
    memo: `Reverse ${original.memo}`,
    currency: original.currency,
    fxRate: original.fxRate ?? null,
    lines: original.lines.map((l) => ({ ...l, debitMinor: l.creditMinor, creditMinor: l.debitMinor })),
    reverseKey: original.key,
  });
}

/**
 * Enqueue a journal through the outbox (re-sent until Accounting answers).
 * Checks the balance once more; enqueueing the same key twice is a no-op.
 */
export async function postJournal(ctx: PluginContext, companyId: string, payload: LedgerPostRequested): Promise<boolean> {
  if (!isBalanced(payload.lines)) throw new BillingError(`Journal ${payload.key} does not balance`);
  const res = await enqueue(ctx, companyId, LEDGER_EVENTS.postRequested, payload as unknown as { key: string } & Record<string, unknown>);
  return res.created;
}

/** `billing:<kind>:<id>[:<event>]` → its parts. */
export function parseLedgerKey(key: string): { kind: string; id: string; event: string | null } | null {
  const match = /^billing:([a-z_]+):([^:]+)(?::(.+))?$/.exec(key);
  if (!match) return null;
  return { kind: match[1]!, id: match[2]!, event: match[3] ?? null };
}
