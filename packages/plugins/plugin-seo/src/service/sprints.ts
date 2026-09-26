/**
 * Sprint lifecycle: create (seed template + backlinks + integrations + root
 * issue), read, today's plan, autopilot and status changes, digests.
 */
import { randomUUID } from "node:crypto";
import { sameClient } from "@partnersinbiz/pib-plugin-kit/client-ref";
import { ORIGIN } from "../constants.js";
import * as db from "../db.js";
import { digestComment, rootIssueDescription, rootIssueTitle } from "../engine/copy.js";
import {
  AUTOPILOT_MODES,
  isRunning,
  nextSprintStatus,
  OPEN_TASK_STATUSES,
  sprintClock,
  type AutopilotMode,
  type SprintStatus,
} from "../engine/sprint.js";
import { scopeParamValue, sprintScope } from "../engine/scope.js";
import { addDays } from "../engine/time.js";
import { DEFAULT_DIRECTORIES, dueDayFor, OUTRANK_90, PHASE_NAMES, TEMPLATE_ID, TEMPLATE_VERSION, type SprintPhase } from "../templates/outrank-90.js";
import { ensureProject, resolveAgent } from "./agent.js";
import {
  actorLabel,
  assignableUser,
  canonicalSiteUrl,
  cockpitPath,
  companyInfo,
  errorMessage,
  isoDateParam,
  oneOf,
  reqStr,
  SeoError,
  str,
  type Actor,
  type CompanyInfo,
  type Env,
  type Params,
} from "./common.js";
import { assertWritable, clockFor, loadSprintContext, requireSprint, sprintCopy } from "./context.js";
import { commentOn, getIssue, openIssue, patchIssue } from "./issues.js";
import { requireClient, scopeParam } from "./scope.js";
import { materialiseDueTasks } from "./tasks.js";

export async function seedTemplate(env: Env, sprint: db.Sprint): Promise<{ tasks: number; backlinks: number }> {
  const tasks = await db.insertTasks(
    env.ctx.db,
    OUTRANK_90.tasks.map((task) => ({
      id: randomUUID(),
      companyId: sprint.companyId,
      sprintId: sprint.id,
      templateKey: task.templateKey,
      week: task.week,
      phase: task.phase,
      dueDay: dueDayFor(task.week, task.dueDay),
      focus: task.focus,
      title: task.title,
      description: null,
      taskType: task.taskType,
      owner: task.owner,
      autopilotEligible: task.autopilotEligible,
      playbookKey: task.playbook,
      source: "template" as const,
      parentOptimizationId: null,
      context: null,
    })),
  );
  const backlinks = await db.insertBacklinks(
    env.ctx.db,
    DEFAULT_DIRECTORIES.map((dir) => ({
      id: randomUUID(),
      companyId: sprint.companyId,
      sprintId: sprint.id,
      source: dir.source,
      domain: dir.domain,
      url: null,
      submitUrl: null,
      type: "directory",
      dr: dir.dr,
      status: "not_started",
      notes: null,
      discoveredVia: "template",
    })),
  );
  for (const [provider, status] of [["gsc", "disconnected"], ["pagespeed", "enabled"], ["bing", "disabled"]] as const) {
    await db.ensureIntegration(env.ctx.db, { id: randomUUID(), companyId: sprint.companyId, sprintId: sprint.id, provider, status });
  }
  await db.updateSprint(env.ctx.db, sprint.companyId, sprint.id, {
    seeded_at: new Date().toISOString(),
    template_id: TEMPLATE_ID,
    template_version: TEMPLATE_VERSION,
  });
  return { tasks, backlinks };
}

