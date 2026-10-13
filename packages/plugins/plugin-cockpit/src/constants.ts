/**
 * Keys shared by the worker and the page (no node imports).
 */
import { COCKPIT_PLUGIN } from "@partnersinbiz/pib-plugin-kit/cockpit";

export const PLUGIN_KEY = COCKPIT_PLUGIN;
export const VERSION = "0.7.10";

export const JOBS = {
  reemitRoles: "reemit-roles",
  healthAlerts: "health-alerts",
  memoryUpkeep: "memory-upkeep",
  /** Daily: close-out reviews the events missed (a finished project, an epic that closed, a milestone of an evergreen project). */
  closeoutSweep: "closeout-sweep",
  /** Daily: re-measures improvements that are due, proposes the pinned tool facts that belong in a skill. */
  improvementsRecheck: "improvements-recheck",
  /** Daily: verifies the credentials it can reach (one cheap GET each) and settles the expiry alerts. */
  credentialsCheck: "credentials-check",
  /** Mondays, before the Weekly retro: one business review issue comparing the goals' actuals to their targets. */
  businessReview: "business-review",
  /** Nightly: one acceptance request for the Acceptance agent (the canary journeys), for companies that staffed one. */
  acceptanceNightly: "acceptance-nightly",
} as const;

export const ROUTINES = {
  daily: "cockpit-daily-operations",
  weekly: "cockpit-weekly-retro",
} as const;

export const ROUTINE_TITLES: Record<(typeof ROUTINES)[keyof typeof ROUTINES], string> = {
  [ROUTINES.daily]: "Daily operations review",
  [ROUTINES.weekly]: "Weekly retro",
};

export const ROLE_KEYS = { operator: "operator", reviewer: "reviewer" } as const;
export type RoleKind = keyof typeof ROLE_KEYS;

export const SKILL_KEYS = { operator: "operator", reviewer: "reviewer", companyOs: "company-os", acceptance: "acceptance" } as const;
export const SKILL_SLUGS = { operator: "pib-operator", reviewer: "pib-reviewer", companyOs: "pib-company-os", acceptance: "pib-acceptance" } as const;

/** The upstream Paperclip operating skill (issues, comments, statuses, hand-offs); core skills are only added to CEO hires by default. */
export const PAPERCLIP_SKILL = { key: "paperclipai/paperclip/paperclip", slug: "paperclip" } as const;

/** Canonical key the host gives a plugin-managed skill: `plugin/<slug(pluginKey)>/<skillKey>`. */
export function canonicalSkillKey(pluginKey: string, skillKey: string): string {
  const slug = pluginKey.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "plugin";
  return `plugin/${slug}/${skillKey}`;
}

export const ORIGIN = {
  health: `plugin:${COCKPIT_PLUGIN}:health`,
  brief: `plugin:${COCKPIT_PLUGIN}:brief`,
  onboarding: `plugin:${COCKPIT_PLUGIN}:onboarding`,
  closeout: `plugin:${COCKPIT_PLUGIN}:closeout`,
  businessReview: `plugin:${COCKPIT_PLUGIN}:business-review`,
  ask: `plugin:${COCKPIT_PLUGIN}:ask`,
  setup: `plugin:${COCKPIT_PLUGIN}:setup`,
  /** Acceptance requests (the run's trigger issue) and the failures a run opens for the owning role. */
  acceptance: `plugin:${COCKPIT_PLUGIN}:acceptance`,
} as const;

/**
 * Origin id prefixes of the issues the Cockpit opens for agents, one per kind
 * (`cockpit:onboarding:company:<id>`, `cockpit:health:<companyId>`). The
 * done-checks match on them.
 */
export const ORIGIN_ID = {
  onboarding: "cockpit:onboarding:",
  health: "cockpit:health:",
  /** `cockpit:closeout:<project or root issue id>:<period>` */
  closeout: "cockpit:closeout:",
  /** `cockpit:business-review:<companyId>:<week>` */
  businessReview: "cockpit:business-review:",
  /** `cockpit:ask:<kind>:<companyId>`: a question the Cockpit itself puts to the owner (a grant, a goal). */
  ask: "cockpit:ask:",
  /** `cockpit:acceptance:<request key>` (a request) and `cockpit:acceptance:fail:<run id>:<step id>` (a failed step). */
  acceptance: "cockpit:acceptance:",
} as const;

/** The same kinds before 0.4.0 (no plugin part), still checked for issues opened then. */
export const LEGACY_ORIGIN_ID = {
  onboarding: "onboarding:",
  health: "health:",
} as const;

/** The Cockpit page tabs (`?tab=`). */
export const COCKPIT_TABS = { overview: "overview", flows: "flows", profile: "profile", memory: "memory" } as const;
export const PROFILE_PATH = "/cockpit?tab=profile";

/** Budget use at or above this share of the monthly budget raises an alert. */
export const BUDGET_ALERT_RATIO = 0.8;
/** A plugin that is on but has not reported for this long is "not reporting". */
export const STALE_AFTER_MS = 3 * 60 * 60 * 1000;
/** A database backup older than this is flagged. */
export const BACKUP_STALE_HOURS = 3;

export const LOCAL_BOARD_USER_ID = "local-board";

/** A real board user id (not the local trusted placeholder), or null. */
export function assignableUser(userId: string | null | undefined): string | null {
  return userId && userId !== LOCAL_BOARD_USER_ID ? userId : null;
}
