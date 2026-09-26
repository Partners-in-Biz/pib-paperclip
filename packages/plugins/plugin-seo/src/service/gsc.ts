/**
 * Google Search Console: OAuth through the static bridge page, sealed tokens
 * (refreshed tokens are persisted — the old platform refreshed and dropped
 * them), property selection, the daily pull, sitemap submission, URL
 * inspection and ad-hoc Search Analytics queries.
 */
import { randomUUID } from "node:crypto";
import type { PluginApiRequestInput, PluginApiResponse } from "@paperclipai/plugin-sdk";
import { pluginUiBase, buildKeyring, openJson, requirePublicBaseUrl, sealJson, sealedVersion, TokenKeyError } from "@partnersinbiz/pib-plugin-kit";
import { ORIGIN } from "../constants.js";
import * as db from "../db.js";
import { reconnectIssueDescription, reconnectIssueTitle } from "../engine/copy.js";
import { sprintPagePath, sprintScope } from "../engine/scope.js";
import { keywordStatusForPosition } from "../engine/sprint.js";
import { addDays } from "../engine/time.js";
import { gscRedirectUri } from "../config.js";
import {
  aggregateKeywordRows,
  aggregatePageRows,
  buildGscAuthorizeUrl,
  exchangeGoogleCode,
  GoogleApiError,
  GSC_SCOPE,
  inspectUrl,
  listGscSites,
  pickPropertyForSite,
  querySearchAnalytics,
  refreshGoogleToken,
  submitSitemap,
  tokenNeedsRefresh,
  type GoogleTokens,
  type GscRow,
} from "../integrations/google.js";
import { comparableUrl } from "../checks/parse.js";
import {
  assignableUser,
  cockpitPath,
  companyInfo,
  errorMessage,
  num,
  reqStr,
  SeoError,
  str,
  urlParam,
  type Actor,
  type CompanyInfo,
  type Env,
  type Params,
} from "./common.js";
import { requireSprint, sprintCopy } from "./context.js";
import { commentOn, getIssue, OPEN_ISSUE_STATUSES, openIssue, patchIssue } from "./issues.js";

const SESSION_TTL_SECONDS = 15 * 60;

interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scope: string;
}

async function keyringFor(info: CompanyInfo) {
  const secret = await info.loaded.secrets.get("encryptionKey");
  if (!secret) throw new SeoError("The token encryption key is not set. Add it in the SEO plugin settings before connecting Search Console.");
  return buildKeyring({ purpose: "seo", companyId: info.companyId, secret });
}

async function googleClient(info: CompanyInfo): Promise<{ clientId: string; clientSecret: string }> {
  const clientId = info.loaded.config.googleClientId;
  if (!clientId) throw new SeoError("The Google OAuth client ID is not set in the SEO plugin settings.");
  const clientSecret = await info.loaded.secrets.get("google.clientSecret");
  if (!clientSecret) throw new SeoError("The Google OAuth client secret is not set in the SEO plugin settings.");
  return { clientId, clientSecret };
}