/** Create the sprint's root issue in the SEO project if it is missing. */
export async function ensureRootIssue(env: Env, info: CompanyInfo, sprint: db.Sprint, projectId: string | null): Promise<db.Sprint> {
  if (sprint.rootIssueId) {
    const existing = await getIssue(env, sprint.companyId, sprint.rootIssueId);
    if (existing) {
      if (existing.identifier && existing.identifier !== sprint.rootIssueIdentifier) {
        await db.updateSprint(env.ctx.db, sprint.companyId, sprint.id, { root_issue_identifier: existing.identifier });
        return { ...sprint, rootIssueIdentifier: existing.identifier };
      }
      return sprint;
    }
  }
  const created = await openIssue(env, {
    companyId: sprint.companyId,
    title: rootIssueTitle(sprint),
    description: rootIssueDescription(sprintCopy(sprint), { startDate: sprint.startDate, cockpitPath: cockpitPath(info, sprint) }),
    originKind: ORIGIN.sprint,
    originId: sprint.id,
    projectId: projectId ?? sprint.projectId,
    assigneeUserId: assignableUser(sprint.ownerUserId),
    wake: false,
  });
  const issue = await getIssue(env, sprint.companyId, created.id);
  await db.updateSprint(env.ctx.db, sprint.companyId, sprint.id, {
    root_issue_id: created.id,
    root_issue_identifier: issue?.identifier ?? null,
    project_id: projectId ?? sprint.projectId,
  });
  return { ...sprint, rootIssueId: created.id, rootIssueIdentifier: issue?.identifier ?? null, projectId: projectId ?? sprint.projectId };
}

async function responsibleUser(env: Env, companyId: string, actor: Actor): Promise<string | null> {
  if (actor.kind === "user") return actor.userId;
  if (actor.kind === "agent") return actor.responsibleUserId;
  return null;
}

export async function createSprint(env: Env, companyId: string, actor: Actor, params: Params) {
  const info = await companyInfo(env, companyId);
  const siteUrl = canonicalSiteUrl(reqStr(params, "siteUrl", { max: 500 }));
  // No client = Partners in Biz's own site. A client must be a real CRM company or contact.
  const scope = scopeParam(params) ?? null;
  if (!scope && str(params, "clientName", { max: 200 })) {
    throw new SeoError('clientName is not accepted. For client work pass client "company:<CRM company id>" or "contact:<CRM contact id>"; for a Partners in Biz site omit client and use siteName.');
  }
  const client = scope ? await requireClient(env, companyId, scope) : null;
  const clientKind = client?.kind ?? null;
  const clientRef = client?.id ?? null;
  const clientName = client?.name ?? null;
  const host = new URL(siteUrl).hostname.replace(/^www\./, "");
  const siteName = str(params, "siteName", { max: 200 }) ?? clientName ?? host;
  const startDate = isoDateParam(params, "startDate") ?? info.today;
  const autopilotMode = oneOf(params, "autopilotMode", AUTOPILOT_MODES) ?? info.loaded.config.defaultAutopilotMode;
  if (actor.kind === "agent" && autopilotMode === "full") throw new SeoError("An agent cannot create a sprint in full autopilot; use safe and ask a person to raise it.");
  const ownerParam = str(params, "ownerUserId", { max: 200 });
  const ownerUserId = ownerParam === "none" ? null : ownerParam ?? (await responsibleUser(env, companyId, actor));
  const clock = sprintClock(startDate, info.today);
  const id = randomUUID();
  await db.insertSprint(env.ctx.db, {
    id,
    companyId,
    name: siteName,
    siteUrl,
    siteName,
    clientKind,
    clientRef,
    clientName,
    status: clock.runningStatus,
    startDate,
    templateId: TEMPLATE_ID,
    templateVersion: TEMPLATE_VERSION,
    autopilotMode,
    ownerUserId,
    notes: str(params, "notes", { max: 4000 }) ?? null,
  });
  let sprint = await requireSprint(env, companyId, id);
  const seeded = await seedTemplate(env, sprint);
  await env.skills.ensure(companyId).catch(() => []);
  const projectId = await ensureProject(env, companyId);
  const warnings: string[] = [];
  try {
    sprint = await ensureRootIssue(env, info, { ...sprint, projectId }, projectId);
  } catch (error) {
    warnings.push(`Root issue not created yet (${errorMessage(error)}); the daily run retries.`);
  }
  await db.updateSprint(env.ctx.db, companyId, id, { current_day: clock.day, current_week: clock.week, current_phase: clock.phase });
  let materialised = { created: 0, remaining: 0, errors: [] as string[] };
  if (sprint.rootIssueId) {
    materialised = await materialiseDueTasks(
      env,
      { info, sprint, day: clock.day, agent: await resolveAgent(env, companyId), projectId },
      { limit: 12 },
    );
    warnings.push(...materialised.errors);
  }
  return {
    sprintId: id,
    siteUrl,
    siteName,
    client: scopeParamValue(sprintScope({ clientKind, clientRef })),
    clientKind,
    clientRef,
    clientName,
    startDate,
    status: clock.runningStatus,
    day: clock.day,
    week: clock.week,
    autopilotMode,
    ownerUserId,
    rootIssueId: sprint.rootIssueId,
    seededTasks: seeded.tasks,
    seededBacklinks: seeded.backlinks,
    issuesOpened: materialised.created,
    issuesPending: materialised.remaining,
    warnings,
    next: "Connect Google Search Console on the SEO page (Integrations tab) and activate the SEO agent if it is not active yet.",
  };
}

