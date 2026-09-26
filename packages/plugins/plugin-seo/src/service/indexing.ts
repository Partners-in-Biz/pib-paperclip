/**
 * Getting pages crawled without a person: sitemap submission (GSC API),
 * IndexNow pings, URL Inspection to confirm, and Bing Webmaster setup via its
 * API. Google has no public "Request indexing" API for normal pages, so only
 * pages still not indexed after 14 days become an optional Needs you item.
 */
import { randomUUID } from "node:crypto";
import * as db from "../db.js";
import { bingKeyItem, indexingFollowUpItem } from "../engine/items.js";
import { addDays } from "../engine/time.js";
import {
  bingAddSite,
  bingSubmitSitemap,
  bingSubmitUrlBatch,
  bingVerificationFiles,
  bingVerifySite,
} from "../integrations/bing.js";
import { inspectUrl, submitSitemap } from "../integrations/google.js";
import { indexNowKeyLocation, indexNowRequest, newIndexNowKey, submitIndexNow } from "../integrations/indexnow.js";
import { bool, companyInfo, errorMessage, reqStr, SeoError, str, strList, urlParam, type CompanyInfo, type Env, type Params } from "./common.js";
import { requireSprint } from "./context.js";
import { gscAccess, GscUnavailable, settingsPath } from "./gsc.js";
import { addNeedsYou, resolveNeedsYou } from "./needs-you.js";

interface IndexNowState {
  key: string;
  keyLocation: string;
  liveAt?: string | null;
}

interface IndexingState {
  requestedOn: string;
  followUpOn: string;
  urls: string[];
  followedUp?: boolean;
  notIndexed?: string[];
}

function origin(siteUrl: string): string {
  return new URL(urlParam(siteUrl)).origin;
}

async function saveVerification(env: Env, sprint: db.Sprint, patch: Record<string, unknown>): Promise<db.Sprint> {
  const verification = { ...sprint.verification, ...patch };
  await db.updateSprint(env.ctx.db, sprint.companyId, sprint.id, { verification });
  return { ...sprint, verification };
}

/** The sprint's IndexNow key (created on first use) and whether its file is live. */
async function indexNowState(env: Env, sprint: db.Sprint): Promise<{ sprint: db.Sprint; state: IndexNowState; live: boolean; liveError: string | null }> {
  let state = sprint.verification.indexNow as IndexNowState | undefined;
  let current = sprint;
  if (!state?.key) {
    const key = newIndexNowKey();
    state = { key, keyLocation: indexNowKeyLocation(origin(sprint.siteUrl), key) };
    current = await saveVerification(env, sprint, { indexNow: state });
  }
  let live = false;
  let liveError: string | null = null;
  try {
    const res = await env.site(state.keyLocation, { maxChars: 2000 });
    live = res.status === 200 && res.text.trim() === state.key;
    if (!live) liveError = `HTTP ${res.status}${res.status === 200 ? " but the file does not contain the key" : ""}`;
  } catch (error) {
    liveError = errorMessage(error);
  }
  if (live && !state.liveAt) {
    state = { ...state, liveAt: env.now().toISOString() };
    current = await saveVerification(env, current, { indexNow: state });
  }
  return { sprint: current, state, live, liveError };
}

export async function indexNowKeyTool(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const { state, live, liveError } = await indexNowState(env, sprint);
  const path = `/${state.key}.txt`;
  return {
    sprintId: sprint.id,
    key: state.key,
    file: { path, content: state.key, nextjs: `public/${state.key}.txt` },
    keyLocation: state.keyLocation,
    live,
    liveError,
    next: live
      ? "The key file is live: request-indexing pings IndexNow (Bing and others) for the core URLs."
      : "Add the key file through the site repo (SEO scope: verification/key files), deploy, then run request-indexing.",
  };
}

/** Home page plus the sprint's known important pages (targets and live content), up to `max`. */
async function coreUrls(env: Env, sprint: db.Sprint, max: number): Promise<string[]> {
  const home = `${origin(sprint.siteUrl)}/`;
  const [keywords, content] = await Promise.all([
    db.listKeywords(env.ctx.db, sprint.companyId, sprint.id),
    db.listContent(env.ctx.db, sprint.companyId, sprint.id, { status: "live" }),
  ]);
  const urls = [home, ...keywords.filter((k) => k.isPriority).map((k) => k.targetUrl), ...content.map((c) => c.targetUrl), ...keywords.map((k) => k.targetUrl)].filter((u): u is string => Boolean(u));
  return [...new Set(urls.map((u) => urlParam(u, sprint.siteUrl)))].slice(0, max);
}

