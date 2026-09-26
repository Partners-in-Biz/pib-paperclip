import { PLUGIN_ID } from "./namespace.js";

export const AGENT_KEY = "seo-specialist";
export const PROJECT_KEY = "seo";
export const DAILY_ROUTINE_KEY = "seo-run-today";
export const WEEKLY_ROUTINE_KEY = "seo-weekly-review";
export const ROUTINE_KEYS = [DAILY_ROUTINE_KEY, WEEKLY_ROUTINE_KEY] as const;
export const ROUTINE_TITLES: Record<(typeof ROUTINE_KEYS)[number], string> = {
  [DAILY_ROUTINE_KEY]: "Run today's SEO",
  [WEEKLY_ROUTINE_KEY]: "Weekly SEO review",
};
export const AGENT_DISPLAY_NAME = "SEO Specialist";
export const AGENT_CAPABILITIES =
  "Runs Partners in Biz 90-day SEO sprints with the SEO plugin tools: site checks, keyword and content work, Search Console data, evidence and hand-offs.";
export const SKILL_KEY = "seo-sprint";
export const SKILL_SLUG = "pib-seo-sprint";
export const DAILY_JOB_KEY = "seo-daily";
export const WEEKLY_JOB_KEY = "seo-weekly";

/** Canonical key the host gives a plugin-managed skill: `plugin/<slug(pluginKey)>/<skillKey>`. */
export function canonicalSkillKey(pluginId: string, skillKey: string): string {
  const slug = pluginId.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "plugin";
  return `plugin/${slug}/${skillKey}`;
}

export const SKILL_CANONICAL_KEY = canonicalSkillKey(PLUGIN_ID, SKILL_KEY);

export const ORIGIN = {
  sprint: `plugin:${PLUGIN_ID}:sprint`,
  task: `plugin:${PLUGIN_ID}:task`,
  approval: `plugin:${PLUGIN_ID}:approval`,
  alert: `plugin:${PLUGIN_ID}:alert`,
  needsYou: `plugin:${PLUGIN_ID}:needs-you`,
} as const;

export function isOurOrigin(originKind: unknown): boolean {
  return typeof originKind === "string" && (originKind === `plugin:${PLUGIN_ID}` || originKind.startsWith(`plugin:${PLUGIN_ID}:`));
}
