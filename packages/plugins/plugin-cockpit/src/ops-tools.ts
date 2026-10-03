/**
 * Runs the Cockpit's measurement, review, improvement, goal and credential
 * tools (declarations in `ops-tool-declarations.ts`).
 */
import type { ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { toolFail, toolOk } from "@partnersinbiz/pib-plugin-kit";
import { clientEffortReport } from "./client-cost.js";
import { effortBrief } from "./client-cost-model.js";
import { openCloseoutNow } from "./closeout.js";
import { CredentialError } from "./credentials-model.js";
import { credentialList, recordCredential, verifyCompany } from "./credentials.js";
import { getRoles } from "./db.js";
import type { Env } from "./env.js";
import { message } from "./env.js";
import { GoalError, goalBrief } from "./goals-model.js";
import { goalViews, goalViewsBrief, setGoal } from "./goals.js";
import { ImprovementError, improvementBrief, type ImprovementStatus } from "./improvements-model.js";
import { listImprovements, proposeImprovement, resolveImprovement } from "./improvements.js";
import { measureReport } from "./measure.js";
import { formatUsd } from "./measure-model.js";
import { metricCatalog } from "./metrics.js";
import { OPS_TOOL_NAMES } from "./ops-tool-declarations.js";

export { OPS_TOOL_SET } from "./ops-tool-declarations.js";

function params(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const ok = (content: string, data: unknown): ToolResult => toolOk(content, data) as ToolResult;
const fail = (text: string): ToolResult => toolFail(text) as ToolResult;

export async function runOpsTool(env: Env, name: string, raw: unknown, run: ToolRunContext): Promise<ToolResult> {
  const companyId = run.companyId;
  const p = params(raw);
  const actor = { agentId: run.agentId ?? null, userId: null as string | null };
  try {
    if (name === OPS_TOOL_NAMES.measure) {
      const wanted = Array.isArray(p.parts) ? p.parts.filter((x): x is string => typeof x === "string") : null;
      const parts = (wanted ?? ["agents", "projects", "trees", "review", "limits"]).filter((x) => x !== "clients") as Array<"agents" | "projects" | "trees" | "review" | "limits">;
      const roles = await getRoles(env.ctx, companyId);
      const report = await measureReport(env, companyId, { windowHours: typeof p.windowHours === "number" ? p.windowHours : undefined, parts, reviewerAgentId: roles?.reviewerAgentId ?? null });
      const clients = wanted?.includes("clients") ? await clientEffortReport(env, companyId) : null;
      const c = report.company;
      return ok(
        `Last ${report.windowHours} h: ${c.runs} runs (${c.failed} failed, ${c.cancelled} cancelled), notional spend ${formatUsd(c.notionalUsd ?? 0)}${c.usdPerDone !== null ? `, ${formatUsd(c.usdPerDone)} per finished issue` : ""}${report.reviewCoverage?.coverage != null ? `; ${Math.round(report.reviewCoverage.coverage * 100)}% of finished code work reviewed` : ""}${report.limitFailures.total ? `; ${report.limitFailures.total} runs hit the plan limit` : ""}.`,
        { ...report, ...(clients ? { clients: effortBrief(clients.rows, clients.settings.usdRate), clientNotes: `Notional spend over 30 days against what each client paid in 30 days (Billing publishes no retainer amounts). Rate used: ${clients.settings.usdRate} ZAR per USD.` } : {}) },
      );
    }
    if (name === OPS_TOOL_NAMES.closeout) {
      const projectId = typeof p.projectId === "string" && p.projectId.trim() ? p.projectId.trim() : undefined;
      const issueId = typeof p.issueId === "string" && p.issueId.trim() ? p.issueId.trim() : undefined;
      const result = await openCloseoutNow(env, companyId, { projectId, issueId });
      if (result.action === "opened") return ok(`Opened the close-out review (${result.issueId}). It is assigned to the Operator with the numbers and a checklist.`, result);
      if (result.action === "exists") return ok(`A review for this work was already opened today. ${result.reason}`, result);
      return fail(result.action === "failed" ? `The review could not be opened: ${result.reason}` : result.reason);
    }
    if (name === OPS_TOOL_NAMES.improvementPropose) {
      const result = await proposeImprovement(env, companyId, p, actor);
      return ok(result.message, { id: result.improvement.id, deduped: result.deduped, baselineFrom: result.baselineFrom, improvement: improvementBrief(result.improvement, env.now()) });
    }
    if (name === OPS_TOOL_NAMES.improvementList) {
      const status = typeof p.status === "string" && ["open", "resolved", "dropped", "all"].includes(p.status) ? (p.status as ImprovementStatus | "all") : "open";
      const rows = await listImprovements(env.ctx, companyId, { status, limit: typeof p.limit === "number" ? p.limit : 30 });
      const now = env.now();
      return ok(rows.length === 0 ? "No improvements recorded." : `${rows.length} ${rows.length === 1 ? "improvement" : "improvements"}.`, { items: rows.map((r) => improvementBrief(r, now)), count: rows.length });
    }
    if (name === OPS_TOOL_NAMES.improvementResolve) {
      const result = await resolveImprovement(env, companyId, {
        id: String(p.id ?? ""),
        resultValue: typeof p.resultValue === "number" ? p.resultValue : null,
        note: typeof p.note === "string" ? p.note : null,
        drop: p.drop === true,
        archiveFact: p.archiveFact === true,
      });
      return ok(result.message, { improvement: improvementBrief(result.improvement, env.now()), archivedFact: result.archivedFact });
    }
    if (name === OPS_TOOL_NAMES.goalSet) {
      const result = await setGoal(env, companyId, p, actor);
      return ok(result.message, { goal: goalBrief(result.goal, { state: "no_data", current: result.goal.lastValue, progress: null, change: null }), created: result.created, reproposed: result.reproposed });
    }
    if (name === OPS_TOOL_NAMES.goalList) {
      const status = typeof p.status === "string" ? p.status : "all-open";
      const statuses = status === "active" ? (["active"] as const) : status === "proposed" ? (["proposed"] as const) : status === "all" ? (["proposed", "active", "achieved", "missed", "dropped"] as const) : (["proposed", "active"] as const);
      const views = await goalViews(env, companyId, [...statuses]);
      const catalog = p.sources === true ? await metricCatalog(env, companyId) : null;
      return ok(views.length === 0 ? "No goals yet. Propose about three with goal-set (goal-list with sources: true lists the numbers you can use)." : `${views.length} ${views.length === 1 ? "goal" : "goals"}.`, { goals: goalViewsBrief(views), ...(catalog ? { sources: catalog } : {}) });
    }
    if (name === OPS_TOOL_NAMES.credentialList) {
      // A fresh check calls the providers, so one that was really checked in the last 15 minutes is not called again.
      const verified = p.verify === true ? await verifyCompany(env, companyId, { skipCheckedWithinMs: 15 * 60_000 }) : null;
      const list = await credentialList(env, companyId, { includeRetired: p.includeRetired === true });
      const empty = list.credentials.length === 0 ? " The register is empty: record each credential the company depends on with credential-record. Partners in Biz's own starting list loads only where the owner has ticked it in that company's Cockpit settings, never for a client company." : "";
      return ok(`${list.credentials.length} credentials in the register${list.problems.length ? `, ${list.problems.length} needing attention` : ""}${verified ? `; checked ${verified.verified} with their providers (${verified.invalid} refused)${verified.skippedRecent ? `, ${verified.skippedRecent} skipped as checked in the last 15 minutes` : ""}` : ""}. The register holds names and places, never values.${empty}`, { ...list, ...(verified ? { verification: verified } : {}) });
    }
    if (name === OPS_TOOL_NAMES.credentialRecord) {
      const result = await recordCredential(env, companyId, p, actor);
      return ok(result.message, { id: result.credential.id, created: result.created });
    }
    return fail(`Unknown tool ${name}`);
  } catch (error) {
    if (error instanceof ImprovementError || error instanceof GoalError || error instanceof CredentialError) return fail(error.message);
    env.ctx.logger.info("Cockpit tool failed", { name, error: message(error) });
    return fail(`${name} failed: ${message(error)}`);
  }
}
