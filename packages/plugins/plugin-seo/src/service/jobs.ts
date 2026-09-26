/**
 * Scheduled work. Jobs have no invocation scope: every host call names the
 * company explicitly, company ids come from our own sprint rows, and a company
 * whose SEO settings are not saved is skipped (the host would refuse anyway).
 *
 * seo-daily (hourly at :05): links a pending SEO agent hire (backstop for
 * missed agent events), then once per sprint per local day after the
 * configured hour — clock/status, root issue, GSC/PageSpeed/Bing pulls,
 * scheduled audit snapshots, due-task sub-issues, measurements, issue heal,
 * today's plan.
 * seo-weekly (Mondays 05:00 UTC = 07:00 SAST): detectors + proposals + one
 * approval issue per sprint.
 */
import { comparableUrl } from "../checks/parse.js";
import * as db from "../db.js";
import { isRunning, nextSprintStatus, type AgentAvailability } from "../engine/sprint.js";
import { daysBetween } from "../engine/time.js";
import { fetchBingLinkCounts } from "../integrations/bing.js";
import { runPagespeed } from "../integrations/pagespeed.js";
import { configSaved } from "@partnersinbiz/pib-plugin-kit";
import { ensureProject, linkPendingHire, resolveAgent } from "./agent.js";
import { savePageHealth } from "./checks.js";
import { companyInfo, errorMessage, type CompanyInfo, type Env } from "./common.js";
import { clockFor } from "./context.js";
import { gscPull, GscUnavailable } from "./gsc.js";
import { detectSignals, measureDue } from "./optimize.js";
import { ensureRootIssue, sprintToday } from "./sprints.js";
import { scheduledSnapshots } from "./snapshots.js";
import { healTasks, materialiseDueTasks } from "./tasks.js";

const JOB_BUDGET_MS = 200_000;

function groupByCompany(sprints: db.Sprint[]): Map<string, db.Sprint[]> {
  const out = new Map<string, db.Sprint[]>();
  for (const sprint of sprints) {
    const list = out.get(sprint.companyId) ?? [];
    list.push(sprint);
    out.set(sprint.companyId, list);
  }
  return out;
}

async function companyReady(env: Env, companyId: string): Promise<CompanyInfo | null> {
  try {
    const info = await companyInfo(env, companyId);
    if (!info.loaded.config.saved) {
      env.ctx.logger.info("SEO settings not saved for company; skipping scheduled work", { companyId });
      return null;
    }
    return info;
  } catch (error) {
    env.ctx.logger.info("SEO company skipped (config unavailable)", { companyId, error: errorMessage(error) });
    return null;
  }
}

/** Home page plus up to 3 target pages, rotated by day so every page gets checked. */
export function pagespeedUrls(siteUrl: string, candidates: string[], day: number, max = 3): string[] {
  const home = comparableUrl(siteUrl) ?? siteUrl;
  const unique = [...new Set(candidates.map((u) => comparableUrl(u)).filter((u): u is string => !!u && u !== home))].sort();
  const picks: string[] = [];
  if (unique.length > 0) {
    const start = ((day % unique.length) + unique.length) % unique.length;
    for (let i = 0; i < Math.min(max, unique.length); i += 1) picks.push(unique[(start + i) % unique.length]!);
  }
  return [home, ...picks];
}

async function dailyPagespeed(env: Env, info: CompanyInfo, sprint: db.Sprint, day: number): Promise<string | null> {
  const integration = await db.getIntegration(env.ctx.db, sprint.companyId, sprint.id, "pagespeed");
  if (!integration || integration.status !== "enabled") return null;
  const [keywords, content, pages] = await Promise.all([
    db.listKeywords(env.ctx.db, sprint.companyId, sprint.id),
    db.listContent(env.ctx.db, sprint.companyId, sprint.id, { status: "live" }),
    db.listPages(env.ctx.db, sprint.companyId, sprint.id),
  ]);
  const urls = pagespeedUrls(
    sprint.siteUrl,
    [...keywords.map((k) => k.targetUrl), ...content.map((c) => c.targetUrl), ...pages.map((p) => p.url)].filter((u): u is string => !!u),
    day,
  );
  let apiKey: string | undefined;
  try {
    apiKey = await info.loaded.secrets.get("pagespeedApiKey");
  } catch {
    apiKey = undefined;
  }
  const results = await Promise.allSettled(urls.map((url) => runPagespeed(env.fetch, { url, strategy: "mobile", apiKey })));
  const errors: string[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") await savePageHealth(env, sprint, result.value, info.today);
    else errors.push(errorMessage(result.reason));
  }
  await db.updateIntegration(env.ctx.db, sprint.companyId, integration.id, {
    last_pull_at: new Date().toISOString(),
    last_error: errors.length > 0 ? errors.join("; ").slice(0, 500) : null,
    stats: { urls, ok: results.filter((r) => r.status === "fulfilled").length, pulledOn: info.today },
  });
  return errors.length > 0 ? `PageSpeed: ${errors[0]}` : null;
}

