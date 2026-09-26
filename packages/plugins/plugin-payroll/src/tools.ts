/**
 * Agent tools. They prepare and read; none approves, locks, reverses,
 * reveals personal details or builds bank files. Every result passes
 * `assertMaskedOutput` before it leaves the worker.
 */
import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";
import { PayrollError } from "./money.js";

const text = { type: "string" } satisfies JsonSchema;

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

const inputsSchema: JsonSchema = {
  type: "object",
  properties: {
    excluded: { type: "boolean", description: "Leave this employee out of the run." },
    ordinaryHours: { type: "number", description: "Hours at the ordinary rate (hourly staff)." },
    overtimeHours: { type: "number" },
    doubleTimeHours: { type: "number", description: "Sunday and public holiday hours." },
    paidLeaveHours: { type: "number", description: "Paid leave hours (hourly staff)." },
    unpaidHours: { type: "number", description: "Unpaid hours on top of approved unpaid leave." },
    components: {
      type: "array",
      description: "One-off amounts for this run, e.g. BONUS, COMMISSION, BACK_PAY, OTHER_ALLOWANCE, STAFF_LOAN.",
      items: {
        type: "object",
        required: ["code", "amountMinor"],
        properties: { code: text, amountMinor: { type: "integer", description: "Cents (R1 = 100)." }, label: text },
      },
    },
    note: text,
  },
};

export const PAYROLL_TOOLS: PluginToolDeclaration[] = [
  {
    name: "payroll-overview",
    displayName: "Payroll overview",
    description: "Settings status, rules for the current tax year (and unconfirmed rules), open pay runs, pending leave and the next run to prepare.",
    parametersSchema: schema([], {}),
  },
  {
    name: "payroll-rules",
    displayName: "Payroll rules",
    description: "The tax tables in use for a tax year (default: current) with their sources, and anything not yet confirmed.",
    parametersSchema: schema([], { taxYear: { type: "string", description: "e.g. 2026/27" } }),
  },
  {
    name: "list-employees",
    displayName: "List employees",
    description: "Employees with pay frequency and masked ID, tax and bank details (never the full numbers).",
    parametersSchema: schema([], { status: { type: "string", enum: ["active", "terminated"] } }),
  },
  {
    name: "list-pay-runs",
    displayName: "List pay runs",
    description: "Recent pay runs with status, approval, ledger posting and totals.",
    parametersSchema: schema([], { limit: { type: "integer" } }),
  },
  {
    name: "get-pay-run",
    displayName: "Get pay run",
    description: "One pay run with each employee's lines, totals, warnings and step-by-step calculation trace.",
    parametersSchema: schema(["runId"], { runId: text }),
  },
  {
    name: "create-pay-run",
    displayName: "Create pay run",
    description: "Start a draft pay run. Defaults to this month (or week) and the company's pay day.",
    parametersSchema: schema([], {
      frequency: { type: "string", enum: ["monthly", "fortnightly", "weekly"] },
      periodStart: text,
      periodEnd: text,
      payDate: text,
      notes: text,
    }),
  },
  {
    name: "calculate-pay-run",
    displayName: "Calculate pay run",
    description: "Calculate PAYE, UIF, SDL, ETI and net pay for everyone in the run. Recalculating drops a pending approval.",
    parametersSchema: schema(["runId"], { runId: text }),
  },
  {
    name: "adjust-pay-run-item",
    displayName: "Adjust pay run item",
    description: "Set this run's hours, overtime, one-off components or exclusion for one employee, then recalculate.",
    parametersSchema: schema(["runId", "employeeId", "inputs"], { runId: text, employeeId: text, inputs: inputsSchema }),
  },
  {
    name: "pay-run-variances",
    displayName: "Pay run variances",
    description: "Compare a run with the previous locked run: changes of at least thresholdPercent (default 10) in gross, net or PAYE, and new or missing staff.",
    parametersSchema: schema(["runId"], { runId: text, compareRunId: text, thresholdPercent: { type: "number" } }),
  },
  {
    name: "request-pay-run-approval",
    displayName: "Request pay run approval",
    description: "Send a calculated run to a board member for approval (opens an approval issue). The approver cannot be the person who calculated it.",
    parametersSchema: schema(["runId"], { runId: text, approverUserId: text }),
  },
  {
    name: "list-leave",
    displayName: "List leave",
    description: "Leave requests with status.",
    parametersSchema: schema([], { status: { type: "string", enum: ["pending", "approved", "rejected", "cancelled"] } }),
  },
  {
    name: "leave-balances",
    displayName: "Leave balances",
    description: "Annual, sick and family responsibility balances (BCEA) per employee.",
    parametersSchema: schema([], { employeeId: text, asOf: text }),
  },
  {
    name: "request-leave",
    displayName: "Request leave",
    description: "Record a leave request and open an approval issue for a person. Types: annual, sick, family, unpaid.",
    parametersSchema: schema(["employeeId", "type", "startDate", "endDate"], {
      employeeId: text,
      type: { type: "string", enum: ["annual", "sick", "family", "unpaid"] },
      startDate: text,
      endDate: text,
      days: { type: "number", description: "Working days; defaults to the working days in the range." },
      reason: text,
    }),
  },
  {
    name: "emp201-summary",
    displayName: "EMP201 summary",
    description: "PAYE, UIF, SDL and ETI for a month (YYYY-MM) from locked pay runs. Evidence only; nothing is submitted.",
    parametersSchema: schema(["month"], { month: text }),
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
