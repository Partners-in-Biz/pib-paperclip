/**
 * Acceptance runs, worker part (Q5-1, Q5-2). The rules, the journeys and the
 * report text are in `acceptance-model.ts` and `journeys/*.json`; this stores the
 * runs, looks up what the agent cannot be trusted to say (an issue exists, an
 * approval reached somebody, a screenshot is on disk), files the report and the
 * failure issues, and opens the requests that start a run.
 *
 * Three ways in, all through `openAcceptanceRequest` (one request per company and
 * key, claimed first, so an event and a sweep never open two):
 * - every night (`acceptance-nightly`): the nightly journeys (and an end to any run nobody finished);
 * - a release: a plugin reports a different version than the one last seen, so
 *   the journeys that exercise it run (the host emits no plugin.upgraded event to
 *   plugins; the version in each plugin's setup status is the signal);
 * - on demand: a person (`acceptance.request`) or any agent starting a run.
 */
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { configSaved, createWorkIssue, type CockpitKpi, type HealthCheck } from "@partnersinbiz/pib-plugin-kit";
import { teamRoleChain, type TeamRoleKey } from "@partnersinbiz/pib-plugin-kit/team";
import { recordActivity } from "./activity.js";
import {
  AcceptanceError,
  describeExpectation,
  failurePlans,
  getPath,
  initRun,
  nextStep,
  recordStep,
  rehearsalIssueIds,
  renderValue,
  reportMarkdown,
  runFinished,
  runStatus,
  runSummary,
  settle,
  abortRun,
  abortState,
  type Evidence,
  type Facts,
  type Journey,
  type NextStep,
  type Report,
  type RunState,
  type RunStatus,
  type Trigger,
} from "./acceptance-model.js";
import { acceptanceAgentId } from "./acceptance-role.js";
import { ORIGIN, ORIGIN_ID } from "./constants.js";
import { getRoles, listRoles } from "./db.js";
import { message, throwIfEveryCompanyFailed, type Env } from "./env.js";
import { JOURNEYS, journeyByKey, journeysFor } from "./journeys.js";
import { NAMESPACE } from "./namespace.js";
import { currentRoles, routeFromRoles } from "./roles.js";

const RUNS = `${NAMESPACE}.acceptance_runs`;
const REQUESTS = `${NAMESPACE}.acceptance_requests`;
const VERSIONS = `${NAMESPACE}.plugin_versions`;
type Raw = Record<string, unknown>;

/** A run nobody has touched for this long is stale: the next start aborts it. */
export const STALE_RUN_MS = 2 * 3_600_000;
/** A failing journey is a warning for a day, then red: nobody fixed it. */
export const FAILING_BAD_AFTER_MS = 24 * 3_600_000;
const COLUMNS = "id, company_id, journey_key, journey_version, client_ref, trigger, trigger_ref, status, state, request_issue_id, report_issue_id, child_issue_ids, agent_id, summary, report, started_at, updated_at, finished_at";

export interface RunRow {
  id: string;
  companyId: string;
  journeyKey: string;
  journeyVersion: number;
  clientRef: string;
  trigger: Trigger;
  triggerRef: string | null;
  status: RunStatus;
  state: RunState;
  requestIssueId: string | null;
  reportIssueId: string | null;
  /** Failure issue per failed step id. */
  children: Record<string, string>;
  agentId: string | null;
  summary: string | null;
  report: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

function json<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

const iso = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  if (value == null || value === "") return null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const str = (value: unknown): string | null => (value == null || value === "" ? null : String(value));

function rowFrom(r: Raw): RunRow {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    journeyKey: String(r.journey_key),
    journeyVersion: Number(r.journey_version),
    clientRef: String(r.client_ref),
    trigger: String(r.trigger) as Trigger,
    triggerRef: str(r.trigger_ref),
    status: String(r.status) as RunStatus,
    state: json<RunState>(r.state, { journey: String(r.journey_key), version: Number(r.journey_version), clientRef: String(r.client_ref), captures: {}, steps: [] }),
    requestIssueId: str(r.request_issue_id),
    reportIssueId: str(r.report_issue_id),
    children: json<Record<string, string>>(r.child_issue_ids, {}),
    agentId: str(r.agent_id),
    summary: str(r.summary),
    report: str(r.report),
    startedAt: iso(r.started_at) ?? "",
    updatedAt: iso(r.updated_at) ?? "",
    finishedAt: iso(r.finished_at),
  };
}

