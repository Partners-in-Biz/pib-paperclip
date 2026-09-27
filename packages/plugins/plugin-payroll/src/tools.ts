/**
 * Agent tools. They prepare and read; none approves, locks, reverses,
 * reveals personal details or builds bank files. Every result passes
 * `assertMaskedOutput` before it leaves the worker.
 */
import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { PayrollError } from "./money.js";

const date = (description: string): JsonSchema => ({ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: `${description} (YYYY-MM-DD).` });
const runId: JsonSchema = { type: "string", description: "Pay run id from list-pay-runs or create-pay-run." };
const employeeId: JsonSchema = { type: "string", description: "Employee id from list-employees." };
const hours = (description: string): JsonSchema => ({ type: "number", minimum: 0, maximum: 744, description: `${description} Hours, e.g. 7.5.` });

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

const inputsSchema: JsonSchema = {
  type: "object",
  description: "This run's changes for the employee. Only the fields you give change; the rest stay as they are.",
  properties: {
    excluded: { type: "boolean", description: "true leaves this employee out of the run (e.g. left before the period)." },
    ordinaryHours: hours("Hours at the ordinary rate (hourly staff only; default: their normal hours less leave)."),
    overtimeHours: hours("Overtime at the overtime rate."),
    doubleTimeHours: hours("Sunday and public holiday hours (double time)."),
    paidLeaveHours: hours("Paid leave hours (hourly staff; default: approved paid leave in the period)."),
    unpaidHours: hours("Unpaid hours on top of approved unpaid leave."),
    components: {
      type: "array",
      description: "One-off amounts for this run only (recurring pay lives in the employee's terms).",
      items: {
        type: "object",
        required: ["code", "amountMinor"],
        properties: {
          code: { type: "string", description: "Component code, e.g. BONUS, COMMISSION, BACK_PAY, OTHER_ALLOWANCE, STAFF_LOAN." },
          amountMinor: { type: "integer", minimum: 0, description: "Amount in whole cents (R1 = 100)." },
          label: { type: "string", maxLength: 80, description: "Label on the payslip (default: the component's name)." },
        },
        additionalProperties: false,
      },
    },
    note: { type: "string", maxLength: 500, description: "Why this changed (shown on the run)." },
  },
  additionalProperties: false,
};

