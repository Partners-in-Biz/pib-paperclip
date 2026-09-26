/**
 * The optimization loop: detect → propose → approve (tasks for the CURRENT
 * week + a baseline) → measure 14 days later → scoreboard.
 */
import { randomUUID } from "node:crypto";
import { comparableUrl } from "../checks/parse.js";
import { ORIGIN } from "../constants.js";
import * as db from "../db.js";
import { approvalIssueDescription, approvalIssueTitle, type ProposalCopy } from "../engine/copy.js";
import { buildMetricSet, classifyOutcome, updateScoreboard, type MetricSet, type Scoreboard } from "../engine/measure.js";
import { isRunning, proposalAllowance } from "../engine/sprint.js";
import { addDays, localDateOf } from "../engine/time.js";
import { healthScore, runDetectors, type DetectorInput, type HealthSignal, type PositionPoint } from "../loop/detectors.js";
import { proposeHypotheses } from "../loop/hypotheses.js";
import { phaseForWeek } from "../templates/outrank-90.js";
import { resolveAgent } from "./agent.js";
import {
  actorId,
  actorLabel,
  assignableUser,
  bool,
  cockpitPath,
  companyInfo,
  errorMessage,
  oneOf,
  reqStr,
  SeoError,
  str,
  type Actor,
  type CompanyInfo,
  type Env,
  type Params,
} from "./common.js";
import { clockFor, requireSprint, sprintCopy } from "./context.js";
import { commentOn, getIssue, OPEN_ISSUE_STATUSES, openIssue, patchIssue } from "./issues.js";
import { materialiseDueTasks } from "./tasks.js";

export async function detectorInput(env: Env, info: CompanyInfo, sprint: db.Sprint): Promise<DetectorInput> {
  const clock = clockFor(sprint, info.today);
  const [keywords, history, content, backlinks, health, snapshots, integrations] = await Promise.all([
    db.listKeywords(env.ctx.db, sprint.companyId, sprint.id),
    db.sprintHistory(env.ctx.db, sprint.id, addDays(info.today, -60)),
    db.listContent(env.ctx.db, sprint.companyId, sprint.id),
    db.listBacklinks(env.ctx.db, sprint.companyId, sprint.id),
    db.latestPageHealth(env.ctx.db, sprint.id),
    db.listSnapshots(env.ctx.db, sprint.companyId, sprint.id),
    db.listIntegrations(env.ctx.db, sprint.companyId, sprint.id),
  ]);
  const byKeyword: Record<string, Map<string, number>> = {};
  for (const row of history) {
    if (row.position == null || !row.recordedOn) continue;
    const map = (byKeyword[row.keywordId] ??= new Map());
    map.set(row.recordedOn, row.position);
  }
  const points: Record<string, PositionPoint[]> = {};
  for (const [id, map] of Object.entries(byKeyword)) {
    points[id] = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([on, position]) => ({ on, position }));
  }
  const gsc = integrations.find((i) => i.provider === "gsc");
  return {
    today: info.today,
    day: clock.day,
    week: clock.week,
    phase: clock.phase,
    gscConnected: Boolean(gsc?.lastPullAt),
    keywords: keywords.map((k) => ({ id: k.id, phrase: k.phrase, targetUrl: k.targetUrl, currentPosition: k.currentPosition, impressions: k.impressions, clicks: k.clicks, ctr: k.ctr })),
    history: points,
    content: content.map((c) => ({ id: c.id, title: c.title, type: c.type, status: c.status, targetUrl: c.targetUrl, publishedOn: c.publishedOn, impressions: c.impressions, linksToPillarIds: c.linksToPillarIds })),
    backlinks: backlinks.map((b) => ({ id: b.id, source: b.source, domain: b.domain, status: b.status, submittedOn: localDateOf(b.submittedAt, info.timezone) })),
    pageHealth: health.filter((h) => h.strategy === "mobile").map((h) => ({ url: h.url, lcpMs: h.lcpMs, cls: h.cls, inpMs: h.inpMs })),
    snapshots: snapshots.map((s) => ({ day: s.day, impressions: typeof s.traffic.impressions === "number" ? (s.traffic.impressions as number) : null })),
  };
}

function signalView(s: HealthSignal) {
  return { type: s.type, severity: s.severity, subject: s.subject, evidence: s.evidence };
}

