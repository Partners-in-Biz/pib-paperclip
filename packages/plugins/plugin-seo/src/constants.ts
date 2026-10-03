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
export const PREVIEW_JOB_KEY = "seo-previews";
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
  build: `plugin:${PLUGIN_ID}:build`,
  previewReview: `plugin:${PLUGIN_ID}:preview-review`,
} as const;

export const BUILD_ORIGIN_PREFIX = "seo:build:";

export function buildOriginId(taskId: string): string {
  return `${BUILD_ORIGIN_PREFIX}${taskId}`;
}

/** The task id in a build issue's origin id, or null. */
export function taskIdFromBuildOrigin(originId: string | null | undefined): string | null {
  if (!originId?.startsWith(BUILD_ORIGIN_PREFIX)) return null;
  return originId.slice(BUILD_ORIGIN_PREFIX.length) || null;
}

/**
 * Origin id of a sprint task's issue: `seo:task:<taskId>` (the done-check
 * matches on it). Issues opened before 0.9.0 carry the bare task id; the
 * daily heal moves open ones to this form.
 */
export const TASK_ORIGIN_PREFIX = "seo:task:";

export function taskOriginId(taskId: string): string {
  return `${TASK_ORIGIN_PREFIX}${taskId}`;
}

/** The task id in a task issue's origin id, or null. */
export function taskIdFromOrigin(originId: string | null | undefined): string | null {
  if (!originId?.startsWith(TASK_ORIGIN_PREFIX)) return null;
  return originId.slice(TASK_ORIGIN_PREFIX.length) || null;
}

export function isOurOrigin(originKind: unknown): boolean {
  return typeof originKind === "string" && (originKind === `plugin:${PLUGIN_ID}` || originKind.startsWith(`plugin:${PLUGIN_ID}:`));
}