export const PAYROLL_TOOLS: PluginToolDeclaration[] = [
  {
    name: "payroll-overview",
    displayName: "Payroll overview",
    description: "Settings status, the rules for the current tax year (each unconfirmed rule with a plain `label`; `rulesReviewed` and `rulesReview` say whether and when an accountant checked them), open pay runs, pending leave and the next run to prepare.",
    parametersSchema: schema([], {}),
  },
  {
    name: "payroll-rules",
    displayName: "Payroll rules",
    description: "The tax tables in use for a tax year (default: current) with their sources, and anything not yet confirmed (each with a plain `label`).",
    parametersSchema: schema([], { taxYear: { type: "string", pattern: "^\\d{4}/\\d{2}$", description: "Tax year, e.g. 2026/27 (March to February; default: the current one)." } }),
  },
  {
    name: "list-employees",
    displayName: "List employees",
    description: "Employees with pay frequency and masked ID, tax and bank details (never the full numbers).",
    parametersSchema: schema([], { status: { type: "string", enum: ["active", "terminated"], description: "Only active or only terminated staff (default: both)." } }),
  },
  {
    name: "list-pay-runs",
    displayName: "List pay runs",
    description: "Recent pay runs, newest first, with status (draft, calculated, pending_approval, approved, locked, reversed, cancelled), approval, ledger posting and totals.",
    parametersSchema: schema([], { limit: { type: "integer", minimum: 1, maximum: 100, description: "At most this many runs (default 20).", default: 20 } }),
  },
  {
    name: "get-pay-run",
    displayName: "Get pay run",
    description: "One pay run with each employee's lines, totals, warnings, step-by-step calculation trace and payslip status.",
    parametersSchema: schema(["runId"], { runId }),
  },
  {
    name: "create-pay-run",
    displayName: "Create pay run",
    description: "Start a draft pay run. Defaults to this month (or week) and the company's pay day. One regular run per period.",
    parametersSchema: schema([], {
      frequency: { type: "string", enum: ["monthly", "fortnightly", "weekly"], description: "Pay frequency of the staff in this run (default monthly).", default: "monthly" },
      periodStart: date("First day of the pay period (default: from the frequency and today)"),
      periodEnd: date("Last day of the pay period"),
      payDate: date("The day staff are paid (default: the company's pay day, moved back to a weekday)"),
      notes: { type: "string", maxLength: 1000, description: "A note on the run, e.g. why it is unusual." },
    }),
  },
  {
    name: "calculate-pay-run",
    displayName: "Calculate pay run",
    description: "Calculate PAYE, UIF, SDL, ETI and net pay for everyone in the run. Recalculating drops a pending approval (ask for it again).",
    parametersSchema: schema(["runId"], { runId }),
  },
  {
    name: "adjust-pay-run-item",
    displayName: "Adjust pay run item",
    description: "Set this run's hours, overtime, one-off components or exclusion for one employee, then recalculate. Drops a pending approval.",
    parametersSchema: schema(["runId", "employeeId", "inputs"], { runId, employeeId, inputs: inputsSchema }),
  },
  {
    name: "pay-run-variances",
    displayName: "Pay run variances",
    description: "Compare a run with the previous locked run: changes of at least thresholdPercent (default 10) in gross, net or PAYE, and new or missing staff.",
    parametersSchema: schema(["runId"], {
      runId,
      compareRunId: { type: "string", description: "Compare with this run instead of the previous locked one." },
      thresholdPercent: { type: "number", minimum: 0, maximum: 100, description: "Smallest change to report, in percent (default 10).", default: 10 },
    }),
  },
  {
    name: "request-pay-run-approval",
    displayName: "Request pay run approval",
    description:
      "Send a calculated run to a board member for approval (opens their approval issue). Their approval also locks the run when \"Lock on approval\" is on: it posts to Accounting and makes the payslips.",
    parametersSchema: schema(["runId"], {
      runId,
      approverUserId: { type: "string", description: "The board member's user id. Leave out to use the default approver from the Payroll settings. Never the person who calculated the run." },
    }),
  },
  {
    name: "list-leave",
    displayName: "List leave",
    description: "Leave requests with status, type and days.",
    parametersSchema: schema([], { status: { type: "string", enum: ["pending", "approved", "rejected", "cancelled"], description: "Only requests in this state (default: all)." } }),
  },
  {
    name: "leave-balances",
    displayName: "Leave balances",
    description: "Annual, sick and family responsibility balances (BCEA) per employee.",
    parametersSchema: schema([], { employeeId: { type: "string", description: "Only this employee (default: every active employee)." }, asOf: date("Balances on this day (default today)") }),
  },
  {
    name: "request-leave",
    displayName: "Request leave",
    description: "Record a leave request and open an approval issue for the leave approver. Approved unpaid leave is deducted in the pay run for that period.",
    parametersSchema: schema(["employeeId", "type", "startDate", "endDate"], {
      employeeId,
      type: { type: "string", enum: ["annual", "sick", "family", "unpaid"], description: "annual, sick, family responsibility or unpaid leave." },
      startDate: date("First day of leave"),
      endDate: date("Last day of leave"),
      days: { type: "number", minimum: 0.5, maximum: 400, description: "Working days; defaults to the working days in the range." },
      reason: { type: "string", maxLength: 500, description: "Why, in the employee's words (shown to the approver)." },
    }),
  },
  {
    name: "emp201-summary",
    displayName: "EMP201 summary",
    description: "PAYE, UIF, SDL and ETI for a month from its locked pay runs, the total payable and the due date (the 7th of the next month). Evidence only; a person files and pays on eFiling.",
    parametersSchema: schema(["month"], { month: { type: "string", pattern: "^\\d{4}-\\d{2}$", description: "The month the staff were paid, YYYY-MM." } }),
  },
  {
    name: "emp501-summary",
    displayName: "EMP501 summary",
    description:
      "The EMP501 reconciliation for a tax year: the EMP201 totals declared against the IRP5/IT3(a) certificate totals, and any difference. Interim covers March to August (due end October), annual March to February (due end May). Totals only; a person files it.",
    parametersSchema: schema(["period"], {
      period: { type: "string", enum: ["interim", "annual"], description: "interim (March to August) or annual (March to February)." },
      taxYear: { type: "string", pattern: "^\\d{4}/\\d{2}$", description: "Tax year, e.g. 2026/27 (default: the current one)." },
    }),
  },
];

export const PAYROLL_TOOL_NAMES = PAYROLL_TOOLS.map((t) => t.name);

/**
 * Last line of defence for tool output: refuses any string that looks like a
 * full ID, tax or account number (9+ digits once spaces and dashes are
 * removed). Views never contain sealed values; this catches mistakes.
 */
export function assertMaskedOutput(value: unknown, path = "result"): void {
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return;
    const digits = value.replace(/[\s-]/g, "");
    if (/^\d{9,}$/.test(digits) || /\b\d{13}\b/.test(value)) throw new PayrollError(`Refusing to return what looks like an unmasked ID, tax or bank number (${path})`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertMaskedOutput(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) assertMaskedOutput(v, `${path}.${k}`);
  }
}