/** Run detectors, store health, and (optionally) record capped, de-duplicated proposals. */
export async function detectSignals(env: Env, info: CompanyInfo, sprint: db.Sprint, opts: { propose: boolean }) {
  const input = await detectorInput(env, info, sprint);
  const signals = runDetectors(input);
  const health = { score: healthScore(signals), signals: signals.slice(0, 25).map(signalView), day: input.day, updatedOn: info.today };
  await db.updateSprint(env.ctx.db, sprint.companyId, sprint.id, { health });
  const created: db.Optimization[] = [];
  let allowance = 0;
  if (opts.propose && isRunning(sprint.status)) {
    allowance = proposalAllowance(input.day, await db.countOptimizationsSince(env.ctx.db, sprint.id, addDays(info.today, -6)));
    for (const proposal of proposeHypotheses(signals, sprint.scoreboard as Scoreboard)) {
      if (created.length >= allowance) break;
      const id = randomUUID();
      const inserted = await db.insertOptimization(env.ctx.db, {
        id,
        companyId: sprint.companyId,
        sprintId: sprint.id,
        signalType: proposal.signal.type,
        severity: proposal.signal.severity,
        subject: proposal.signal.subject,
        evidence: proposal.signal.evidence,
        hypothesis: proposal.hypothesis,
        hypothesisType: proposal.hypothesisType,
        proposedAction: proposal.proposedAction,
        proposedTasks: proposal.tasks,
        targetKeywordIds: proposal.targetKeywordIds,
        targetUrl: proposal.targetUrl,
        detectedOn: info.today,
      });
      if (!inserted) continue;
      const row = await db.getOptimization(env.ctx.db, sprint.companyId, id);
      if (row) created.push(row);
    }
    if (created.length > 0) await announceProposals(env, info, sprint, created);
  }
  return {
    sprintId: sprint.id,
    health: health.score,
    signals: signals.map(signalView),
    proposalsCreated: created.map((o) => ({ optimizationId: o.id, hypothesis: o.hypothesis, signal: o.signalType })),
    allowanceLeft: opts.propose ? Math.max(0, allowance - created.length) : null,
  };
}

function proposalCopy(o: db.Optimization): ProposalCopy {
  return {
    id: o.id,
    signalType: o.signalType,
    severity: o.severity,
    hypothesis: o.hypothesis,
    proposedAction: o.proposedAction,
    evidence: o.evidence,
    taskTitles: o.proposedTasks.map((t) => t.title),
  };
}

/** One approval issue per sprint: reuse an open one (comment) or open a new one for the owner. */
async function announceProposals(env: Env, info: CompanyInfo, sprint: db.Sprint, created: db.Optimization[]): Promise<void> {
  const pending = await db.listOptimizations(env.ctx.db, sprint.companyId, sprint.id, { status: "proposed" });
  const existingIssueId = pending.map((o) => o.approvalIssueId).find((id) => id) ?? null;
  let issueId: string | null = null;
  if (existingIssueId) {
    const issue = await getIssue(env, sprint.companyId, existingIssueId);
    if (issue && OPEN_ISSUE_STATUSES.has(String(issue.status))) {
      issueId = existingIssueId;
      await commentOn(env, sprint.companyId, existingIssueId, approvalIssueDescription(sprintCopy(sprint), created.map(proposalCopy), cockpitPath(info, sprint.id)));
    }
  }
  if (!issueId) {
    try {
      const clock = clockFor(sprint, info.today);
      const opened = await openIssue(env, {
        companyId: sprint.companyId,
        title: approvalIssueTitle(sprint, `week ${clock.week}`),
        description: approvalIssueDescription(sprintCopy(sprint), created.map(proposalCopy), cockpitPath(info, sprint.id)),
        originKind: ORIGIN.approval,
        originId: sprint.id,
        projectId: sprint.projectId,
        parentId: sprint.rootIssueId,
        assigneeUserId: assignableUser(sprint.ownerUserId),
        wake: false,
      });
      issueId = opened.id;
    } catch (error) {
      env.ctx.logger.info("SEO approval issue not created", { sprintId: sprint.id, error: errorMessage(error) });
      return;
    }
  }
  for (const o of created) await db.updateOptimization(env.ctx.db, sprint.companyId, o.id, { approval_issue_id: issueId });
}

export async function detectSignalsTool(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  return detectSignals(env, info, sprint, { propose: bool(params, "propose") ?? false });
}

