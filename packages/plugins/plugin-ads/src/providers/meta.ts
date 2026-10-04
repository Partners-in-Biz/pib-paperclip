/**
 * Meta Marketing API (Facebook and Instagram ads), written against Meta's published Graph API. Off until the owner adds the app
 * (client id and secret) or a system-user token; nothing here has run against Meta yet, so the first live read is a check, not a
 * formality (the Setup item says so).
 *
 * Reading: `GET /me/adaccounts`, `GET /act_<id>/campaigns`, `GET /act_<id>/insights` (campaign level, one row per day).
 * Writing (only through `execute.ts`): `POST /act_<id>/campaigns` (always PAUSED), `POST /<campaign id>` for status and budget.
 *
 * Facts this relies on (Meta's docs, checked 2026-10): `ads_read` is enough to read; `ads_management` also changes things; standard
 * access covers ad accounts the signed-in person owns, managing other businesses' accounts needs advanced access (App Review);
 * `special_ad_categories` is required on campaign creation; budgets are integers in the currency's minor unit; insights `spend` is a
 * decimal string in major units. The token goes in the `Authorization` header, never in a URL.
 */
import { decimalToMinor } from "../money.js";
import { AdsError } from "../domain.js";
import { FORM_HEADERS, ProviderError, expiresAtFrom, formBody, int, readJson, request, str } from "./http.js";
import type { AccountRef, AdsProvider, CampaignInfo, CampaignStatus, ExchangeResult, InsightRow, ProviderAdAccount, ProviderEnv, TokenBundle } from "./types.js";

export const DEFAULT_META_VERSION = "v25.0";
const DAY_MS = 86_400_000;
/** Pages followed per read. Insights pages hold 500 rows, so this is 20,000 rows: far more than any real account's window. */
const PAGE_LIMIT = 40;

export const META_READ_SCOPES = ["ads_read"];
export const META_WRITE_SCOPES = ["ads_read", "ads_management"];

/** Which `actions` entry counts as a result, in order of preference, when the account names none (one is used per row: they overlap). */
export const DEFAULT_CONVERSION_ACTIONS = [
  "omni_purchase",
  "purchase",
  "offsite_conversion.fb_pixel_purchase",
  "lead",
  "onsite_conversion.lead_grouped",
  "offsite_conversion.fb_pixel_lead",
  "omni_complete_registration",
  "complete_registration",
];

function version(env: ProviderEnv): string {
  const v = env.app.apiVersion?.trim() || DEFAULT_META_VERSION;
  return v.startsWith("v") ? v : `v${v}`;
}

const graph = (env: ProviderEnv) => `https://graph.facebook.com/${version(env)}`;

const bearer = (token: TokenBundle) => ({ Authorization: `Bearer ${token.accessToken}`, Accept: "application/json" });

async function get<T = Record<string, unknown>>(env: ProviderEnv, token: TokenBundle, path: string, params: Record<string, string | number | undefined>, label: string): Promise<T> {
  const qs = formBody(params);
  const res = await request(`${graph(env)}${path}${qs ? `?${qs}` : ""}`, { fetchImpl: env.fetchImpl, headers: bearer(token) });
  return readJson<T>(res, label);
}

async function post<T = Record<string, unknown>>(env: ProviderEnv, token: TokenBundle, path: string, params: Record<string, string | number | undefined>, label: string): Promise<T> {
  const res = await request(`${graph(env)}${path}`, { fetchImpl: env.fetchImpl, method: "POST", headers: { ...FORM_HEADERS, ...bearer(token) }, body: formBody(params) });
  return readJson<T>(res, label);
}

interface Page<T> {
  data?: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/** Follows `paging.cursors.after` ourselves: Meta's `paging.next` URL carries the access token in its query string. */
async function pages<T>(env: ProviderEnv, token: TokenBundle, path: string, params: Record<string, string | number | undefined>, label: string): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (let i = 0; i < PAGE_LIMIT; i += 1) {
    const page = await get<Page<T>>(env, token, path, { ...params, ...(after ? { after } : {}) }, label);
    out.push(...(page.data ?? []));
    after = page.paging?.next ? page.paging.cursors?.after : undefined;
    if (!after) return out;
  }
  // More pages exist than we follow. Handing back the part we have would look like a complete answer: days and campaigns missing from it would
  // read as "the platform stopped returning them" and be zeroed. Fail the read instead, so it is seen and nothing real is overwritten.
  throw new ProviderError(`${label} has more than ${PAGE_LIMIT} pages, so the answer would be incomplete and nothing was changed. Ask for fewer days, or tell the platform team.`);
}

const actId = (externalId: string) => (externalId.startsWith("act_") ? externalId : `act_${externalId}`);

