/**
 * What the worker returns to the Payroll page (`payroll.load`, `payroll.run`,
 * `payroll.leave`, `payroll.emp201` …). Types only.
 */
import type { ClerkHire } from "./clerk.js";

export type Frequency = "monthly" | "fortnightly" | "weekly";

export interface Totals {
  employeeCount: number;
  grossMinor: number;
  payeMinor: number;
  etiMinor: number;
  uifEmployeeMinor: number;
  uifEmployerMinor: number;
  sdlMinor: number;
  deductionsMinor: number;
  employerContributionsMinor: number;
  netPayMinor: number;
  employerCostMinor: number;
}

export interface RunSummary {
  id: string;
  number: string;
  kind: "regular" | "correction" | "reversal";
  frequency: Frequency;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  taxYear: string;
  status: string;
  preparedBy: { kind: string; id: string } | null;
  approverUserId: string | null;
  approvalIssueId: string | null;
  approvedByUserId: string | null;
  reversesRunId: string | null;
  reversedByRunId: string | null;
  ledger: { status: string; journalNumber: string | null; error: string | null };
  totals: Totals;
  warnings: string[];
}

export interface TermsView {
  frequency: Frequency;
  workerCategory: "salaried" | "hourly";
  rateMinor: number;
  standardHours: number;
  hoursPerDay: number;
  daysPerWeek: number;
  overtimeMultiplier: number;
  uifApplicable: boolean;
  sdlApplicable: boolean;
  medical: { members: number; employeeContributionMinor: number; employerContributionMinor: number } | null;
  retirement: { fund: string; employeeContributionMinor: number; employerContributionMinor: number } | null;
  travel: { amountMinor: number; businessUseAtLeast80: boolean } | null;
  annualLeaveDays: number | null;
  effectiveFrom: string;
  version: number;
}

export interface EmployeeView {
  id: string;
  employeeNumber: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  dateOfBirth: string | null;
  age: number | null;
  status: string;
  startDate: string;
  endDate: string | null;
  taxResidency: string;
  details: { idOrPassport: string; taxReference: string; bank: string };
  has: { identity: boolean; tax: boolean; bank: boolean };
  etiEligible: boolean;
  etiMonthsBefore: number;
  terms: TermsView | null;
  recurring: Array<{ code: string; amountMinor: number; label: string | null }>;
}

export interface Component {
  code: string;
  name: string;
  kind: string;
  sarsCode: string | null;
  active: boolean;
}

/** The accountant's check of the unconfirmed tax rules (`accountantName` is null for checks recorded before names were kept). */
export interface RulesReviewView {
  accountantName: string | null;
  checkedOn: string;
  at: string;
}

export interface Snapshot {
  today: string;
  me: string | null;
  settings: {
    saved: boolean;
    employerNamed: boolean;
    payeReference: boolean;
    encryptionKey: boolean;
    privateStorage: boolean;
    defaultApproverSet: boolean;
    defaultApproverUserId?: string | null;
    /** Approving also locks the run, as the approver (default on). */
    lockOnApproval?: boolean;
    emailPayslipsOnLock?: boolean;
    sdlMode: string;
    etiRegistered: boolean;
    defaultPayDay: number;
    prepareDaysBefore?: number;
  };
  /** `unverified[].label` is the plain name of the rule (never show `path`). */
  rules: { id: string | null; taxYear: string; unverified: Array<{ path: string; label?: string; note: string }>; notes: string[] };
  counts: { employees: number; withoutTerms: number; withoutBank: number; withoutTax: number; pendingLeave: number };
  estimatedMonthlyBasicMinor: number;
  openRuns: RunSummary[];
  lastLocked: RunSummary | null;
  members: Array<{ userId: string; role: string | null; isYou: boolean }>;
  employees: EmployeeView[];
  runs: RunSummary[];
  components: Component[];
  hire: ClerkHire | null;
  rulesReviewed: boolean;
  rulesReview?: RulesReviewView | null;
  /** The host's Payroll settings page. */
  settingsHref?: string;
}

export interface Line {
  code: string;
  label: string;
  section: string;
  sarsCode: string | null;
  amountMinor: number;
  quantityCenti?: number | null;
  rateMinor?: number | null;
}

export interface TraceStep {
  step: number;
  code: string;
  label: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
}

export interface ItemView {
  id: string;
  employeeId: string;
  name: string;
  employeeNumber: string;
  status: string;
  error: string | null;
  grossMinor: number;
  payeMinor: number;
  uifEmployeeMinor: number;
  uifEmployerMinor: number;
  sdlMinor: number;
  etiMinor: number;
  deductionsMinor: number;
  netMinor: number;
  employerCostMinor: number;
  lines: Line[];
  trace: TraceStep[];
  warnings: string[];
  bank: string | null;
  inputs: Record<string, unknown>;
}

export interface RunPayslip {
  id: string;
  employeeId: string;
  number: string;
  status: string;
  emailedTo: string | null;
  emailedAt: string | null;
  error: string | null;
}

export interface RunDetail {
  run: RunSummary;
  approvalStatus: string | null;
  items: ItemView[];
  excluded: Array<{ employeeId: string; name: string }>;
  payslips: RunPayslip[];
}

export interface PayslipRow {
  id: string;
  number: string;
  runId: string;
  run: string | null;
  payDate: string | null;
  employee: string | null;
  status: string;
  emailedTo: string | null;
  emailedAt: string | null;
  error: string | null;
}

export interface LeaveRequestRow {
  id: string;
  employeeId: string;
  employee: string | null;
  type: string;
  label: string;
  startDate: string;
  endDate: string;
  days: number;
  status: string;
  reason: string | null;
}

export interface LeaveData {
  asOf: string;
  requests: LeaveRequestRow[];
  balances: Array<{ employeeId: string; name: string; balances: Array<{ type: string; label: string; balanceCenti: number; takenCenti: number; pendingCenti: number; note: string | null }> }>;
}

export interface Emp201View {
  month: string;
  payeMinor: number;
  sdlMinor: number;
  uifMinor: number;
  etiCalculatedMinor: number;
  etiBroughtForwardMinor: number;
  etiUsedMinor: number;
  etiCarriedForwardMinor: number;
  payeAfterEtiMinor: number;
  totalPayableMinor: number;
  dueDate: string;
  runs: string[];
  notes: string[];
  employees: number;
}

export type TabId = "overview" | "employees" | "runs" | "payslips" | "leave" | "statutory";
export const TAB_IDS: TabId[] = ["overview", "employees", "runs", "payslips", "leave", "statutory"];

/** Runs a page action, refreshes the snapshot and shows `success` (or the error). */
export type RunFn = <T>(work: () => Promise<T>, success?: string) => Promise<T | null>;
