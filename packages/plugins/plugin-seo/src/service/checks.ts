/**
 * Site-check tools. Each runs a bounded check through the SSRF-guarded
 * fetcher; with a sprintId the findings are stored (and findings the check no
 * longer reports for that URL are resolved).
 */
import { randomUUID } from "node:crypto";
import type { CheckFinding } from "../checks/parse.js";
import {
  runCanonicalCheck,
  runCrawlerSim,
  runInternalLinkAudit,
  runMetaCheck,
  runRobotsCheck,
  runSchemaCheck,
  runSitemapCheck,
} from "../checks/site.js";
import * as db from "../db.js";
import { cwvFindings, runPagespeed, type PageHealthRecord, type Strategy } from "../integrations/pagespeed.js";
import { companyInfo, errorMessage, num, oneOf, SeoError, str, urlParam, type Env, type Params } from "./common.js";
import { requireSprint } from "./context.js";

async function targetFor(env: Env, companyId: string, params: Params): Promise<{ sprint: db.Sprint | null; url: string }> {
  const sprintId = str(params, "sprintId");
  const sprint = sprintId ? await requireSprint(env, companyId, sprintId) : null;
  const raw = str(params, "url", { max: 2000 });
  if (!raw && !sprint) throw new SeoError("Pass url, or sprintId to check the sprint's site");
  return { sprint, url: raw ? urlParam(raw, sprint?.siteUrl) : urlParam(sprint!.siteUrl) };
}

/** Store findings and resolve stale ones for every (category, url) the check covered. */
export async function recordCheckFindings(
  env: Env,
  sprint: db.Sprint | null,
  source: string,
  findings: CheckFinding[],
  covered: Array<{ category: string; url: string | null }>,
): Promise<{ recorded: number; resolved: number }> {
  if (!sprint) return { recorded: 0, resolved: 0 };
  let recorded = 0;
  let resolved = 0;
  const kept = findings.filter((f) => f.severity !== "info");
  for (const f of kept) {
    await db.upsertFinding(env.ctx.db, {
      id: randomUUID(),
      companyId: sprint.companyId,
      sprintId: sprint.id,
      finding: f.finding,
      severity: f.severity,
      category: f.category,
      url: f.url,
      source,
    });
    recorded += 1;
  }
  const pairs = new Map<string, { category: string; url: string | null }>();
  for (const c of covered) pairs.set(`${c.category}|${c.url ?? ""}`, c);
  for (const f of kept) pairs.set(`${f.category}|${f.url ?? ""}`, { category: f.category, url: f.url });
  for (const pair of pairs.values()) {
    const current = kept.filter((f) => f.category === pair.category && (f.url ?? "") === (pair.url ?? "")).map((f) => f.finding);
    resolved += await db.resolveStaleFindings(env.ctx.db, { sprintId: sprint.id, category: pair.category, url: pair.url, source, current });
  }
  return { recorded, resolved };
}

export async function checkRobotsTool(env: Env, companyId: string, params: Params) {
  const { sprint, url } = await targetFor(env, companyId, params);
  const result = await runRobotsCheck(env.site, url);
  const stored = await recordCheckFindings(env, sprint, "check-robots", result.findings, [{ category: "robots", url: result.url }]);
  return { ...result, stored };
}

export async function checkSitemapTool(env: Env, companyId: string, params: Params) {
  const { sprint, url } = await targetFor(env, companyId, params);
  const sitemapUrl = str(params, "sitemapUrl", { max: 2000 });
  const result = await runSitemapCheck(env.site, {
    siteUrl: sprint?.siteUrl ?? url,
    sitemapUrl: sitemapUrl ? urlParam(sitemapUrl, sprint?.siteUrl ?? url) : !sprint && /sitemap/i.test(url) ? url : null,
    sample: num(params, "sample", { integer: true, min: 0, max: 10 }) ?? 5,
  });
  const covered = [{ category: "sitemap", url: result.sitemapUrl }, ...result.spotChecked.map((s) => ({ category: "sitemap", url: s.url }))];
  const stored = await recordCheckFindings(env, sprint, "check-sitemap", result.findings, covered);
  const { urls: _urls, ...rest } = result;
  return { ...rest, stored };
}

export async function checkMetaTool(env: Env, companyId: string, params: Params) {
  const { sprint, url } = await targetFor(env, companyId, params);
  const result = await runMetaCheck(env.site, url);
  const stored = await recordCheckFindings(env, sprint, "check-meta", result.findings, [{ category: "meta", url: result.finalUrl }]);
  return {
    url: result.url,
    finalUrl: result.finalUrl,
    status: result.status,
    title: result.meta.title,
    titleLength: result.meta.title?.length ?? 0,
    description: result.meta.description,
    descriptionLength: result.meta.description?.length ?? 0,
    h1: result.meta.h1,
    canonical: result.meta.canonicals[0] ?? null,
    robots: result.meta.robots,
    ogTitle: result.meta.ogTitle,
    ogDescription: result.meta.ogDescription,
    ogImage: result.meta.ogImage,
    twitterCard: result.meta.twitterCard,
    lang: result.meta.lang,
    issues: result.findings.map((f) => `${f.severity}: ${f.finding}`),
    stored,
  };
}

