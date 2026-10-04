/**
 * Turns what an agent or a person asks for into a checked proposal payload: which account, which campaign, the numbers in minor units,
 * what it adds to the month. Reads the registry (accounts, synced campaigns) so a proposal can only name things that exist in its scope.
 */
import { AdsError, minorField, objectParams, optionalString, requiredString, stringList } from "./domain.js";
import { addDays, isDay, todayIn } from "./dates.js";
import { getAccount, getCampaign, type AccountRow, type ScopeRow } from "./db.js";
import { PROPOSAL_KINDS, type ProposalKind } from "./platforms.js";
import type { SpendAddition } from "./budgets.js";
import type { AdsRuntime } from "./runtime.js";

export const META_OBJECTIVES = ["OUTCOME_LEADS", "OUTCOME_TRAFFIC", "OUTCOME_SALES", "OUTCOME_AWARENESS", "OUTCOME_ENGAGEMENT", "OUTCOME_APP_PROMOTION"] as const;
export const GOOGLE_CHANNELS = ["SEARCH"] as const;
export const META_SPECIAL_CATEGORIES = ["CREDIT", "EMPLOYMENT", "HOUSING", "ISSUES_ELECTIONS_POLITICS", "ONLINE_GAMBLING_AND_GAMING", "FINANCIAL_PRODUCTS_SERVICES"] as const;

export interface CampaignTarget {
  accountId: string;
  accountName: string;
  platform: string;
  campaignExternalId: string;
  campaignName: string;
  dailyBudgetMinor: number | null;
  status: string;
  spendMonthMinor?: number;
}

export interface Creative {
  headline: string | null;
  primaryText: string | null;
  description: string | null;
  callToAction: string | null;
  landingUrl: string | null;
}

export interface Normalized {
  kind: ProposalKind;
  accountId: string | null;
  platform: string | null;
  currency: string;
  /** The checked payload: what the approver is shown and what the hash covers. */
  payload: Record<string, unknown>;
  title: string;
  /** One or two plain sentences. */
  summary: string;
  /** What it adds to spend this month (null: nothing, or not a spend change). */
  addition: SpendAddition | null;
  creative: Creative | null;
  specialAdCategories: string[];
}

function creativeFrom(raw: unknown): Creative | null {
  if (raw === undefined || raw === null) return null;
  const c = objectParams(raw);
  const text = (key: string, max: number) => optionalString(c, key, max) ?? null;
  const creative = { headline: text("headline", 200), primaryText: text("primaryText", 2200), description: text("description", 300), callToAction: text("callToAction", 60), landingUrl: text("landingUrl", 500) };
  return Object.values(creative).some(Boolean) ? creative : null;
}

async function accountFor(rt: AdsRuntime, scope: ScopeRow, accountId: string): Promise<AccountRow> {
  const account = await getAccount(rt.ctx, rt.companyId, accountId);
  if (!account || account.status !== "active") throw new AdsError("That ad account was not found or is not active. Use list-ad-accounts for the ids.");
  if (account.scope_key !== scope.scope_key) throw new AdsError("That ad account belongs to another scope. A proposal covers one scope only.");
  if (account.currency !== scope.currency) throw new AdsError(`That account is in ${account.currency} and the scope budgets in ${scope.currency}.`);
  return account;
}

