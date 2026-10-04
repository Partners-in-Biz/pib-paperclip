/**
 * The test platform. It serves accounts, campaigns and day-by-day numbers from memory, records every write it is asked for, and can be told
 * to fail, so the whole path (sync, rollups, ledger, caps, alerts, approvals, guarded writes) is tested and rehearsed on a canary client without
 * touching an ad platform. In production it is switched on by `platforms.mock.enabled`; it never opens a network connection, and what it serves
 * is made up (a demo account with three campaigns), so a rehearsal can never be mistaken for real spend.
 */
import { AdsError } from "../domain.js";
import { ProviderError } from "./http.js";
import type { StoredPlatform } from "../platforms.js";
import type { AccountRef, AdsProvider, CampaignInfo, CreateCampaignRequest, InsightRow, ProviderAdAccount, TokenBundle } from "./types.js";

export interface MockWrite {
  op: "create" | "status" | "budget";
  accountExternalId: string;
  campaignExternalId?: string;
  status?: "active" | "paused";
  dailyBudgetMinor?: number;
  name?: string;
  objective?: string;
}

/** A stable pseudo-random number in 0..1 from text, so the demo numbers are the same on every read. */
function unit(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

/** The made-up numbers for one campaign on one day: about `dailyBudgetMinor` of spend, with a CPC and a conversion rate that drift. */
export function demoDay(accountId: string, campaign: CampaignInfo, day: string): InsightRow {
  const budget = campaign.dailyBudgetMinor ?? 10_000;
  const spendMinor = Math.round(budget * (0.6 + unit(`${accountId}${campaign.externalId}${day}s`) * 0.4));
  const cpc = 300 + Math.round(unit(`${campaign.externalId}${day}c`) * 200);
  const clicks = Math.round(spendMinor / cpc);
  const impressions = Math.round(clicks * (18 + unit(`${campaign.externalId}${day}i`) * 14));
  const conversions = Math.round(clicks * (0.03 + unit(`${campaign.externalId}${day}v`) * 0.04) * 100) / 100;
  return { campaignExternalId: campaign.externalId, campaignName: campaign.name, day, spendMinor, impressions, clicks, conversions, valueMinor: Math.round(conversions * 45_000) };
}

export class MockAdsProvider implements AdsProvider {
  readonly refreshKind = "refresh_token" as const;
  accounts: ProviderAdAccount[] = [];
  campaigns: Record<string, CampaignInfo[]> = {};
  /** Fixed rows per account (tests). An account without any gets generated demo numbers. */
  insightRows: Record<string, InsightRow[]> = {};
  writes: MockWrite[] = [];
  reads: string[] = [];
  /** Set to make the next call of that kind throw. */
  failNext: Partial<Record<"insights" | "listAccounts" | "listCampaigns" | "create" | "status" | "budget" | "refresh", ProviderError | AdsError>> = {};
  refreshed = 0;
  /** The clock the demo token expiry follows (tests move it). */
  clock: () => Date = () => new Date();
  private seq = 100;

  constructor(readonly platform: StoredPlatform = "meta", options: { demo?: boolean } = {}) {
    if (options.demo) this.seedDemo();
  }

  /** One made-up account with three campaigns. */
  seedDemo(): void {
    this.accounts = [{ externalId: "demo-1", name: "Demo ad account (test platform)", currency: "ZAR", timezone: "Africa/Johannesburg", status: "active" }];
    this.campaigns = {
      "demo-1": [
        { externalId: "demo-c1", name: "Demo: search leads", status: "active", rawStatus: "ACTIVE", objective: "OUTCOME_LEADS", channel: "mock", dailyBudgetMinor: 15_000, lifetimeBudgetMinor: null },
        { externalId: "demo-c2", name: "Demo: retargeting", status: "active", rawStatus: "ACTIVE", objective: "OUTCOME_TRAFFIC", channel: "mock", dailyBudgetMinor: 8_000, lifetimeBudgetMinor: null },
        { externalId: "demo-c3", name: "Demo: old promotion", status: "paused", rawStatus: "PAUSED", objective: "OUTCOME_AWARENESS", channel: "mock", dailyBudgetMinor: 5_000, lifetimeBudgetMinor: null },
      ],
    };
  }

  private maybeFail(kind: keyof MockAdsProvider["failNext"]): void {
    const error = this.failNext[kind];
    if (error) {
      delete this.failNext[kind];
      throw error;
    }
  }

  authorize(_env: unknown, state: string) {
    return { url: `https://mock.invalid/authorize?state=${state}`, scopes: ["mock"] };
  }

  async exchange() {
    return { token: { accessToken: "mock-access", refreshToken: "mock-refresh", expiresAt: new Date(this.clock().getTime() + 3600_000).toISOString(), scopes: ["mock"] }, label: "Test platform", externalUserId: "mock-user", canWrite: true, scopes: ["mock"] };
  }

  async refresh(_env: unknown, token: TokenBundle) {
    this.maybeFail("refresh");
    this.refreshed += 1;
    return { ...token, accessToken: `mock-access-${this.refreshed}`, expiresAt: new Date(this.clock().getTime() + 3600_000).toISOString() };
  }

  async listAccounts() {
    this.reads.push("listAccounts");
    this.maybeFail("listAccounts");
    return this.accounts;
  }

  async listCampaigns(_env: unknown, _token: TokenBundle, account: AccountRef) {
    this.reads.push(`listCampaigns:${account.externalId}`);
    this.maybeFail("listCampaigns");
    return this.campaigns[account.externalId] ?? [];
  }

  async insights(_env: unknown, _token: TokenBundle, account: AccountRef, range: { since: string; until: string }) {
    this.reads.push(`insights:${account.externalId}:${range.since}:${range.until}`);
    this.maybeFail("insights");
    const fixed = this.insightRows[account.externalId];
    if (fixed) return fixed.filter((r) => r.day >= range.since && r.day <= range.until);
    const out: InsightRow[] = [];
    for (const campaign of this.campaigns[account.externalId] ?? []) {
      if (campaign.status !== "active") continue;
      for (let t = Date.parse(`${range.since}T00:00:00Z`); t <= Date.parse(`${range.until}T00:00:00Z`); t += 86_400_000) out.push(demoDay(account.externalId, campaign, new Date(t).toISOString().slice(0, 10)));
    }
    return out;
  }

  async createCampaign(_env: unknown, _token: TokenBundle, account: AccountRef, request: CreateCampaignRequest) {
    this.maybeFail("create");
    const externalId = `mock-cmp-${(this.seq += 1)}`;
    this.writes.push({ op: "create", accountExternalId: account.externalId, campaignExternalId: externalId, name: request.name, objective: request.objective, dailyBudgetMinor: request.dailyBudgetMinor, status: "paused" });
    (this.campaigns[account.externalId] ??= []).push({ externalId, name: request.name, status: "paused", rawStatus: "PAUSED", objective: request.objective, channel: this.platform, dailyBudgetMinor: request.dailyBudgetMinor, lifetimeBudgetMinor: null });
    return { externalId, name: request.name };
  }

  async setCampaignStatus(_env: unknown, _token: TokenBundle, account: AccountRef, campaignExternalId: string, status: "active" | "paused") {
    this.maybeFail("status");
    this.writes.push({ op: "status", accountExternalId: account.externalId, campaignExternalId, status });
    const campaign = this.campaigns[account.externalId]?.find((c) => c.externalId === campaignExternalId);
    if (campaign) {
      campaign.status = status;
      campaign.rawStatus = status.toUpperCase();
    }
  }

  async setCampaignBudget(_env: unknown, _token: TokenBundle, account: AccountRef, campaignExternalId: string, dailyBudgetMinor: number) {
    this.maybeFail("budget");
    this.writes.push({ op: "budget", accountExternalId: account.externalId, campaignExternalId, dailyBudgetMinor });
    const campaign = this.campaigns[account.externalId]?.find((c) => c.externalId === campaignExternalId);
    if (campaign) campaign.dailyBudgetMinor = dailyBudgetMinor;
  }
}
