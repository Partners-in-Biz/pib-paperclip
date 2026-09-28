/**
 * Agent tool handlers and the shared page data. Tools prepare and read with
 * masked data only; every result passes `assertMaskedOutput`.
 */
import type { ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { toolFail, toolOk } from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import type { Actor } from "../domain.js";
import { PayrollError } from "../money.js";
import { withRuleLabels } from "../rule-labels.js";
import { ruleVersionFor, taxYearOf } from "../rules.js";
import { assertMaskedOutput } from "../tools.js";
import { employeeSummary } from "./employees.js";
import { errorMessage, optStr, reqStr, today, type Env } from "./env.js";
import { balancesFor, leaveView, loadLeaveData, requestLeave } from "./leave.js";
import { rulesReviewState } from "./rules-review.js";
import { adjustItem, calculateRun, createRun, requestApproval, runDetail, runSummary, runVariances } from "./runs.js";
import { emp201, emp501 } from "./statutory.js";
import { emp201Filing, markEmp201FiledTool } from "./emp201-filing.js";

// ---------------------------------------------------------------------------
// Agent tools
// ---------------------------------------------------------------------------

/** Results are always JSON objects (kit `toolOk` / `toolFail`), which strict MCP clients need. */
export async function runTool(e: Env, name: string, params: Record<string, unknown>, run: ToolRunContext): Promise<ToolResult> {
  try {
    const actor: Actor = { kind: "agent", userId: null, agentId: run.agentId };
    const data = await dispatchTool(e, name, run.companyId, actor, params);
    assertMaskedOutput(data);
    return toolOk(name, data);
  } catch (error) {
    return toolFail(errorMessage(error));
  }
}

export async function dispatchTool(e: Env, name: string, companyId: string, actor: Actor, params: Record<string, unknown>): Promise<unknown> {
  const { ctx } = e;
  switch (name) {
    case "payroll-overview":
      return overview(e, companyId, false);
    case "payroll-rules":
      return rulesView(e, optStr(params, "taxYear", 7) ?? taxYearOf(today(e)));
    case "list-employees": {
      const status = params.status === "terminated" ? "terminated" : params.status === "active" ? "active" : undefined;
      const [employees, terms] = await Promise.all([db.listEmployees(ctx, companyId, { status }), db.termsOn(ctx, companyId, today(e))]);
      return { employees: employees.map((x) => employeeSummary(x, terms.get(x.id) ?? null)) };
    }
    case "list-pay-runs": {
      const limit = typeof params.limit === "number" ? params.limit : 20;
      return { runs: (await db.listRuns(ctx, companyId, limit)).map(runSummary) };
    }
    case "get-pay-run":
      return agentRunDetail(await runDetail(e, companyId, reqStr(params, "runId", 64)));
    case "create-pay-run":
      return createRun(e, companyId, actor, params);
    case "calculate-pay-run":
      return agentRunDetail(await calculateRun(e, companyId, actor, params));
    case "adjust-pay-run-item":
      return agentRunDetail(await adjustItem(e, companyId, actor, params));
    case "pay-run-variances":
      return runVariances(e, companyId, params);
    case "request-pay-run-approval":
      return requestApproval(e, companyId, actor, params);
    case "list-leave": {
      const status = typeof params.status === "string" ? (params.status as db.LeaveRequest["status"]) : undefined;
      const [requests, employees] = await Promise.all([db.listLeave(ctx, companyId, { status }), db.listEmployees(ctx, companyId)]);
      const byId = new Map(employees.map((x) => [x.id, x]));
      return { requests: requests.map((r) => leaveView(r, byId.get(r.employeeId))) };
    }
    case "leave-balances": {
      const asOf = optStr(params, "asOf", 10) ?? today(e);
      const employeeId = optStr(params, "employeeId", 64);
      const employees = employeeId ? [await db.getEmployee(ctx, companyId, employeeId)].filter((x): x is db.Employee => Boolean(x)) : await db.listEmployees(ctx, companyId, { status: "active" });
      const data = await loadLeaveData(e, companyId, asOf, employeeId ?? undefined);
      const out = [];
      for (const x of employees) out.push({ employeeId: x.id, name: x.name, balances: await balancesFor(e, companyId, x, asOf, data) });
      return { asOf, employees: out };
    }
    case "request-leave":
      return requestLeave(e, companyId, actor, params);
    case "emp201-summary": {
      // Figures only: the employer's SARS reference numbers stay on the board page.
      const month = reqStr(params, "month", 7);
      const filing = await emp201Filing(e, companyId, month);
      return { emp201: (await emp201(e, companyId, params)).emp201, filed: filing ? { filedOn: filing.filedOn } : null };
    }
    case "mark-emp201-filed":
      return markEmp201FiledTool(e, companyId, actor, params);
    case "emp501-summary": {
      // Company totals only (no certificate rows or personal details).
      const period = params.period === "annual" ? "annual" : "interim";
      const result = await emp501(e, companyId, { taxYear: optStr(params, "taxYear", 7) ?? taxYearOf(today(e)), period });
      return {
        taxYear: result.taxYear,
        period: result.period,
        months: result.months.map((m) => ({ month: m.month, totalPayableMinor: m.totalPayableMinor, runs: m.runs })),
        declared: result.declared,
        certificates: result.certificates,
        difference: result.difference,
        reconciled: result.reconciled,
      };
    }
    default:
      throw new PayrollError(`Unknown payroll tool ${name}`);
  }
}

/** Agents get the run without email addresses. */
export function agentRunDetail(detail: Awaited<ReturnType<typeof runDetail>>) {
  return { ...detail, payslips: detail.payslips.map((p) => ({ ...p, emailedTo: p.emailedTo ? "on file" : null })) };
}

// ---------------------------------------------------------------------------
// Page data
// ---------------------------------------------------------------------------

export async function rulesView(e: Env, taxYear: string) {
  const versions = await db.listRuleVersions(e.ctx);
  const version = versions.find((v) => v.taxYear === taxYear && v.status === "published") ?? null;
  return {
    taxYear,
    available: versions.map((v) => ({ id: v.id, taxYear: v.taxYear, version: v.version, unverified: v.unverified.length })),
    version: version ? { id: version.id, taxYear: version.taxYear, effectiveFrom: version.effectiveFrom, effectiveTo: version.effectiveTo, rules: version.rules, sources: version.sources, unverified: withRuleLabels(version.unverified), notes: version.notes, contentHash: version.contentHash } : null,
  };
}

export async function members(e: Env, companyId: string, meUserId: string | null) {
  try {
    const list = await e.ctx.access.members.list({ companyId });
    return list
      .filter((m) => m.principalType === "user" && m.status === "active")
      .map((m) => ({ userId: m.principalId, role: m.membershipRole, isYou: m.principalId === meUserId }));
  } catch {
    return [];
  }
}

export async function overview(e: Env, companyId: string, board: boolean, meUserId: string | null = null) {
  const { ctx } = e;
  const config = await e.config(companyId);
  const date = today(e);
  const versions = await db.listRuleVersions(ctx);
  const version = ruleVersionFor(versions, date);
  const [runs, employees, pendingLeave, terms, rulesCheck] = await Promise.all([
    db.listRuns(ctx, companyId, 24),
    db.listEmployees(ctx, companyId, { status: "active" }),
    db.listLeave(ctx, companyId, { status: "pending" }),
    db.termsOn(ctx, companyId, date),
    rulesReviewState(e, companyId),
  ]);
  const open = runs.filter((r) => ["draft", "calculated", "pending_approval", "approved"].includes(r.status));
  const lastLocked = runs.find((r) => r.status === "locked" && r.kind !== "reversal") ?? null;
  const monthlyCost = employees.reduce((sum, x) => {
    const t = terms.get(x.id);
    if (!t) return sum;
    const periods = version?.rules.periods[t.frequency] ?? 12;
    const perPeriod = t.workerCategory === "salaried" ? t.rateMinor : Math.round((t.rateMinor * t.standardHoursCenti) / 100);
    return sum + Math.round((perPeriod * periods) / 12);
  }, 0);
  return {
    today: date,
    settings: {
      saved: config.saved,
      employerNamed: Boolean(config.employer.legalName),
      payeReference: Boolean(config.employer.payeReference),
      encryptionKey: config.encryptionKeyConfigured,
      privateStorage: config.r2Configured,
      defaultApproverSet: Boolean(config.defaultApproverUserId),
      lockOnApproval: config.lockOnApproval,
      emailPayslipsOnLock: config.payslipEmail.sendOnLock,
      sdlMode: config.sdlMode,
      etiRegistered: config.etiRegistered,
      defaultPayDay: config.defaultPayDay,
      prepareDaysBefore: config.prepareDaysBefore,
      ...(board ? { employer: config.employer, defaultApproverUserId: config.defaultApproverUserId } : {}),
    },
    // Each unconfirmed rule with its plain name (`label`); never show the raw `path` to people.
    rules: version
      ? { id: version.id, taxYear: version.taxYear, unverified: withRuleLabels(version.unverified), notes: version.notes }
      : { id: null, taxYear: taxYearOf(date), unverified: [], notes: [`No payroll rules are loaded for ${taxYearOf(date)}.`] },
    /** True when nothing is left for the accountant to check. */
    rulesReviewed: rulesCheck.reviewed,
    /** The accountant's check that covers today's rules: `{ accountantName, checkedOn, at }`, else null. */
    rulesReview: rulesCheck.review,
    counts: {
      employees: employees.length,
      withoutTerms: employees.filter((x) => !terms.has(x.id)).length,
      withoutBank: employees.filter((x) => !x.hasBank).length,
      withoutTax: employees.filter((x) => !x.hasTax).length,
      pendingLeave: pendingLeave.length,
    },
    estimatedMonthlyBasicMinor: monthlyCost,
    openRuns: open.map(runSummary),
    lastLocked: lastLocked ? runSummary(lastLocked) : null,
    ...(board ? { members: await members(e, companyId, meUserId) } : {}),
  };
}