export async function requestIndexingTool(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  const given = strList(params, "urls", { max: 20, itemMax: 2000 }).map((u) => urlParam(u, sprint.siteUrl));
  const urls = given.length > 0 ? given : await coreUrls(env, sprint, 5);
  const sitemapUrl = str(params, "sitemapUrl", { max: 1000 }) ? urlParam(str(params, "sitemapUrl")!, sprint.siteUrl) : `${origin(sprint.siteUrl)}/sitemap.xml`;
  const out: Record<string, unknown> = { sprintId: sprint.id, urls };

  // 1. Sitemap to Search Console, 3. URL Inspection (same access).
  let property: string | null = null;
  let token: string | null = null;
  try {
    const access = await gscAccess(env, info, sprint, { needProperty: true });
    property = access.propertyUrl;
    token = access.accessToken;
    await submitSitemap(env.fetch, token, property!, sitemapUrl);
    out.sitemap = { submitted: true, sitemapUrl, property, via: access.via };
  } catch (error) {
    out.sitemap = { submitted: false, sitemapUrl, reason: errorMessage(error) };
  }

  // 2. IndexNow.
  const now = await indexNowState(env, sprint);
  if (now.live) {
    const result = await submitIndexNow(env.fetch, indexNowRequest(origin(sprint.siteUrl), now.state.key, urls)).catch((error: unknown) => ({ ok: false, status: 0, meaning: errorMessage(error), submitted: 0 }));
    out.indexNow = result;
  } else {
    out.indexNow = { ok: false, skipped: true, reason: `The IndexNow key file is not live at ${now.state.keyLocation} (${now.liveError ?? "missing"}). Add it with indexnow-key through the repo.` };
  }

  // 3. Inspect (bounded: each call can take a few seconds).
  const inspections: Array<Record<string, unknown>> = [];
  if (token && property) {
    for (const url of urls.slice(0, 5)) {
      try {
        const r = await inspectUrl(env.fetch, token, property, url);
        inspections.push({ url, verdict: r.verdict, coverageState: r.coverageState, lastCrawlTime: r.lastCrawlTime });
      } catch (error) {
        inspections.push({ url, error: errorMessage(error) });
      }
    }
  }
  out.inspections = inspections;
  const notIndexed = inspections.filter((i) => i.verdict !== "PASS").map((i) => String(i.url));
  const tracking: IndexingState = { requestedOn: info.today, followUpOn: addDays(info.today, 14), urls, notIndexed, followedUp: false };
  await saveVerification(env, (await db.getSprint(env.ctx.db, companyId, sprint.id)) ?? sprint, { indexing: tracking });
  out.notIndexed = notIndexed;
  out.followUpOn = tracking.followUpOn;
  out.note =
    "Google has no public API to request indexing for normal pages. Sitemap + IndexNow + internal links get pages crawled; on the follow-up date the daily run re-inspects them and adds optional URL-inspection links to Needs you for any still not indexed.";
  return out;
}

/** Daily: 14 days after request-indexing, re-inspect and put stragglers on Needs you (optional). */
export async function indexingFollowUp(env: Env, info: CompanyInfo, sprint: db.Sprint): Promise<number> {
  const state = sprint.verification.indexing as IndexingState | undefined;
  if (!state || state.followedUp || !state.followUpOn || state.followUpOn > info.today) return 0;
  let access;
  try {
    access = await gscAccess(env, info, sprint, { needProperty: true });
  } catch (error) {
    if (error instanceof GscUnavailable) return 0;
    throw error;
  }
  const still: string[] = [];
  for (const url of state.urls.slice(0, 10)) {
    try {
      const r = await inspectUrl(env.fetch, access.accessToken, access.propertyUrl!, url);
      if (r.verdict !== "PASS") still.push(url);
    } catch {
      still.push(url);
    }
  }
  await saveVerification(env, sprint, { indexing: { ...state, followedUp: true, notIndexed: still, checkedOn: info.today } });
  if (still.length > 0) await addNeedsYou(env, info, sprint, indexingFollowUpItem(access.propertyUrl!, still));
  return still.length;
}

// ---------------------------------------------------------------------------
// Bing Webmaster Tools (API key in the SEO settings)
// ---------------------------------------------------------------------------

async function bingKey(env: Env, info: CompanyInfo, sprint: db.Sprint, taskId?: string): Promise<string> {
  const key = await info.loaded.secrets.get("bingApiKey").catch(() => undefined);
  if (key) return key;
  await addNeedsYou(env, info, sprint, bingKeyItem({ prefix: info.prefix, settingsPath: await settingsPath(env, info) }, taskId ? [taskId] : []));
  throw new SeoError("No Bing Webmaster API key is set yet. It is on the sprint's Needs you digest; this task continues when it is added.");
}