/** Give a sprint from the first plugin version the 90-day plan. */
export async function upgradeLegacySprint(env: Env, companyId: string, actor: Actor, params: Params) {
  if (actor.kind !== "user") throw new SeoError("Only a board user can start the 90-day plan on an old sprint");
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  if (sprint.seededAt) throw new SeoError("This sprint already has the 90-day plan");
  const info = await companyInfo(env, companyId);
  const startDate = isoDateParam(params, "startDate") ?? info.today;
  const clock = sprintClock(startDate, info.today);
  await db.updateSprint(env.ctx.db, companyId, sprint.id, {
    start_date: startDate,
    status: clock.runningStatus,
    owner_user_id: sprint.ownerUserId ?? actor.userId,
    autopilot_mode: info.loaded.config.defaultAutopilotMode,
  });
  const fresh = await requireSprint(env, companyId, sprint.id);
  const seeded = await seedTemplate(env, fresh);
  return { sprintId: sprint.id, startDate, seededTasks: seeded.tasks, seededBacklinks: seeded.backlinks, next: "The next daily run opens the due tasks as issues." };
}

export function sprintView(sprint: db.Sprint, today: string, counts?: { open: number; due: number; done: number; total: number; blocked: number; proposals: number }) {
  const clock = sprintClock(sprint.startDate, today);
  const running = isRunning(sprint.status);
  return {
    sprintId: sprint.id,
    siteName: sprint.siteName,
    siteUrl: sprint.siteUrl,
    /** Pass this as `client` to tools; null = Partners in Biz's own site. */
    client: scopeParamValue(sprintScope(sprint)),
    clientKind: sprint.clientKind,
    clientRef: sprint.clientRef,
    clientName: sprint.clientName,
    ...(sprint.legacyClientName ? { legacyClientName: sprint.legacyClientName } : {}),
    status: sprint.status,
    legacy: !sprint.seededAt,
    startDate: sprint.startDate,
    day: clock.day,
    week: clock.week,
    phase: clock.phase,
    phaseName: PHASE_NAMES[clock.phase as SprintPhase],
    calendarStatus: running ? clock.runningStatus : sprint.status,
    autopilotMode: sprint.autopilotMode,
    ownerUserId: sprint.ownerUserId,
    rootIssueId: sprint.rootIssueId,
    rootIssueIdentifier: sprint.rootIssueIdentifier,
    health: sprint.health,
    lastDailyOn: sprint.lastDailyOn,
    notes: sprint.notes,
    ...(counts ? { tasks: counts } : {}),
  };
}

export async function listSprintsTool(env: Env, companyId: string, params: Params) {
  const info = await companyInfo(env, companyId);
  const status = str(params, "status");
  const sprints = await db.listSprints(env.ctx.db, companyId, { status, scope: scopeParam(params) });
  const counts = await db.sprintCounts(env.ctx.db, companyId);
  return { today: info.today, sprints: sprints.map((s) => sprintView(s, info.today, counts[s.id])) };
}