async function targetsFrom(rt: AdsRuntime, scope: ScopeRow, raw: unknown): Promise<CampaignTarget[]> {
  if (!Array.isArray(raw) || raw.length === 0) throw new AdsError("targets is required: a list of { accountId, campaignExternalId } (from list-ad-campaigns)");
  if (raw.length > 25) throw new AdsError("At most 25 campaigns in one proposal.");
  const out: CampaignTarget[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const t = objectParams(item);
    const account = await accountFor(rt, scope, requiredString(t, "accountId"));
    const externalId = requiredString(t, "campaignExternalId");
    const key = `${account.id}|${externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const campaign = await getCampaign(rt.ctx, rt.companyId, account.id, externalId);
    if (!campaign) throw new AdsError(`Campaign ${externalId} is not known for ${account.name}. Sync the account first (sync-ad-account), then list-ad-campaigns for the ids.`);
    out.push({ accountId: account.id, accountName: account.name, platform: account.platform, campaignExternalId: externalId, campaignName: campaign.name, dailyBudgetMinor: campaign.daily_budget_minor, status: campaign.status });
  }
  return out;
}

export async function normalizeProposal(rt: AdsRuntime, scope: ScopeRow, input: Record<string, unknown>): Promise<Normalized> {
  const kind = optionalKind(input.kind);
  const reason = optionalString(input, "reason", 1000) ?? null;
  const today = todayIn(rt.config.timezone, rt.now());

  if (kind === "create_campaign") {
    const account = await accountFor(rt, scope, requiredString(input, "accountId"));
    const name = requiredString(input, "name", 120);
    if (name.length < 3) throw new AdsError("name is too short");
    const objective = (optionalString(input, "objective", 40) ?? (account.platform === "google" ? "SEARCH" : "OUTCOME_LEADS")).toUpperCase();
    const allowed: readonly string[] = account.platform === "google" ? GOOGLE_CHANNELS : account.platform === "meta" ? META_OBJECTIVES : [...META_OBJECTIVES, ...GOOGLE_CHANNELS];
    if (!allowed.includes(objective)) throw new AdsError(`objective must be one of ${allowed.join(", ")} for ${account.platform === "google" ? "Google Ads (version 0.1 creates search campaigns)" : "this platform"}`);
    const dailyBudgetMinor = minorField(input, "dailyBudgetMinor", { required: true })!;
    if (dailyBudgetMinor <= 0) throw new AdsError("dailyBudgetMinor must be more than zero");
    const startDate = optionalString(input, "startDate", 10);
    const endDate = optionalString(input, "endDate", 10);
    if (startDate && !isDay(startDate)) throw new AdsError("startDate must be YYYY-MM-DD");
    if (endDate && !isDay(endDate)) throw new AdsError("endDate must be YYYY-MM-DD");
    if (startDate && endDate && endDate < startDate) throw new AdsError("endDate is before startDate");
    const categories = stringList(input.specialAdCategories, 8, 40).map((c) => c.toUpperCase());
    const creative = creativeFrom(input.creative);
    const days = startDate && endDate ? Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000) + 1 : null;
    return {
      kind,
      accountId: account.id,
      platform: account.platform,
      currency: account.currency,
      payload: {
        accountId: account.id,
        accountName: account.name,
        platform: account.platform,
        name,
        objective,
        dailyBudgetMinor,
        startDate: startDate ?? null,
        endDate: endDate ?? null,
        plannedDays: days,
        totalCommitmentMinor: days ? dailyBudgetMinor * days : null,
        specialAdCategories: categories,
        audience: optionalString(input, "audience", 1000) ?? null,
        creative,
        notes: optionalString(input, "notes", 2000) ?? null,
        reason,
        // The plugin creates the campaign PAUSED with its budget. Ad sets, audiences and ads are built in the platform (version 0.1).
        creates: "campaign shell, paused",
      },
      title: `New campaign "${name}"`,
      summary: `Create "${name}" on ${account.name} (${account.platform}) at ${dailyBudgetMinor} minor units a day. It is created paused; switching it on is a separate approved change.`,
      addition: { dailyMinor: dailyBudgetMinor, fromDay: startDate && startDate > addDays(today, 1) ? startDate : null, toDay: endDate ?? null },
      creative,
      specialAdCategories: categories,
    };
  }

  if (kind === "change_budget") {
    const account = await accountFor(rt, scope, requiredString(input, "accountId"));
    const externalId = requiredString(input, "campaignExternalId");
    const campaign = await getCampaign(rt.ctx, rt.companyId, account.id, externalId);
    if (!campaign) throw new AdsError(`Campaign ${externalId} is not known for ${account.name}. Sync the account, then list-ad-campaigns for the ids.`);
    if (campaign.daily_budget_minor === null) throw new AdsError("This campaign has no daily budget on the campaign itself (it may be a lifetime budget, or set on its ad sets). Change it in the ad platform.");
    const next = minorField(input, "newDailyBudgetMinor", { required: true })!;
    if (next <= 0) throw new AdsError("newDailyBudgetMinor must be more than zero; to stop spend, propose a pause");
    if (next === campaign.daily_budget_minor) throw new AdsError("That is the budget the campaign already has.");
    return {
      kind,
      accountId: account.id,
      platform: account.platform,
      currency: account.currency,
      payload: {
        accountId: account.id,
        accountName: account.name,
        platform: account.platform,
        campaignExternalId: externalId,
        campaignName: campaign.name,
        campaignStatus: campaign.status,
        currentDailyBudgetMinor: campaign.daily_budget_minor,
        newDailyBudgetMinor: next,
        reason,
      },
      title: `${next > campaign.daily_budget_minor ? "Raise" : "Lower"} the budget of "${campaign.name}"`,
      summary: `Change the daily budget of "${campaign.name}" on ${account.name} from ${campaign.daily_budget_minor} to ${next} minor units.`,
      // Only an active campaign spends its budget; a paused one adds nothing until it is resumed (its own proposal).
      addition: campaign.status === "active" ? { dailyMinor: Math.max(0, next - campaign.daily_budget_minor) } : null,
      creative: null,
      specialAdCategories: [],
    };
  }

  if (kind === "pause_campaign" || kind === "resume_campaign") {
    const targets = await targetsFrom(rt, scope, input.targets);
    const first = await getAccount(rt.ctx, rt.companyId, targets[0]!.accountId);
    const resume = kind === "resume_campaign";
    const bad = targets.filter((t) => (resume ? t.status === "active" : t.status === "paused" || t.status === "archived"));
    if (bad.length === targets.length) throw new AdsError(resume ? "Every campaign named is already active." : "Every campaign named is already paused or archived.");
    const useful = targets.filter((t) => !bad.includes(t));
    if (resume && useful.some((t) => t.dailyBudgetMinor === null)) throw new AdsError("A campaign to resume has no known daily budget, so the cap cannot be checked. Sync the account first.");
    const names = useful.map((t) => `"${t.campaignName}"`).join(", ");
    return {
      kind,
      accountId: useful.length === 1 ? useful[0]!.accountId : null,
      platform: first?.platform ?? null,
      currency: scope.currency,
      payload: { targets: useful, reason, trigger: optionalString(input, "trigger", 40) ?? null },
      title: `${resume ? "Resume" : "Pause"} ${useful.length === 1 ? names : `${useful.length} campaigns`}`,
      summary: `${resume ? "Switch on" : "Pause"} ${names}.`,
      addition: resume ? { dailyMinor: useful.reduce((sum, t) => sum + (t.dailyBudgetMinor ?? 0), 0) } : null,
      creative: null,
      specialAdCategories: [],
    };
  }

  // creative_check
  const platform = optionalString(input, "platform", 10) ?? "meta";
  if (platform !== "meta" && platform !== "google") throw new AdsError("platform must be meta or google");
  const creative = creativeFrom(input.creative);
  if (!creative) throw new AdsError("creative is required: at least a headline or primary text");
  const categories = stringList(input.specialAdCategories, 8, 40).map((c) => c.toUpperCase());
  const label = optionalString(input, "name", 120) ?? creative.headline ?? "ad copy";
  return {
    kind: "creative_check",
    accountId: null,
    platform,
    currency: scope.currency,
    payload: { platform, name: label, creative, specialAdCategories: categories, notes: optionalString(input, "notes", 2000) ?? null, reason },
    title: `Ad copy: ${label.slice(0, 80)}`,
    summary: `Check the copy "${label.slice(0, 80)}" for ${platform}. Clearing it changes nothing in the ad platform.`,
    addition: null,
    creative,
    specialAdCategories: categories,
  };
}

function optionalKind(value: unknown): ProposalKind {
  if (typeof value !== "string" || !(PROPOSAL_KINDS as readonly string[]).includes(value)) throw new AdsError(`kind must be one of ${PROPOSAL_KINDS.join(", ")}`);
  return value as ProposalKind;
}
