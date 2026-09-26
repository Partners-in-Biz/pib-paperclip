/**
 * Payslip PDF (kit `renderDocumentPdf`). Shows what BCEA section 33 asks
 * for: employer and employee, period, earnings, deductions, net pay, hours
 * and rates, plus year-to-date figures, employer contributions and leave
 * balances. Bank and tax numbers are masked; no ID number is printed.
 */
import { renderDocumentPdf, type PdfDocumentSpec } from "@partnersinbiz/pib-plugin-kit";
import type { PayslipLine, PeriodTotals } from "./engine.js";
import type { LeaveBalance } from "./leave.js";
import { formatRand } from "./money.js";

export interface PayslipData {
  number: string;
  employer: { legalName: string; address: string; payeReference: string };
  employee: { name: string; employeeNumber: string; jobTitle: string | null; taxReferenceMask: string | null; bankName: string | null; accountMask: string | null };
  run: { number: string; periodStart: string; periodEnd: string; payDate: string; taxYear: string; kind: string };
  lines: PayslipLine[];
  totals: PeriodTotals;
  /** Year to date per line code, including this period. */
  ytdByCode: Record<string, number>;
  ytd: { grossMinor: number; taxableMinor: number; payeMinor: number; uifEmployeeMinor: number; netMinor: number };
  leave: LeaveBalance[];
  warnings?: string[];
}

function hours(centi: number | null | undefined): string {
  if (!centi) return "";
  return (centi / 100).toFixed(2).replace(/\.00$/, "");
}

function days(centi: number): string {
  return (centi / 100).toFixed(2).replace(/\.00$/, "");
}

/** Standard PDF fonts cannot draw "•" through the kit's pdfSafe; masks print with "*". */
function pdfMask(value: string | null): string | null {
  return value ? value.replace(/•/g, "*") : value;
}

export function payslipSpec(data: PayslipData): PdfDocumentSpec {
  const rows: Array<Record<string, string>> = [];
  const section = (title: string, lines: PayslipLine[], sign = 1) => {
    if (!lines.length) return;
    rows.push({ item: title.toUpperCase(), code: "", qty: "", rate: "", amount: "", ytd: "" });
    for (const line of lines) {
      rows.push({
        item: line.label,
        code: line.sarsCode ?? "",
        qty: hours(line.quantityCenti),
        rate: line.rateMinor ? formatRand(line.rateMinor) : "",
        amount: formatRand(sign * line.amountMinor),
        ytd: data.ytdByCode[line.code] != null ? formatRand(sign * data.ytdByCode[line.code]!) : "",
      });
    }
  };
  const earnings = data.lines.filter((l) => l.section === "earning");
  const deductions = data.lines.filter((l) => l.section === "statutory" || l.section === "deduction");
  const employer = data.lines.filter((l) => l.section === "employer");
  section("Earnings", earnings);
  section("Deductions", deductions);

  const totalDeductions = data.totals.payeMinor + data.totals.uifEmployeeMinor + data.totals.deductionsMinor;
  const sections: PdfDocumentSpec["sections"] = [];
  if (employer.length) {
    sections.push({
      heading: "Employer contributions (not deducted from your pay)",
      lines: employer.map((l) => `${l.label}${l.sarsCode ? ` (${l.sarsCode})` : ""}: ${formatRand(l.amountMinor)}`),
    });
  }
  sections.push({
    heading: "Tax",
    lines: [
      `Taxable income this period: ${formatRand(data.totals.taxableIncomeMinor)}`,
      `Year to date: taxable ${formatRand(data.ytd.taxableMinor)}, PAYE ${formatRand(data.ytd.payeMinor)}, UIF ${formatRand(data.ytd.uifEmployeeMinor)}, gross ${formatRand(data.ytd.grossMinor)}`,
      ...(data.totals.medicalCreditMinor ? [`Medical tax credit used: ${formatRand(data.totals.medicalCreditMinor)}`] : []),
      ...(data.totals.retirementDeductionMinor ? [`Retirement fund deduction for tax: ${formatRand(data.totals.retirementDeductionMinor)}`] : []),
    ],
  });
  const leave = data.leave.filter((b) => b.type !== "unpaid");
  if (leave.length) {
    sections.push({ heading: "Leave balances (days)", lines: leave.map((b) => `${b.label}: ${days(b.balanceCenti)} available (${days(b.takenCenti)} taken)`) });
  }
  sections.push({
    heading: "Payment",
    lines: [
      data.employee.accountMask
        ? `Net pay ${formatRand(data.totals.netPayMinor)} paid into ${data.employee.bankName ?? "your bank account"} account ${pdfMask(data.employee.accountMask)}.`
        : `Net pay ${formatRand(data.totals.netPayMinor)}.`,
    ],
  });

  return {
    title: data.run.kind === "correction" ? "Payslip (correction)" : "Payslip",
    number: data.number,
    details: [
      ["Pay date", data.run.payDate],
      ["Period", `${data.run.periodStart} to ${data.run.periodEnd}`],
      ["Tax year", data.run.taxYear],
      ["Pay run", data.run.number],
    ],
    parties: [
      {
        heading: "Employer",
        lines: [data.employer.legalName || "Employer", ...(data.employer.address ? [data.employer.address] : []), ...(data.employer.payeReference ? [`PAYE ref ${data.employer.payeReference}`] : [])],
      },
      {
        heading: "Employee",
        lines: [
          data.employee.name,
          `Employee no. ${data.employee.employeeNumber}`,
          ...(data.employee.jobTitle ? [data.employee.jobTitle] : []),
          ...(data.employee.taxReferenceMask ? [`Tax number ${pdfMask(data.employee.taxReferenceMask)}`] : []),
        ],
      },
    ],
    columns: [
      { key: "item", label: "Item", width: 34 },
      { key: "code", label: "Code", width: 8 },
      { key: "qty", label: "Hours", width: 9, align: "right" },
      { key: "rate", label: "Rate", width: 14, align: "right" },
      { key: "amount", label: "This period", width: 17, align: "right" },
      { key: "ytd", label: "Year to date", width: 18, align: "right" },
    ],
    rows,
    totals: [
      { label: "Gross pay", value: formatRand(data.totals.grossMinor) },
      { label: "Total deductions", value: formatRand(totalDeductions) },
      { label: "Net pay", value: formatRand(data.totals.netPayMinor), bold: true },
    ],
    sections,
    footer: `${data.employer.legalName || "Payslip"} · ${data.number} · Confidential`,
  };
}

export function renderPayslip(data: PayslipData): Promise<Uint8Array> {
  return renderDocumentPdf(payslipSpec(data));
}