async function dailyBing(env: Env, info: CompanyInfo, sprint: db.Sprint): Promise<string | null> {
  const integration = await db.getIntegration(env.ctx.db, sprint.companyId, sprint.id, "bing");
  if (!integration || integration.status !== "enabled") return null;
  const apiKey = await info.loaded.secrets.get("bingApiKey").catch(() => undefined);
  if (!apiKey) {
    await db.updateIntegration(env.ctx.db, sprint.companyId, integration.id, { last_error: "Bing API key is not set in the SEO settings" });
    return "Bing: API key missing";
  }
  try {
    const counts = await fetchBingLinkCounts(env.fetch, { apiKey, siteUrl: integration.propertyUrl ?? sprint.siteUrl });
    await db.updateIntegration(env.ctx.db, sprint.companyId, integration.id, {
      last_pull_at: new Date().toISOString(),
      last_error: null,
      stats: { totalInboundLinks: counts.totalInboundLinks, topPages: counts.pages.slice(0, 10), totalPages: counts.totalPages, pulledOn: info.today },
    });
    return null;
  } catch (error) {
    await db.updateIntegration(env.ctx.db, sprint.companyId, integration.id, { last_error: errorMessage(error).slice(0, 500) });
    return `Bing: ${errorMessage(error)}`;
  }
}

export interface DailySprintResult {
  sprintId: string;
  status: string;
  day: number;
  issuesOpened: number;
  snapshotDay: number | null;
  measured: number;
  healed: number;
  warnings: string[];
}

export async function runDailyForSprint(
  env: Env,
  info: CompanyInfo,
  input: db.Sprint,
  deps: { agent: AgentAvailability; projectId: string | null },
): Promise<DailySprintResult> {
  let sprint = input;
  const warnings: string[] = [];
  const clock = clockFor(sprint, info.today);
  const status = nextSprintStatus(sprint.status, clock);
  await db.updateSprint(env.ctx.db, sprint.companyId, sprint.id, {
    status,
    current_day: clock.day,
    current_week: clock.week,
    current_phase: clock.phase,
    ...(deps.projectId && !sprint.projectId ? { project_id: deps.projectId } : {}),
  });
  sprint = { ...sprint, status, projectId: sprint.projectId ?? deps.projectId };

  try {
    sprint = await ensureRootIssue(env, info, sprint, sprint.projectId);
  } catch (error) {
    warnings.push(`Root issue: ${errorMessage(error)}`);
  }

  const gsc = await db.getIntegration(env.ctx.db, sprint.companyId, sprint.id, "gsc");
  if (gsc?.tokenSealed && gsc.status === "connected" && gsc.propertyUrl) {
    try {
      await gscPull(env, info, sprint);
    } catch (error) {
      warnings.push(error instanceof GscUnavailable ? error.message : `GSC: ${errorMessage(error)}`);
      if (!(error instanceof GscUnavailable)) {
        await db.updateIntegration(env.ctx.db, sprint.companyId, gsc.id, { last_error: errorMessage(error).slice(0, 500) });
      }
    }
  }
  const [psWarning, bingWarning] = await Promise.all([
    dailyPagespeed(env, info, sprint, clock.day).catch((error) => `PageSpeed: ${errorMessage(error)}`),
    dailyBing(env, info, sprint).catch((error) => `Bing: ${errorMessage(error)}`),
  ]);
  if (psWarning) warnings.push(psWarning);
  if (bingWarning) warnings.push(bingWarning);

  let snapshotDay: number | null = null;
  if (clock.day >= 0) {
    try {
      snapshotDay = await scheduledSnapshots(env, info, sprint, clock.day);
    } catch (error) {
      warnings.push(`Snapshot: ${errorMessage(error)}`);
    }
  }

  let issuesOpened = 0;
  if (sprint.rootIssueId) {
    const result = await materialiseDueTasks(env, { info, sprint, day: clock.day, agent: deps.agent, projectId: sprint.projectId }, { limit: 60 });
    issuesOpened = result.created;
    warnings.push(...result.errors.slice(0, 5));
  }

  let measured = 0;
  try {
    measured = await measureDue(env, info, sprint);
  } catch (error) {
    warnings.push(`Measure: ${errorMessage(error)}`);
  }

  let healed = 0;
  try {
    healed = await healTasks(env, sprint);
  } catch (error) {
    warnings.push(`Heal: ${errorMessage(error)}`);
  }

  const today = await sprintToday(env, info, sprint);
  await db.updateSprint(env.ctx.db, sprint.companyId, sprint.id, {
    today: {
      asOf: new Date().toISOString(),
      day: today.day,
      week: today.week,
      phase: today.phase,
      due: today.due.length,
      inProgress: today.inProgress.length,
      blocked: today.blocked.length,
      proposals: today.proposals.length,
      next: today.next,
      warnings: warnings.slice(0, 10),
    },
    last_daily_on: info.today,
  });
  return { sprintId: sprint.id, status, day: clock.day, issuesOpened, snapshotDay, measured, healed, warnings };
}