const newId = (): string => `run${randomBytes(6).toString("hex")}`;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export async function getRun(ctx: PluginContext, companyId: string, id: string): Promise<RunRow | null> {
  const rows = await ctx.db.query<Raw>(`SELECT ${COLUMNS} FROM ${RUNS} WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return rows[0] ? rowFrom(rows[0]) : null;
}

export async function listRuns(ctx: PluginContext, companyId: string, options: { journey?: string; status?: RunStatus; limit?: number } = {}): Promise<RunRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const where = ["company_id = $1"];
  const params: unknown[] = [companyId];
  if (options.journey) {
    params.push(options.journey);
    where.push(`journey_key = $${params.length}`);
  }
  if (options.status) {
    params.push(options.status);
    where.push(`status = $${params.length}`);
  }
  params.push(limit);
  const rows = await ctx.db.query<Raw>(`SELECT ${COLUMNS} FROM ${RUNS} WHERE ${where.join(" AND ")} ORDER BY started_at DESC LIMIT $${params.length}`, params);
  return rows.map(rowFrom);
}

/** The newest finished run of each journey (the state of each, today). */
export async function latestRuns(ctx: PluginContext, companyId: string): Promise<RunRow[]> {
  const rows = await ctx.db.query<Raw>(`SELECT DISTINCT ON (journey_key) ${COLUMNS} FROM ${RUNS} WHERE company_id = $1 AND status <> 'running' ORDER BY journey_key, started_at DESC`, [companyId]);
  return rows.map(rowFrom);
}

async function saveRun(env: Env, run: RunRow, patch: { state: RunState; status?: RunStatus; summary?: string | null; report?: string | null; reportIssueId?: string | null; children?: Record<string, string>; finished?: boolean; agentId?: string | null }): Promise<RunRow> {
  const now = env.now().toISOString();
  await env.ctx.db.execute(
    `UPDATE ${RUNS} SET state = $3::jsonb, status = $4, summary = $5, report = $6, report_issue_id = $7, child_issue_ids = $8::jsonb, agent_id = $9, updated_at = $10, finished_at = $11 WHERE company_id = $1 AND id = $2`,
    [
      run.companyId,
      run.id,
      JSON.stringify(patch.state),
      patch.status ?? run.status,
      patch.summary !== undefined ? patch.summary : run.summary,
      patch.report !== undefined ? patch.report : run.report,
      patch.reportIssueId !== undefined ? patch.reportIssueId : run.reportIssueId,
      JSON.stringify(patch.children ?? run.children),
      patch.agentId !== undefined ? patch.agentId : run.agentId,
      now,
      patch.finished ? now : run.finishedAt,
    ],
  );
  return (await getRun(env.ctx, run.companyId, run.id)) ?? run;
}

// ---------------------------------------------------------------------------
// Starting and working a run
// ---------------------------------------------------------------------------

/** What the agent is shown for a step: the call to make, the answer to check and what to attach. */
export function stepView(next: NextStep, state: RunState): Record<string, unknown> {
  const { step } = next;
  return {
    id: step.id,
    number: `${next.index}/${next.total}`,
    title: step.title,
    kind: step.kind,
    ...(step.tool ? { tool: step.tool } : {}),
    ...(next.input !== undefined ? { input: next.input } : {}),
    ...(next.missing.length ? { unfilled: next.missing } : {}),
    ...(step.note ? { note: renderValue(step.note, state.captures) } : {}),
    mustShow: step.expect.map((e) => describeExpectation(e, state.captures)),
    ...(step.probe ? { cockpitChecks: step.probe.kind === "issue" ? "The Cockpit looks the issue up itself." : "The Cockpit looks up who the approval reached." } : {}),
    ...(step.evidence?.length ? { attach: step.evidence } : {}),
    ...(step.always ? { always: true } : {}),
    ...(step.optional ? { mayBeSkipped: true } : {}),
    then: `Record it with acceptance-run action "record" (runId, stepId "${step.id}"): the input you actually used, the tool's data as output (or error).`,
  };
}

async function requestFor(env: Env, companyId: string, issueId: string | null): Promise<{ trigger: Trigger; key: string } | null> {
  if (!issueId) return null;
  const rows = await env.ctx.db.query<Raw>(`SELECT trigger, request_key FROM ${REQUESTS} WHERE company_id = $1 AND issue_id = $2 LIMIT 1`, [companyId, issueId]);
  return rows[0] ? { trigger: String(rows[0].trigger) as Trigger, key: String(rows[0].request_key) } : null;
}

/** Starts a journey on the canary client. Refuses any other client, an unknown journey and a journey that is already being worked. */
export async function startRun(env: Env, companyId: string, input: { journey: string; client: string; issueId?: string | null; agentId?: string | null; trigger?: Trigger }): Promise<{ run: RunRow; journey: Journey; next: NextStep | null }> {
  const journey = journeyByKey(input.journey);
  if (!journey) throw new AcceptanceError(`There is no journey ${JSON.stringify(input.journey)}. They are: ${JOURNEYS.map((j) => j.key).join(", ")}.`);
  const now = env.now();
  // The canary is ONE client shared by every journey and each journey ends by removing it, so a second journey started while another is open would lose its client under it (the first live three-journey request did exactly that): one open run per company, whatever the journey.
  const open = await listRuns(env.ctx, companyId, { status: "running", limit: 10 });
  for (const other of open) {
    if (now.getTime() - Date.parse(other.updatedAt) < STALE_RUN_MS) throw new AcceptanceError(`Run ${other.id} of ${other.journeyKey} is still open (started ${other.startedAt.slice(0, 16).replace("T", " ")}). Journeys run one at a time, because they share one canary client and each ends by removing it: continue that run with action "next" and runId ${other.id} until it is finished (its last step, the cleanup, runs even after a failure), or abort it, then start ${journey.key}.`);
    await abortStaleRun(env, other, "Nobody finished this run: it was aborted when a newer one started.");
  }
  const id = newId();
  const state = initRun(journey, input.client, id, now.toISOString().slice(0, 10));
  const request = await requestFor(env, companyId, input.issueId ?? null);
  const trigger = request?.trigger ?? input.trigger ?? "on-demand";
  await env.ctx.db.execute(
    `INSERT INTO ${RUNS} (id, company_id, journey_key, journey_version, client_ref, trigger, trigger_ref, status, state, request_issue_id, agent_id, started_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', $8::jsonb, $9, $10, $11, $11)`,
    [id, companyId, journey.key, journey.version, input.client, trigger, request?.key ?? null, JSON.stringify(state), input.issueId ?? null, input.agentId ?? null, now.toISOString()],
  );
  const run = (await getRun(env.ctx, companyId, id))!;
  return { run, journey, next: nextStep(journey, state) };
}

