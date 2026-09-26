/**
 * Printable documents: tax invoices, quotes, credit notes and statements as
 * PDF specs for the kit's `renderDocumentPdf`, plus the plain names used for
 * files and emails. Pure: the worker loads the rows and stores the bytes.
 */
import { formatMoneyMinor, renderDocumentPdf, type PdfDocumentSpec } from "@partnersinbiz/pib-plugin-kit";
import { taxLabel, type TaxGroup } from "./money.js";
import type { TaxCode } from "@partnersinbiz/pib-plugin-kit";

export type DocKind = "invoice" | "quote" | "credit_note";

export interface DocLineView {
  description: string;
  quantity: number;
  unitAmountMinor: number;
  taxCode: TaxCode | null;
  rateBp: number;
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
}

export interface DocView {
  kind: DocKind;
  number: string;
  status: string;
  currency: string;
  issuedAt: string | null;
  /** Due date (invoice) or valid-until (quote). */
  dueAt: string | null;
  sender: Record<string, unknown>;
  customer: Record<string, unknown>;
  lines: DocLineView[];
  groups: TaxGroup[];
  subtotalMinor: number;
  vatMinor: number;
  totalMinor: number;
  pricesIncludeVat: boolean;
  legacy: boolean;
  paidMinor?: number;
  creditedMinor?: number;
  outstandingMinor?: number;
  payment?: Record<string, unknown> | null;
  notes?: string | null;
  /** Credit note: the invoice it credits. */
  againstNumber?: string | null;
  reason?: string | null;
}

const PAYMENT_FIELDS: Array<[string, string]> = [
  ["bankName", "Bank"],
  ["accountName", "Account name"],
  ["accountNumber", "Account number"],
  ["branchCode", "Branch code"],
  ["accountType", "Account type"],
  ["swift", "SWIFT"],
];

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function partyLines(party: Record<string, unknown>, fallbackName: string): string[] {
  const lines = [text(party.name) || fallbackName];
  const address = text(party.address);
  if (address) lines.push(...address.split(/\n+/).map((l) => l.trim()).filter(Boolean));
  if (text(party.email)) lines.push(text(party.email));
  if (text(party.phone)) lines.push(text(party.phone));
  if (text(party.vatNumber)) lines.push(`VAT no. ${text(party.vatNumber)}`);
  if (text(party.registrationNumber)) lines.push(`Reg. no. ${text(party.registrationNumber)}`);
  return lines;
}

export function paymentLines(payment: Record<string, unknown> | null | undefined, reference: string): string[] {
  if (!payment) return [];
  const out = PAYMENT_FIELDS.filter(([key]) => text(payment[key])).map(([key, label]) => `${label}: ${text(payment[key])}`);
  if (out.length === 0) return [];
  out.push(`Reference: ${reference}`);
  return out;
}

export function isVatRegistered(sender: Record<string, unknown>): boolean {
  return Boolean(text(sender.vatNumber));
}

export function docTitle(view: Pick<DocView, "kind" | "sender">): string {
  if (view.kind === "quote") return "Quote";
  if (view.kind === "credit_note") return isVatRegistered(view.sender) ? "Tax credit note" : "Credit note";
  return isVatRegistered(view.sender) ? "Tax invoice" : "Invoice";
}

function day(value: string | null | undefined): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value).slice(0, 10) : parsed.toISOString().slice(0, 10);
}

function stampFor(view: DocView): string | null {
  if (view.status === "draft") return "Draft";
  if (view.status === "paid") return "Paid";
  if (view.status === "cancelled") return "Void";
  if (view.status === "written_off") return "Written off";
  return null;
}