/**
 * Agent events are delivered at most once, so the hourly job also links a
 * pending hire, for every company with sprints or saved SEO settings.
 */
export async function linkPendingHires(env: Env): Promise<number> {
  const companies = new Set<string>();
  try {
    for (const id of await db.listSprintCompanies(env.ctx.db)) companies.add(id);
  } catch (error) {
    env.ctx.logger.info("SEO hire check: sprint companies unavailable", { error: errorMessage(error) });
  }
  try {
    for (const company of await env.ctx.companies.list({ limit: 100 })) {
      if (!companies.has(company.id) && (await configSaved(env.ctx, company.id))) companies.add(company.id);
    }
  } catch (error) {
    env.ctx.logger.info("SEO hire check: company list unavailable", { error: errorMessage(error) });
  }
  let linked = 0;
  for (const companyId of companies) {
    if (await linkPendingHire(env, companyId)) linked += 1;
  }
  return linked;
}

export async function runDailyJob(env: Env, opts: { force?: boolean } = {}): Promise<{ processed: number; skipped: number; errors: string[]; hiresLinked: number }> {
  const started = Date.now();
  const hiresLinked = await linkPendingHires(env).catch((error: unknown) => {
    env.ctx.logger.info("SEO hire check failed", { error: errorMessage(error) });
    return 0;
  });
  const sprints = await db.listRunnableSprints(env.ctx.db);
  let processed = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const [companyId, list] of groupByCompany(sprints)) {
    const info = await companyReady(env, companyId);
    if (!info) {
      skipped += list.length;
      continue;
    }
    if (!opts.force && info.hour < info.loaded.config.dailyHourLocal) {
      skipped += list.length;
      continue;
    }
    const pending = list.filter((s) => opts.force || s.lastDailyOn !== info.today);
    if (pending.length === 0) continue;
    await env.skills.ensure(companyId).catch(() => []);
    const projectId = await ensureProject(env, companyId);
    const agent = await resolveAgent(env, companyId);
    for (const sprint of pending) {
      if (Date.now() - started > JOB_BUDGET_MS) {
        skipped += 1;
        continue;
      }
      try {
        const result = await runDailyForSprint(env, info, sprint, { agent, projectId });
        processed += 1;
        env.ctx.logger.info("SEO daily run", { ...result });
      } catch (error) {
        errors.push(`${sprint.id}: ${errorMessage(error)}`);
        env.ctx.logger.error("SEO daily run failed", { sprintId: sprint.id, companyId, error: errorMessage(error) });
      }
    }
  }
  await db.deleteExpiredOAuthSessions(env.ctx.db).catch(() => undefined);
  return { processed, skipped, errors, hiresLinked };
}

export async function runWeeklyForSprint(env: Env, info: CompanyInfo, sprint: db.Sprint) {
  const result = await detectSignals(env, info, sprint, { propose: true });
  await db.updateSprint(env.ctx.db, sprint.companyId, sprint.id, { last_weekly_on: info.today });
  return result;
}

export async function runWeeklyJob(env: Env, opts: { force?: boolean } = {}): Promise<{ processed: number; proposals: number; errors: string[] }> {
  const started = Date.now();
  const sprints = (await db.listRunnableSprints(env.ctx.db)).filter((s) => s.status === "active" || s.status === "compounding");
  let processed = 0;
  let proposals = 0;
  const errors: string[] = [];
  for (const [companyId, list] of groupByCompany(sprints)) {
    const info = await companyReady(env, companyId);
    if (!info) continue;
    await env.skills.ensure(companyId).catch(() => []);
    for (const sprint of list) {
      if (!opts.force && sprint.lastWeeklyOn && daysBetween(sprint.lastWeeklyOn, info.today) < 6) continue;
      if (!isRunning(sprint.status) || Date.now() - started > JOB_BUDGET_MS) continue;
      try {
        const result = await runWeeklyForSprint(env, info, sprint);
        processed += 1;
        proposals += result.proposalsCreated.length;
      } catch (error) {
        errors.push(`${sprint.id}: ${errorMessage(error)}`);
        env.ctx.logger.error("SEO weekly run failed", { sprintId: sprint.id, companyId, error: errorMessage(error) });
      }
    }
  }
  return { processed, proposals, errors };
}
