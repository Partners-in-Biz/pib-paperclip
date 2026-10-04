/**
 * Google Ads API over REST, written against Google's published API. Off until the owner adds the OAuth client; nothing here has run
 * against Google yet, so the first live read is a check (the Setup item says so).
 *
 * Reading: `customers:listAccessibleCustomers`, GAQL through `googleAds:search` (campaign and customer resources).
 * Writing (only through `execute.ts`): one atomic `googleAds:mutate` that creates a budget and a PAUSED search campaign;
 * `campaigns:mutate` for status; `campaignBudgets:mutate` for the daily amount.
 *
 * Facts this relies on (Google's docs, checked 2026-10): the OAuth scope is `https://www.googleapis.com/auth/adwords`; developer tokens
 * were retired on 2026-09-09 and API access levels now belong to the Google Cloud project that owns the OAuth client (the
 * `developer-token` header is optional and ignored; it is sent only when one is saved); a manager account is addressed with
 * `login-customer-id`; cost is in micros of the account currency; REST field names are camelCase; a new campaign must say whether it
 * carries EU political advertising.
 */
import { AdsError } from "../domain.js";
import { microsToMinor, minorToMicros } from "../money.js";
import { FORM_HEADERS, JSON_HEADERS, ProviderError, expiresAtFrom, formBody, int, num, readJson, request, str } from "./http.js";
import type { AccountRef, AdsProvider, CampaignInfo, CampaignStatus, ExchangeResult, InsightRow, ProviderAdAccount, ProviderEnv, TokenBundle } from "./types.js";

export const DEFAULT_GOOGLE_VERSION = "v25";
export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/adwords";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ADS_HOST = "https://googleads.googleapis.com";
const MAX_PAGES = 20;
const MAX_CUSTOMERS = 50;

function version(env: ProviderEnv): string {
  const v = env.app.apiVersion?.trim() || DEFAULT_GOOGLE_VERSION;
  return v.startsWith("v") ? v : `v${v}`;
}

const digits = (id: string) => id.replace(/\D/g, "");

function headers(env: ProviderEnv, token: TokenBundle, loginCustomerId?: string | null): Record<string, string> {
  const out: Record<string, string> = { ...JSON_HEADERS, Authorization: `Bearer ${token.accessToken}` };
  if (env.app.developerToken?.trim()) out["developer-token"] = env.app.developerToken.trim();
  if (loginCustomerId) out["login-customer-id"] = digits(loginCustomerId);
  return out;
}

