/**
 * The ad platform boundary.
 *
 * A provider is pure network code (an injected `fetch`, no plugin context), so it is tested with a mocked fetch and with the
 * in-memory `MockAdsProvider`. Everything else (rollups, the ledger, caps, alerts, approvals) is the same for every platform.
 *
 * Rules every adapter keeps:
 * - Off until its app credentials exist and the owner switched it on (`providerState` in `../config.ts`).
 * - Reading is the default. The three write calls (`createCampaign`, `setCampaignStatus`, `setCampaignBudget`) are reachable only
 *   through `execute.ts`, which has checked an approval, the scope's switch and the cap. A created campaign is always PAUSED.
 * - Tokens never leave the worker and never appear in an error message.
 * - Money is integer minor units of the account's currency.
 */
import type { AdPlatform, StoredPlatform } from "../platforms.js";

export interface ProviderApp {
  platform: AdPlatform;
  clientId: string;
  clientSecret: string;
  apiVersion?: string;
  /** Google only. The developer token was retired on 2026-09-09; when saved it is still sent (ignored by Google) until it is rejected. */
  developerToken?: string;
  /** Ask for the write permission on connect (Meta `ads_management`). Off: a read-only connection. */
  requestWrite?: boolean;
}

export interface ProviderEnv {
  app: ProviderApp;
  /** The bridge redirect URI registered with the provider. */
  redirectUri: string;
  /** Injected for tests; the worker uses the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Everything sealed in `connections.token_enc`. */
export interface TokenBundle {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string | null;
  scopes?: string[];
}

export interface ProviderAdAccount {
  externalId: string;
  name: string;
  currency: string;
  timezone: string | null;
  status: "active" | "paused" | "disabled";
  /** Google: the manager account to send as `login-customer-id`. */
  loginCustomerId?: string | null;
  /** The business the account belongs to, when the platform says. */
  business?: string | null;
}

export type CampaignStatus = "active" | "paused" | "archived" | "other";

export interface CampaignInfo {
  externalId: string;
  name: string;
  status: CampaignStatus;
  rawStatus: string;
  objective: string | null;
  channel: string | null;
  dailyBudgetMinor: number | null;
  lifetimeBudgetMinor: number | null;
}

export interface InsightRow {
  campaignExternalId: string;
  campaignName: string;
  /** `YYYY-MM-DD` in the account's own timezone. */
  day: string;
  spendMinor: number;
  impressions: number;
  clicks: number;
  conversions: number;
  valueMinor: number;
}

/** What a provider needs to know about the account it works on. */
export interface AccountRef {
  externalId: string;
  currency: string;
  loginCustomerId?: string | null;
  /** Meta: which `actions` entry counts as a conversion, in order of preference. Empty: the default list. */
  conversionActions?: string[];
}

export interface CreateCampaignRequest {
  name: string;
  /** Meta ODAX objective (`OUTCOME_LEADS`...), or Google channel (`SEARCH`). */
  objective: string;
  dailyBudgetMinor: number;
  /** Meta only. */
  specialAdCategories?: string[];
}

export interface ExchangeResult {
  token: TokenBundle;
  /** Who signed in, for the connection's label (never a secret). */
  label: string;
  /** The user or customer id, for reconnects. */
  externalUserId: string | null;
  /** True when the token may change things (Meta: `ads_management` was granted). */
  canWrite: boolean;
  scopes: string[];
}

export interface AdsProvider {
  platform: StoredPlatform;
  /** How tokens are kept alive. */
  refreshKind: "refresh_token" | "long_lived";
  authorize(env: ProviderEnv, state: string): { url: string; scopes: string[] };
  exchange(env: ProviderEnv, params: Record<string, string>): Promise<ExchangeResult>;
  refresh(env: ProviderEnv, token: TokenBundle): Promise<TokenBundle>;
  listAccounts(env: ProviderEnv, token: TokenBundle): Promise<ProviderAdAccount[]>;
  listCampaigns(env: ProviderEnv, token: TokenBundle, account: AccountRef): Promise<CampaignInfo[]>;
  insights(env: ProviderEnv, token: TokenBundle, account: AccountRef, range: { since: string; until: string }): Promise<InsightRow[]>;
  /** Write: creates the campaign PAUSED. */
  createCampaign(env: ProviderEnv, token: TokenBundle, account: AccountRef, request: CreateCampaignRequest): Promise<{ externalId: string; name: string }>;
  /** Write: ACTIVE or PAUSED. */
  setCampaignStatus(env: ProviderEnv, token: TokenBundle, account: AccountRef, campaignExternalId: string, status: "active" | "paused"): Promise<void>;
  /** Write: the campaign's daily budget. Refuses a budget shared with other campaigns, or set on ad sets. */
  setCampaignBudget(env: ProviderEnv, token: TokenBundle, account: AccountRef, campaignExternalId: string, dailyBudgetMinor: number): Promise<void>;
}