function accountStatus(code: unknown): ProviderAdAccount["status"] {
  // 1 ACTIVE, 2 DISABLED, 3 UNSETTLED, 7 PENDING_RISK_REVIEW, 8 PENDING_SETTLEMENT, 9 IN_GRACE_PERIOD, 100 PENDING_CLOSURE, 101 CLOSED
  const n = int(code);
  if (n === 1 || n === 9) return "active";
  if (n === 3 || n === 7 || n === 8) return "paused";
  return "disabled";
}

export function campaignStatus(effective: unknown): CampaignStatus {
  const s = str(effective).toUpperCase();
  if (s === "ACTIVE") return "active";
  if (s === "PAUSED" || s === "CAMPAIGN_PAUSED" || s === "ADSET_PAUSED") return "paused";
  if (s === "ARCHIVED" || s === "DELETED") return "archived";
  return "other";
}

/** Result count and value of one insights row: the first preferred action type the row has (they overlap, so never summed). */
export function conversionOf(row: { actions?: unknown; action_values?: unknown }, currency: string, preferred: string[]): { conversions: number; valueMinor: number } {
  const order = preferred.length ? preferred : DEFAULT_CONVERSION_ACTIONS;
  const list = (value: unknown): Array<{ action_type?: string; value?: string }> => (Array.isArray(value) ? (value as Array<{ action_type?: string; value?: string }>) : []);
  const actions = list(row.actions);
  const values = list(row.action_values);
  for (const type of order) {
    const hit = actions.find((a) => a.action_type === type);
    if (!hit) continue;
    const conversions = Number(hit.value ?? 0);
    const valueText = values.find((v) => v.action_type === type)?.value;
    return { conversions: Number.isFinite(conversions) ? conversions : 0, valueMinor: valueText ? decimalToMinor(valueText, currency) ?? 0 : 0 };
  }
  return { conversions: 0, valueMinor: 0 };
}