export async function getSprintTool(env: Env, companyId: string, params: Params) {
  const ctx = await loadSprintContext(env, companyId, reqStr(params, "sprintId"));
  const counts = (await db.sprintCounts(env.ctx.db, companyId))[ctx.sprint.id];
  const [integrations, keywords, health, snapshots] = await Promise.all([
    db.listIntegrations(env.ctx.db, companyId, ctx.sprint.id),
    db.listKeywords(env.ctx.db, companyId, ctx.sprint.id),
    db.latestPageHealth(env.ctx.db, ctx.sprint.id),
    db.listSnapshots(env.ctx.db, companyId, ctx.sprint.id),
  ]);
  return {
    ...sprintView(ctx.sprint, ctx.info.today, counts),
    cockpit: cockpitPath(ctx.info, ctx.sprint),
    integrations: integrations.map(integrationView),
    keywords: { tracked: keywords.length, top10: keywords.filter((k) => (k.currentPosition ?? 999) <= 10).length, priority: keywords.filter((k) => k.isPriority).map((k) => k.phrase) },
    pageHealth: health.map((h) => ({ url: h.url, strategy: h.strategy, performance: h.performance, seo: h.seo, lcpMs: h.lcpMs, cls: h.cls, inpMs: h.inpMs, source: h.source, pulledOn: h.pulledOn })),
    snapshots: snapshots.map((s) => ({ day: s.day, kind: s.kind, capturedOn: s.capturedOn, traffic: s.traffic, rankings: s.rankings })),
    scoreboard: ctx.sprint.scoreboard,
  };
}

export function integrationView(i: db.Integration) {
  return {
    provider: i.provider,
    status: i.status,
    propertyUrl: i.propertyUrl,
    lastPullAt: i.lastPullAt,
    lastError: i.lastError,
    connected: i.provider === "gsc" ? Boolean(i.tokenSealed) && i.status === "connected" : i.status === "enabled",
    stats: i.stats,
  };
}

export async function todayTool(env: Env, companyId: string, params: Params) {
  const info = await companyInfo(env, companyId);
  const sprintId = str(params, "sprintId");
  const scope = scopeParam(params);
  const sprints = sprintId
    ? [await requireSprint(env, companyId, sprintId)]
    : (await db.listSprints(env.ctx.db, companyId, { scope })).filter((s) => s.status !== "archived" && s.seededAt);
  const out = [];
  for (const sprint of sprints) out.push(await sprintToday(env, info, sprint));
  return { today: info.today, timezone: info.timezone, sprints: out };
}

