/**
 * Sprint lifecycle: create (seed template + backlinks + integrations + root
 * issue), read, today's plan, autopilot and status changes, digests.
 */
import { randomUUID } from "node:crypto";
import { sameClient } from "@partnersinbiz/pib-plugin-kit/client-ref";
import { ORIGIN } from "../constants.js";
import * as db from "../db.js";
import { announcementLine } from "./handoff.js";
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
import { dueDayFor, PHASE_NAMES, TEMPLATE_VERSION, type SprintPhase } from "../templates/outrank-90.js";
import { BUSINESS_TYPES, businessTypeOf, defaultBusinessType, planFor, planOf, type BusinessType, type PlanVariant } from "../templates/plans.js";
import { ensureProject, resolveAgent } from "./agent.js";
import { sprintOverviews, withRunFailures, type SprintOverview } from "./overview.js";
import { RUNS_TROUBLE } from "../engine/due.js";
import { plural } from "../engine/plain.js";
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
import { groupViews } from "./chunks.js";
import { geoSummary } from "./geo.js";
import { ga4Line } from "./analytics.js";
import { loadServiceAccount } from "./google-access.js";
import { needsYouView } from "./needs-you.js";
import { playbookSummary } from "./playbook.js";
import { autoLinkClientProject, siteLinkView } from "./site.js";
import { autoLinkWordPressSite, sprintWordPressSite, wordPressSiteView } from "./wordpress.js";
import { isCodeTask } from "../engine/site-change.js";
import { geoLine } from "../engine/geo.js";

/** The plan to seed: `businessType` when given, else local for a client and software for our own sites. */
export function businessTypeParam(params: Params, forClient: boolean): BusinessType {
  return oneOf(params, "businessType", BUSINESS_TYPES) ?? defaultBusinessType(forClient);
}