export async function checkCanonicalTool(env: Env, companyId: string, params: Params) {
  const { sprint, url } = await targetFor(env, companyId, params);
  const result = await runCanonicalCheck(env.site, url);
  const stored = await recordCheckFindings(env, sprint, "check-canonical", result.findings, [{ category: "canonical", url: result.url }]);
  return { ...result, stored };
}

export async function validateSchemaTool(env: Env, companyId: string, params: Params) {
  const { sprint, url } = await targetFor(env, companyId, params);
  const result = await runSchemaCheck(env.site, url);
  const stored = await recordCheckFindings(env, sprint, "validate-schema", result.findings, [{ category: "schema", url: result.url }]);
  return { ...result, stored };
}

export async function crawlerSimTool(env: Env, companyId: string, params: Params) {
  const { sprint, url } = await targetFor(env, companyId, params);
  const result = await runCrawlerSim(env.site, url);
  const stored = await recordCheckFindings(env, sprint, "crawler-sim", result.findings, [
    { category: "crawl", url: result.finalUrl },
    { category: "images", url: result.finalUrl },
  ]);
  return { ...result, stored };
}

export async function internalLinkAuditTool(env: Env, companyId: string, params: Params) {
  const { sprint, url } = await targetFor(env, companyId, params);
  const sitemapUrl = str(params, "sitemapUrl", { max: 2000 });
  const result = await runInternalLinkAudit(env.site, {
    siteUrl: sprint?.siteUrl ?? url,
    sitemapUrl: sitemapUrl ? urlParam(sitemapUrl, sprint?.siteUrl ?? url) : null,
    maxPages: num(params, "maxPages", { integer: true, min: 1, max: 40 }) ?? 25,
  });
  // Orphans are only meaningful for a complete crawl; partial runs are reported, not stored.
  const stored = result.partial
    ? { recorded: 0, resolved: 0 }
    : await recordCheckFindings(
      env,
      sprint,
      "internal-link-audit",
      result.findings.filter((f) => f.category === "links"),
      result.crawledPages.map((page) => ({ category: "links", url: page })),
    );
  return {
    ...result,
    stored,
    note: result.partial ? "Partial crawl (page cap or time limit): orphans are relative to the crawled pages and were not stored as findings." : undefined,
  };
}

// ---------------------------------------------------------------------------
// PageSpeed
// ---------------------------------------------------------------------------

export async function savePageHealth(env: Env, sprint: db.Sprint, record: PageHealthRecord, pulledOn: string): Promise<{ recorded: number; resolved: number }> {
  await db.upsertPageHealth(env.ctx.db, {
    id: randomUUID(),
    companyId: sprint.companyId,
    sprintId: sprint.id,
    url: record.url,
    strategy: record.strategy,
    performance: record.performance,
    seo: record.seo,
    accessibility: record.accessibility,
    bestPractices: record.bestPractices,
    lcpMs: record.lcpMs,
    cls: record.cls,
    inpMs: record.inpMs,
    labLcpMs: record.labLcpMs,
    labCls: record.labCls,
    labInpMs: record.labInpMs,
    fieldLcpMs: record.fieldLcpMs,
    fieldCls: record.fieldCls,
    fieldInpMs: record.fieldInpMs,
    fieldScope: record.fieldScope,
    source: record.source,
    opportunities: record.opportunities,
    pulledOn,
  });
  const findings: CheckFinding[] = record.strategy === "mobile"
    ? cwvFindings(record).map((f) => ({ category: "cwv", severity: f.severity, url: record.url, finding: f.finding }))
    : [];
  return recordCheckFindings(env, sprint, "pagespeed", findings, record.strategy === "mobile" ? [{ category: "cwv", url: record.url }] : []);
}

export async function runPagespeedTool(env: Env, companyId: string, params: Params) {
  const { sprint, url } = await targetFor(env, companyId, params);
  const strategy: Strategy = oneOf(params, "strategy", ["mobile", "desktop"] as const) ?? "mobile";
  const info = await companyInfo(env, companyId);
  let apiKey: string | undefined;
  try {
    apiKey = await info.loaded.secrets.get("pagespeedApiKey");
  } catch (error) {
    env.ctx.logger.info("PageSpeed key unavailable", { error: errorMessage(error) });
  }
  const record = await runPagespeed(env.fetch, { url, strategy, apiKey });
  const stored = sprint ? await savePageHealth(env, sprint, record, info.today) : { recorded: 0, resolved: 0 };
  if (sprint) {
    const integration = await db.getIntegration(env.ctx.db, companyId, sprint.id, "pagespeed");
    if (integration) await db.updateIntegration(env.ctx.db, companyId, integration.id, { last_pull_at: new Date().toISOString(), last_error: null });
  }
  return { ...record, saved: Boolean(sprint), stored };
}