export async function sprintToday(env: Env, info: CompanyInfo, sprint: db.Sprint) {
  const clock = clockFor(sprint, info.today);
  const tasks = await db.listTasks(env.ctx.db, sprint.companyId, sprint.id, { status: OPEN_TASK_STATUSES });
  const due = tasks.filter((t) => t.dueDay == null || t.dueDay <= clock.day);
  const brief = (t: db.SprintTask) => ({
    taskId: t.id,
    title: t.title,
    week: t.week,
    owner: t.owner,
    status: t.status,
    issueId: t.issueId,
    issueIdentifier: t.issueIdentifier,
    autopilotEligible: t.autopilotEligible,
    ...(t.humanAsk ? { humanAsk: t.humanAsk } : {}),
    ...(t.blockerReason ? { blockerReason: t.blockerReason } : {}),
  });
  const [integrations, proposals, doneRecently] = await Promise.all([
    db.listIntegrations(env.ctx.db, sprint.companyId, sprint.id),
    db.listOptimizations(env.ctx.db, sprint.companyId, sprint.id, { status: "proposed" }),
    db.listTasks(env.ctx.db, sprint.companyId, sprint.id, { status: ["done"] }),
  ]);
  const since = `${addDays(info.today, -1)}T00:00:00Z`;
  const notStarted = due.filter((t) => t.status === "not_started");
  const agentWork = notStarted.filter((t) => t.owner === "agent");
  const inProgress = due.filter((t) => t.status === "in_progress");
  const blocked = due.filter((t) => t.status === "blocked");
  const gsc = integrations.find((i) => i.provider === "gsc");
  const next: string[] = [];
  if (!isRunning(sprint.status)) next.push(`Sprint is ${sprint.status}; nothing runs until it is resumed.`);
  if (gsc?.status === "needs_reconnect") next.push("Search Console needs a reconnect by the owner (send the gsc-connect-url link).");
  else if (!gsc || gsc.status !== "connected" || !gsc.propertyUrl) next.push("Search Console is not connected with a property: rankings cannot update. Ask the owner to connect it (gsc-connect-url).");
  if (inProgress.length > 0) next.push(`Finish the ${inProgress.length} task(s) in progress first.`);
  if (agentWork.length > 0) next.push(`Work the ${agentWork.length} due agent task(s), oldest week first; complete each with complete-task and evidence.`);
  if (blocked.length > 0) next.push(`${blocked.length} task(s) wait on a person; do not redo them.`);
  if (proposals.length > 0) next.push(`${proposals.length} optimization proposal(s) await approval.`);
  if (next.length === 0) next.push("Nothing is due. Check keyword positions (list-keywords) and post a short digest.");
  return {
    sprintId: sprint.id,
    site: sprint.siteName,
    siteUrl: sprint.siteUrl,
    client: scopeParamValue(sprintScope(sprint)),
    clientName: sprint.clientName,
    status: sprint.status,
    day: clock.day,
    week: clock.week,
    phase: clock.phase,
    phaseName: PHASE_NAMES[clock.phase as SprintPhase],
    autopilotMode: sprint.autopilotMode,
    rootIssueId: sprint.rootIssueId,
    rootIssueIdentifier: sprint.rootIssueIdentifier,
    due: notStarted.map(brief),
    inProgress: inProgress.map(brief),
    blocked: blocked.map(brief),
    doneToday: doneRecently.filter((t) => (t.completedAt ?? "") >= since).map((t) => t.title),
    upcoming: tasks.filter((t) => t.dueDay != null && t.dueDay > clock.day).slice(0, 5).map(brief),
    proposals: proposals.map((p) => ({ optimizationId: p.id, hypothesis: p.hypothesis, signal: p.signalType, severity: p.severity })),
    integrations: integrations.map(integrationView),
    health: sprint.health,
    next,
  };
}

export async function setAutopilot(env: Env, companyId: string, actor: Actor, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  assertWritable(sprint);
  const mode = oneOf(params, "mode", AUTOPILOT_MODES);
  if (!mode) throw new SeoError("mode is required (off, safe or full)");
  const rank: Record<AutopilotMode, number> = { off: 0, safe: 1, full: 2 };
  if (actor.kind === "agent" && rank[mode] > rank[sprint.autopilotMode]) {
    throw new SeoError("An agent can lower autopilot but not raise it. Ask a person to change it on the SEO page.");
  }
  await db.updateSprint(env.ctx.db, companyId, sprint.id, { autopilot_mode: mode });
  if (sprint.rootIssueId && mode !== sprint.autopilotMode) {
    await commentOn(env, companyId, sprint.rootIssueId, `Autopilot changed from ${sprint.autopilotMode} to ${mode} by ${actorLabel(actor)}. New task issues follow the new mode; open issues keep their assignee.`);
  }
  return { sprintId: sprint.id, autopilotMode: mode, previous: sprint.autopilotMode };
}