export async function seedTemplate(env: Env, sprint: db.Sprint, plan: PlanVariant = planOf(sprint.templateId)): Promise<{ tasks: number; backlinks: number }> {
  const tasks = await db.insertTasks(
    env.ctx.db,
    plan.tasks.map((task) => ({
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
    plan.sources.map((dir) => ({
      id: randomUUID(),
      companyId: sprint.companyId,
      sprintId: sprint.id,
      source: dir.source,
      domain: dir.domain,
      url: null,
      submitUrl: null,
      type: dir.type ?? "directory",
      dr: dir.dr,
      status: "not_started",
      notes: null,
      discoveredVia: "template",
    })),
  );
  for (const [provider, status] of [["gsc", "disconnected"], ["pagespeed", "enabled"], ["bing", "disabled"], ["ga4", "disconnected"]] as const) {
    await db.ensureIntegration(env.ctx.db, { id: randomUUID(), companyId: sprint.companyId, sprintId: sprint.id, provider, status });
  }
  await db.updateSprint(env.ctx.db, sprint.companyId, sprint.id, {
    seeded_at: new Date().toISOString(),
    template_id: plan.id,
    template_version: TEMPLATE_VERSION,
  });
  return { tasks, backlinks };
}

/** Create the sprint's root issue in the SEO project if it is missing. */
export async function ensureRootIssue(env: Env, info: CompanyInfo, sprint: db.Sprint, projectId: string | null): Promise<db.Sprint> {
  if (sprint.rootIssueId) {
    const existing = await getIssue(env, sprint.companyId, sprint.rootIssueId);
    // A closed root issue is retired (e.g. its thread grew too long to hand an agent): open a fresh one.
    if (existing && (existing.status === "done" || existing.status === "cancelled")) {
      // fall through to create a new root issue
    } else if (existing) {
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
  const plan = planFor(businessTypeParam(params, Boolean(client)));
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
    templateId: plan.id,
    templateVersion: TEMPLATE_VERSION,
    autopilotMode,
    ownerUserId,
    notes: str(params, "notes", { max: 4000 }) ?? null,
  });
  let sprint = await requireSprint(env, companyId, id);
  // The client's one WordPress site at this URL with a connected Connector: link it now (best effort, never fails creation).
  let wordpressLinked: string | null = null;
  if (client) {
    try {
      const wp = await autoLinkWordPressSite(env, sprint);
      if (wp) {
        await db.updateSprint(env.ctx.db, companyId, id, { site_access: "wordpress", site_id: wp.id, hosting: "other" });
        sprint = await requireSprint(env, companyId, id);
        wordpressLinked = wp.url;
      }
    } catch (error) {
      env.ctx.logger.info("SEO WordPress auto-link skipped", { sprintId: id, error: errorMessage(error) });
    }
  }
  const seeded = await seedTemplate(env, sprint, plan);
  await env.skills.ensure(companyId).catch(() => []);
  // A client sprint works in the client's own project when one exists; the company SEO project is the fallback.
  sprint = await autoLinkClientProject(env, sprint);
  const projectId = sprint.clientProjectId ?? (await ensureProject(env, companyId));
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
    businessType: plan.businessType,
    plan: plan.label,
    rootIssueId: sprint.rootIssueId,
    seededTasks: seeded.tasks,
    seededBacklinks: seeded.backlinks,
    issuesOpened: materialised.created,
    issuesPending: materialised.remaining,
    warnings,
    siteAccess: sprint.siteAccess,
    ...(wordpressLinked ? { wordpressSite: wordpressLinked } : {}),
    next: wordpressLinked
      ? `Linked to the client's WordPress site ${wordpressLinked} through the PiB Connector: the agent makes SEO changes there itself. The agent verifies Search Console itself with the service account; anything only a person can do goes on the weekly Needs you issue. Wrong plan for this business? change-plan.`
      : "Link the site's repo project (link-site, or the sprint's Integrations tab) so code tasks open there. The agent verifies Search Console itself with the service account; anything only a person can do goes on the weekly Needs you issue. Wrong plan for this business? change-plan.",
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
  const plan = planFor(businessTypeParam(params, Boolean(sprint.clientRef)));
  await db.updateSprint(env.ctx.db, companyId, sprint.id, {
    start_date: startDate,
    status: clock.runningStatus,
    owner_user_id: sprint.ownerUserId ?? actor.userId,
    autopilot_mode: info.loaded.config.defaultAutopilotMode,
  });
  const fresh = await requireSprint(env, companyId, sprint.id);
  const seeded = await seedTemplate(env, fresh, plan);
  return { sprintId: sprint.id, startDate, businessType: plan.businessType, plan: plan.label, seededTasks: seeded.tasks, seededBacklinks: seeded.backlinks, next: "The next daily run opens the due tasks as issues." };
}

/**
 * A sprint as tools and the page see it. With its overview: `tasks` holds the
 * counts (due, overdue, stuck and waiting follow engine/due.ts) and `next` the
 * next thing due.
 */
export function sprintView(sprint: db.Sprint, today: string, overview?: SprintOverview) {
  const clock = sprintClock(sprint.startDate, today);
  const running = isRunning(sprint.status);
  const plan = planOf(sprint.templateId);
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
    /** The 90-day plan the sprint follows (local, professional, ecommerce or saas). */
    businessType: businessTypeOf(sprint.templateId),
    plan: plan.label,
    autopilotMode: sprint.autopilotMode,
    ownerUserId: sprint.ownerUserId,
    rootIssueId: sprint.rootIssueId,
    rootIssueIdentifier: sprint.rootIssueIdentifier,
    health: sprint.health,
    lastDailyOn: sprint.lastDailyOn,
    notes: sprint.notes,
    site: siteLinkView(sprint),
    ...(overview ? { tasks: overview.numbers, next: overview.next } : {}),
  };
}

export async function listSprintsTool(env: Env, companyId: string, params: Params) {
  const info = await companyInfo(env, companyId);
  const status = str(params, "status");
  const sprints = await db.listSprints(env.ctx.db, companyId, { status, scope: scopeParam(params) });
  const overviews = await sprintOverviews(env.ctx.db, companyId, sprints, info.today, await resolveAgent(env, companyId));
  return { today: info.today, sprints: sprints.map((s) => sprintView(s, info.today, overviews.get(s.id))) };
}

export async function getSprintTool(env: Env, companyId: string, params: Params) {
  const ctx = await loadSprintContext(env, companyId, reqStr(params, "sprintId"));
  const overview = (await sprintOverviews(env.ctx.db, companyId, [ctx.sprint], ctx.info.today, await resolveAgent(env, companyId))).get(ctx.sprint.id);
  const [integrations, keywords, health, snapshots] = await Promise.all([
    db.listIntegrations(env.ctx.db, companyId, ctx.sprint.id),
    db.listKeywords(env.ctx.db, companyId, ctx.sprint.id),
    db.latestPageHealth(env.ctx.db, ctx.sprint.id),
    db.listSnapshots(env.ctx.db, companyId, ctx.sprint.id),
  ]);
  return {
    ...sprintView(ctx.sprint, ctx.info.today, overview),
    cockpit: cockpitPath(ctx.info, ctx.sprint),
    integrations: integrations.map(integrationView),
    keywords: { tracked: keywords.length, top10: keywords.filter((k) => (k.currentPosition ?? 999) <= 10).length, priority: keywords.filter((k) => k.isPriority).map((k) => k.phrase) },
    pageHealth: health.map((h) => ({ url: h.url, strategy: h.strategy, performance: h.performance, seo: h.seo, lcpMs: h.lcpMs, cls: h.cls, inpMs: h.inpMs, source: h.source, pulledOn: h.pulledOn })),
    snapshots: snapshots.map((s) => ({ day: s.day, kind: s.kind, capturedOn: s.capturedOn, traffic: s.traffic, rankings: s.rankings, geo: s.geo, analytics: s.analytics })),
    // AI-search readiness and how often sampled AI answers named the business (geo-audit, record-ai-mentions).
    geo: await geoSummary(env, ctx.sprint).catch(() => null),
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
    connected:
      i.provider === "gsc"
        ? (Boolean(i.tokenSealed) || i.settings?.auth === "service_account") && i.status === "connected"
        : i.provider === "ga4"
          ? i.status === "connected" && Boolean(i.propertyUrl)
          : i.status === "enabled",
    auth: i.provider === "gsc" ? (i.settings?.auth === "service_account" ? "service_account" : i.tokenSealed ? "oauth" : null) : i.provider === "ga4" && i.status === "connected" ? "service_account" : null,
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
  // Tasks whose runs stop at the workspace check are stuck, not blocked on a person (engine/due.ts).
  const tasks = await withRunFailures(env.ctx.db, sprint.companyId, await db.listTasks(env.ctx.db, sprint.companyId, sprint.id, { status: OPEN_TASK_STATUSES }));
  const due = tasks.filter((t) => t.dueDay == null || t.dueDay <= clock.day);
  // A site-wide task split into page groups: the agent works the group issues, not the parent (service/chunks.ts).
  const groups = await groupViews(env, sprint.companyId, sprint.id).catch(() => new Map());
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
    ...(groups.has(t.id) ? { pageGroups: groups.get(t.id) } : {}),
  });
  const [integrations, proposals, doneRecently] = await Promise.all([
    db.listIntegrations(env.ctx.db, sprint.companyId, sprint.id),
    db.listOptimizations(env.ctx.db, sprint.companyId, sprint.id, { status: "proposed" }),
    db.listTasks(env.ctx.db, sprint.companyId, sprint.id, { status: ["done"] }),
  ]);
  const since = `${addDays(info.today, -1)}T00:00:00Z`;
  const notStarted = due.filter((t) => t.status === "not_started");
  const agentWork = notStarted.filter((t) => t.owner === "agent");
  // Person tasks listed on Needs you are not the agent's work in progress.
  const inProgress = due.filter((t) => t.status === "in_progress" && t.assigneeKind !== "needs_you" && !t.runsFailing);
  const blocked = due.filter((t) => t.status === "blocked" && !t.runsFailing);
  const runsFailing = isRunning(sprint.status) ? due.filter((t) => t.runsFailing) : [];
  const gsc = integrations.find((i) => i.provider === "gsc");
  const sa = await loadServiceAccount(info);
  const needsYou = await needsYouView(env, info, sprint).catch(() => null);
  const playbook = await playbookSummary(env, sprint).catch(() => ({ playbookId: null, version: null, pending: 0 }));
  // Pages marked live that Social has not been told about yet (they must answer 200 first).
  const announcements = await env.announcements.open(sprint.companyId, sprint.id).catch(() => [] as db.Announcement[]);
  const next: string[] = [];
  if (!isRunning(sprint.status)) next.push(`Sprint is ${sprint.status}; nothing runs until it is resumed.`);
  if (!gsc || gsc.status !== "connected" || !gsc.propertyUrl) {
    if (sa.key) {
      next.push(
        sprint.clientRef
          ? "Search Console: run gsc-check-access. Without access the client email is on Needs you; the plugin re-checks every morning."
          : "Search Console: verify it yourself with the service account (gsc-verification-token → tag through the repo → gsc-verify-site).",
      );
    } else {
      next.push("Search Console: waiting for the service account key (on the Needs you issue). Work the other tasks meanwhile; rankings start once it is set.");
    }
  }
  const wpSite = await sprintWordPressSite(env, sprint);
  if (sprint.siteAccess === "wordpress") {
    next.push(
      !wpSite
        ? "The linked WordPress site is no longer in the CRM: ask a person to pick it again (needs-you-add key site_project); work the other tasks."
        : wpSite.connector_status === "connected"
          ? `WordPress (${wordPressSiteView(wpSite).summary}): make SEO changes with the partnersinbiz.crm:wp-* tools and siteId "${wpSite.id}" (get-site-link, references/wordpress.md).`
          : `WordPress: the PiB Connector on ${wpSite.url} is not connected. Site changes wait for it (needs-you-add key wp_connector, then block-task); work the other tasks.`,
    );
  }
  if (sprint.siteAccess === "unlinked") {
    const waiting = notStarted.filter((t) => t.owner === "agent" && !t.issueId && isCodeTask(t)).length;
    if (waiting > 0) next.push(`${plural(waiting, "code task")} ${waiting === 1 ? "waits" : "wait"} for the site repo link (on Needs you). If you know the repo's project, link it with link-site.`);
  }
  if (runsFailing.length > 0) {
    next.push(
      `${plural(runsFailing.length, "task issue")} (${runsFailing.slice(0, 3).map((t) => t.issueIdentifier ?? t.title).join(", ")}) can't start: ${RUNS_TROUBLE}. Nothing you do there runs until a person fixes the project's Codebase; the Cockpit's System health shows it to them. Do not retry them; work the other tasks.`,
    );
  }
  if (inProgress.length > 0) next.push(`Finish the ${plural(inProgress.length, "task")} in progress first.`);
  if (agentWork.length > 0) next.push(`Work the ${plural(agentWork.length, "due agent task")}, oldest week first; complete each with complete-task and evidence.`);
  for (const view of groups.values()) {
    const task = tasks.find((t) => t.id === view.taskId);
    if (task && view.openIssue) next.push(`"${task.title}" is split into ${view.total} page groups (${view.done} done): work the open group issue ${view.openIssue.identifier ?? view.openIssue.issueId}, not the task's own issue; the task is completed after the last group.`);
  }
  if (blocked.length > 0) next.push(`${plural(blocked.length, "task")} ${blocked.length === 1 ? "is" : "are"} blocked; what they need is on Needs you — do not redo them.`);
  if (needsYou && needsYou.open.length > 0) next.push(`${plural(needsYou.open.length, "item")} ${needsYou.open.length === 1 ? "waits" : "wait"} on a person in Needs you${needsYou.issueIdentifier ? ` (${needsYou.issueIdentifier})` : ""}: ${needsYou.open.map((i) => i.title).slice(0, 4).join("; ")}.`);
  if (proposals.length > 0) next.push(`${plural(proposals.length, "optimization proposal")} ${proposals.length === 1 ? "waits" : "wait"} for approval.`);
  const geo = await geoSummary(env, sprint).catch(() => null);
  if (geo && (geo.score != null || geo.mentions)) next.push(`${geoLine(geo)}. geo-audit refreshes it; record-ai-mentions adds sampled AI answers.`);
  const ga4 = integrations.find((i) => i.provider === "ga4");
  if (ga4?.status === "connected") {
    const line = await ga4Line(env, sprint);
    if (line) next.push(line);
  } else if (sa.key && gsc?.status === "connected") {
    next.push("Google Analytics is not connected: connect-ga4 finds the property by the site's address; the one-time grant it may need is on Needs you (optional).");
  }
  for (const a of announcements.filter((row) => row.status === "stuck").slice(0, 3)) next.push(announcementLine(a));
  if (playbook.pending > 0) {
    next.push(
      sprint.autopilotMode === "full"
        ? `${plural(playbook.pending, "playbook change")} pending: keep or discard each with decide-playbook-change (full autopilot).`
        : `${plural(playbook.pending, "playbook change")} ${playbook.pending === 1 ? "waits" : "wait"} for a person (Needs you / SEO → Playbook); follow the current version meanwhile.`,
    );
  }
  if (next.length === 0) {
    next.push(
      sprint.autopilotMode === "full"
        ? "Nothing is due. Check keyword positions (list-keywords) and post a short digest. The plan is ahead of its dates: you may pull the next week forward with start-tasks-now (week)."
        : "Nothing is due. Check keyword positions (list-keywords) and post a short digest. Pulling the plan forward is the owner's call (Start now on the SEO plan).",
    );
  }
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
    businessType: businessTypeOf(sprint.templateId),
    plan: planOf(sprint.templateId).label,
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
    siteRepo: siteLinkView(sprint, wpSite),
    serviceAccountEmail: sa.key?.clientEmail ?? null,
    playbook: { version: playbook.version, pending: playbook.pending, read: "Call get-playbook with this sprintId before working its tasks and follow it." },
    needsYou: needsYou ? { issueId: needsYou.issueId, issueIdentifier: needsYou.issueIdentifier, open: needsYou.open.map((i) => ({ key: i.key, title: i.title, kind: i.kind })) } : null,
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

/** A digest is a short daily note on the sprint issue; long ones made its thread too big to hand an agent. */
export const DIGEST_MAX = 1000;
/** The digest comment: its summary, the day header and the waiting list. */
const DIGEST_COMMENT_MAX = 3_000;

export async function postDigest(env: Env, companyId: string, actor: Actor, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  if (!sprint.rootIssueId) throw new SeoError("This sprint has no root issue yet");
  const summary = reqStr(params, "summary", { max: 6000 });
  if (summary.length > DIGEST_MAX) {
    throw new SeoError(`Keep the digest under ${DIGEST_MAX} characters: what moved (real numbers) and what waits on whom. The full report belongs on the task's own issue.`);
  }
  const info = await companyInfo(env, companyId);
  const today = await sprintToday(env, info, sprint);
  const mark = { scopeKind: "company" as const, scopeId: companyId, namespace: "seo-digest", stateKey: `${sprint.id}:${info.today}` };
  if (await env.ctx.state.get(mark).catch(() => null)) {
    return { sprintId: sprint.id, rootIssueId: sprint.rootIssueId, posted: false, reason: "Today's digest is already posted. Put task details on the task's own issue." };
  }
  const body = digestComment({
    summary,
    day: today.day,
    week: today.week,
    phase: today.phase,
    doneToday: today.doneToday,
    blocked: today.blocked.map((b) => ({ title: b.title, humanAsk: b.humanAsk ?? null })),
    dueOpen: today.due.length + today.inProgress.length,
  });
  const ok = await commentOn(env, companyId, sprint.rootIssueId, body, { max: DIGEST_COMMENT_MAX, pointer: "task details are on each task's own issue, and the Needs you issue lists what waits on a person" });
  if (!ok) throw new SeoError("The digest comment could not be posted");
  await env.ctx.state.set(mark, new Date().toISOString()).catch(() => undefined);
  return { sprintId: sprint.id, rootIssueId: sprint.rootIssueId, posted: true, by: actorLabel(actor) };
}
