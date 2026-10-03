/**
 * Runs the acceptance tools (declarations in `acceptance-tool-declarations.ts`).
 */
import type { ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { toolFail, toolOk } from "@partnersinbiz/pib-plugin-kit";
import { AcceptanceError, failurePlans, nextStep, settle, type Trigger } from "./acceptance-model.js";
import { abortRunById, finishRun, getRun, latestRuns, listRuns, recordRunStep, startRun, stepView, type RunRow } from "./acceptance.js";
import { ACCEPTANCE_TOOL_NAMES } from "./acceptance-tool-declarations.js";
import type { Env } from "./env.js";
import { message } from "./env.js";
import { JOURNEYS, journeyByKey } from "./journeys.js";

export { ACCEPTANCE_TOOL_SET } from "./acceptance-tool-declarations.js";

const ok = (content: string, data: unknown): ToolResult => toolOk(content, data) as ToolResult;
const fail = (text: string): ToolResult => toolFail(text) as ToolResult;

function params(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const text = (value: unknown, max = 300): string | undefined => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);

/** A run as the agent and the report read it (no raw state). */
function runBrief(row: RunRow): Record<string, unknown> {
  const journey = journeyByKey(row.journeyKey);
  const state = journey && journey.version === row.journeyVersion ? settle(journey, row.state) : row.state;
  return {
    runId: row.id,
    journey: row.journeyKey,
    version: row.journeyVersion,
    title: journey?.title ?? row.journeyKey,
    status: row.status,
    trigger: row.trigger,
    client: row.clientRef,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    summary: row.summary,
    steps: state.steps.map((s) => ({ id: s.id, status: s.status })),
    reportIssueId: row.reportIssueId,
    failureIssues: row.children,
  };
}

async function resolveIssueId(env: Env, companyId: string, ref: string | undefined): Promise<string | null> {
  if (!ref) return null;
  const issue = await env.ctx.issues.get(ref, companyId).catch(() => null);
  if (!issue) throw new AcceptanceError(`Issue ${ref} was not found in this company. Pass the acceptance request issue you were woken on.`);
  return issue.id;
}

export async function runAcceptanceTool(env: Env, name: string, raw: unknown, run: ToolRunContext): Promise<ToolResult> {
  const companyId = run.companyId;
  const p = params(raw);
  try {
    if (name === ACCEPTANCE_TOOL_NAMES.run) {
      const action = text(p.action, 20);
      if (action === "list") {
        const runs = await listRuns(env.ctx, companyId, { limit: 10 });
        return ok(`${JOURNEYS.length} journeys, ${runs.length} recent ${runs.length === 1 ? "run" : "runs"}.`, {
          journeys: JOURNEYS.map((j) => ({ key: j.key, title: j.title, version: j.version, schedule: j.schedule, steps: j.steps.length, summary: j.summary })),
          recent: runs.map(runBrief),
          how: "start a journey with a client from partnersinbiz.crm:create-canary-client.",
        });
      }
      if (action === "start") {
        const journey = text(p.journey, 60);
        const client = text(p.client, 200);
        if (!journey || !client) return fail("start needs journey and client (the canary client from partnersinbiz.crm:create-canary-client).");
        const issueId = await resolveIssueId(env, companyId, text(p.issueId, 100));
        const started = await startRun(env, companyId, { journey, client, issueId, agentId: run.agentId ?? null, trigger: "on-demand" as Trigger });
        return ok(`Started run ${started.run.id} of ${started.journey.title} (${started.journey.steps.length} steps). Step 1: ${started.next?.step.title ?? "none"}.`, {
          runId: started.run.id,
          journey: started.journey.key,
          trigger: started.run.trigger,
          step: started.next ? stepView(started.next, started.run.state) : null,
        });
      }
      const runId = text(p.runId, 60);
      if (!runId) return fail(`${action ?? "That action"} needs runId.`);
      if (action === "next") {
        const row = await getRun(env.ctx, companyId, runId);
        if (!row) return fail(`No run ${runId} in this company.`);
        const journey = journeyByKey(row.journeyKey);
        if (row.status !== "running" || !journey) return ok(`Run ${row.id} is ${row.status}: ${row.summary ?? ""}`, runBrief(row));
        const next = nextStep(journey, row.state);
        return ok(next ? `Step ${next.index} of ${next.total}: ${next.step.title}.` : "No step is left to give.", { runId: row.id, step: next ? stepView(next, row.state) : null });
      }
      if (action === "record") {
        const stepId = text(p.stepId, 60);
        if (!stepId) return fail("record needs stepId, the step the Cockpit gave you.");
        const done = await recordRunStep(env, companyId, {
          runId,
          stepId,
          input: p.input,
          output: p.output,
          error: text(p.error, 1000) ?? null,
          evidence: Array.isArray(p.evidence) ? (p.evidence as Array<{ kind?: unknown; ref?: unknown; note?: unknown }>) : undefined,
          skip: text(p.skip) ?? null,
        });
        const checks = done.result.checks.map((c) => `${c.ok ? "ok" : "NOT"}: ${c.detail}`);
        if (done.finished) {
          return ok(`Step ${stepId} ${done.result.status}. The run is finished: ${done.run.summary ?? done.status}`, {
            result: { step: stepId, status: done.result.status, checks },
            finished: true,
            ...runBrief(done.run),
            next: done.run.reportIssueId ? "The report is on the issue. Close your request when every journey has finished. Do not fix failures yourself." : "The report is kept with the run (acceptance-report).",
          });
        }
        return ok(`Step ${stepId} ${done.result.status}.${done.next ? ` Next: ${done.next.step.title}.` : ""}`, {
          result: { step: stepId, status: done.result.status, checks },
          finished: false,
          runId,
          step: done.next ? stepView(done.next, done.run.state) : null,
        });
      }
      if (action === "abort") {
        const row = await abortRunById(env, companyId, runId, text(p.reason) ?? "The agent stopped the run.");
        return ok(`Aborted run ${row.id}. An aborted run is not a pass.`, runBrief(row));
      }
      return fail("action is one of list, start, next, record, abort.");
    }
    if (name === ACCEPTANCE_TOOL_NAMES.report) {
      const runId = text(p.runId, 60);
      const journeyKey = text(p.journey, 60);
      if (!runId && !journeyKey) {
        const latest = await latestRuns(env.ctx, companyId);
        const passed = latest.filter((r) => r.status === "passed").length;
        return ok(latest.length === 0 ? "No acceptance run has finished yet." : `${passed} of ${latest.length} journeys pass on their latest run.`, { journeys: latest.map(runBrief) });
      }
      let row: RunRow | null = null;
      if (runId) row = await getRun(env.ctx, companyId, runId);
      else row = (await listRuns(env.ctx, companyId, { journey: journeyKey, limit: 1 }))[0] ?? null;
      if (!row) return fail(runId ? `No run ${runId} in this company.` : `No run of ${journeyKey} yet.`);
      let refiled = false;
      if (p.file === true && row.status !== "running") {
        const current: RunRow = row;
        const journey = journeyByKey(current.journeyKey);
        const missing = !!journey && journey.version === current.journeyVersion && (!current.reportIssueId || failurePlans(journey, settle(journey, current.state), { runId: current.id, reportLink: "" }).some((plan) => !current.children[plan.stepId]));
        if (missing) {
          row = await finishRun(env, current);
          refiled = true;
        }
      }
      return ok(`${row.summary ?? row.status}${refiled ? " The report and failure issues were filed again." : ""}`, { ...runBrief(row), report: row.report ?? "The run has not finished: no report yet.", refiled });
    }
    return fail(`Unknown tool ${name}`);
  } catch (error) {
    if (error instanceof AcceptanceError) return fail(error.message);
    env.ctx.logger.info("Cockpit tool failed", { name, error: message(error) });
    return fail(`${name} failed: ${message(error)}`);
  }
}
