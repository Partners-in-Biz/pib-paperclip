/**
 * Google Search Console: OAuth through the static bridge page, sealed tokens
 * (refreshed tokens are persisted — the old platform refreshed and dropped
 * them), property selection, the daily pull, sitemap submission, URL
 * inspection and ad-hoc Search Analytics queries.
 */
import { randomUUID } from "node:crypto";
import type { PluginApiRequestInput, PluginApiResponse } from "@paperclipai/plugin-sdk";
import { pluginUiBase, buildKeyring, openJson, requirePublicBaseUrl, sealJson, sealedVersion, TokenKeyError } from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import { clientGscAccessItem, dnsTxtItem, gscReconnectItem, serviceAccountItem } from "../engine/items.js";
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
  bool,
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
import { requireSprint } from "./context.js";
import { commentOn, getIssue, OPEN_ISSUE_STATUSES, patchIssue } from "./issues.js";
import { loadServiceAccount, serviceAccountAccess } from "./google-access.js";
import { addNeedsYou, resolveNeedsYou } from "./needs-you.js";
import { settingsPath } from "./settings-path.js";

export { settingsPath };
import {
  addSearchConsoleSite,
  getVerificationToken,
  gscUsersLink,
  insertWebResource,
  propertyFor,
  verificationChange,
  verificationSite,
  type VerificationMethod,
} from "../integrations/google-sa.js";

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