export async function setSprintStatus(env: Env, companyId: string, actor: Actor, params: Params, target: "paused" | "resume" | "archived") {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const reason = str(params, "reason", { max: 1000 }) ?? null;
  const info = await companyInfo(env, companyId);
  let status: SprintStatus;
  if (target === "resume") {
    if (isRunning(sprint.status)) return { sprintId: sprint.id, status: sprint.status, unchanged: true };
    status = nextSprintStatus("active", clockFor(sprint, info.today));
  } else {
    status = target;
  }
  await db.updateSprint(env.ctx.db, companyId, sprint.id, { status, paused_reason: target === "resume" ? null : reason });
  if (sprint.rootIssueId) {
    await commentOn(env, companyId, sprint.rootIssueId, `Sprint ${target === "resume" ? `resumed (${status})` : status} by ${actorLabel(actor)}${reason ? `: ${reason}` : ""}.`);
  }
  return { sprintId: sprint.id, status, previous: sprint.status };
}

export async function updateSprintTool(env: Env, companyId: string, actor: Actor, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  assertWritable(sprint);
  const patch: Record<string, unknown> = {};
  const siteName = str(params, "siteName", { max: 200 });
  if (siteName) patch.site_name = siteName;
  if (params.notes !== undefined) patch.notes = str(params, "notes", { max: 4000 }) ?? null;
  const startDate = isoDateParam(params, "startDate");
  if (startDate) {
    if (actor.kind !== "user") throw new SeoError("Only a person can move the start date");
    patch.start_date = startDate;
  }
  const owner = str(params, "ownerUserId", { max: 200 });
  if (owner) {
    if (actor.kind !== "user") throw new SeoError("Only a person can change the sprint owner");
    patch.owner_user_id = owner === "me" ? actor.userId : owner === "none" ? null : owner;
  }
  // Moving a sprint between Partners in Biz's own sites and a client (or between clients).
  const scope = scopeParam(params);
  const from = sprintScope(sprint);
  let moved: { client: string | null; clientName: string | null } | null = null;
  if (scope !== undefined && !sameClient(scope, from)) {
    if (actor.kind !== "user") throw new SeoError("Only a person can move a sprint to another client or back to Partners in Biz's own sites.");
    const client = scope ? await requireClient(env, companyId, scope) : null;
    patch.client_kind = client?.kind ?? null;
    patch.client_ref = client?.id ?? null;
    patch.client_name = client?.name ?? null;
    moved = { client: scopeParamValue(scope), clientName: client?.name ?? null };
  }
  if (Object.keys(patch).length === 0) throw new SeoError("Nothing to update");
  await db.updateSprint(env.ctx.db, companyId, sprint.id, patch);
  if (moved && sprint.rootIssueId) {
    const fresh = await requireSprint(env, companyId, sprint.id);
    await patchIssue(env, companyId, sprint.rootIssueId, { title: rootIssueTitle(fresh) });
    const before = sprint.clientName ?? (from ? scopeParamValue(from) : "Partners in Biz's own sites");
    await commentOn(env, companyId, sprint.rootIssueId, `Sprint moved from ${before} to ${moved.clientName ?? "Partners in Biz's own sites"} by ${actorLabel(actor)}. Open sub-issues keep their titles.`);
  }
  return { sprintId: sprint.id, updated: Object.keys(patch), ...(moved ? { client: moved.client, clientName: moved.clientName } : {}) };
}

export async function postDigest(env: Env, companyId: string, actor: Actor, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  if (!sprint.rootIssueId) throw new SeoError("This sprint has no root issue yet");
  const info = await companyInfo(env, companyId);
  const today = await sprintToday(env, info, sprint);
  const body = digestComment({
    summary: reqStr(params, "summary", { max: 6000 }),
    day: today.day,
    week: today.week,
    phase: today.phase,
    doneToday: today.doneToday,
    blocked: today.blocked.map((b) => ({ title: b.title, humanAsk: b.humanAsk ?? null })),
    dueOpen: today.due.length + today.inProgress.length,
  });
  const ok = await commentOn(env, companyId, sprint.rootIssueId, body);
  if (!ok) throw new SeoError("The digest comment could not be posted");
  return { sprintId: sprint.id, rootIssueId: sprint.rootIssueId, posted: true, by: actorLabel(actor) };
}
