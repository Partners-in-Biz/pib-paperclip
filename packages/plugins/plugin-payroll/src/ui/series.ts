/**
 * Chart series and status tones for the Payroll page (pure, no React).
 * Charts only use run totals: no names, ID numbers or per-person pay.
 */

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

export interface RunTotalsLite {
  employeeCount: number;
  grossMinor: number;
  payeMinor: number;
  uifEmployeeMinor: number;
  uifEmployerMinor: number;
  sdlMinor: number;
  deductionsMinor: number;
  employerContributionsMinor: number;
  netPayMinor: number;
  employerCostMinor: number;
}

export interface RunLite {
  id: string;
  number: string;
  kind: string;
  status: string;
  payDate: string;
  totals: RunTotalsLite;
}

/** One tone scale: locked green, waiting for approval amber, calculated / approved / draft blue, cancelled or reversed grey. */
export function runTone(status: string): Tone {
  if (status === "locked") return "ok";
  if (status === "pending_approval") return "warn";
  if (status === "failed" || status === "error") return "bad";
  if (status === "draft" || status === "calculated" || status === "approved") return "info";
  return "neutral";
}

/** Leave requests, payslips and pay-run items. */
export function statusTone(status: string): Tone {
  if (["approved", "sent", "locked", "active", "ok", "posted", "reconciled"].includes(status)) return "ok";
  if (["pending", "pending_approval", "review"].includes(status)) return "warn";
  if (["failed", "error", "rejected", "declined", "blocked"].includes(status)) return "bad";
  if (["ready", "draft", "calculated", "queued", "scheduled"].includes(status)) return "info";
  return "neutral";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Cost of the last `limit` locked regular runs, oldest first, split into what
 * staff take home, PAYE + employee UIF, other deductions, and employer costs
 * (employer UIF, SDL and employer contributions). Without fringe benefits
 * the parts add up to the cost to company.
 */
export function costPerRun(runs: RunLite[], limit = 12) {
  return runs
    .filter((r) => r.status === "locked" && r.kind !== "reversal")
    .sort((a, b) => a.payDate.localeCompare(b.payDate))
    .slice(-limit)
    .map((r) => {
      const t = r.totals;
      const d = new Date(`${r.payDate}T12:00:00Z`);
      return {
        id: r.id,
        label: `${MONTHS[d.getUTCMonth()]}`,
        title: `${r.number} · paid ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
        values: {
          net: t.netPayMinor,
          tax: t.payeMinor + t.uifEmployeeMinor,
          deductions: t.deductionsMinor,
          employer: t.uifEmployerMinor + t.sdlMinor + t.employerContributionsMinor,
        },
        employerCostMinor: t.employerCostMinor,
        employeeCount: t.employeeCount,
      };
    });
}

/** Where the cost to company of one run goes. */
export function costSplit(t: RunTotalsLite): Array<{ key: string; label: string; value: number }> {
  return [
    { key: "net", label: "Net pay", value: t.netPayMinor },
    { key: "paye", label: "Income tax (PAYE)", value: t.payeMinor },
    { key: "uif", label: "UIF (employee and employer)", value: t.uifEmployeeMinor + t.uifEmployerMinor },
    { key: "sdl", label: "Skills levy (SDL)", value: t.sdlMinor },
    { key: "deductions", label: "Other deductions", value: t.deductionsMinor },
    { key: "employer", label: "Employer contributions", value: t.employerContributionsMinor },
  ].filter((s) => s.value > 0);
}

/** The EMP201 month to show on `today`: up to the 7th that is last month's (still due), after that this month's. */
export function emp201Month(today: string): string {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  if (d > 7) return today.slice(0, 7);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

/** Days from `today` to `due` (negative when past). */
export function daysUntil(today: string, due: string): number {
  return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** Share of a leave entitlement used (taken + pending) against what is left, 0–1. */
export function leaveUsed(b: { balanceCenti: number; takenCenti: number; pendingCenti: number }): { ratio: number; entitlementCenti: number } {
  const entitlementCenti = Math.max(0, b.balanceCenti + b.takenCenti);
  if (entitlementCenti <= 0) return { ratio: 0, entitlementCenti: 0 };
  return { ratio: Math.min(1, (b.takenCenti + b.pendingCenti) / entitlementCenti), entitlementCenti };
}

// ── Words people read ──────────────────────────────────────────────────────

/** "1 employee has" / "3 employees have". */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function ymd(value: string | null | undefined): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec((value ?? "").trim());
  if (!match) return null;
  const m = Number(match[2]);
  return m >= 1 && m <= 12 ? { y: Number(match[1]), m, d: Number(match[3]) } : null;
}

/**
 * A date range as people read it (the same style as pib-plugin-ui `formatDate`):
 * "1–30 Sep 2026", "25 Aug – 7 Sep 2026", "15 Dec 2026 – 14 Jan 2027", or one
 * date when both are the same day. Never 2026-09-01.
 */
export function periodText(start: string | null | undefined, end: string | null | undefined): string {
  const a = ymd(start);
  const b = ymd(end);
  const day = (p: { y: number; m: number; d: number }) => `${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
  if (!a && !b) return "–";
  if (!a || !b) return day((a ?? b)!);
  if (a.y === b.y && a.m === b.m && a.d === b.d) return day(a);
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${MONTHS[a.m - 1]} ${a.y}`;
  if (a.y === b.y) return `${a.d} ${MONTHS[a.m - 1]} – ${day(b)}`;
  return `${day(a)} – ${day(b)}`;
}

function sentence(value: string): string {
  const words = value.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "–";
}

const RUN_STATUS: Record<string, string> = {
  draft: "Draft",
  calculated: "Calculated",
  pending_approval: "Waiting for approval",
  approved: "Approved",
  locked: "Locked",
  reversed: "Reversed",
  cancelled: "Cancelled",
};

/** A pay run's status in plain words ("Waiting for approval"). */
export function runStatusLabel(status: string): string {
  return RUN_STATUS[status] ?? sentence(status);
}

const PAYSLIP_STATUS: Record<string, string> = { pending: "Not made yet", ready: "Ready", sending: "Sending", sent: "Emailed", failed: "Failed" };

export function payslipStatusLabel(status: string): string {
  return PAYSLIP_STATUS[status] ?? sentence(status);
}

const LEAVE_STATUS: Record<string, string> = { pending: "Waiting", approved: "Approved", rejected: "Declined", cancelled: "Cancelled" };

export function leaveStatusLabel(status: string): string {
  return LEAVE_STATUS[status] ?? sentence(status);
}

/** "Monthly", "Fortnightly", "Weekly"; a correction or reversal says so first. */
export function runKindText(run: { kind: string; frequency: string }): string {
  const frequency = sentence(run.frequency);
  if (run.kind === "correction") return `Correction · ${frequency.toLowerCase()}`;
  if (run.kind === "reversal") return `Reversal · ${frequency.toLowerCase()}`;
  return frequency;
}

/** Where a run stands in Accounting, short enough for a table cell. */
export function ledgerLabel(ledger: { status: string; journalNumber: string | null; error: string | null }): string {
  if (ledger.status === "posted") return ledger.journalNumber ? `Posted · ${ledger.journalNumber}` : "Posted";
  if (ledger.status === "pending") return "Sending";
  if (ledger.status === "rejected") return "Refused";
  if (ledger.status === "failed") return "Failed";
  if (ledger.status === "none") return ledger.error ? "Not posted" : "–";
  return sentence(ledger.status);
}

const DETAIL_LABELS: Record<string, string> = {
  idNumber: "ID number",
  passportNumber: "Passport number",
  passportCountry: "Passport country",
  taxReference: "Tax number",
  bankName: "Bank",
  branchCode: "Branch code",
  accountNumber: "Account number",
  accountType: "Account type",
  accountHolder: "Account holder",
};
const ACCOUNT_TYPES: Record<string, string> = { current: "Current or cheque", savings: "Savings", transmission: "Transmission" };

/** Revealed ID, tax or bank details as labelled lines (never the internal field names). */
export function revealedLines(value: unknown): Array<{ label: string; value: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v != null && v !== "")
    .map(([key, v]) => ({
      label: DETAIL_LABELS[key] ?? sentence(key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()),
      value: key === "accountType" ? ACCOUNT_TYPES[String(v)] ?? String(v) : String(v),
    }));
}

const LINE_SECTIONS: Record<string, string> = { earning: "Earnings", deduction: "Deductions", statutory: "Tax and UIF", employer: "Paid by the employer", info: "For information" };

/** Where a payslip line sits, in plain words. */
export function lineSectionLabel(section: string): string {
  return LINE_SECTIONS[section] ?? sentence(section);
}

const VARIANCE_FIELDS: Record<string, string> = { gross: "Gross pay", net: "Net pay", paye: "PAYE (income tax)" };

export function varianceFieldLabel(field: string): string {
  return VARIANCE_FIELDS[field] ?? sentence(field);
}

/** Why "+ New pay run" is off, or null: it needs employees, and the tax rules for this year. */
export function newRunBlocker(s: { employees: ReadonlyArray<{ status: string }>; rules: { id: string | null; taxYear: string } }): string | null {
  if (!s.employees.some((e) => e.status === "active")) return "Add employees first.";
  if (!s.rules.id) return `No tax rules are loaded for ${s.rules.taxYear} yet.`;
  return null;
}

export type TodoTab = "employees" | "runs" | "leave";

export interface TodoStep {
  key: string;
  text: string;
  tone: "bad" | "warn" | "info";
  action: { label: string; tab?: TodoTab; runId?: string } | null;
}

export interface TodoInput {
  me: string | null;
  settings: { saved: boolean; encryptionKey: boolean; defaultApproverSet: boolean };
  counts: { employees: number; withoutTerms: number; withoutBank: number; withoutTax: number; pendingLeave: number };
  openRuns: ReadonlyArray<{ id: string; number: string; status: string; approverUserId: string | null }>;
}

/**
 * The Overview's "To do": what needs a person now, most urgent first, each
 * with the one button that goes to the fix. Settings, the encryption key,
 * storage and the tax rules are the page's warning lines instead.
 */
export function todoSteps(s: TodoInput): TodoStep[] {
  const steps: TodoStep[] = [];
  for (const run of s.openRuns.filter((r) => r.status === "approved")) {
    steps.push({ key: `lock:${run.id}`, text: `${run.number} is approved but not locked, so it isn't in the books and has no payslips yet.`, tone: "bad", action: { label: "Open run", runId: run.id } });
  }
  for (const run of s.openRuns.filter((r) => r.status === "pending_approval" && s.me && r.approverUserId === s.me)) {
    steps.push({ key: `approve:${run.id}`, text: `${run.number} is waiting for your approval.`, tone: "warn", action: { label: "Open run", runId: run.id } });
  }
  if (!s.settings.defaultApproverSet) steps.push({ key: "approver", text: "Choose who approves pay runs.", tone: "warn", action: { label: "Choose approver", tab: "runs" } });
  if (!s.counts.employees && s.settings.saved && s.settings.encryptionKey) steps.push({ key: "employees", text: "Add your employees.", tone: "info", action: { label: "Add employees", tab: "employees" } });
  if (s.counts.withoutTerms) steps.push({ key: "terms", text: `${plural(s.counts.withoutTerms, "employee has", "employees have")} no pay terms yet (their salary and how often they're paid).`, tone: "warn", action: { label: "Open employees", tab: "employees" } });
  if (s.counts.withoutBank) steps.push({ key: "bank", text: `${plural(s.counts.withoutBank, "employee has", "employees have")} no bank details, needed for the bank payment file.`, tone: "warn", action: { label: "Open employees", tab: "employees" } });
  if (s.counts.withoutTax) steps.push({ key: "tax", text: `${plural(s.counts.withoutTax, "employee has", "employees have")} no tax number, needed for the IRP5 (their yearly tax certificate).`, tone: "warn", action: { label: "Open employees", tab: "employees" } });
  if (s.counts.pendingLeave) steps.push({ key: "leave", text: `${plural(s.counts.pendingLeave, "leave request is", "leave requests are")} waiting for a decision.`, tone: "warn", action: { label: "Open leave", tab: "leave" } });
  return steps;
}