async function gscIntegration(env: Env, sprint: db.Sprint): Promise<db.Integration> {
  let integration = await db.getIntegration(env.ctx.db, sprint.companyId, sprint.id, "gsc");
  if (!integration) {
    await db.ensureIntegration(env.ctx.db, { id: randomUUID(), companyId: sprint.companyId, sprintId: sprint.id, provider: "gsc", status: "disconnected" });
    integration = await db.getIntegration(env.ctx.db, sprint.companyId, sprint.id, "gsc");
  }
  if (!integration) throw new SeoError("Search Console integration row could not be created");
  return integration;
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export async function gscConnectStart(env: Env, companyId: string, actor: Actor, params: Params) {
  if (actor.kind !== "user") throw new SeoError("A person must connect Search Console from the SEO page");
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  const base = requirePublicBaseUrl(info.loaded.config.publicBaseUrl);
  const { clientId } = await googleClient(info);
  await keyringFor(info);
  const state = randomUUID();
  await db.insertOAuthSession(env.ctx.db, {
    state,
    companyId,
    sprintId: sprint.id,
    provider: "gsc",
    createdByUserId: actor.userId,
    returnTo: str(params, "returnTo", { max: 500 }) ?? null,
    ttlSeconds: SESSION_TTL_SECONDS,
  });
  const redirectUri = gscRedirectUri(base, await pluginUiBase(env.ctx));
  return { authorizeUrl: buildGscAuthorizeUrl({ clientId, redirectUri, state }), state, redirectUri, expiresInSeconds: SESSION_TTL_SECONDS };
}

/** Tool for agents: where a person goes to connect (never the Google URL itself). */
export async function gscConnectUrl(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  const integration = await db.getIntegration(env.ctx.db, companyId, sprint.id, "gsc");
  const path = cockpitPath(info, sprint);
  const base = info.loaded.config.publicBaseUrl?.replace(/\/$/, "") ?? null;
  return {
    sprintId: sprint.id,
    status: integration?.status ?? "disconnected",
    propertyUrl: integration?.propertyUrl ?? null,
    connectPage: path ? `${base ?? ""}${path}&tab=integrations` : null,
    instructions:
      "Send this link to the sprint owner: open it, click Connect Google Search Console, and sign in with the Google account that owns the property. The connection must be made in the person's own browser.",
    redirectUriToRegister: await (async () => {
      const uiBase = await pluginUiBase(env.ctx);
      return base && uiBase ? gscRedirectUri(base, uiBase) : null;
    })(),
  };
}

function apiError(status: number, error: string): PluginApiResponse {
  return { status, body: { error } };
}

export async function gscOauthComplete(env: Env, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  const body = (input.body && typeof input.body === "object" ? input.body : {}) as Record<string, unknown>;
  const state = typeof body.state === "string" ? body.state : "";
  const params = (body.params && typeof body.params === "object" ? body.params : {}) as Record<string, unknown>;
  if (!state) return apiError(400, "Missing state");
  const session = await db.getOAuthSession(env.ctx.db, state);
  if (!session) return apiError(400, "This connection attempt expired or was already used. Start again from the SEO page.");
  if (session.companyId !== input.companyId) return apiError(403, "This connection was started in another company");
  await db.deleteOAuthSession(env.ctx.db, state);
  if (session.expired) return apiError(400, "This connection attempt expired. Start again from the SEO page.");
  if (input.actor.actorType !== "user") return apiError(403, "Only a person can finish connecting Search Console");
  if (typeof params.error === "string" && params.error) {
    return apiError(400, `Google did not grant access: ${String(params.error_description ?? params.error)}`);
  }
  const code = typeof params.code === "string" ? params.code : "";
  if (!code) return apiError(400, "Google did not return an authorization code");
  const sprint = await db.getSprint(env.ctx.db, session.companyId, session.sprintId);
  if (!sprint) return apiError(404, "The sprint for this connection no longer exists");
  try {
    const info = await companyInfo(env, session.companyId);
    const base = requirePublicBaseUrl(info.loaded.config.publicBaseUrl);
    const client = await googleClient(info);
    const keyring = await keyringFor(info);
    const tokens = await exchangeGoogleCode(env.fetch, { ...client, redirectUri: gscRedirectUri(base, await pluginUiBase(env.ctx)), code });
    if (!tokens.refreshToken) {
      return apiError(
        400,
        "Google did not return a refresh token. Remove this app at myaccount.google.com/permissions for that Google account, then connect again.",
      );
    }
    if (!tokens.scope.split(/\s+/).includes(GSC_SCOPE)) {
      return apiError(400, "Search Console access was not granted. Connect again and allow Search Console.");
    }
    const integration = await gscIntegration(env, sprint);
    let propertyUrl = integration.propertyUrl;
    let sites: Array<{ siteUrl: string; permissionLevel: string }> = [];
    try {
      sites = await listGscSites(env.fetch, tokens.accessToken);
      propertyUrl = propertyUrl && sites.some((s) => s.siteUrl === propertyUrl) ? propertyUrl : pickPropertyForSite(sites, sprint.siteUrl);
    } catch (error) {
      env.ctx.logger.info("GSC site list failed after connect", { error: errorMessage(error) });
    }
    const sealed = sealJson({ ...tokens } satisfies StoredTokens, keyring);
    await db.updateIntegration(env.ctx.db, sprint.companyId, integration.id, {
      status: "connected",
      token_sealed: sealed,
      expires_at: new Date(tokens.expiresAt).toISOString(),
      scopes: tokens.scope.split(/\s+/).filter(Boolean),
      key_version: sealedVersion(sealed),
      property_url: propertyUrl,
      last_error: null,
      connected_by_user_id: input.actor.userId ?? input.actor.actorId,
      settings: { ...integration.settings, sites: sites.map((s) => s.siteUrl).slice(0, 50) },
    });
    if (integration.alertIssueId) {
      const alert = await getIssue(env, sprint.companyId, integration.alertIssueId);
      if (alert && OPEN_ISSUE_STATUSES.has(String(alert.status))) {
        await commentOn(env, sprint.companyId, integration.alertIssueId, "Search Console is connected again.");
        await patchIssue(env, sprint.companyId, integration.alertIssueId, { status: "done" });
      }
      await db.updateIntegration(env.ctx.db, sprint.companyId, integration.id, { alert_issue_id: null });
    }
    const prefix = info.prefix ?? "";
    // Back to the sprint in its own scope, so a client sprint reopens inside that client's workspace.
    const redirectTo = sprintPagePath(`/${prefix}/seo`, sprint.id, sprintScope(sprint), {
      tab: "integrations",
      connected: "gsc",
      ...(propertyUrl ? {} : { pick: "property" }),
    });
    return { status: 200, body: { redirectTo, propertyUrl } };
  } catch (error) {
    const message = error instanceof SeoError || error instanceof GoogleApiError || error instanceof TokenKeyError ? error.message : `Connection failed: ${errorMessage(error)}`;
    return apiError(400, message);
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export class GscUnavailable extends SeoError {}

/** Access token for the sprint's GSC connection; refreshes and persists when needed. */
export async function gscAccess(env: Env, info: CompanyInfo, sprint: db.Sprint, opts: { needProperty?: boolean } = {}): Promise<{ accessToken: string; propertyUrl: string | null; integration: db.Integration }> {
  const integration = await gscIntegration(env, sprint);
  if (!integration.tokenSealed || integration.status === "disconnected") {
    throw new GscUnavailable("Search Console is not connected for this sprint. A person connects it on the SEO page → Integrations (gsc-connect-url gives the link).");
  }
  if (integration.status === "needs_reconnect") {
    throw new GscUnavailable("Search Console access was revoked or expired. The sprint owner must reconnect it on the SEO page → Integrations.");
  }
  if (opts.needProperty && !integration.propertyUrl) {
    throw new GscUnavailable("Search Console is connected but no property is selected. Pick one with gsc-set-property (see gsc-properties).");
  }
  const keyring = await keyringFor(info);
  let tokens: StoredTokens;
  try {
    tokens = openJson<StoredTokens>(integration.tokenSealed, keyring);
  } catch (error) {
    await markNeedsReconnect(env, info, sprint, integration, errorMessage(error));
    throw new GscUnavailable(`Stored Search Console token cannot be read (${errorMessage(error)}). The owner must reconnect.`);
  }
  if (tokenNeedsRefresh(tokens) || !tokens.accessToken) {
    if (!tokens.refreshToken) {
      await markNeedsReconnect(env, info, sprint, integration, "No refresh token stored");
      throw new GscUnavailable("Search Console needs to be reconnected (no refresh token).");
    }
    let refreshed: GoogleTokens;
    try {
      refreshed = await refreshGoogleToken(env.fetch, { ...(await googleClient(info)), refreshToken: tokens.refreshToken });
    } catch (error) {
      if (error instanceof GoogleApiError && error.reconnect) {
        await markNeedsReconnect(env, info, sprint, integration, error.message);
        throw new GscUnavailable(`Search Console access was revoked: ${error.message}. The owner must reconnect.`);
      }
      throw error;
    }
    tokens = { accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken ?? tokens.refreshToken, expiresAt: refreshed.expiresAt, scope: refreshed.scope || tokens.scope };
    const sealed = sealJson(tokens, keyring);
    // Persist the refreshed token (the old platform never did).
    await db.updateIntegration(env.ctx.db, sprint.companyId, integration.id, {
      token_sealed: sealed,
      expires_at: new Date(tokens.expiresAt).toISOString(),
      key_version: sealedVersion(sealed),
    });
  }
  return { accessToken: tokens.accessToken, propertyUrl: integration.propertyUrl, integration };
}

export async function markNeedsReconnect(env: Env, info: CompanyInfo, sprint: db.Sprint, integration: db.Integration, error: string): Promise<void> {
  await db.updateIntegration(env.ctx.db, sprint.companyId, integration.id, { status: "needs_reconnect", last_error: error.slice(0, 500) });
  if (integration.alertIssueId) {
    const existing = await getIssue(env, sprint.companyId, integration.alertIssueId);
    if (existing && OPEN_ISSUE_STATUSES.has(String(existing.status))) return;
  }
  try {
    const created = await openIssue(env, {
      companyId: sprint.companyId,
      title: reconnectIssueTitle(sprint),
      description: reconnectIssueDescription(sprintCopy(sprint), error, cockpitPath(info, sprint)),
      originKind: ORIGIN.alert,
      originId: integration.id,
      projectId: sprint.projectId,
      parentId: sprint.rootIssueId,
      assigneeUserId: assignableUser(sprint.ownerUserId),
      priority: "high",
      wake: false,
    });
    await db.updateIntegration(env.ctx.db, sprint.companyId, integration.id, { alert_issue_id: created.id });
  } catch (issueError) {
    env.ctx.logger.info("GSC reconnect issue not created", { sprintId: sprint.id, error: errorMessage(issueError) });
  }
}

async function withGsc<T>(env: Env, info: CompanyInfo, sprint: db.Sprint, fn: (access: { accessToken: string; propertyUrl: string | null; integration: db.Integration }) => Promise<T>, needProperty = true): Promise<T> {
  const access = await gscAccess(env, info, sprint, { needProperty });
  try {
    return await fn(access);
  } catch (error) {
    if (error instanceof GoogleApiError && error.reconnect) {
      await markNeedsReconnect(env, info, sprint, access.integration, error.message);
      throw new GscUnavailable(`${error.message}. The owner must reconnect Search Console.`);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export async function gscProperties(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  return withGsc(env, info, sprint, async ({ accessToken, propertyUrl }) => {
    const sites = await listGscSites(env.fetch, accessToken);
    return {
      sprintId: sprint.id,
      selected: propertyUrl,
      suggested: pickPropertyForSite(sites, sprint.siteUrl),
      properties: sites.map((s) => ({ propertyUrl: s.siteUrl, permissionLevel: s.permissionLevel, usable: s.permissionLevel !== "siteUnverifiedUser" })),
    };
  }, false);
}

export async function gscSetProperty(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const propertyUrl = reqStr(params, "propertyUrl", { max: 500 });
  const info = await companyInfo(env, companyId);
  return withGsc(env, info, sprint, async ({ accessToken, integration }) => {
    const sites = await listGscSites(env.fetch, accessToken);
    const match = sites.find((s) => s.siteUrl === propertyUrl);
    if (!match) throw new SeoError(`The connected Google account has no property ${propertyUrl}. Use gsc-properties to see the list.`);
    if (match.permissionLevel === "siteUnverifiedUser") throw new SeoError("That property is not verified for the connected account");
    await db.updateIntegration(env.ctx.db, companyId, integration.id, { property_url: propertyUrl, status: "connected", last_error: null });
    return { sprintId: sprint.id, propertyUrl };
  }, false);
}

export async function gscDisconnect(env: Env, companyId: string, actor: Actor, params: Params) {
  if (actor.kind !== "user") throw new SeoError("Only a person can disconnect Search Console");
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const integration = await gscIntegration(env, sprint);
  await db.updateIntegration(env.ctx.db, companyId, integration.id, { status: "disconnected", token_sealed: null, expires_at: null, last_error: null });
  return { sprintId: sprint.id, status: "disconnected" };
}

function siteTotalsFrom(rows: GscRow[]): { impressions: number; clicks: number; ctr: number; position: number | null } | null {
  const row = rows[0];
  if (!row) return null;
  return { impressions: row.impressions, clicks: row.clicks, ctr: row.ctr, position: row.position || null };
}

/**
 * Daily pull: page+query rows for the last 8 days up to yesterday, matched to
 * tracked keywords (impression-weighted position), plus site totals and
 * per-page numbers for content rows.
 */
export async function gscPull(env: Env, info: CompanyInfo, sprint: db.Sprint) {
  return withGsc(env, info, sprint, async ({ accessToken, propertyUrl, integration }) => {
    const property = propertyUrl!;
    const endDate = addDays(info.today, -1);
    const startDate = addDays(info.today, -8);
    const rows: GscRow[] = [];
    for (let page = 0; page < 2; page += 1) {
      const batch = await querySearchAnalytics(env.fetch, accessToken, property, {
        startDate,
        endDate,
        dimensions: ["page", "query"],
        rowLimit: 25000,
        startRow: page * 25000,
      });
      rows.push(...batch);
      if (batch.length < 25000) break;
    }
    const totals = siteTotalsFrom(await querySearchAnalytics(env.fetch, accessToken, property, { startDate, endDate, dimensions: [] }));
    const keywords = await db.listKeywords(env.ctx.db, sprint.companyId, sprint.id);
    const byKeyword = aggregateKeywordRows(rows, keywords);
    const now = new Date().toISOString();
    for (const keyword of keywords) {
      const agg = byKeyword.get(keyword.id);
      if (!agg) continue;
      await db.recordPosition(env.ctx.db, {
        id: randomUUID(),
        companyId: sprint.companyId,
        sprintId: sprint.id,
        keywordId: keyword.id,
        position: agg.position,
        impressions: agg.impressions,
        clicks: agg.clicks,
        ctr: agg.ctr,
        source: "gsc",
        recordedOn: endDate,
      });
      await db.updateKeyword(env.ctx.db, sprint.companyId, keyword.id, {
        current_position: agg.position,
        rank: agg.position != null ? Math.max(1, Math.round(agg.position)) : null,
        impressions: agg.impressions,
        clicks: agg.clicks,
        ctr: agg.ctr,
        status: keywordStatusForPosition(agg.position),
        ranking_url: agg.topPage,
        last_pulled_at: now,
      });
    }
    const byPage = aggregatePageRows(rows);
    const content = await db.listContent(env.ctx.db, sprint.companyId, sprint.id);
    let contentUpdated = 0;
    for (const item of content) {
      if (!item.targetUrl) continue;
      const key = comparableUrl(item.targetUrl);
      const agg = key ? byPage.get(key) : undefined;
      await db.updateContent(env.ctx.db, sprint.companyId, item.id, {
        impressions: agg?.impressions ?? 0,
        clicks: agg?.clicks ?? 0,
        position: agg?.position ?? null,
        perf_pulled_at: now,
      });
      contentUpdated += 1;
    }
    const stats = {
      window: { startDate, endDate },
      rows: rows.length,
      matchedKeywords: byKeyword.size,
      trackedKeywords: keywords.length,
      siteTotals: totals ? { ...totals, startDate, endDate } : null,
      pulledOn: info.today,
    };
    await db.updateIntegration(env.ctx.db, sprint.companyId, integration.id, { last_pull_at: now, last_error: null, status: "connected", stats });
    return { sprintId: sprint.id, propertyUrl: property, ...stats, contentUpdated };
  });
}

export async function gscPullTool(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  return gscPull(env, info, sprint);
}

export async function gscSubmitSitemap(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  const raw = str(params, "sitemapUrl", { max: 1000 });
  const sitemapUrl = raw ? urlParam(raw, sprint.siteUrl) : `${new URL(urlParam(sprint.siteUrl)).origin}/sitemap.xml`;
  return withGsc(env, info, sprint, async ({ accessToken, propertyUrl }) => {
    await submitSitemap(env.fetch, accessToken, propertyUrl!, sitemapUrl);
    return { sprintId: sprint.id, propertyUrl, sitemapUrl, submitted: true };
  });
}

export async function gscInspectUrl(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  const url = urlParam(reqStr(params, "url", { max: 2000 }), sprint.siteUrl);
  return withGsc(env, info, sprint, async ({ accessToken, propertyUrl }) => ({
    sprintId: sprint.id,
    propertyUrl,
    ...(await inspectUrl(env.fetch, accessToken, propertyUrl!, url)),
    note: "Search Console's API reads index status only. 'Request indexing' has to be clicked by a person in the Search Console UI.",
  }));
}

export async function gscQuery(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  const days = num(params, "days", { integer: true, min: 1, max: 90 }) ?? 28;
  const minPos = num(params, "positionMin", { min: 0, max: 200 });
  const maxPos = num(params, "positionMax", { min: 0, max: 200 });
  const limit = num(params, "limit", { integer: true, min: 1, max: 500 }) ?? 100;
  const page = str(params, "page", { max: 2000 });
  const query = str(params, "query", { max: 200 });
  const filters: Array<Record<string, string>> = [];
  if (page) filters.push({ dimension: "page", operator: "equals", expression: urlParam(page, sprint.siteUrl) });
  if (query) filters.push({ dimension: "query", operator: "contains", expression: query });
  return withGsc(env, info, sprint, async ({ accessToken, propertyUrl }) => {
    const endDate = addDays(info.today, -1);
    const startDate = addDays(info.today, -days);
    const rows = await querySearchAnalytics(env.fetch, accessToken, propertyUrl!, {
      startDate,
      endDate,
      dimensions: ["page", "query"],
      rowLimit: 5000,
      ...(filters.length > 0 ? { dimensionFilterGroups: [{ groupType: "and", filters }] } : {}),
    });
    const filtered = rows
      .filter((r) => (minPos == null || r.position >= minPos) && (maxPos == null || r.position <= maxPos))
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, limit)
      .map((r) => ({ page: r.keys[0], query: r.keys[1], position: Math.round(r.position * 10) / 10, impressions: r.impressions, clicks: r.clicks, ctr: Math.round(r.ctr * 10000) / 10000 }));
    return { sprintId: sprint.id, propertyUrl, window: { startDate, endDate }, totalRows: rows.length, rows: filtered };
  });
}