export function documentPdfSpec(view: DocView): PdfDocumentSpec {
  const money = (minor: number) => formatMoneyMinor(minor, view.currency);
  const details: Array<[string, string]> = [];
  if (view.issuedAt) details.push(["Date", day(view.issuedAt)]);
  if (view.dueAt) details.push([view.kind === "quote" ? "Valid until" : "Due", day(view.dueAt)]);
  if (view.kind === "invoice") details.push(["Reference", view.number]);
  if (view.kind === "credit_note" && view.againstNumber) details.push(["Credits invoice", view.againstNumber]);
  details.push(["Currency", view.currency]);
  const showVat = !view.legacy || view.vatMinor > 0;
  const columns = [
    { key: "description", label: "Description", width: 46 },
    { key: "quantity", label: "Qty", width: 7, align: "right" as const },
    { key: "unit", label: view.pricesIncludeVat ? "Unit (incl. VAT)" : "Unit", width: 15, align: "right" as const },
    ...(showVat && !view.legacy ? [{ key: "vat", label: "VAT", width: 14, align: "right" as const }] : []),
    { key: "amount", label: view.pricesIncludeVat ? "Amount (incl.)" : "Amount", width: 18, align: "right" as const },
  ];
  const rows = view.lines.map((line) => ({
    description: line.description,
    quantity: String(line.quantity),
    unit: money(line.unitAmountMinor),
    vat: line.rateBp > 0 ? `${line.rateBp / 100}%` : line.taxCode ? taxLabel(line.taxCode, 0) : "-",
    amount: money(view.pricesIncludeVat ? line.grossMinor : line.netMinor),
  }));
  const totals: PdfDocumentSpec["totals"] = [{ label: "Subtotal (excl. VAT)", value: money(view.subtotalMinor) }];
  if (showVat) {
    for (const group of view.groups) {
      if (group.vatMinor > 0 || !view.legacy) totals.push({ label: group.rateBp > 0 ? `VAT ${group.rateBp / 100}%` : taxLabel(group.taxCode, 0), value: money(group.vatMinor) });
    }
  }
  totals.push({ label: "Total", value: money(view.totalMinor), bold: true });
  if (view.kind === "invoice") {
    if ((view.paidMinor ?? 0) > 0) totals.push({ label: "Paid", value: money(-(view.paidMinor ?? 0)) });
    if ((view.creditedMinor ?? 0) > 0) totals.push({ label: "Credited", value: money(-(view.creditedMinor ?? 0)) });
    if (view.outstandingMinor != null && view.status !== "draft") totals.push({ label: "Balance due", value: money(view.outstandingMinor), bold: true });
  }
  const sections: NonNullable<PdfDocumentSpec["sections"]> = [];
  if (view.kind === "invoice") {
    const pay = paymentLines(view.payment, view.number);
    if (pay.length) {
      sections.push({ heading: "Payment details (EFT)", lines: pay });
      sections.push({ heading: "Proof of payment", lines: [`Use ${view.number} as your payment reference, then reply to our email with your proof of payment.`] });
    }
  }
  if (view.kind === "credit_note" && view.reason) sections.push({ heading: "Reason", lines: [view.reason] });
  if (view.notes) sections.push({ heading: "Notes", lines: [view.notes] });
  const footerParts = [text(view.sender.name), text(view.sender.vatNumber) ? `VAT ${text(view.sender.vatNumber)}` : "", text(view.sender.registrationNumber) ? `Reg ${text(view.sender.registrationNumber)}` : ""].filter(Boolean);
  return {
    title: docTitle(view),
    number: view.number,
    details,
    parties: [
      { heading: "From", lines: partyLines(view.sender, "Partners in Biz") },
      { heading: view.kind === "quote" ? "Prepared for" : "Bill to", lines: partyLines(view.customer, "Customer") },
    ],
    columns,
    rows,
    totals,
    sections,
    footer: footerParts.join(" · ") || null,
    stamp: stampFor(view),
  };
}

export async function renderDocument(view: DocView): Promise<Uint8Array> {
  return renderDocumentPdf(documentPdfSpec(view));
}

export function docFileName(view: Pick<DocView, "kind" | "number">): string {
  const label = view.kind === "quote" ? "Quote" : view.kind === "credit_note" ? "Credit-note" : "Invoice";
  return `${label}-${view.number.replace(/[^A-Za-z0-9-]/g, "")}.pdf`;
}

// ── Statements ──────────────────────────────────────────────────────────────

export interface StatementEntry {
  date: string;
  kind: "invoice" | "payment" | "credit_note" | "write_off";
  reference: string;
  description: string;
  debitMinor: number;
  creditMinor: number;
}

export interface StatementView {
  currency: string;
  from: string;
  to: string;
  sender: Record<string, unknown>;
  customer: Record<string, unknown>;
  openingMinor: number;
  entries: StatementEntry[];
  ageing: { current: number; d30: number; d60: number; d90: number; d90plus: number };
  payment?: Record<string, unknown> | null;
}

/** Entries in date order with a running balance. */
export function statementRows(view: StatementView): Array<StatementEntry & { balanceMinor: number }> {
  let balance = view.openingMinor;
  return [...view.entries]
    .sort((a, b) => a.date.localeCompare(b.date) || (a.kind === "invoice" ? -1 : 1))
    .map((entry) => {
      balance += entry.debitMinor - entry.creditMinor;
      return { ...entry, balanceMinor: balance };
    });
}

export function statementPdfSpec(view: StatementView): PdfDocumentSpec {
  const money = (minor: number) => formatMoneyMinor(minor, view.currency);
  const rows = statementRows(view);
  const closing = rows.length ? rows[rows.length - 1]!.balanceMinor : view.openingMinor;
  const reference = text(view.customer.name) || "Statement";
  return {
    title: "Statement",
    number: null,
    details: [["Period", `${view.from} to ${view.to}`], ["Currency", view.currency]],
    parties: [
      { heading: "From", lines: partyLines(view.sender, "Partners in Biz") },
      { heading: "Account", lines: partyLines(view.customer, "Customer") },
    ],
    columns: [
      { key: "date", label: "Date", width: 14 },
      { key: "reference", label: "Reference", width: 16 },
      { key: "description", label: "Description", width: 34 },
      { key: "debit", label: "Charges", width: 12, align: "right" },
      { key: "credit", label: "Credits", width: 12, align: "right" },
      { key: "balance", label: "Balance", width: 14, align: "right" },
    ],
    rows: [
      { date: view.from, reference: "", description: "Opening balance", debit: "", credit: "", balance: money(view.openingMinor) },
      ...rows.map((row) => ({
        date: row.date,
        reference: row.reference,
        description: row.description,
        debit: row.debitMinor ? money(row.debitMinor) : "",
        credit: row.creditMinor ? money(row.creditMinor) : "",
        balance: money(row.balanceMinor),
      })),
    ],
    totals: [
      { label: "Current", value: money(view.ageing.current) },
      { label: "1-30 days", value: money(view.ageing.d30) },
      { label: "31-60 days", value: money(view.ageing.d60) },
      { label: "61-90 days", value: money(view.ageing.d90) },
      { label: "Over 90 days", value: money(view.ageing.d90plus) },
      { label: "Amount due", value: money(closing), bold: true },
    ],
    sections: paymentLines(view.payment, reference).length ? [{ heading: "Payment details (EFT)", lines: paymentLines(view.payment, reference) }] : [],
    footer: text(view.sender.name) || null,
  };
}