async function call<T = Record<string, unknown>>(env: ProviderEnv, token: TokenBundle, path: string, init: { method?: string; body?: unknown; loginCustomerId?: string | null }, label: string): Promise<T> {
  const res = await request(`${ADS_HOST}/${version(env)}/${path}`, {
    fetchImpl: env.fetchImpl,
    method: init.method ?? "POST",
    headers: headers(env, token, init.loginCustomerId),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return readJson<T>(res, label);
}

/** One GAQL query, every page. */
async function gaql(env: ProviderEnv, token: TokenBundle, customerId: string, query: string, loginCustomerId: string | null | undefined, label: string): Promise<Array<Record<string, any>>> {
  const out: Array<Record<string, any>> = [];
  let pageToken: string | undefined;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const page = await call<{ results?: Array<Record<string, any>>; nextPageToken?: string }>(env, token, `customers/${digits(customerId)}/googleAds:search`, { body: { query, ...(pageToken ? { pageToken } : {}) }, loginCustomerId }, label);
    out.push(...(page.results ?? []));
    pageToken = page.nextPageToken || undefined;
    if (!pageToken) return out;
  }
  // Never hand back part of an answer as the whole one (see Meta's `pages`): the sync would zero the days it did not see.
  throw new ProviderError(`${label} has more than ${MAX_PAGES} pages, so the answer would be incomplete and nothing was changed. Ask for fewer days, or tell the platform team.`);
}

export function campaignStatusOf(raw: unknown): CampaignStatus {
  const s = str(raw).toUpperCase();
  if (s === "ENABLED") return "active";
  if (s === "PAUSED") return "paused";
  if (s === "REMOVED") return "archived";
  return "other";
}

function customerStatus(raw: unknown): ProviderAdAccount["status"] {
  const s = str(raw).toUpperCase();
  if (s === "ENABLED") return "active";
  if (s === "SUSPENDED" || s === "PAUSED") return "paused";
  return "disabled";
}

export const googleProvider: AdsProvider = {
  platform: "google",
  refreshKind: "refresh_token",

  authorize(env, state) {
    const params = formBody({
      client_id: env.app.clientId,
      redirect_uri: env.redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPE,
      state,
      // A refresh token is only returned when consent is asked for again.
      access_type: "offline",
      prompt: "consent",
    });
    return { url: `${AUTH_URL}?${params}`, scopes: [GOOGLE_SCOPE] };
  },

  async exchange(env, params): Promise<ExchangeResult> {
    const code = params.code;
    if (!code) throw new ProviderError("Google did not send an authorization code. Start the connection again.");
    const data = await readJson<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }>(
      await request(TOKEN_URL, {
        fetchImpl: env.fetchImpl,
        method: "POST",
        headers: FORM_HEADERS,
        body: formBody({ code, client_id: env.app.clientId, client_secret: env.app.clientSecret, redirect_uri: env.redirectUri, grant_type: "authorization_code" }),
      }),
      "Google sign-in",
    );
    if (!data.access_token) throw new ProviderError("Google did not return an access token.");
    if (!data.refresh_token) throw new ProviderError("Google did not return a refresh token, so the connection would stop working within the hour. Remove Paperclip's access at myaccount.google.com/permissions and connect again.");
    const scopes = str(data.scope).split(/\s+/).filter(Boolean);
    return {
      token: { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: expiresAtFrom(data.expires_in), scopes },
      label: "Google Ads",
      externalUserId: null,
      // The single Ads scope reads and changes; what matters for changing things is the plugin's switches, not this flag.
      canWrite: scopes.includes(GOOGLE_SCOPE),
      scopes,
    };
  },

  async refresh(env, token) {
    if (!token.refreshToken) throw new ProviderError("This connection has no refresh token. Connect Google Ads again.", { tokenInvalid: true });
    const data = await readJson<{ access_token?: string; expires_in?: number }>(
      await request(TOKEN_URL, {
        fetchImpl: env.fetchImpl,
        method: "POST",
        headers: FORM_HEADERS,
        body: formBody({ refresh_token: token.refreshToken, client_id: env.app.clientId, client_secret: env.app.clientSecret, grant_type: "refresh_token" }),
      }),
      "Google token refresh",
    );
    if (!data.access_token) throw new ProviderError("Google did not return a refreshed token.", { tokenInvalid: true });
    return { ...token, accessToken: data.access_token, expiresAt: expiresAtFrom(data.expires_in) };
  },

  async listAccounts(env, token) {
    const listed = await call<{ resourceNames?: string[] }>(env, token, "customers:listAccessibleCustomers", { method: "GET" }, "Google accessible customers");
    const ids = (listed.resourceNames ?? []).map((n) => digits(n)).filter(Boolean).slice(0, MAX_CUSTOMERS);
    const out = new Map<string, ProviderAdAccount>();
    for (const id of ids) {
      let info: Record<string, any> | undefined;
      try {
        info = (await gaql(env, token, id, "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.status FROM customer LIMIT 1", id, "Google customer"))[0]?.customer;
      } catch {
        // An account we cannot read directly (cancelled, no access) is left out; the rest still list.
        continue;
      }
      if (!info) continue;
      if (info.manager === true) {
        const children = await gaql(
          env,
          token,
          id,
          "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.level = 1 AND customer_client.manager = false",
          id,
          "Google client accounts",
        ).catch(() => [] as Array<Record<string, any>>);
        for (const row of children) {
          const c = row.customerClient ?? row.customer_client;
          if (!c?.id) continue;
          out.set(str(c.id), { externalId: str(c.id), name: str(c.descriptiveName) || `Customer ${str(c.id)}`, currency: str(c.currencyCode).toUpperCase() || "USD", timezone: str(c.timeZone) || null, status: customerStatus(c.status), loginCustomerId: id });
        }
      } else {
        out.set(str(info.id), { externalId: str(info.id), name: str(info.descriptiveName) || `Customer ${str(info.id)}`, currency: str(info.currencyCode).toUpperCase() || "USD", timezone: str(info.timeZone) || null, status: customerStatus(info.status), loginCustomerId: null });
      }
    }
    return [...out.values()];
  },

  async listCampaigns(env, token, account) {
    const rows = await gaql(
      env,
      token,
      account.externalId,
      "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED'",
      account.loginCustomerId,
      "Google campaigns",
    );
    return rows.map((r): CampaignInfo => ({
      externalId: str(r.campaign?.id),
      name: str(r.campaign?.name),
      status: campaignStatusOf(r.campaign?.status),
      rawStatus: str(r.campaign?.status),
      objective: null,
      channel: str(r.campaign?.advertisingChannelType) || null,
      dailyBudgetMinor: r.campaignBudget?.amountMicros !== undefined ? microsToMinor(r.campaignBudget.amountMicros, account.currency) : null,
      lifetimeBudgetMinor: null,
    }));
  },

  async insights(env, token, account, range) {
    const rows = await gaql(
      env,
      token,
      account.externalId,
      `SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${range.since}' AND '${range.until}'`,
      account.loginCustomerId,
      "Google reporting",
    );
    const out: InsightRow[] = [];
    for (const r of rows) {
      const day = str(r.segments?.date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !str(r.campaign?.id)) continue;
      const m = r.metrics ?? {};
      out.push({
        campaignExternalId: str(r.campaign.id),
        campaignName: str(r.campaign.name),
        day,
        spendMinor: microsToMinor(m.costMicros, account.currency),
        impressions: int(m.impressions),
        clicks: int(m.clicks),
        conversions: Math.round(num(m.conversions) * 100) / 100,
        // `conversionsValue` is a decimal in major units; micros of it are the same shape as cost.
        valueMinor: microsToMinor(num(m.conversionsValue) * 1_000_000, account.currency),
      });
    }
    return out;
  },

  async createCampaign(env, token, account, req) {
    const customer = digits(account.externalId);
    const temp = `customers/${customer}/campaignBudgets/-1`;
    const res = await call<{ mutateOperationResponses?: Array<{ campaignResult?: { resourceName?: string } }> }>(
      env,
      token,
      `customers/${customer}/googleAds:mutate`,
      {
        loginCustomerId: account.loginCustomerId,
        body: {
          // One request, so the budget and the campaign are created together or not at all.
          mutateOperations: [
            { campaignBudgetOperation: { create: { resourceName: temp, name: `${req.name} budget ${Date.now()}`, deliveryMethod: "STANDARD", amountMicros: String(minorToMicros(req.dailyBudgetMinor, account.currency)), explicitlyShared: false } } },
            {
              campaignOperation: {
                create: {
                  name: req.name,
                  // Always paused: making it live is a separate request with its own approval.
                  status: "PAUSED",
                  advertisingChannelType: "SEARCH",
                  campaignBudget: temp,
                  manualCpc: {},
                  networkSettings: { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: false, targetPartnerSearchNetwork: false },
                  containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
                },
              },
            },
          ],
        },
      },
      "Google create campaign",
    );
    const resourceName = res.mutateOperationResponses?.map((r) => r.campaignResult?.resourceName).find(Boolean);
    if (!resourceName) throw new ProviderError("Google did not return the new campaign.");
    return { externalId: resourceName.split("/").pop() ?? resourceName, name: req.name };
  },

  async setCampaignStatus(env, token, account, campaignExternalId, status) {
    const customer = digits(account.externalId);
    await call(
      env,
      token,
      `customers/${customer}/campaigns:mutate`,
      { loginCustomerId: account.loginCustomerId, body: { operations: [{ updateMask: "status", update: { resourceName: `customers/${customer}/campaigns/${digits(campaignExternalId)}`, status: status === "active" ? "ENABLED" : "PAUSED" } }] } },
      "Google campaign status",
    );
  },

  async setCampaignBudget(env, token, account, campaignExternalId, dailyBudgetMinor) {
    const customer = digits(account.externalId);
    const rows = await gaql(
      env,
      token,
      customer,
      `SELECT campaign.campaign_budget, campaign_budget.explicitly_shared, campaign_budget.reference_count FROM campaign WHERE campaign.id = ${digits(campaignExternalId)}`,
      account.loginCustomerId,
      "Google campaign budget",
    );
    const row = rows[0];
    const resourceName = str(row?.campaign?.campaignBudget);
    if (!resourceName) throw new ProviderError("Google did not return this campaign's budget.");
    if (row?.campaignBudget?.explicitlyShared === true || int(row?.campaignBudget?.referenceCount) > 1) {
      throw new AdsError("This campaign shares its budget with other campaigns, so changing it would change them too. Change it in Google Ads.");
    }
    await call(
      env,
      token,
      `customers/${customer}/campaignBudgets:mutate`,
      { loginCustomerId: account.loginCustomerId, body: { operations: [{ updateMask: "amount_micros", update: { resourceName, amountMicros: String(minorToMicros(dailyBudgetMinor, account.currency)) } }] } },
      "Google campaign budget",
    );
  },
};

export type { AccountRef };