async function bingIntegration(env: Env, sprint: db.Sprint): Promise<db.Integration> {
  let integration = await db.getIntegration(env.ctx.db, sprint.companyId, sprint.id, "bing");
  if (!integration) {
    await db.ensureIntegration(env.ctx.db, { id: randomUUID(), companyId: sprint.companyId, sprintId: sprint.id, provider: "bing", status: "disabled" });
    integration = await db.getIntegration(env.ctx.db, sprint.companyId, sprint.id, "bing");
  }
  if (!integration) throw new SeoError("Bing integration row could not be created");
  return integration;
}

export async function bingAddSiteTool(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  const apiKey = await bingKey(env, info, sprint, str(params, "taskId"));
  const siteUrl = str(params, "siteUrl", { max: 500 }) ? urlParam(str(params, "siteUrl")!) : `${origin(sprint.siteUrl)}/`;
  const site = await bingAddSite(env.fetch, apiKey, siteUrl).catch((error: unknown) => {
    throw new SeoError(errorMessage(error));
  });
  await saveVerification(env, sprint, { bing: { siteUrl, code: site.authenticationCode, verified: site.isVerified, addedAt: env.now().toISOString() } });
  const files = site.authenticationCode ? bingVerificationFiles(site.authenticationCode) : null;
  return {
    sprintId: sprint.id,
    siteUrl,
    verified: site.isVerified,
    authenticationCode: site.authenticationCode,
    file: files?.file ?? null,
    meta: files?.meta ?? null,
    next: site.isVerified
      ? "Already verified: run bing-verify-site to enable Bing on the sprint and submit the sitemap."
      : "Add BingSiteAuth.xml (or the msvalidate.01 meta tag) through the site repo (SEO scope), deploy, then run bing-verify-site.",
  };
}

export async function bingVerifySiteTool(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  const apiKey = await bingKey(env, info, sprint, str(params, "taskId"));
  const bing = (sprint.verification.bing ?? {}) as { siteUrl?: string };
  const siteUrl = bing.siteUrl ?? `${origin(sprint.siteUrl)}/`;
  const verified = await bingVerifySite(env.fetch, apiKey, siteUrl).catch((error: unknown) => {
    throw new SeoError(errorMessage(error));
  });
  if (!verified) {
    throw new SeoError(`Bing could not verify ${siteUrl}. Check ${origin(sprint.siteUrl)}/BingSiteAuth.xml (or the msvalidate.01 meta tag) is live on production, then run bing-verify-site again.`);
  }
  const integration = await bingIntegration(env, sprint);
  await db.updateIntegration(env.ctx.db, companyId, integration.id, { status: "enabled", property_url: siteUrl, last_error: null });
  await saveVerification(env, sprint, { bing: { ...bing, siteUrl, verified: true, verifiedAt: env.now().toISOString() } });
  let sitemap: Record<string, unknown> = { submitted: false };
  if (bool(params, "submitSitemap") ?? true) {
    const feedUrl = `${origin(sprint.siteUrl)}/sitemap.xml`;
    try {
      await bingSubmitSitemap(env.fetch, apiKey, siteUrl, feedUrl);
      sitemap = { submitted: true, feedUrl };
    } catch (error) {
      sitemap = { submitted: false, feedUrl, error: errorMessage(error) };
    }
  }
  await resolveNeedsYou(env, info, sprint, "bing_key", "checked by the SEO plugin").catch(() => undefined);
  return { sprintId: sprint.id, siteUrl, verified: true, bingEnabled: true, sitemap, next: "Bing link counts pull daily; submit new URLs with bing-submit (IndexNow pings reach Bing too)." };
}

export async function bingSubmitTool(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  const apiKey = await bingKey(env, info, sprint, str(params, "taskId"));
  const bing = (sprint.verification.bing ?? {}) as { siteUrl?: string };
  const siteUrl = bing.siteUrl ?? `${origin(sprint.siteUrl)}/`;
  const urls = strList(params, "urls", { max: 500, itemMax: 2000 }).map((u) => urlParam(u, sprint.siteUrl));
  const sitemapUrl = str(params, "sitemapUrl", { max: 1000 });
  const out: Record<string, unknown> = { sprintId: sprint.id, siteUrl };
  if (sitemapUrl || urls.length === 0) {
    const feedUrl = sitemapUrl ? urlParam(sitemapUrl, sprint.siteUrl) : `${origin(sprint.siteUrl)}/sitemap.xml`;
    await bingSubmitSitemap(env.fetch, apiKey, siteUrl, feedUrl).catch((error: unknown) => {
      throw new SeoError(errorMessage(error));
    });
    out.sitemap = feedUrl;
  }
  if (urls.length > 0) {
    out.urlsSubmitted = await bingSubmitUrlBatch(env.fetch, apiKey, siteUrl, urls).catch((error: unknown) => {
      throw new SeoError(errorMessage(error));
    });
  }
  return out;
}
