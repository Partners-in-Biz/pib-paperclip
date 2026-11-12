/**
 * Google App campaigns (app installs on Google Play or the Apple App Store), PAR-6695.
 *
 * Facts from Google's "Create an App campaign" guide (checked 2026-11-12, API v26): `advertisingChannelType` MULTI_CHANNEL with
 * `advertisingChannelSubType` APP_CAMPAIGN; `appCampaignSetting` names the store, the app id (package name on Google Play, the numeric
 * id on the App Store) and the goal; an App campaign cannot use a shared budget or a portfolio bidding strategy. This module builds only
 * the two install goals: a target install cost (`targetCpa`) or most installs for the budget (`maximizeConversions`). Location targeting
 * is a campaign criterion; without one Google shows the campaign in every country, so a proposal must name at least one location.
 */
import { AdsError, minorField, requiredString, stringList } from "../domain.js";
import { minorToMicros } from "../money.js";
import type { CreateCampaignRequest } from "./types.js";

export const GOOGLE_APP_CHANNEL = "MULTI_CHANNEL";
export const GOOGLE_APP_STORES = ["GOOGLE_APP_STORE", "APPLE_APP_STORE"] as const;
export type GoogleAppStore = (typeof GOOGLE_APP_STORES)[number];

export interface GoogleAppSettings {
  appStore: GoogleAppStore;
  /** Google Play package name (`com.example.app`) or the App Store's numeric id. */
  appId: string;
  /** Set: bid to this cost per install (minor units). Null: as many installs as the budget buys. */
  targetInstallCostMinor: number | null;
  /** Google geo target constant ids (2710 is South Africa). At least one. */
  locationIds: string[];
}

const PLAY_PACKAGE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

/** Checks the app fields of a create_campaign proposal. Throws an AdsError the agent can act on. */
export function appSettingsFrom(input: Record<string, unknown>, dailyBudgetMinor: number): GoogleAppSettings {
  const store = requiredString(input, "appStore", 40).toUpperCase();
  if (!(GOOGLE_APP_STORES as readonly string[]).includes(store)) throw new AdsError(`appStore must be one of ${GOOGLE_APP_STORES.join(", ")}`);
  const appStore = store as GoogleAppStore;
  let appId = requiredString(input, "appId", 255);
  if (appStore === "APPLE_APP_STORE") {
    // People paste the store link's "id1234567890"; Google wants the digits.
    appId = appId.replace(/^id/i, "");
    if (!/^\d{5,15}$/.test(appId)) throw new AdsError("appId for APPLE_APP_STORE is the App Store's numeric id (the digits after \"id\" in the store link)");
  } else if (!PLAY_PACKAGE.test(appId)) {
    throw new AdsError("appId for GOOGLE_APP_STORE is the Play package name, for example com.example.app");
  }
  const targetInstallCostMinor = minorField(input, "targetInstallCostMinor") ?? null;
  if (targetInstallCostMinor !== null && targetInstallCostMinor <= 0) throw new AdsError("targetInstallCostMinor must be more than zero (leave it out to get as many installs as the budget buys)");
  if (targetInstallCostMinor !== null && targetInstallCostMinor > dailyBudgetMinor) throw new AdsError("targetInstallCostMinor is more than the daily budget, so the campaign could not buy one install a day. Lower it or raise the budget.");
  const locationIds = stringList(input.locationIds, 50, 12).map((id) => id.replace(/^geoTargetConstants\//, ""));
  if (locationIds.length === 0) throw new AdsError("locationIds is required: Google geo target ids for where the app ads may show (2710 is South Africa). Without one Google shows them worldwide.");
  const bad = locationIds.find((id) => !/^\d{4,10}$/.test(id));
  if (bad) throw new AdsError(`locationIds must be Google geo target ids (digits, e.g. 2710); "${bad}" is not one`);
  return { appStore, appId, targetInstallCostMinor, locationIds: [...new Set(locationIds)] };
}

/** A stored payload's app back as proposal input, so a revision keeps what it does not name. */
export function appInput(app: unknown): Record<string, unknown> {
  if (!app || typeof app !== "object") return {};
  const a = app as GoogleAppSettings;
  return { appStore: a.appStore, appId: a.appId, targetInstallCostMinor: a.targetInstallCostMinor, locationIds: a.locationIds };
}

/** The `googleAds:mutate` operations: budget, PAUSED App campaign and its locations, so they are made together or not at all. */
export function appCampaignOperations(customer: string, req: CreateCampaignRequest, currency: string, nonce: number): Array<Record<string, unknown>> {
  const app = req.app;
  if (!app) throw new AdsError("An App campaign needs appStore, appId and locationIds.");
  const budget = `customers/${customer}/campaignBudgets/-1`;
  const campaign = `customers/${customer}/campaigns/-2`;
  const bidding = app.targetInstallCostMinor
    ? { targetCpa: { targetCpaMicros: String(minorToMicros(app.targetInstallCostMinor, currency)) } }
    : { maximizeConversions: {} };
  return [
    // App campaigns refuse a shared budget, so it is always the campaign's own.
    { campaignBudgetOperation: { create: { resourceName: budget, name: `${req.name} budget ${nonce}`, deliveryMethod: "STANDARD", amountMicros: String(minorToMicros(req.dailyBudgetMinor, currency)), explicitlyShared: false } } },
    {
      campaignOperation: {
        create: {
          resourceName: campaign,
          name: req.name,
          // Always paused: making it live is a separate request with its own approval.
          status: "PAUSED",
          advertisingChannelType: GOOGLE_APP_CHANNEL,
          advertisingChannelSubType: "APP_CAMPAIGN",
          campaignBudget: budget,
          appCampaignSetting: {
            appStore: app.appStore,
            appId: app.appId,
            biddingStrategyGoalType: app.targetInstallCostMinor ? "OPTIMIZE_INSTALLS_TARGET_INSTALL_COST" : "OPTIMIZE_INSTALLS_WITHOUT_TARGET_INSTALL_COST",
          },
          ...bidding,
          containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
        },
      },
    },
    ...app.locationIds.map((id) => ({ campaignCriterionOperation: { create: { campaign, location: { geoTargetConstant: `geoTargetConstants/${id}` } } } })),
  ];
}
