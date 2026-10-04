/**
 * Constants shared by the worker, the manifest and the UI bundle.
 * Keep this file free of Node imports: the UI bundle imports it.
 */

export const PLUGIN_ID = "partnersinbiz.ads";
export const PLUGIN_VERSION = "0.1.0";
/** Managed project that holds PiB's own ads work (a client's work goes in the client's own project). */
export const ADS_PROJECT_KEY = "ads";
export const ADS_ROLE_KEY = "ads-manager";
/** Same-origin route the static OAuth bridge page posts to. */
export const COMPLETE_ROUTE_PATH = `/api/plugins/${PLUGIN_ID}/api/oauth/complete`;

export type AdPlatform = "meta" | "google";
export const AD_PLATFORMS: AdPlatform[] = ["meta", "google"];
/** What a connection or account row stores: the two real platforms, and the rehearsal platform (`mock`, off by default). */
export type StoredPlatform = AdPlatform | "mock";

export const PLATFORM_LABELS: Record<AdPlatform, string> = {
  meta: "Meta (Facebook and Instagram)",
  google: "Google Ads",
};

export function isAdPlatform(value: unknown): value is AdPlatform {
  return value === "meta" || value === "google";
}

export function isStoredPlatform(value: unknown): value is StoredPlatform {
  return isAdPlatform(value) || value === "mock";
}

export function platformLabel(platform: StoredPlatform): string {
  return platform === "mock" ? "Test platform" : PLATFORM_LABELS[platform];
}

/** What a person can ask to change. `creative_check` changes nothing: it only clears ad copy. */
export const PROPOSAL_KINDS = ["create_campaign", "change_budget", "pause_campaign", "resume_campaign", "creative_check"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const PROPOSAL_KIND_LABELS: Record<ProposalKind, string> = {
  create_campaign: "New campaign",
  change_budget: "Budget change",
  pause_campaign: "Pause",
  resume_campaign: "Resume",
  creative_check: "Ad copy check",
};

/** Kinds that put money at risk (they can raise spend), so a budget cap check and an approval apply. */
export const SPEND_KINDS: ProposalKind[] = ["create_campaign", "change_budget", "resume_campaign"];

export const PROPOSAL_STATUSES = [
  "needs_changes",
  "in_review",
  "approved",
  "executing",
  "executed",
  "cleared",
  "failed",
  "rejected",
  "cancelled",
  "expired",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** Statuses where the proposal can still move forward (a person or the Reviewer may act). */
export const OPEN_PROPOSAL_STATUSES: ProposalStatus[] = ["needs_changes", "in_review", "approved"];

export const STATUS_LABELS: Record<ProposalStatus, string> = {
  needs_changes: "Needs changes",
  in_review: "Waiting for approval",
  approved: "Approved",
  executing: "Running",
  executed: "Done",
  cleared: "Copy cleared",
  failed: "Failed",
  rejected: "Refused",
  cancelled: "Cancelled",
  expired: "Expired",
};

export const ALERT_KINDS = ["spend_spike", "zero_delivery", "cpa_over_target", "budget_90", "budget_100", "on_track_to_exceed", "sync_failed", "needs_reconnect"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_LABELS: Record<AlertKind, string> = {
  spend_spike: "Spend spike",
  zero_delivery: "No delivery",
  cpa_over_target: "Cost per result over target",
  budget_90: "Budget nearly used",
  budget_100: "Budget used up",
  on_track_to_exceed: "On track to exceed the budget",
  sync_failed: "Numbers not updating",
  needs_reconnect: "Connection needs signing in again",
};

/** Origin id prefixes of the issues this plugin opens (stable: the done-checks match on them). */
export const ADS_ORIGINS = {
  /** A person decides (the Reviewer checks first): `ads-approval:<proposalId>`. Contains "approv" so the kit treats it as an approval only a person may close. */
  approval: "ads-approval:",
  /** The Account Manager asks the client to sign off (CRM client action): `ads-client-ask:<proposalId>`. */
  clientAsk: "ads-client-ask:",
  /** Run an approved change (the ads agent calls `execute-ad-change`): `ads-run:<proposalId>`. */
  run: "ads-run:",
  /** An anomaly for the ads agent: `ads-alert:<alertId>`. */
  alert: "ads-alert:",
  /** A connection that needs a person to sign in again: `ads-reconnect:<connectionId>`. */
  reconnect: "ads-reconnect:",
} as const;

export type ScopeKey = string;
export const OWN_SCOPE: ScopeKey = "own";
