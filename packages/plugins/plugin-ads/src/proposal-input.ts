/**
 * Turns what an agent or a person asks for into a checked proposal payload: which account, which campaign, the numbers in minor units,
 * what it adds to the month. Reads the registry (accounts, synced campaigns) so a proposal can only name things that exist in its scope.
 */
import { AdsError, minorField, objectParams, optionalString, requiredString, stringList } from "./domain.js";
import { addDays, isDay, todayIn } from "./dates.js";
import { getAccount, getCampaign, type AccountRow, type ScopeRow } from "./db.js";
import { validateResponsiveSearchAd } from "./rsa.js";
import { PROPOSAL_KINDS, type ProposalKind } from "./platforms.js";
import type { SpendAddition } from "./budgets.js";
import type { AdsRuntime } from "./runtime.js";

export const META_OBJECTIVES = ["OUTCOME_LEADS", "OUTCOME_TRAFFIC", "OUTCOME_SALES", "OUTCOME_AWARENESS", "OUTCOME_ENGAGEMENT", "OUTCOME_APP_PROMOTION"] as const;
export const GOOGLE_CHANNELS = ["SEARCH"] as const;
export const META_SPECIAL_CATEGORIES = ["CREDIT", "EMPLOYMENT", "HOUSING", "ISSUES_ELECTIONS_POLITICS", "ONLINE_GAMBLING_AND_GAMING", "FINANCIAL_PRODUCTS_SERVICES"] as const;
export const OPTIMIZATION_GOALS = ["LINK_CLICKS", "LANDING_PAGE_VIEWS", "IMPRESSIONS", "REACH", "OFFSITE_CONVERSIONS", "APP_INSTALLS"] as const;
export const BILLING_EVENTS = ["IMPRESSIONS", "LINK_CLICKS"] as const;
export const CREATIVE_CTAS = ["LEARN_MORE", "SHOP_NOW", "SIGN_UP", "DOWNLOAD", "BOOK_TRAVEL", "CONTACT_US", "GET_OFFER", "SUBSCRIBE", "APPLY_NOW", "ORDER_NOW", "GET_QUOTE", "WATCH_MORE"] as const;

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
  /** Further copy lines the precheck must read too (an RSA has up to 19 texts; `creative` carries only the first few). */
  extraCopy?: Array<{ where: string; field: "headline" | "description"; text: string }>;
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

  if (kind === "create_ad_set") {
    const account = await accountFor(rt, scope, requiredString(input, "accountId"));
    if (account.platform !== "meta") throw new AdsError("Ad sets are only supported on Meta (Facebook and Instagram).");
    const name = requiredString(input, "name", 120);
    if (name.length < 3) throw new AdsError("name is too short");
    const campaignExternalId = requiredString(input, "campaignExternalId");
    const campaign = await getCampaign(rt.ctx, rt.companyId, account.id, campaignExternalId);
    if (!campaign) throw new AdsError(`Campaign ${campaignExternalId} is not known for ${account.name}. Sync the account first.`);
    const lifetimeBudgetMinor = minorField(input, "lifetimeBudgetMinor", { required: true })!;
    if (lifetimeBudgetMinor <= 0) throw new AdsError("lifetimeBudgetMinor must be more than zero");
    if (input.dailyBudgetMinor !== undefined || input.daily_budget !== undefined) throw new AdsError("Daily budgets are not allowed for ad sets; use lifetimeBudgetMinor for a total budget.");
    const startDate = requiredString(input, "startDate", 10);
    const endDate = requiredString(input, "endDate", 10);
    if (!isDay(startDate)) throw new AdsError("startDate must be YYYY-MM-DD");
    if (!isDay(endDate)) throw new AdsError("endDate must be YYYY-MM-DD");
    if (endDate < startDate) throw new AdsError("endDate is before startDate");
    const optimizationGoal = requiredString(input, "optimizationGoal", 40);
    if (!(OPTIMIZATION_GOALS as readonly string[]).includes(optimizationGoal)) throw new AdsError(`optimizationGoal must be one of ${OPTIMIZATION_GOALS.join(", ")}`);
    const billingEvent = requiredString(input, "billingEvent", 20);
    if (!(BILLING_EVENTS as readonly string[]).includes(billingEvent)) throw new AdsError(`billingEvent must be one of ${BILLING_EVENTS.join(", ")}`);
    const targeting = objectParams(input.targeting ?? {});
    const countries = stringList(targeting.countries, 300, 2);
    if (countries.length === 0) throw new AdsError("targeting.countries is required: at least one 2-letter ISO code");
    const ageMin = minorField(targeting, "ageMin", { required: false }) ?? 18;
    const ageMax = minorField(targeting, "ageMax", { required: false }) ?? 65;
    if (ageMin < 13 || ageMin > 65) throw new AdsError("targeting.ageMin must be 13-65");
    if (ageMax < 18 || ageMax > 65) throw new AdsError("targeting.ageMax must be 18-65");
    if (ageMax < ageMin) throw new AdsError("targeting.ageMax is less than ageMin");
    const interests = Array.isArray(targeting.interests) ? targeting.interests.filter((i) => typeof i === "object" && i !== null && typeof (i as any).id === "string") : [];
    const publisherPlatforms = stringList(input.publisherPlatforms, 10, 40);
    const days = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000) + 1;
    return {
      kind,
      accountId: account.id,
      platform: account.platform,
      currency: account.currency,
      payload: {
        accountId: account.id,
        accountName: account.name,
        platform: account.platform,
        campaignExternalId,
        campaignName: campaign.name,
        name,
        lifetimeBudgetMinor,
        startDate,
        endDate,
        plannedDays: days,
        totalCommitmentMinor: lifetimeBudgetMinor,
        optimizationGoal,
        billingEvent,
        targeting: { countries, ageMin, ageMax, interests },
        publisherPlatforms: publisherPlatforms.length ? publisherPlatforms : null,
        notes: optionalString(input, "notes", 2000) ?? null,
        reason,
        status: "PAUSED",
        creates: "ad set, paused",
      },
      title: `New ad set "${name}"`,
      summary: `Create "${name}" on "${campaign.name}" with a lifetime budget of ${lifetimeBudgetMinor} minor units from ${startDate} to ${endDate}. It is created paused; switching it on is a separate approved change.`,
      addition: { dailyMinor: Math.ceil(lifetimeBudgetMinor / days), fromDay: startDate > addDays(today, 1) ? startDate : null, toDay: endDate },
      creative: null,
      specialAdCategories: [],
    };
  }

  if (kind === "create_ad_creative") {
    const account = await accountFor(rt, scope, requiredString(input, "accountId"));
    if (account.platform !== "meta") throw new AdsError("Ad creatives are only supported on Meta (Facebook and Instagram).");
    const name = requiredString(input, "name", 120);
    if (name.length < 3) throw new AdsError("name is too short");
    const pageId = requiredString(input, "pageId", 40);
    if (!/^\d+$/.test(pageId)) throw new AdsError("pageId must be digits only");
    const imageHash = optionalString(input, "imageHash", 100);
    const videoId = optionalString(input, "videoId", 100);
    if ((imageHash && videoId) || (!imageHash && !videoId)) throw new AdsError("Supply exactly one of imageHash or videoId, not both or neither.");
    const link = requiredString(input, "link", 2000);
    if (!link.startsWith("https://")) throw new AdsError("link must start with https://");
    const headline = requiredString(input, "headline", 40);
    if (headline.length < 1) throw new AdsError("headline is required (1-40 characters)");
    const body = requiredString(input, "body", 2000);
    if (body.length < 1) throw new AdsError("body is required (1-2000 characters)");
    const cta = requiredString(input, "cta", 20);
    if (!(CREATIVE_CTAS as readonly string[]).includes(cta)) throw new AdsError(`cta must be one of ${CREATIVE_CTAS.join(", ")}`);
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
        pageId,
        imageHash: imageHash ?? null,
        videoId: videoId ?? null,
        link,
        headline,
        body,
        cta,
        notes: optionalString(input, "notes", 2000) ?? null,
        reason,
        creates: "ad creative (serves nothing until an ad uses it)",
      },
      title: `New ad creative "${name}"`,
      summary: `Create ad creative "${name}" on ${account.name} with headline "${headline}" and CTA "${cta}". It serves nothing until an ad is created to use it.`,
      addition: null,
      creative: { headline, primaryText: body, description: null, callToAction: cta, landingUrl: link },
      specialAdCategories: [],
    };
  }

  if (kind === "create_ad") {
    const account = await accountFor(rt, scope, requiredString(input, "accountId"));
    if (account.platform !== "meta") throw new AdsError("Ads are only supported on Meta (Facebook and Instagram).");
    const name = requiredString(input, "name", 120);
    if (name.length < 3) throw new AdsError("name is too short");
    const adSetExternalId = requiredString(input, "adSetExternalId", 100);
    if (adSetExternalId.length === 0) throw new AdsError("adSetExternalId must be a non-empty string");
    const creativeExternalId = requiredString(input, "creativeExternalId", 100);
    if (creativeExternalId.length === 0) throw new AdsError("creativeExternalId must be a non-empty string");
    if (input.status !== undefined && input.status !== "PAUSED") throw new AdsError("Ads must be created PAUSED; once created, you can change the status in a separate proposal.");
    if (input.dailyBudgetMinor !== undefined) throw new AdsError("Budget is set on the ad set, not on individual ads.");
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
        adSetExternalId,
        creativeExternalId,
        status: "PAUSED",
        creates: "ad, paused (Meta reviews it before it can deliver)",
        notes: optionalString(input, "notes", 2000) ?? null,
        reason,
      },
      title: `New ad "${name}"`,
      summary: `Create ad "${name}" on ${account.name} with the specified ad set and creative. It is created paused; Meta reviews it before it can deliver.`,
      addition: null,
      creative: null,
      specialAdCategories: [],
    };
  }

  if (kind === "create_ad_group") {
    const account = await accountFor(rt, scope, requiredString(input, "accountId"));
    if (account.platform !== "google") throw new AdsError("Ad groups can only be created on Google (version 0.2 supports Google only).");
    const externalId = requiredString(input, "campaignExternalId");
    const campaign = await getCampaign(rt.ctx, rt.companyId, account.id, externalId);
    if (!campaign) throw new AdsError(`Campaign ${externalId} is not known for ${account.name}. Sync the account first, then list-ad-campaigns for the ids.`);
    const name = String(input.name ?? "").trim();
    if (name.length < 1) throw new AdsError("name is too short");
    if (name.length > 120) throw new AdsError("name is too long (120 characters at most)");
    const cpcBidMinor = minorField(input, "cpcBidMinor", { required: true })!;
    if (cpcBidMinor <= 0) throw new AdsError("cpcBidMinor must be more than zero");
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
        name,
        cpcBidMinor,
        reason,
      },
      title: `New ad group "${name}" in "${campaign.name}"`,
      summary: `Create ad group "${name}" in "${campaign.name}" on ${account.name} with ${cpcBidMinor} minor units max CPC bid. It is created paused.`,
      addition: null,
      creative: null,
      specialAdCategories: [],
    };
  }

  if (kind === "add_keywords") {
    const account = await accountFor(rt, scope, requiredString(input, "accountId"));
    if (account.platform !== "google") throw new AdsError("Keywords can only be added on Google (version 0.2 supports Google only).");
    const adGroupExternalId = requiredString(input, "adGroupExternalId");
    const keywords = (Array.isArray(input.keywords) ? input.keywords : []) as Array<unknown>;
    if (keywords.length === 0 || keywords.length > 50) throw new AdsError("keywords must have 1 to 50 items");
    const normalized: Array<{ text: string; matchType: string; negative?: boolean }> = [];
    for (const kw of keywords) {
      const k = objectParams(kw);
      const text = String(k.text ?? "").trim();
      if (text.length < 1) throw new AdsError("keyword text must not be empty");
      if (text.length > 80) throw new AdsError("keyword text is too long (80 characters at most)");
      const matchType = requiredString(k, "matchType", 10);
      if (!["exact", "phrase", "broad"].includes(matchType)) throw new AdsError(`matchType must be exact, phrase or broad, not ${matchType}`);
      const negative = k.negative === true ? true : undefined;
      normalized.push({ text, matchType, ...( negative ? { negative } : {}) });
    }
    return {
      kind,
      accountId: account.id,
      platform: account.platform,
      currency: account.currency,
      payload: {
        accountId: account.id,
        accountName: account.name,
        platform: account.platform,
        adGroupExternalId,
        keywords: normalized,
        reason,
      },
      title: `Add ${keywords.length} keyword${keywords.length === 1 ? "" : "s"}`,
      summary: `Add ${keywords.length} keyword${keywords.length === 1 ? "" : "s"} to ad group ${adGroupExternalId} on ${account.name}.`,
      addition: null,
      creative: null,
      specialAdCategories: [],
    };
  }
  if (kind === "create_responsive_search_ad") {
    const account = await accountFor(rt, scope, requiredString(input, "accountId"));
    if (account.platform !== "google") throw new AdsError("Responsive search ads can only be created on Google (use create_ad_creative and create_ad on Meta).");
    const adGroupExternalId = requiredString(input, "adGroupExternalId", 100);
    if (input.status !== undefined && input.status !== "PAUSED") throw new AdsError("Ads must be created PAUSED; once created, you can change the status in a separate proposal.");
    const copy = validateResponsiveSearchAd(input);
    return {
      kind,
      accountId: account.id,
      platform: account.platform,
      currency: account.currency,
      payload: {
        accountId: account.id,
        accountName: account.name,
        platform: account.platform,
        adGroupExternalId,
        headlines: copy.headlines,
        descriptions: copy.descriptions,
        finalUrl: copy.finalUrl,
        path1: copy.path1 ?? null,
        path2: copy.path2 ?? null,
        status: "PAUSED",
        creates: "responsive search ad, paused (Google reviews it before it can serve)",
        notes: optionalString(input, "notes", 2000) ?? null,
        reason,
      },
      title: `New responsive search ad "${copy.headlines[0]}"`,
      summary: `Create a responsive search ad in ad group ${adGroupExternalId} on ${account.name} with ${copy.headlines.length} headlines and ${copy.descriptions.length} descriptions, landing on ${copy.finalUrl}. It is created paused; Google reviews it before it can serve.`,
      addition: null,
      creative: { headline: copy.headlines[0]!, primaryText: copy.descriptions[0]!, description: copy.descriptions[1] ?? null, callToAction: null, landingUrl: copy.finalUrl },
      extraCopy: [
        ...copy.headlines.slice(1).map((text, i) => ({ where: `headlines[${i + 1}]`, field: "headline" as const, text })),
        ...copy.descriptions.slice(2).map((text, i) => ({ where: `descriptions[${i + 2}]`, field: "description" as const, text })),
      ],
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