/** Tool for agents: how Search Console access works for this sprint, and the OAuth fallback page. */
export async function gscConnectUrl(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  const integration = await db.getIntegration(env.ctx.db, companyId, sprint.id, "gsc");
  const sa = await loadServiceAccount(info);
  const path = cockpitPath(info, sprint);
  const base = info.loaded.config.publicBaseUrl?.replace(/\/$/, "") ?? null;
  return {
    sprintId: sprint.id,
    status: integration?.status ?? "disconnected",
    propertyUrl: integration?.propertyUrl ?? null,
    auth: integrationAuth(integration),
    serviceAccountEmail: sa.key?.clientEmail ?? null,
    serviceAccountError: sa.error,
    connectPage: path ? `${base ?? ""}${path}&tab=integrations` : null,
    instructions: sa.key
      ? sprint.clientRef
        ? "Use the service account: gsc-check-access. If it has no access, the Needs you digest carries the email for the client (add the service account as a user)."
        : "Use the service account: gsc-verification-token → add the tag through the site repo → gsc-verify-site. No person needed."
      : "No service account key yet: the setup checklist item is on the Needs you digest. The OAuth connection on the connect page is the fallback for a property only a person's Google account can reach.",
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

export type GscVia = "service_account" | "oauth";

export interface GscAccess {
  accessToken: string;
  propertyUrl: string | null;
  integration: db.Integration;
  via: GscVia;
}

export function integrationAuth(integration: db.Integration | null | undefined): GscVia | null {
  if (!integration) return null;
  if (integration.settings?.auth === "service_account") return "service_account";
  return integration.tokenSealed ? "oauth" : null;
}

function oauthUsable(integration: db.Integration): boolean {
  return Boolean(integration.tokenSealed) && integration.status !== "disconnected" && integration.status !== "needs_reconnect";
}

/** Service account token plus the sprint's property (auto-selected from the account's sites when missing). */
async function serviceAccountGsc(env: Env, info: CompanyInfo, sprint: db.Sprint, integration: db.Integration, needProperty: boolean): Promise<GscAccess | null> {
  let sa: { token: string; email: string } | null;
  try {
    sa = await serviceAccountAccess(env, info);
  } catch (error) {
    if (oauthUsable(integration)) return null;
    throw new GscUnavailable(`The Google service account cannot be used: ${errorMessage(error)}`);
  }
  if (!sa) return null;
  let propertyUrl = integration.propertyUrl;
  if (!propertyUrl || integration.settings?.auth !== "service_account") {
    const sites = await listGscSites(env.fetch, sa.token).catch(() => [] as Array<{ siteUrl: string; permissionLevel: string }>);
    const own = propertyUrl && sites.some((s) => s.siteUrl === propertyUrl && s.permissionLevel !== "siteUnverifiedUser") ? propertyUrl : pickPropertyForSite(sites, sprint.siteUrl);
    if (own) {
      propertyUrl = own;
      await db.updateIntegration(env.ctx.db, sprint.companyId, integration.id, {
        property_url: own,
        status: "connected",
        last_error: null,
        settings: { ...integration.settings, auth: "service_account", serviceAccountEmail: sa.email },
      });
      integration = { ...integration, propertyUrl: own, status: "connected", settings: { ...integration.settings, auth: "service_account" } };
    } else if (oauthUsable(integration)) {
      return null; // The OAuth connection reaches a property the service account cannot (yet).
    } else if (needProperty) {
      throw new GscUnavailable(
        sprint.clientRef
          ? `The service account (${sa.email}) has no access to ${sprint.siteUrl} in Search Console yet. Run gsc-check-access: it puts the email for the client on the Needs you digest.`
          : `The service account (${sa.email}) is not an owner of ${sprint.siteUrl} yet. Verify it: gsc-verification-token → add the tag through the site repo → gsc-verify-site.`,
      );
    }
  }
  return { accessToken: sa.token, propertyUrl, integration, via: "service_account" };
}

async function oauthGsc(env: Env, info: CompanyInfo, sprint: db.Sprint, integration: db.Integration, needProperty: boolean): Promise<GscAccess> {
  if (!integration.tokenSealed || integration.status === "disconnected") {
    throw new GscUnavailable(
      "Search Console is not set up for this sprint. With the service account key in the SEO settings the agent verifies and connects it itself (it is on the Needs you digest); the OAuth connection is the fallback.",
    );
  }
  if (integration.status === "needs_reconnect") {
    throw new GscUnavailable("The OAuth Search Console access was revoked or expired. The service account key (setup checklist) replaces it; until then the reconnect is on the Needs you digest.");
  }
  if (needProperty && !integration.propertyUrl) {
    throw new GscUnavailable("Search Console is connected but no property is selected. Pick one with gsc-set-property (see gsc-properties).");
  }
  const keyring = await keyringFor(info);
  let tokens: StoredTokens;
  try {
    tokens = openJson<StoredTokens>(integration.tokenSealed, keyring);
  } catch (error) {
    await markNeedsReconnect(env, info, sprint, integration, errorMessage(error));
    throw new GscUnavailable(`Stored Search Console token cannot be read (${errorMessage(error)}).`);
  }
  if (tokenNeedsRefresh(tokens) || !tokens.accessToken) {
    if (!tokens.refreshToken) {
      await markNeedsReconnect(env, info, sprint, integration, "No refresh token stored");
      throw new GscUnavailable("The OAuth Search Console connection has no refresh token.");
    }
    let refreshed: GoogleTokens;
    try {
      refreshed = await refreshGoogleToken(env.fetch, { ...(await googleClient(info)), refreshToken: tokens.refreshToken });
    } catch (error) {
      if (error instanceof GoogleApiError && error.reconnect) {
        await markNeedsReconnect(env, info, sprint, integration, error.message);
        throw new GscUnavailable(`The OAuth Search Console access was revoked: ${error.message}.`);
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
  return { accessToken: tokens.accessToken, propertyUrl: integration.propertyUrl, integration, via: "oauth" };
}

/**
 * Access token for the sprint's Search Console property: the service account
 * first, the stored OAuth connection as fallback.
 */
export async function gscAccess(env: Env, info: CompanyInfo, sprint: db.Sprint, opts: { needProperty?: boolean; preferOauth?: boolean } = {}): Promise<GscAccess> {
  const integration = await gscIntegration(env, sprint);
  if (!opts.preferOauth) {
    const sa = await serviceAccountGsc(env, info, sprint, integration, Boolean(opts.needProperty));
    if (sa) return sa;
  }
  return oauthGsc(env, info, sprint, integration, Boolean(opts.needProperty));
}

/** The OAuth grant stopped working: flag it and (only without a service account) put the reconnect on Needs you. */
export async function markNeedsReconnect(env: Env, info: CompanyInfo, sprint: db.Sprint, integration: db.Integration, error: string): Promise<void> {
  await db.updateIntegration(env.ctx.db, sprint.companyId, integration.id, { status: "needs_reconnect", last_error: error.slice(0, 500) });
  const sa = await loadServiceAccount(info);
  if (sa.key) return;
  await addNeedsYou(env, info, sprint, gscReconnectItem(cockpitPath(info, sprint), error.slice(0, 200))).catch((issueError: unknown) => {
    env.ctx.logger.info("GSC reconnect item not added", { sprintId: sprint.id, error: errorMessage(issueError) });
  });
}

async function withGsc<T>(env: Env, info: CompanyInfo, sprint: db.Sprint, fn: (access: GscAccess) => Promise<T>, needProperty = true): Promise<T> {
  const access = await gscAccess(env, info, sprint, { needProperty });
  try {
    return await fn(access);
  } catch (error) {
    if (!(error instanceof GoogleApiError)) throw error;
    // The service account lacks rights on this property but a person's OAuth connection has them.
    if (access.via === "service_account" && [403, 404].includes(error.status) && oauthUsable(access.integration)) {
      return fn(await gscAccess(env, info, sprint, { needProperty, preferOauth: true }));
    }
    if (access.via === "oauth" && error.reconnect) {
      await markNeedsReconnect(env, info, sprint, access.integration, error.message);
      throw new GscUnavailable(`${error.message}. The OAuth connection needs a reconnect (on the Needs you digest) unless the service account is set up.`);
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
    note: "Google has no public API to request indexing for normal pages. Use request-indexing (sitemap + IndexNow + inspection); after 14 days it adds optional URL-inspection links to Needs you.",
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

// ---------------------------------------------------------------------------
// Service account: verification and access (no person in the loop for our own sites)
// ---------------------------------------------------------------------------

async function requireServiceAccount(env: Env, info: CompanyInfo, sprint: db.Sprint, taskIds: string[] = []): Promise<{ token: string; email: string }> {
  let sa: { token: string; email: string } | null = null;
  try {
    sa = await serviceAccountAccess(env, info);
  } catch (error) {
    throw new SeoError(`The Google service account cannot be used: ${errorMessage(error)}`);
  }
  if (!sa) {
    await addNeedsYou(env, info, sprint, serviceAccountItem({ prefix: info.prefix, settingsPath: await settingsPath(env, info) }, taskIds)).catch(() => undefined);
    throw new SeoError("No Google service account key is set yet. It is on the sprint's Needs you digest; this task continues when it is added.");
  }
  return sa;
}

function methodParam(params: Params): VerificationMethod | undefined {
  const raw = str(params, "method");
  if (!raw) return undefined;
  const upper = raw.toUpperCase();
  if (upper !== "META" && upper !== "FILE" && upper !== "DNS_TXT") throw new SeoError("method must be META, FILE or DNS_TXT");
  return upper;
}

export async function gscVerificationToken(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  const taskId = str(params, "taskId");
  const sa = await requireServiceAccount(env, info, sprint, taskId ? [taskId] : []);
  const domain = str(params, "property") === "domain";
  const method = methodParam(params) ?? (domain ? "DNS_TXT" : "META");
  const site = verificationSite({ siteUrl: sprint.siteUrl, domain: domain || method === "DNS_TXT" });
  let result: { method: VerificationMethod; token: string };
  try {
    result = await getVerificationToken(env.fetch, sa.token, site, method);
  } catch (error) {
    throw new SeoError(`Site Verification token failed: ${errorMessage(error)}. Check the Site Verification API is enabled for the service account's project.`);
  }
  const change = verificationChange(result.method, result.token);
  const google = { ...((sprint.verification.google as Record<string, unknown>) ?? {}), method: result.method, token: result.token, site, property: propertyFor(site), requestedAt: env.now().toISOString(), serviceAccountEmail: sa.email };
  await db.updateSprint(env.ctx.db, companyId, sprint.id, { verification: { ...sprint.verification, google } });
  if (change.kind === "dns") {
    await addNeedsYou(env, info, sprint, dnsTxtItem(sprint, result.token, taskId ? [taskId] : []));
  }
  return {
    sprintId: sprint.id,
    serviceAccountEmail: sa.email,
    site,
    property: propertyFor(site),
    method: result.method,
    token: result.token,
    change,
    next:
      change.kind === "dns"
        ? "The TXT record is on the Needs you digest (the agent has no DNS access). Run gsc-verify-site once it is added."
        : `Add it through the site repo (verification files are SEO scope under merge_seo_scope): ${change.kind === "meta" ? "the meta tag in the root layout's <head>" : `the file at ${change.detail.path}`}. After the deploy, check it on production, then run gsc-verify-site.`,
  };
}

export async function gscVerifySite(env: Env, companyId: string, actor: Actor, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  const sa = await requireServiceAccount(env, info, sprint);
  const pending = (sprint.verification.google ?? {}) as { method?: VerificationMethod; site?: { type: "SITE" | "INET_DOMAIN"; identifier: string } };
  const method = methodParam(params) ?? pending.method ?? "META";
  const site = pending.site ?? verificationSite({ siteUrl: sprint.siteUrl, domain: method === "DNS_TXT" });
  let owners: string[] = [];
  try {
    owners = (await insertWebResource(env.fetch, sa.token, site, method)).owners;
  } catch (error) {
    throw new SeoError(
      `Google could not verify ${site.identifier} (${errorMessage(error)}). ${method === "META" ? "Check the google-site-verification meta tag is live on the home page (check-meta on production)" : method === "FILE" ? "Check the verification file is live at its URL" : "Check the DNS TXT record (it can take up to an hour)"} and run gsc-verify-site again.`,
    );
  }
  const property = propertyFor(site);
  let added = true;
  let addError: string | null = null;
  try {
    await addSearchConsoleSite(env.fetch, sa.token, property);
  } catch (error) {
    added = false;
    addError = errorMessage(error);
  }
  const integration = await gscIntegration(env, sprint);
  await db.updateIntegration(env.ctx.db, companyId, integration.id, {
    property_url: property,
    status: "connected",
    last_error: addError,
    settings: { ...integration.settings, auth: "service_account", serviceAccountEmail: sa.email },
  });
  const google = { ...((sprint.verification.google as Record<string, unknown>) ?? {}), method, site, property, verifiedAt: env.now().toISOString(), owners: owners.slice(0, 10), addedToSearchConsole: added };
  await db.updateSprint(env.ctx.db, companyId, sprint.id, { verification: { ...sprint.verification, google } });
  for (const key of ["gsc_access", "gsc_dns", "gsc_reconnect"]) await resolveNeedsYou(env, info, sprint, key, "the service account").catch(() => undefined);
  let sitemap: { submitted: boolean; sitemapUrl: string; error?: string } | null = null;
  if (bool(params, "submitSitemap") ?? true) {
    const sitemapUrl = `${new URL(urlParam(sprint.siteUrl)).origin}/sitemap.xml`;
    try {
      await submitSitemap(env.fetch, sa.token, property, sitemapUrl);
      sitemap = { submitted: true, sitemapUrl };
    } catch (error) {
      sitemap = { submitted: false, sitemapUrl, error: errorMessage(error) };
    }
  }
  if (sprint.rootIssueId) {
    await commentOn(env, companyId, sprint.rootIssueId, `Search Console: ${site.identifier} verified (${method}) with the service account; property \`${property}\` ${added ? "added" : `not added (${addError})`}${sitemap?.submitted ? `, sitemap ${sitemap.sitemapUrl} submitted` : ""}. Rankings pull every morning.`);
  }
  return { sprintId: sprint.id, verified: true, method, property, addedToSearchConsole: added, addError, owners, sitemap, by: actor.kind };
}

export async function gscCheckAccess(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  const taskId = str(params, "taskId");
  const sa = await requireServiceAccount(env, info, sprint, taskId ? [taskId] : []);
  const sites = await listGscSites(env.fetch, sa.token);
  const requested = str(params, "property", { max: 500 });
  const match = requested ? sites.find((s) => s.siteUrl === requested) : null;
  const property = match?.siteUrl ?? (requested ? null : pickPropertyForSite(sites, sprint.siteUrl));
  const entry = property ? sites.find((s) => s.siteUrl === property) ?? null : null;
  const hasAccess = Boolean(entry && entry.permissionLevel !== "siteUnverifiedUser");
  if (hasAccess && property) {
    const integration = await gscIntegration(env, sprint);
    await db.updateIntegration(env.ctx.db, companyId, integration.id, {
      property_url: property,
      status: "connected",
      last_error: null,
      settings: { ...integration.settings, auth: "service_account", serviceAccountEmail: sa.email },
    });
    await resolveNeedsYou(env, info, sprint, "gsc_access", "the service account").catch(() => undefined);
    return { sprintId: sprint.id, serviceAccountEmail: sa.email, hasAccess: true, property, permissionLevel: entry!.permissionLevel, next: "Property selected. Submit the sitemap (gsc-submit-sitemap); rankings pull every morning." };
  }
  const guess = requested ?? `sc-domain:${new URL(urlParam(sprint.siteUrl)).hostname.replace(/^www\./, "")}`;
  let queued = false;
  if (sprint.clientRef || sprint.siteAccess === "none" || bool(params, "askClient")) {
    await addNeedsYou(env, info, sprint, clientGscAccessItem(sprint, sa.email, guess, taskId ? [taskId] : []));
    queued = true;
  }
  return {
    sprintId: sprint.id,
    serviceAccountEmail: sa.email,
    hasAccess: false,
    property: guess,
    usersLink: gscUsersLink(guess),
    visibleProperties: sites.map((s) => ({ propertyUrl: s.siteUrl, permissionLevel: s.permissionLevel })).slice(0, 50),
    next: queued
      ? "The email asking the client to add the service account is on the Needs you digest; the plugin re-checks access every morning."
      : "This is one of our own sites: verify it with gsc-verification-token → repo change → gsc-verify-site (no person needed).",
  };
}
