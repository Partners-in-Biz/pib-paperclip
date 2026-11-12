/**
 * Google YouTube video campaigns, PAR-6696.
 *
 * Facts from Google's docs (checked 2026-11-12, API v26): the Google Ads API cannot create or change campaigns of type VIDEO
 * ("Video campaigns", docs/video/overview: reporting only) and names Demand Gen as the way to run video ads on YouTube through the API.
 * So a "video campaign" here is a Demand Gen campaign (`advertisingChannelType` DEMAND_GEN, no sub type) with its own budget
 * (`explicitlyShared` false), bidding Target CPA, Maximize Conversions or Maximize Clicks. Channel controls and locations live on the
 * ad group, so the same request creates one ad group with only YouTube (in-stream, in-feed, Shorts) selected and Discover, Gmail,
 * Display and Maps off, and its location criteria. Google enforces a per-currency minimum daily budget (about 5 USD) and refuses
 * a lower one with BUDGET_BELOW_PER_DAY_MINIMUM; this module leaves that check to Google. The video ads themselves are built in the
 * platform (or a later ticket).
 */
import { AdsError, minorField, optionalString, stringList } from "../domain.js";
import { minorToMicros } from "../money.js";
import type { CreateCampaignRequest } from "./types.js";

export const GOOGLE_VIDEO_CHANNEL = "DEMAND_GEN";
/** Accepted as an objective and stored as DEMAND_GEN: the API cannot create a VIDEO campaign. */
export const GOOGLE_VIDEO_ALIASES = ["VIDEO", "YOUTUBE"] as const;
export const GOOGLE_VIDEO_BID_FOR = ["CONVERSIONS", "CLICKS"] as const;
export type GoogleVideoBidFor = (typeof GOOGLE_VIDEO_BID_FOR)[number];

export interface GoogleVideoSettings {
  /** Set: bid to this cost per conversion (minor units). Null: `bidFor` says what to get the most of. */
  targetCpaMinor: number | null;
  /** Without a target: most conversions (needs conversion tracking) or most clicks. */
  bidFor: GoogleVideoBidFor;
  /** Google geo target constant ids (2710 is South Africa). At least one. */
  locationIds: string[];
}

/** DEMAND_GEN, or a video alias mapped to it. Anything else comes back unchanged. */
export function videoObjective(objective: string): string {
  return (GOOGLE_VIDEO_ALIASES as readonly string[]).includes(objective) ? GOOGLE_VIDEO_CHANNEL : objective;
}

/** Checks the video fields of a create_campaign proposal. Throws an AdsError the agent can act on. */
export function videoSettingsFrom(input: Record<string, unknown>, dailyBudgetMinor: number): GoogleVideoSettings {
  const targetCpaMinor = minorField(input, "targetCpaMinor") ?? null;
  if (targetCpaMinor !== null && targetCpaMinor <= 0) throw new AdsError("targetCpaMinor must be more than zero (leave it out to bid for the most conversions or clicks)");
  if (targetCpaMinor !== null && targetCpaMinor > dailyBudgetMinor) throw new AdsError("targetCpaMinor is more than the daily budget, so the campaign could not buy one conversion a day. Google advises a daily budget of 15 times the target. Lower it or raise the budget.");
  const bid = (optionalString(input, "bidFor", 20) ?? "CONVERSIONS").toUpperCase();
  if (!(GOOGLE_VIDEO_BID_FOR as readonly string[]).includes(bid)) throw new AdsError(`bidFor must be one of ${GOOGLE_VIDEO_BID_FOR.join(", ")}`);
  if (targetCpaMinor !== null && bid !== "CONVERSIONS") throw new AdsError("targetCpaMinor bids for conversions; leave bidFor out or set it to CONVERSIONS");
  const locationIds = stringList(input.locationIds, 50, 30).map((id) => id.replace(/^geoTargetConstants\//, ""));
  if (locationIds.length === 0) throw new AdsError("locationIds is required: Google geo target ids for where the YouTube ads may show (2710 is South Africa). Without one Google shows them worldwide.");
  const bad = locationIds.find((id) => !/^\d{4,10}$/.test(id));
  if (bad) throw new AdsError(`locationIds must be Google geo target ids (digits, e.g. 2710); "${bad}" is not one`);
  return { targetCpaMinor, bidFor: bid as GoogleVideoBidFor, locationIds: [...new Set(locationIds)] };
}

/** A stored payload's video settings back as proposal input, so a revision keeps what it does not name. */
export function videoInput(video: unknown): Record<string, unknown> {
  if (!video || typeof video !== "object") return {};
  const v = video as GoogleVideoSettings;
  return { targetCpaMinor: v.targetCpaMinor, bidFor: v.bidFor, locationIds: v.locationIds };
}

/** Only YouTube: every flag is named, as Google asks when `selectedChannels` is used. */
const YOUTUBE_ONLY = { youtubeInStream: true, youtubeInFeed: true, youtubeShorts: true, discover: false, gmail: false, display: false, maps: false };

/** The `googleAds:mutate` operations: budget, PAUSED Demand Gen campaign, its YouTube-only ad group and locations, all or nothing. */
export function videoCampaignOperations(customer: string, req: CreateCampaignRequest, currency: string, nonce: number): Array<Record<string, unknown>> {
  const video = req.video;
  if (!video) throw new AdsError("A YouTube video campaign needs locationIds.");
  const budget = `customers/${customer}/campaignBudgets/-1`;
  const campaign = `customers/${customer}/campaigns/-2`;
  const adGroup = `customers/${customer}/adGroups/-3`;
  const bidding = video.targetCpaMinor
    ? { targetCpa: { targetCpaMicros: String(minorToMicros(video.targetCpaMinor, currency)) } }
    : video.bidFor === "CLICKS"
      ? { targetSpend: {} }
      : { maximizeConversions: {} };
  return [
    // Demand Gen refuses a shared budget, so it is always the campaign's own.
    { campaignBudgetOperation: { create: { resourceName: budget, name: `${req.name} budget ${nonce}`, deliveryMethod: "STANDARD", amountMicros: String(minorToMicros(req.dailyBudgetMinor, currency)), explicitlyShared: false } } },
    {
      campaignOperation: {
        create: {
          resourceName: campaign,
          name: req.name,
          // Always paused: making it live is a separate request with its own approval.
          status: "PAUSED",
          advertisingChannelType: GOOGLE_VIDEO_CHANNEL,
          campaignBudget: budget,
          ...bidding,
          containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
        },
      },
    },
    // The ad group is paused too: nothing serves until its video ads exist and a person switches it on.
    { adGroupOperation: { create: { resourceName: adGroup, name: `${req.name} YouTube`, campaign, status: "PAUSED", demandGenAdGroupSettings: { channelControls: { selectedChannels: YOUTUBE_ONLY } } } } },
    ...video.locationIds.map((id) => ({ adGroupCriterionOperation: { create: { adGroup, location: { geoTargetConstant: `geoTargetConstants/${id}` } } } })),
  ];
}
