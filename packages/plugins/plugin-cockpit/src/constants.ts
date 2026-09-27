/**
 * Keys shared by the worker and the page (no node imports).
 */
import { COCKPIT_PLUGIN } from "@partnersinbiz/pib-plugin-kit/cockpit";

export const PLUGIN_KEY = COCKPIT_PLUGIN;
export const VERSION = "0.3.0";

export const JOBS = {
  reemitRoles: "reemit-roles",
  healthAlerts: "health-alerts",
  memoryUpkeep: "memory-upkeep",
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

export const SKILL_KEYS = { operator: "operator", reviewer: "reviewer", companyOs: "company-os" } as const;
export const SKILL_SLUGS = { operator: "pib-operator", reviewer: "pib-reviewer", companyOs: "pib-company-os" } as const;

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
} as const;

/** The Cockpit page tabs (`?tab=`). */
export const COCKPIT_TABS = { overview: "overview", profile: "profile", memory: "memory" } as const;
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
