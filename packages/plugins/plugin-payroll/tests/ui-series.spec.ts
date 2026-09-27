import { describe, expect, it } from "vitest";
import {
  costPerRun,
  costSplit,
  daysUntil,
  emp201Month,
  leaveStatusLabel,
  leaveUsed,
  ledgerLabel,
  lineSectionLabel,
  newRunBlocker,
  payslipStatusLabel,
  periodText,
  plural,
  revealedLines,
  runKindText,
  runStatusLabel,
  runTone,
  statusTone,
  todoSteps,
  varianceFieldLabel,
  type RunLite,
  type TodoInput,
} from "../src/ui/series.js";

const totals = { employeeCount: 2, grossMinor: 3_600_000, payeMinor: 468_100, uifEmployeeMinor: 23_712, uifEmployerMinor: 23_712, sdlMinor: 36_000, deductionsMinor: 0, employerContributionsMinor: 10_000, netPayMinor: 3_108_188, employerCostMinor: 3_669_712 };
const run = (id: string, payDate: string, status = "locked", kind = "regular"): RunLite => ({ id, number: `PR-${id}`, kind, status, payDate, totals });

describe("payroll UI series", () => {
  it("tones run and other statuses", () => {
    expect(["locked", "pending_approval", "calculated", "cancelled", "reversed"].map(runTone)).toEqual(["ok", "warn", "info", "neutral", "neutral"]);
    expect(["approved", "pending", "rejected", "ready", "cancelled"].map(statusTone)).toEqual(["ok", "warn", "bad", "info", "neutral"]);
  });

  it("charts locked regular runs oldest first, parts adding up to the cost to company", () => {
    const rows = costPerRun([run("c", "2026-09-25"), run("a", "2026-07-25"), run("x", "2026-08-25", "calculated"), run("r", "2026-08-26", "locked", "reversal"), run("b", "2026-08-25")], 2);
    expect(rows.map((r) => r.id)).toEqual(["b", "c"]);
    expect(rows[1]).toMatchObject({ label: "Sep", title: "PR-c · paid 25 Sep 2026", employeeCount: 2 });
    const v = rows[1]!.values;
    expect(v.net + v.tax + v.deductions + v.employer).toBe(totals.employerCostMinor);
    expect(v).toEqual({ net: 3_108_188, tax: 491_812, deductions: 0, employer: 69_712 });
  });

  it("splits one run's cost and drops empty parts, with the abbreviations spelled out", () => {
    expect(costSplit(totals).map((s) => s.key)).toEqual(["net", "paye", "uif", "sdl", "employer"]);
    expect(costSplit(totals).find((s) => s.key === "uif")!.value).toBe(47_424);
    expect(costSplit(totals).map((s) => s.label)).toEqual(["Net pay", "Income tax (PAYE)", "UIF (employee and employer)", "Skills levy (SDL)", "Employer contributions"]);
  });

  it("picks the EMP201 month and counts days to its due date", () => {
    expect(emp201Month("2026-09-26")).toBe("2026-09");
    expect(emp201Month("2026-10-05")).toBe("2026-09");
    expect(emp201Month("2026-01-03")).toBe("2025-12");
    expect(daysUntil("2026-09-26", "2026-10-07")).toBe(11);
    expect(daysUntil("2026-10-09", "2026-10-07")).toBe(-2);
  });

  it("measures leave used against the entitlement", () => {
    expect(leaveUsed({ balanceCenti: 1_500, takenCenti: 600, pendingCenti: 200 })).toEqual({ ratio: 800 / 2_100, entitlementCenti: 2_100 });
    expect(leaveUsed({ balanceCenti: 0, takenCenti: 0, pendingCenti: 0 })).toEqual({ ratio: 0, entitlementCenti: 0 });
  });

  it("writes periods as people read them, never year-first", () => {
    expect(periodText("2026-09-01", "2026-09-30")).toBe("1–30 Sep 2026");
    expect(periodText("2026-08-25", "2026-09-07")).toBe("25 Aug – 7 Sep 2026");
    expect(periodText("2026-12-15", "2027-01-14")).toBe("15 Dec 2026 – 14 Jan 2027");
    expect(periodText("2026-09-22", "2026-09-22")).toBe("22 Sep 2026");
    expect(periodText("2026-09-22", null)).toBe("22 Sep 2026");
    expect(periodText(null, undefined)).toBe("–");
  });

  it("labels statuses in plain words", () => {
    expect(["draft", "calculated", "pending_approval", "approved", "locked", "reversed", "cancelled", "odd_one"].map(runStatusLabel)).toEqual(["Draft", "Calculated", "Waiting for approval", "Approved", "Locked", "Reversed", "Cancelled", "Odd one"]);
    expect(["pending", "ready", "sending", "sent", "failed"].map(payslipStatusLabel)).toEqual(["Not made yet", "Ready", "Sending", "Emailed", "Failed"]);
    expect(["pending", "approved", "rejected", "cancelled"].map(leaveStatusLabel)).toEqual(["Waiting", "Approved", "Declined", "Cancelled"]);
    expect(runKindText({ kind: "regular", frequency: "monthly" })).toBe("Monthly");
    expect(runKindText({ kind: "correction", frequency: "weekly" })).toBe("Correction · weekly");
    expect(ledgerLabel({ status: "posted", journalNumber: "JE-0007", error: null })).toBe("Posted · JE-0007");
    expect(ledgerLabel({ status: "rejected", journalNumber: null, error: "x" })).toBe("Refused");
    expect(ledgerLabel({ status: "none", journalNumber: null, error: null })).toBe("–");
    expect(ledgerLabel({ status: "none", journalNumber: null, error: "Accounting is switched off" })).toBe("Not posted");
    expect(lineSectionLabel("statutory")).toBe("Tax and UIF");
    expect(varianceFieldLabel("paye")).toBe("PAYE (income tax)");
    expect(plural(1, "person", "people")).toBe("1 person");
    expect(plural(3, "person", "people")).toBe("3 people");
  });

  it("labels revealed details without internal field names", () => {
    expect(revealedLines({ idNumber: "9001015009086", passportNumber: null, passportCountry: "" })).toEqual([{ label: "ID number", value: "9001015009086" }]);
    expect(revealedLines({ bankName: "FNB", branchCode: "250655", accountNumber: "62812345678", accountType: "current", accountHolder: "T Nkosi" }).map((l) => `${l.label}: ${l.value}`)).toEqual([
      "Bank: FNB", "Branch code: 250655", "Account number: 62812345678", "Account type: Current or cheque", "Account holder: T Nkosi",
    ]);
    expect(revealedLines({ someNewField: "x" })).toEqual([{ label: "Some new field", value: "x" }]);
    expect(revealedLines(null)).toEqual([]);
  });

  it("blocks a new pay run until there are employees and tax rules", () => {
    const rules = { id: "za-2026-27-v1", taxYear: "2026/27" };
    expect(newRunBlocker({ employees: [], rules })).toBe("Add employees first.");
    expect(newRunBlocker({ employees: [{ status: "terminated" }], rules })).toBe("Add employees first.");
    expect(newRunBlocker({ employees: [{ status: "active" }], rules: { id: null, taxYear: "2031/32" } })).toBe("No tax rules are loaded for 2031/32 yet.");
    expect(newRunBlocker({ employees: [{ status: "active" }], rules })).toBeNull();
  });

  it("builds the Overview to-do list, most urgent first, each with its fix", () => {
    const base: TodoInput = {
      me: "u-me",
      settings: { saved: true, encryptionKey: true, defaultApproverSet: true },
      counts: { employees: 3, withoutTerms: 0, withoutBank: 0, withoutTax: 0, pendingLeave: 0 },
      openRuns: [],
    };
    expect(todoSteps(base)).toEqual([]);
    const steps = todoSteps({
      ...base,
      settings: { saved: true, encryptionKey: true, defaultApproverSet: false },
      counts: { employees: 3, withoutTerms: 1, withoutBank: 2, withoutTax: 1, pendingLeave: 2 },
      openRuns: [
        { id: "r1", number: "PR-2026-09-M01", status: "approved", approverUserId: "u-other" },
        { id: "r2", number: "PR-2026-09-M02", status: "pending_approval", approverUserId: "u-me" },
        { id: "r3", number: "PR-2026-09-M03", status: "pending_approval", approverUserId: "u-other" },
      ],
    });
    expect(steps.map((x) => x.key)).toEqual(["lock:r1", "approve:r2", "approver", "terms", "bank", "tax", "leave"]);
    expect(steps[0]).toMatchObject({ tone: "bad", action: { label: "Open run", runId: "r1" } });
    expect(steps[2]).toEqual({ key: "approver", text: "Choose who approves pay runs.", tone: "warn", action: { label: "Choose approver", tab: "runs" } });
    expect(steps.find((x) => x.key === "terms")!.text).toBe("1 employee has no pay terms yet (their salary and how often they're paid).");
    expect(steps.find((x) => x.key === "bank")!.text).toBe("2 employees have no bank details, needed for the bank payment file.");
    expect(steps.find((x) => x.key === "tax")!.text).toContain("IRP5 (their yearly tax certificate)");
    expect(steps.find((x) => x.key === "leave")).toMatchObject({ text: "2 leave requests are waiting for a decision.", action: { tab: "leave" } });
    // "Add your employees" only once they can be entered (settings saved, encryption key set).
    expect(todoSteps({ ...base, counts: { ...base.counts, employees: 0 } }).map((x) => x.key)).toEqual(["employees"]);
    expect(todoSteps({ ...base, settings: { ...base.settings, encryptionKey: false }, counts: { ...base.counts, employees: 0 } })).toEqual([]);
  });
});