/**
 * Ends a run nobody finished. Its approvals are cancelled and its report written the way
 * any ending is (`finishRun`): an agent that died after an approval step passed must not
 * leave a canary invoice, sequence or report waiting in the owner's queue.
 */
export async function abortStaleRun(env: Env, run: RunRow, reason: string): Promise<RunRow> {
  const aborted = await saveRun(env, run, { state: abortState(run.state, reason), status: "aborted", summary: "Aborted: nobody finished it.", finished: true });
  if (journeyByKey(run.journeyKey)) return finishRun(env, aborted);
  // The journey is gone (a release removed it): there is no report to write, but the approvals and the rehearsal's own issues still go.
  await cancelCanaryApprovals(env, run.companyId, aborted.state.approvals ?? [], run.id);
  await cancelCanaryApprovals(env, run.companyId, aborted.state.rehearsalIssues ?? [], run.id, "issue");
  return aborted;
}

/** Aborts this company's runs nobody has touched for longer than STALE_RUN_MS (the nightly job calls it, so a dead run does not wait for the next start of the same journey). */
export async function sweepStaleRuns(env: Env, companyId: string): Promise<number> {
  const now = env.now().getTime();
  let swept = 0;
  for (const run of await listRuns(env.ctx, companyId, { status: "running", limit: 100 })) {
    if (now - Date.parse(run.updatedAt) < STALE_RUN_MS) continue;
    try {
      await abortStaleRun(env, run, "Nobody finished this run: the nightly sweep aborted it.");
      swept += 1;
    } catch (error) {
      env.ctx.logger.info("Acceptance: a stale run could not be aborted", { companyId, runId: run.id, error: message(error) });
    }
  }
  return swept;
}

const ALLOWED_ROOTS = ["/tmp/", "/var/tmp/", "/home/paperclip/"];
const SHOT_MIN_BYTES = 2_000;
const SHOT_MAX_BYTES = 12 * 1024 * 1024;

/** A screenshot the agent names must be a real, plausible image file in a place agents write: its size, or null. */
async function screenshotBytes(env: Env, path: string): Promise<number | null> {
  if (!path.startsWith("/") || path.includes("..") || !ALLOWED_ROOTS.some((root) => path.startsWith(root)) || !/\.(png|jpe?g|webp)$/i.test(path)) return null;
  const found = env.statFile ? await env.statFile(path) : await stat(path).then((s) => ({ size: s.size })).catch(() => null);
  if (!found || found.size < SHOT_MIN_BYTES || found.size > SHOT_MAX_BYTES) return null;
  return found.size;
}

async function lookupIssue(env: Env, companyId: string, id: unknown): Promise<NonNullable<Facts["issue"]> | null> {
  if (typeof id !== "string" || !id) return null;
  try {
    const issue = await env.ctx.issues.get(id, companyId);
    if (!issue) return null;
    return { id: String(issue.id), status: String(issue.status), title: String(issue.title ?? ""), description: String(issue.description ?? ""), assigneeAgentId: issue.assigneeAgentId ?? null, assigneeUserId: issue.assigneeUserId ?? null };
  } catch {
    return null;
  }
}

/** Who an approval reached, from its assignee and the company's roles. */
export function assignedTo(issue: { assigneeAgentId: string | null; assigneeUserId: string | null }, roles: { reviewerAgentId: string | null; operatorAgentId: string | null } | null): NonNullable<Facts["assignedTo"]> {
  if (issue.assigneeAgentId) return issue.assigneeAgentId === roles?.reviewerAgentId ? "reviewer" : "operator";
  return issue.assigneeUserId ? "person" : "nobody";
}

async function gatherFacts(env: Env, companyId: string, journey: Journey, stepId: string, report: Report, evidence: Evidence[]): Promise<{ facts: Facts; approvalIssueId: string | null }> {
  const step = journey.steps.find((s) => s.id === stepId)!;
  const facts: Facts = {};
  let approvalIssueId: string | null = null;
  if (step.probe && !report.skip && !report.error) {
    const id = getPath(report.output, step.probe.idPath).value;
    facts.issue = await lookupIssue(env, companyId, id);
    if (step.probe.kind === "approval-route") {
      const roles = await getRoles(env.ctx, companyId).catch(() => null);
      facts.reviewOutward = roles?.reviewOutward === true && !!roles.reviewerAgentId;
      facts.assignedTo = facts.issue ? assignedTo(facts.issue, roles) : "nobody";
      if (facts.issue) approvalIssueId = facts.issue.id;
    }
  }
  const missing: string[] = [];
  for (const e of evidence) {
    if (e.kind !== "screenshot") continue;
    const bytes = await screenshotBytes(env, e.ref);
    if (bytes === null) missing.push(e.ref);
    else e.bytes = bytes;
  }
  if (missing.length) facts.missingFiles = missing;
  return { facts, approvalIssueId };
}