function optimizationView(o: db.Optimization) {
  return {
    optimizationId: o.id,
    status: o.status,
    signal: o.signalType,
    severity: o.severity,
    hypothesis: o.hypothesis,
    hypothesisType: o.hypothesisType,
    proposedAction: o.proposedAction,
    evidence: o.evidence,
    proposedTasks: o.proposedTasks,
    detectedOn: o.detectedOn,
    approvedAt: o.approvedAt,
    measureOn: o.measureOn,
    result: o.result,
    outcome: o.outcome,
    generatedTaskIds: o.generatedTaskIds,
    approvalIssueId: o.approvalIssueId,
    rejectedReason: o.rejectedReason,
  };
}

export async function listOptimizationsTool(env: Env, companyId: string, params: Params) {
  const sprintId = reqStr(params, "sprintId");
  const status = oneOf(params, "status", ["proposed", "approved", "rejected", "measured"] as const);
  const list = await db.listOptimizations(env.ctx.db, companyId, sprintId, { status });
  const sprint = await requireSprint(env, companyId, sprintId);
  return { sprintId, count: list.length, scoreboard: sprint.scoreboard, optimizations: list.map(optimizationView) };
}

async function metricSetFor(env: Env, info: CompanyInfo, sprint: db.Sprint, o: db.Optimization): Promise<MetricSet> {
  const [keywords, health, integrations] = await Promise.all([
    db.listKeywords(env.ctx.db, sprint.companyId, sprint.id, { includeRetired: true }),
    db.latestPageHealth(env.ctx.db, sprint.id),
    db.listIntegrations(env.ctx.db, sprint.companyId, sprint.id),
  ]);
  const target = o.targetUrl ? comparableUrl(o.targetUrl) : null;
  let chosen = keywords.filter((k) => o.targetKeywordIds.includes(k.id));
  if (chosen.length === 0 && target) {
    chosen = keywords.filter((k) => !k.retiredAt && [k.targetUrl, k.rankingUrl].some((u) => u && comparableUrl(u) === target));
  }
  const page = target ? health.find((h) => h.strategy === "mobile" && comparableUrl(h.url) === target) : null;
  const gsc = integrations.find((i) => i.provider === "gsc");
  const totals = (gsc?.stats?.siteTotals ?? null) as { impressions: number; clicks: number; position: number | null } | null;
  return buildMetricSet({
    keywords: chosen.map((k) => ({ id: k.id, phrase: k.phrase, position: k.currentPosition, impressions: k.impressions ?? 0, clicks: k.clicks ?? 0 })),
    page: page ? { url: page.url, lcpMs: page.lcpMs, cls: page.cls, performance: page.performance } : null,
    siteTotals: totals,
    capturedOn: info.today,
  });
}

async function closeApprovalIssueIfDecided(env: Env, companyId: string, sprintId: string, approvalIssueId: string | null): Promise<void> {
  if (!approvalIssueId) return;
  const pending = await db.listOptimizations(env.ctx.db, companyId, sprintId, { status: "proposed" });
  if (pending.some((o) => o.approvalIssueId === approvalIssueId)) return;
  const issue = await getIssue(env, companyId, approvalIssueId);
  if (!issue || !OPEN_ISSUE_STATUSES.has(String(issue.status))) return;
  await commentOn(env, companyId, approvalIssueId, "Every proposal on this issue has been approved or rejected.");
  await patchIssue(env, companyId, approvalIssueId, { status: "done" });
}