export const metaProvider: AdsProvider = {
  platform: "meta",
  refreshKind: "long_lived",

  authorize(env, state) {
    const scopes = env.app.requestWrite ? META_WRITE_SCOPES : META_READ_SCOPES;
    const params = formBody({ client_id: env.app.clientId, redirect_uri: env.redirectUri, state, scope: scopes.join(","), response_type: "code" });
    return { url: `https://www.facebook.com/${version(env)}/dialog/oauth?${params}`, scopes };
  },

  async exchange(env, params): Promise<ExchangeResult> {
    const code = params.code;
    if (!code) throw new ProviderError("Meta did not send an authorization code. Start the connection again.");
    const short = await readJson<{ access_token?: string }>(
      await request(`${graph(env)}/oauth/access_token?${formBody({ client_id: env.app.clientId, client_secret: env.app.clientSecret, redirect_uri: env.redirectUri, code })}`, { fetchImpl: env.fetchImpl }),
      "Meta sign-in",
    );
    if (!short.access_token) throw new ProviderError("Meta did not return an access token.");
    const long = await readJson<{ access_token?: string; expires_in?: number }>(
      await request(`${graph(env)}/oauth/access_token?${formBody({ grant_type: "fb_exchange_token", client_id: env.app.clientId, client_secret: env.app.clientSecret, fb_exchange_token: short.access_token })}`, { fetchImpl: env.fetchImpl }),
      "Meta long-lived token",
    );
    const accessToken = long.access_token ?? short.access_token;
    const token: TokenBundle = { accessToken, expiresAt: expiresAtFrom(long.expires_in) ?? new Date(Date.now() + 60 * DAY_MS).toISOString() };
    const me = await get<{ id?: string; name?: string }>(env, token, "/me", { fields: "id,name" }, "Meta profile");
    const perms = await get<Page<{ permission?: string; status?: string }>>(env, token, "/me/permissions", {}, "Meta permissions").catch(() => ({ data: [] as Array<{ permission?: string; status?: string }> }));
    const granted = (perms.data ?? []).filter((p) => p.status === "granted").map((p) => str(p.permission));
    token.scopes = granted;
    return { token, label: me.name ? `${me.name} (Meta)` : "Meta", externalUserId: me.id ?? null, canWrite: granted.includes("ads_management"), scopes: granted };
  },

  async refresh(env, token) {
    // A still-valid long-lived token is exchanged again for a fresh 60 days.
    const data = await readJson<{ access_token?: string; expires_in?: number }>(
      await request(`${graph(env)}/oauth/access_token?${formBody({ grant_type: "fb_exchange_token", client_id: env.app.clientId, client_secret: env.app.clientSecret, fb_exchange_token: token.accessToken })}`, { fetchImpl: env.fetchImpl }),
      "Meta token refresh",
    );
    if (!data.access_token) throw new ProviderError("Meta did not return a refreshed token.", { tokenInvalid: true });
    return { ...token, accessToken: data.access_token, expiresAt: expiresAtFrom(data.expires_in) ?? new Date(Date.now() + 60 * DAY_MS).toISOString() };
  },

  async listAccounts(env, token) {
    const rows = await pages<Record<string, unknown>>(env, token, "/me/adaccounts", { fields: "id,account_id,name,currency,timezone_name,account_status,business{name}", limit: 100 }, "Meta ad accounts");
    return rows
      .filter((r) => str(r.account_id) || str(r.id))
      .map((r) => ({
        externalId: str(r.account_id) || str(r.id).replace(/^act_/, ""),
        name: str(r.name) || `Ad account ${str(r.account_id)}`,
        currency: str(r.currency).toUpperCase() || "USD",
        timezone: str(r.timezone_name) || null,
        status: accountStatus(r.account_status),
        business: typeof r.business === "object" && r.business ? str((r.business as { name?: unknown }).name) || null : null,
      }));
  },

  async listCampaigns(env, token, account) {
    const rows = await pages<Record<string, unknown>>(
      env,
      token,
      `/${actId(account.externalId)}/campaigns`,
      { fields: "id,name,objective,effective_status,daily_budget,lifetime_budget", limit: 200, effective_status: JSON.stringify(["ACTIVE", "PAUSED", "IN_PROCESS", "WITH_ISSUES"]) },
      "Meta campaigns",
    );
    return rows.map((r): CampaignInfo => ({
      externalId: str(r.id),
      name: str(r.name),
      status: campaignStatus(r.effective_status),
      rawStatus: str(r.effective_status),
      objective: str(r.objective) || null,
      channel: "meta",
      // Budgets are minor units, as integers in a string. The account's exponent is not needed to keep them.
      dailyBudgetMinor: r.daily_budget !== undefined ? int(r.daily_budget) : null,
      lifetimeBudgetMinor: r.lifetime_budget !== undefined ? int(r.lifetime_budget) : null,
    }));
  },

  async insights(env, token, account, range) {
    const rows = await pages<Record<string, unknown>>(
      env,
      token,
      `/${actId(account.externalId)}/insights`,
      {
        level: "campaign",
        time_increment: 1,
        time_range: JSON.stringify({ since: range.since, until: range.until }),
        fields: "campaign_id,campaign_name,spend,impressions,clicks,actions,action_values,account_currency",
        limit: 500,
      },
      "Meta insights",
    );
    const out: InsightRow[] = [];
    for (const r of rows) {
      const day = str(r.date_start);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !str(r.campaign_id)) continue;
      const currency = str(r.account_currency) || account.currency;
      const { conversions, valueMinor } = conversionOf(r, currency, account.conversionActions ?? []);
      out.push({
        campaignExternalId: str(r.campaign_id),
        campaignName: str(r.campaign_name),
        day,
        spendMinor: decimalToMinor(str(r.spend) || "0", currency) ?? 0,
        impressions: int(r.impressions),
        clicks: int(r.clicks),
        conversions,
        valueMinor,
      });
    }
    return out;
  },

  async createCampaign(env, token, account, request_) {
    const created = await post<{ id?: string }>(
      env,
      token,
      `/${actId(account.externalId)}/campaigns`,
      {
        name: request_.name,
        objective: request_.objective,
        // Always paused: making it live is a separate request with its own approval.
        status: "PAUSED",
        special_ad_categories: JSON.stringify(request_.specialAdCategories ?? []),
        daily_budget: request_.dailyBudgetMinor,
        bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      },
      "Meta create campaign",
    );
    if (!created.id) throw new ProviderError("Meta did not return the new campaign's id.");
    return { externalId: created.id, name: request_.name };
  },

  async setCampaignStatus(env, token, _account, campaignExternalId, status) {
    const res = await post<{ success?: boolean }>(env, token, `/${campaignExternalId}`, { status: status === "active" ? "ACTIVE" : "PAUSED" }, "Meta campaign status");
    if (res.success === false) throw new ProviderError("Meta did not accept the status change.");
  },

  async setCampaignBudget(env, token, _account, campaignExternalId, dailyBudgetMinor) {
    // A campaign whose budget sits on its ad sets cannot take one here; say so instead of letting Meta fail obscurely.
    const current = await get<{ daily_budget?: string; lifetime_budget?: string }>(env, token, `/${campaignExternalId}`, { fields: "daily_budget,lifetime_budget" }, "Meta campaign budget");
    if (current.daily_budget === undefined) {
      throw new AdsError(current.lifetime_budget !== undefined
        ? "This campaign has a lifetime budget; change it in Meta Ads Manager."
        : "This campaign's budget is set on its ad sets, not on the campaign; change it in Meta Ads Manager.");
    }
    const res = await post<{ success?: boolean }>(env, token, `/${campaignExternalId}`, { daily_budget: dailyBudgetMinor }, "Meta campaign budget");
    if (res.success === false) throw new ProviderError("Meta did not accept the budget change.");
  },
};