export interface RecordInput {
  runId: string;
  stepId: string;
  input?: unknown;
  output?: unknown;
  error?: string | null;
  evidence?: Array<{ kind?: unknown; ref?: unknown; note?: unknown }>;
  skip?: string | null;
}

const EVIDENCE_KINDS = new Set(["screenshot", "curl", "output", "link", "note"]);

/** The names an agent naturally gives the file, command, link or text of an evidence item; `ref` is the documented one. */
const REF_ALIASES = ["ref", "path", "file", "filepath", "url", "link", "command", "text", "value"] as const;

function evidenceRef(e: Record<string, unknown>): string | null {
  for (const key of REF_ALIASES) {
    const value = e[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function cleanEvidence(raw: RecordInput["evidence"]): Evidence[] {
  return (raw ?? [])
    .slice(0, 8)
    .map((e) => {
      if (!e || typeof e !== "object" || typeof e.kind !== "string" || !EVIDENCE_KINDS.has(e.kind)) return null;
      const ref = evidenceRef(e as Record<string, unknown>);
      if (!ref) return null;
      return { kind: e.kind as Evidence["kind"], ref: ref.slice(0, 600), ...(typeof e.note === "string" && e.note.trim() ? { note: e.note.slice(0, 300) } : {}) } as Evidence;
    })
    .filter((e): e is Evidence => e !== null);
}

export interface RecordResult {
  run: RunRow;
  result: ReturnType<typeof recordStep>["result"];
  next: NextStep | null;
  finished: boolean;
  status: RunStatus;
}

/** Records what the agent reported for the step it was given, decides the step, and ends the run when it is over. */
export async function recordRunStep(env: Env, companyId: string, input: RecordInput): Promise<RecordResult> {
  const run = await getRun(env.ctx, companyId, input.runId);
  if (!run) throw new AcceptanceError(`No run ${input.runId} in this company.`);
  if (run.status !== "running") throw new AcceptanceError(`Run ${run.id} is already ${run.status}.`);
  const journey = journeyByKey(run.journeyKey);
  if (!journey || journey.version !== run.journeyVersion) {
    await saveRun(env, run, { state: abortState(run.state, `The journey changed (v${run.journeyVersion} to ${journey ? `v${journey.version}` : "gone"}) while this run was open: start it again.`), status: "aborted", summary: "Aborted: the journey changed while it ran.", finished: true });
    throw new AcceptanceError("The journey changed (a release) while this run was open, so the run was aborted. Start it again.");
  }
  const evidence = cleanEvidence(input.evidence);
  const report: Report = { input: input.input, output: input.output, error: input.error ?? null, evidence, evidenceIgnored: Math.max(0, Math.min((input.evidence ?? []).length, 8) - evidence.length), skip: input.skip ?? null };
  const { facts, approvalIssueId } = await gatherFacts(env, companyId, journey, input.stepId, report, evidence);
  const recorded = recordStep(journey, run.state, input.stepId, report, facts, env.now().toISOString());
  let state = recorded.state;
  if (approvalIssueId && recorded.result.status === "passed") state = { ...state, approvals: [...new Set([...(state.approvals ?? []), approvalIssueId])] };
  // An issue the step opened for the rehearsal exists whether the step then passed or not, so it is remembered either way (never for a call that errored or was skipped, or for input that was not the canary's).
  if (!recorded.aborted && !report.error && !report.skip) {
    const opened = rehearsalIssueIds(journey.steps.find((s) => s.id === input.stepId)!, report.output);
    if (opened.length) state = { ...state, rehearsalIssues: [...new Set([...(state.rehearsalIssues ?? []), ...opened])] };
  }
  const status = runStatus(journey, state);
  let saved = await saveRun(env, run, { state, status: status === "running" ? "running" : run.status });
  if (runFinished(journey, state)) saved = await finishRun(env, saved);
  return { run: saved, result: recorded.result, next: saved.status === "running" ? nextStep(journey, saved.state) : null, finished: saved.status !== "running", status: saved.status };
}

export async function abortRunById(env: Env, companyId: string, runId: string, reason: string): Promise<RunRow> {
  const run = await getRun(env.ctx, companyId, runId);
  if (!run) throw new AcceptanceError(`No run ${runId} in this company.`);
  if (run.status !== "running") throw new AcceptanceError(`Run ${run.id} is already ${run.status}.`);
  const journey = journeyByKey(run.journeyKey);
  if (!journey) throw new AcceptanceError(`The journey ${run.journeyKey} no longer exists.`);
  const aborted = await saveRun(env, run, { state: abortRun(journey, run.state, reason), status: "aborted" });
  return finishRun(env, aborted);
}

// ---------------------------------------------------------------------------
// Ending a run: the canary's approvals, the report and the failures
// ---------------------------------------------------------------------------

const CANARY_TEXT = /canary-[a-z0-9]{4,}|canary\.invalid|PiB Canary/i;
const CLOSED = new Set(["done", "cancelled"]);

/**
 * A rehearsal that tests where an approval goes leaves the approval behind. The
 * canary's own are cancelled when the run ends (a refusal: nothing is sent), so
 * the owner is never asked to decide a test. The same goes for an issue a step
 * opened only because of the rehearsal (`cleanupIssues`: the work issue a document
 * opens for the deal desk), which would otherwise wake an agent for nothing and stay
 * open. Only an issue whose text names the canary is touched; anything else is left
 * open and said so in the report.
 */
export async function cancelCanaryApprovals(env: Env, companyId: string, ids: string[], runId: string, what: "approval" | "issue" = "approval"): Promise<{ cancelled: string[]; left: string[] }> {
  const out = { cancelled: [] as string[], left: [] as string[] };
  for (const id of ids) {
    const issue = await lookupIssue(env, companyId, id);
    if (!issue || CLOSED.has(issue.status)) continue;
    if (!CANARY_TEXT.test(`${issue.title}\n${issue.description}`)) {
      out.left.push(id);
      continue;
    }
    try {
      await env.ctx.issues.update(id, { status: "cancelled" }, companyId);
      await env.ctx.issues.createComment(id, what === "approval" ? `Cancelled by acceptance run ${runId}: this approval was opened for the canary client to check where it goes. Nothing was sent.` : `Cancelled by acceptance run ${runId}: this issue was opened for the canary client by a rehearsal of the product, so nothing real depends on it.`, companyId).catch(() => undefined);
      out.cancelled.push(id);
    } catch (error) {
      env.ctx.logger.info("Acceptance: a canary issue could not be cancelled", { companyId, issueId: id, error: message(error) });
      out.left.push(id);
    }
  }
  return out;
}

/** The originId a failure issue starts with: one (journey, step) pair, then the run that opened it. */
export const failureOriginPrefix = (journeyKey: string, stepId: string): string => `${ORIGIN_ID.acceptance}fail:${journeyKey}:${stepId}:`;
const OPEN_STATUSES = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);

/** The oldest still-open failure issue for this journey step, from an earlier run, or null. */
async function openFailureIssue(env: Env, companyId: string, journeyKey: string, stepId: string): Promise<{ id: string; identifier?: string | null; originId: string } | null> {
  try {
    const prefix = failureOriginPrefix(journeyKey, stepId);
    const found = (await env.ctx.issues.list({ companyId, originKind: ORIGIN.acceptance as `plugin:${string}`, limit: 200 })) as unknown as Array<{ id: string; identifier?: string | null; status: string; originId?: string | null; createdAt?: string | null }>;
    const open = found.filter((i) => String(i.originId ?? "").startsWith(prefix) && OPEN_STATUSES.has(i.status)).sort((a, b) => Date.parse(String(a.createdAt ?? 0)) - Date.parse(String(b.createdAt ?? 0)));
    return open[0] ? { id: open[0].id, identifier: open[0].identifier ?? null, originId: String(open[0].originId) } : null;
  } catch {
    // Unable to look: open a new one rather than lose the failure.
    return null;
  }
}

function linkFor(prefix: string | null, issue: { id: string; identifier?: string | null }): string {
  return `${prefix ? `/${prefix}` : ""}/issues/${issue.identifier ?? issue.id}`;
}

/** Writes the report, opens a failure issue for each failed step and ends the run. Safe to call again: nothing is opened twice. */
export async function finishRun(env: Env, run: RunRow): Promise<RunRow> {
  const journey = journeyByKey(run.journeyKey);
  if (!journey) return run;
  const companyId = run.companyId;
  const state = settle(journey, run.state);
  const status = runStatus(journey, state);
  const now = env.now().toISOString();
  const company = await env.ctx.companies.get(companyId).catch(() => null);
  const prefix = company?.issuePrefix ?? null;
  const roles = await currentRoles(env, companyId).catch(() => null);
  const cleaned = await cancelCanaryApprovals(env, companyId, state.approvals ?? [], run.id);
  const rehearsal = await cancelCanaryApprovals(env, companyId, state.rehearsalIssues ?? [], run.id, "issue");

  // Where the report lives: the request the run answered, else (for a failure) a new issue for the Operator.
  let reportIssueId = run.reportIssueId ?? run.requestIssueId;
  let reportRef: { id: string; identifier?: string | null } | null = null;
  if (reportIssueId) reportRef = await env.ctx.issues.get(reportIssueId, companyId).catch(() => null);
  const failed = status !== "passed";
  if (!reportRef && failed) {
    const route = routeFromRoles(roles, ["operator"]);
    try {
      const made = await createWorkIssue(env.ctx, {
        companyId,
        title: `Acceptance ${status === "failed" ? "failed" : "stopped"}: ${journey.title}`,
        description: `The acceptance journey **${journey.title}** ${status === "failed" ? "failed" : "was aborted"}. The report is posted below; each failed step has its own issue for the role that owns it.`,
        priority: "high",
        originKind: ORIGIN.acceptance as `plugin:${string}`,
        originId: `${ORIGIN_ID.acceptance}report:${run.id}`,
        ...(route.assigneeAgentId ? { assigneeAgentId: route.assigneeAgentId } : route.assigneeUserId ? { assigneeUserId: route.assigneeUserId } : {}),
        wakeReason: `Acceptance ${status}: ${journey.title}`,
      });
      reportIssueId = made.id;
      reportRef = await env.ctx.issues.get(made.id, companyId).catch(() => ({ id: made.id }));
    } catch (error) {
      env.ctx.logger.info("Acceptance: the report issue could not be opened", { companyId, runId: run.id, error: message(error) });
    }
  }
  const reportLink = reportRef ? linkFor(prefix, reportRef) : "(the report is kept with the run)";

  // One issue per failed step, for the role that owns it (never twice). A step that keeps failing night after night
  // is one open issue with a comment per failure, not a new issue (and a new wake-up) every night.
  const children = { ...run.children };
  for (const plan of failurePlans(journey, state, { runId: run.id, reportLink })) {
    if (children[plan.stepId]) continue;
    const open = await openFailureIssue(env, companyId, journey.key, plan.stepId);
    if (open) {
      const detail = plan.checks.map((c) => `- ${c.detail}`).join("\n");
      // This run's own issue (a re-file after a crash) is not an earlier failure: link it, say nothing.
      if (open.originId !== `${failureOriginPrefix(journey.key, plan.stepId)}${run.id}`) await env.ctx.issues.createComment(open.id, `Failed again in acceptance run \`${run.id}\` (${now.slice(0, 10)}), journey v${journey.version}.\n\n${detail}\n\nReport and evidence: ${reportLink}. This issue stays open until the step passes; the next run checks it again.`, companyId).catch((error) => env.ctx.logger.info("Acceptance: the repeat failure comment was not posted", { companyId, runId: run.id, error: message(error) }));
      children[plan.stepId] = linkFor(prefix, { id: open.id });
      continue;
    }
    const route = routeFromRoles(roles, teamRoleChain(plan.ownerRole as TeamRoleKey));
    try {
      const made = await createWorkIssue(env.ctx, {
        companyId,
        title: plan.title,
        description: plan.description,
        priority: "high",
        originKind: ORIGIN.acceptance as `plugin:${string}`,
        originId: `${failureOriginPrefix(journey.key, plan.stepId)}${run.id}`,
        ...(reportIssueId ? { parentId: reportIssueId } : {}),
        ...(route.assigneeAgentId ? { assigneeAgentId: route.assigneeAgentId } : route.assigneeUserId ? { assigneeUserId: route.assigneeUserId } : {}),
        wakeReason: `Acceptance failure: ${journey.title}`,
      });
      children[plan.stepId] = linkFor(prefix, { id: made.id });
    } catch (error) {
      env.ctx.logger.info("Acceptance: a failure issue could not be opened", { companyId, runId: run.id, stepId: plan.stepId, error: message(error) });
    }
  }

  const markdown = [
    reportMarkdown(journey, state, { runId: run.id, trigger: run.trigger, triggerRef: run.triggerRef, startedAt: run.startedAt, finishedAt: now, children }),
    ...(cleaned.cancelled.length ? ["", `The canary's own approval${cleaned.cancelled.length === 1 ? " was" : "s were"} cancelled (${cleaned.cancelled.length}): nothing was sent.`] : []),
    ...(rehearsal.cancelled.length ? ["", `The work issue${rehearsal.cancelled.length === 1 ? "" : "s"} the rehearsal opened for the canary ${rehearsal.cancelled.length === 1 ? "was" : "were"} cancelled (${rehearsal.cancelled.length}): nobody is left waiting on it.`] : []),
    ...([...cleaned.left, ...rehearsal.left].length ? ["", `Left open, because it does not name the canary: ${[...cleaned.left, ...rehearsal.left].join(", ")}. A person looks at it.`] : []),
  ].join("\n");
  if (reportRef) await env.ctx.issues.createComment(reportRef.id, markdown, companyId).catch((error) => env.ctx.logger.info("Acceptance: the report comment was not posted", { runId: run.id, error: message(error) }));
  const saved = await saveRun(env, run, { state, status, summary: runSummary(journey, state), report: markdown, reportIssueId: reportIssueId ?? null, children, finished: true });
  // A failure, or a release that was checked, is news; a quiet nightly pass is not.
  if (status !== "passed" || run.trigger === "release") {
    await recordActivity(env.ctx, companyId, {
      key: `acceptance:${run.id}`,
      kind: "acceptance",
      at: now,
      text: `Acceptance ${status === "passed" ? "passed" : status}: ${journey.title}${run.trigger === "release" && run.triggerRef ? ` (${run.triggerRef.replace(/^release:/, "release of ")})` : ""}`,
      href: reportRef ? `/issues/${reportRef.identifier ?? reportRef.id}` : "/cockpit",
      agentId: run.agentId,
    }).catch(() => false);
  }
  return saved;
}

// ---------------------------------------------------------------------------
// Requests: what wakes the Acceptance agent
// ---------------------------------------------------------------------------

export function requestText(input: { journeys: Journey[]; why: string; date: string }): { title: string; description: string } {
  const names = input.journeys.map((j) => j.title);
  const lines = [
    `${input.why} Use the **pib-acceptance** skill and work each journey below on the canary client.`,
    "",
    ...input.journeys.map((j) => `- **${j.title}** (\`${j.key}\`, v${j.version}): ${j.summary}`),
    "",
    "For each journey:",
    "1. Call `partnersinbiz.crm:create-canary-client` and take its `client`.",
    "2. Call `partnersinbiz.cockpit:acceptance-run` with action `start`, the journey key, that client and this issue's id. It hands you the first step; make the call it names, then `record` the input you used and the tool's data. Repeat until it says the run is finished.",
    "3. The Cockpit writes the report on this issue and opens an issue for the role that owns each failed step. Do not fix a failure yourself and do not work around it.",
    "",
    "Close this issue when every journey has finished: one line saying how many passed and failed. Never approve, send or publish anything.",
  ];
  const first = names.length === 1 ? names[0]! : `${names.length} journeys`;
  return { title: `Acceptance request: ${first} (${input.date})`, description: lines.join("\n") };
}

export type RequestResult = { action: "opened"; issueId: string } | { action: "exists" | "none" | "no-agent" } | { action: "failed"; reason: string };

/** Opens one request for the Acceptance agent, once per (company, key). Without a linked agent nothing is claimed: the next one (tomorrow's) tries again. */
export async function openAcceptanceRequest(env: Env, companyId: string, input: { key: string; trigger: Trigger; journeys: Journey[]; why: string }): Promise<RequestResult> {
  if (input.journeys.length === 0) return { action: "none" };
  const agentId = await acceptanceAgentId(env, companyId);
  if (!agentId) return { action: "no-agent" };
  const now = env.now();
  const claim = await env.ctx.db.execute(
    `INSERT INTO ${REQUESTS} (company_id, request_key, trigger, journeys, created_at) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (company_id, request_key) DO NOTHING`,
    [companyId, input.key.slice(0, 200), input.trigger, JSON.stringify(input.journeys.map((j) => j.key)), now.toISOString()],
  );
  if ((claim.rowCount ?? 0) === 0) return { action: "exists" };
  try {
    const text = requestText({ journeys: input.journeys, why: input.why, date: now.toISOString().slice(0, 10) });
    const made = await createWorkIssue(env.ctx, {
      companyId,
      title: text.title,
      description: text.description,
      priority: input.trigger === "release" ? "high" : "medium",
      originKind: ORIGIN.acceptance as `plugin:${string}`,
      originId: `${ORIGIN_ID.acceptance}${input.key}`,
      assigneeAgentId: agentId,
      wakeReason: `Acceptance request: ${input.trigger}`,
    });
    await env.ctx.db.execute(`UPDATE ${REQUESTS} SET issue_id = $3 WHERE company_id = $1 AND request_key = $2`, [companyId, input.key.slice(0, 200), made.id]);
    return { action: "opened", issueId: made.id };
  } catch (error) {
    // Let the next try open it.
    await env.ctx.db.execute(`DELETE FROM ${REQUESTS} WHERE company_id = $1 AND request_key = $2 AND issue_id IS NULL`, [companyId, input.key.slice(0, 200)]).catch(() => undefined);
    return { action: "failed", reason: message(error) };
  }
}

/** The nightly job: one request per company that staffed an Acceptance agent, for the nightly journeys. */
export async function nightlyAcceptance(env: Env): Promise<Record<string, number>> {
  const total: Record<string, number> = { companies: 0, opened: 0, exists: 0, noAgent: 0, failed: 0, swept: 0 };
  const date = env.now().toISOString().slice(0, 10);
  for (const row of await listRoles(env.ctx)) {
    if (!(await configSaved(env.ctx, row.companyId))) continue;
    total.companies = (total.companies ?? 0) + 1;
    try {
      // First, runs an agent walked away from: their approvals are cancelled before tonight's request opens.
      total.swept = (total.swept ?? 0) + (await sweepStaleRuns(env, row.companyId));
      const result = await openAcceptanceRequest(env, row.companyId, { key: `nightly:${date}`, trigger: "nightly", journeys: journeysFor("nightly"), why: "The nightly check: is the product still working for a customer?" });
      if (result.action === "opened") total.opened = (total.opened ?? 0) + 1;
      else if (result.action === "exists") total.exists = (total.exists ?? 0) + 1;
      else if (result.action === "no-agent") total.noAgent = (total.noAgent ?? 0) + 1;
      else if (result.action === "failed") {
        total.failed = (total.failed ?? 0) + 1;
        env.ctx.logger.info("Acceptance request not opened", { companyId: row.companyId, reason: result.reason });
      }
    } catch (error) {
      total.failed = (total.failed ?? 0) + 1;
      env.ctx.logger.info("Nightly acceptance failed for a company", { companyId: row.companyId, error: message(error) });
    }
  }
  throwIfEveryCompanyFailed("The nightly acceptance", total.companies ?? 0, total.failed ?? 0);
  return total;
}

/**
 * A plugin reported a version (its setup status): a different one from the last seen
 * is a release, and the journeys that exercise that plugin get a request. The first
 * time a plugin is seen only records it, so the Cockpit's own first deploy does not
 * start every journey at once.
 */
export async function onPluginVersion(env: Env, companyId: string, pluginKey: string, version: string | null | undefined): Promise<"ignored" | "seen" | "new" | "no-journey" | RequestResult["action"]> {
  const v = typeof version === "string" ? version.trim().slice(0, 40) : "";
  if (!v || !/^partnersinbiz\.[a-z]+$/.test(pluginKey)) return "ignored";
  const rows = await env.ctx.db.query<Raw>(`SELECT version FROM ${VERSIONS} WHERE company_id = $1 AND plugin_key = $2`, [companyId, pluginKey]);
  const previous = rows[0] ? String(rows[0].version) : null;
  if (previous === v) return "seen";
  await env.ctx.db.execute(
    `INSERT INTO ${VERSIONS} (company_id, plugin_key, version, seen_at) VALUES ($1, $2, $3, $4) ON CONFLICT (company_id, plugin_key) DO UPDATE SET version = EXCLUDED.version, seen_at = EXCLUDED.seen_at`,
    [companyId, pluginKey, v, env.now().toISOString()],
  );
  if (!previous) return "new";
  const journeys = journeysFor("release", pluginKey);
  if (journeys.length === 0) return "no-journey";
  const result = await openAcceptanceRequest(env, companyId, { key: `release:${pluginKey}:${v}`, trigger: "release", journeys, why: `${pluginKey.replace("partnersinbiz.", "")} was released (${previous} to ${v}).` });
  return result.action;
}

/** A person asks for a check now (all journeys, or the named ones). */
export async function requestAcceptanceNow(env: Env, companyId: string, keys: string[] | null): Promise<RequestResult> {
  const journeys = keys && keys.length ? keys.map((k) => journeyByKey(k)).filter((j): j is Journey => !!j) : JOURNEYS;
  if (keys && keys.length && journeys.length === 0) throw new AcceptanceError(`No journey matches ${keys.join(", ")}. They are: ${JOURNEYS.map((j) => j.key).join(", ")}.`);
  return openAcceptanceRequest(env, companyId, { key: `manual:${env.now().getTime()}`, trigger: "on-demand", journeys, why: "A check was asked for." });
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * What the Cockpit says about acceptance once an Acceptance agent is staffed: a
 * journey that failed its last run (a warning for a day, then red), and a nightly
 * request nobody worked. Silent when no agent is staffed (the role is optional).
 */
export async function acceptanceChecks(env: Env, companyId: string): Promise<{ health: HealthCheck[]; kpis: CockpitKpi[] }> {
  const out: { health: HealthCheck[]; kpis: CockpitKpi[] } = { health: [], kpis: [] };
  if (!(await acceptanceAgentId(env, companyId))) return out;
  const now = env.now();
  const latest = await latestRuns(env.ctx, companyId);
  const failing = latest.filter((r) => r.status === "failed");
  const recent = latest.filter((r) => now.getTime() - Date.parse(r.startedAt) < 7 * 86_400_000);
  if (recent.length) {
    const passed = recent.filter((r) => r.status === "passed").length;
    out.kpis.push({ key: "acceptance_passing", label: "Acceptance journeys passing", value: `${passed} of ${recent.length}`, raw: passed, hint: "Each journey's latest run in the last 7 days, on the canary client", tone: passed === recent.length ? "ok" : "warn", group: "delivery", href: "/cockpit" });
  }
  if (failing.length) {
    const oldest = failing.reduce((a, b) => (Date.parse(a.finishedAt ?? a.startedAt) < Date.parse(b.finishedAt ?? b.startedAt) ? a : b));
    const since = oldest.finishedAt ?? oldest.startedAt;
    const names = failing.slice(0, 3).map((r) => `${journeyByKey(r.journeyKey)?.title ?? r.journeyKey}: ${r.summary ?? "failed"}`);
    out.health.push({
      key: "acceptance:failing",
      title: `${failing.length} acceptance ${failing.length === 1 ? "journey is" : "journeys are"} failing`,
      status: now.getTime() - Date.parse(since) >= FAILING_BAD_AFTER_MS ? "bad" : "warn",
      detail: `${names.join("; ")}${failing.length > 3 ? "; and more" : ""}. A customer doing this today would hit the failure; each failed step has an issue for the role that owns it.`,
      href: "/cockpit",
      fix: "Hand each failure issue to its owner and wake it, then run the journey again (acceptance request). Never mark a journey passed by hand: the next run says.",
      since,
    });
  }
  const requests = await env.ctx.db.query<Raw>(`SELECT max(created_at) AS at FROM ${REQUESTS} WHERE company_id = $1 AND trigger = 'nightly'`, [companyId]);
  const lastRequest = iso(requests[0]?.at);
  const nightly = await env.ctx.db.query<Raw>(`SELECT max(started_at) AS at FROM ${RUNS} WHERE company_id = $1 AND trigger = 'nightly'`, [companyId]);
  const lastRun = iso(nightly[0]?.at);
  if (lastRequest && now.getTime() - Date.parse(lastRequest) >= 48 * 3_600_000 && (!lastRun || Date.parse(lastRun) < Date.parse(lastRequest))) {
    out.health.push({
      key: "acceptance:stale",
      title: "The nightly acceptance request is not being worked",
      status: "warn",
      detail: `The last nightly request opened ${lastRequest.slice(0, 10)} and no run has started since. Is the Acceptance agent paused or in error?`,
      href: "/setup?section=team",
      fix: "Check the Acceptance agent in Setup → Team (paused, no model key, in error) and resume it; the request issue is waiting for it.",
      since: lastRequest,
    });
  }
  return out;
}