export async function approveOptimization(env: Env, companyId: string, actor: Actor, params: Params) {
  const id = reqStr(params, "optimizationId");
  const o = await db.getOptimization(env.ctx.db, companyId, id);
  if (!o) throw new SeoError(`Optimization ${id} was not found`);
  if (o.status !== "proposed") throw new SeoError(`This optimization is already ${o.status}`);
  const sprint = await requireSprint(env, companyId, o.sprintId);
  if (actor.kind === "agent" && sprint.autopilotMode !== "full") {
    throw new SeoError("Only a person can approve optimizations unless the sprint's autopilot is full. Leave it for the owner (it is on the approval issue).");
  }
  const info = await companyInfo(env, companyId);
  const clock = clockFor(sprint, info.today);
  const baseline = await metricSetFor(env, info, sprint, o);
  const week = Math.max(clock.week, 0);
  const note = str(params, "note", { max: 2000 });
  const context = [
    `Optimization: ${o.hypothesis}`,
    `Action: ${o.proposedAction}`,
    `Signal \`${o.signalType}\` (${o.severity}): \`${JSON.stringify(o.evidence)}\``,
    `Measured on ${addDays(info.today, 14)} against the baseline taken today (win: position +2 or impressions +20%).`,
    note ? `Approver note: ${note}` : null,
  ].filter(Boolean).join("\n");
  const tasks = o.proposedTasks.map((spec) => ({
    id: randomUUID(),
    companyId,
    sprintId: sprint.id,
    templateKey: null,
    week,
    phase: phaseForWeek(week),
    dueDay: clock.day <= 0 ? null : clock.day,
    focus: "Optimization",
    title: spec.title,
    description: null,
    taskType: spec.taskType,
    owner: spec.owner,
    autopilotEligible: spec.autopilotEligible,
    playbookKey: spec.playbook,
    source: "optimization" as const,
    parentOptimizationId: o.id,
    context,
  }));
  await db.insertTasks(env.ctx.db, tasks);
  const measureOn = addDays(info.today, 14);
  await db.updateOptimization(env.ctx.db, companyId, o.id, {
    status: "approved",
    approved_at: new Date().toISOString(),
    approved_by: actorId(actor),
    generated_task_ids: tasks.map((t) => t.id),
    baseline,
    measure_on: measureOn,
  });
  let opened = 0;
  if (sprint.rootIssueId && isRunning(sprint.status)) {
    const result = await materialiseDueTasks(
      env,
      { info, sprint, day: clock.day, agent: await resolveAgent(env, companyId), projectId: sprint.projectId },
      { onlyTaskIds: tasks.map((t) => t.id) },
    );
    opened = result.created;
  }
  if (o.approvalIssueId) await commentOn(env, companyId, o.approvalIssueId, `Approved by ${actorLabel(actor)}: ${o.hypothesis}. ${tasks.length} task(s) created for week ${week}; measured on ${measureOn}.`);
  await closeApprovalIssueIfDecided(env, companyId, sprint.id, o.approvalIssueId);
  return { optimizationId: o.id, status: "approved", taskIds: tasks.map((t) => t.id), issuesOpened: opened, week, measureOn, baseline };
}

export async function rejectOptimization(env: Env, companyId: string, actor: Actor, params: Params) {
  const id = reqStr(params, "optimizationId");
  const o = await db.getOptimization(env.ctx.db, companyId, id);
  if (!o) throw new SeoError(`Optimization ${id} was not found`);
  if (o.status !== "proposed") throw new SeoError(`This optimization is already ${o.status}`);
  const reason = reqStr(params, "reason", { max: 2000 });
  await db.updateOptimization(env.ctx.db, companyId, o.id, { status: "rejected", rejected_at: new Date().toISOString(), rejected_reason: reason });
  if (o.approvalIssueId) await commentOn(env, companyId, o.approvalIssueId, `Rejected by ${actorLabel(actor)}: ${o.hypothesis} — ${reason}`);
  await closeApprovalIssueIfDecided(env, companyId, o.sprintId, o.approvalIssueId);
  return { optimizationId: o.id, status: "rejected" };
}

/** Measure approved optimizations whose 14 days are up; update the scoreboard. */
export async function measureDue(env: Env, info: CompanyInfo, sprint: db.Sprint): Promise<number> {
  const due = await db.dueMeasurements(env.ctx.db, sprint.id, info.today);
  let scoreboard = sprint.scoreboard as Scoreboard;
  let measured = 0;
  for (const o of due) {
    try {
      const current = await metricSetFor(env, info, sprint, o);
      const baseline = (o.baseline ?? buildMetricSet({ keywords: [], capturedOn: o.detectedOn ?? info.today })) as MetricSet;
      const outcome = classifyOutcome(baseline, current);
      await db.updateOptimization(env.ctx.db, sprint.companyId, o.id, {
        status: "measured",
        measured_at: new Date().toISOString(),
        result: outcome.result,
        outcome: { ...outcome, current },
      });
      scoreboard = updateScoreboard(scoreboard, o.hypothesisType, outcome.result);
      measured += 1;
      if (sprint.rootIssueId) {
        await commentOn(
          env,
          sprint.companyId,
          sprint.rootIssueId,
          `**Optimization measured: ${outcome.result.replace("_", " ")}** — ${o.hypothesis}\n\n${outcome.reasons.join(" ")}`,
        );
      }
    } catch (error) {
      env.ctx.logger.info("SEO measurement failed", { optimizationId: o.id, error: errorMessage(error) });
    }
  }
  if (measured > 0) await db.updateSprint(env.ctx.db, sprint.companyId, sprint.id, { scoreboard });
  return measured;
}
