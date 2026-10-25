/**
 * Company preferences for SEO: the three choices a company owner changes without an instance admin.
 * Platform config (URL, keys, Google, Jev) stays in the host settings form. Row, else the saved
 * host-form value, else the default, so a company that never opens the panel behaves as before.
 */
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import {
  definePreferences,
  describePreferences,
  readPreferences,
  savePreferences,
  type PreferenceValue,
  type PreferenceValues,
} from "@partnersinbiz/pib-plugin-kit";
import { DEFAULT_TIMEZONE, validTimezone } from "./engine/time.js";
import { AUTOPILOT_MODES } from "./engine/sprint.js";

export const DEFAULT_DAILY_HOUR = 6;
export const DEFAULT_AUTOPILOT_MODE = "safe";

export const SEO_PREFERENCES = definePreferences({
  id: "seo",
  fields: {
    timezone: {
      type: "string",
      label: "Timezone",
      help: "Sprint days, the daily run and audit days use this timezone, e.g. Africa/Johannesburg.",
      default: DEFAULT_TIMEZONE,
      max: 64,
      legacy: (raw) => (validTimezone(raw.timezone) ? String(raw.timezone) : undefined),
    },
    dailyHourLocal: {
      type: "int",
      label: "Daily run hour",
      help: "Local hour (0 to 23) after which the daily SEO run creates tasks and pulls data.",
      default: DEFAULT_DAILY_HOUR,
      min: 0,
      max: 23,
      legacy: (raw) => {
        const hour = raw.dailyHourLocal === "" || raw.dailyHourLocal == null ? NaN : Number(raw.dailyHourLocal);
        return Number.isInteger(hour) ? hour : undefined;
      },
    },
    defaultAutopilotMode: {
      type: "enum",
      label: "Default autopilot for new sprints",
      help: "off: every task goes to the sprint owner. safe: the SEO agent works its tasks, and anything that publishes, sends or changes the live site needs sign-off. full: the agent finishes its tasks without sign-off.",
      options: AUTOPILOT_MODES,
      default: DEFAULT_AUTOPILOT_MODE,
      legacy: "defaultAutopilotMode",
    },
  },
});

export async function loadPreferencesView(ctx: PluginContext, companyId: string) {
  return { fields: describePreferences(SEO_PREFERENCES), values: await readPreferences(ctx, companyId, SEO_PREFERENCES) };
}

/** The kit checks the role (owner or admin) and fails closed; this adds the timezone check the kit cannot know. */
export async function savePreferencesFor(ctx: PluginContext, context: PluginPerformActionContext, patch: unknown) {
  const changes = patch && typeof patch === "object" && !Array.isArray(patch) ? (patch as Record<string, PreferenceValue | null>) : {};
  if (typeof changes.timezone === "string" && !validTimezone(changes.timezone)) return { ok: false as const, error: `Timezone is not a known timezone: ${changes.timezone}` };
  return savePreferences(ctx, { companyId: context.companyId, actor: context.actor }, SEO_PREFERENCES, changes);
}

export type SeoPreferenceValues = {
  timezone: string;
  dailyHourLocal: number;
  defaultAutopilotMode: (typeof AUTOPILOT_MODES)[number];
};

/** Effective values for jobs and services. A row value that is no longer valid falls back to `fallback`. */
export async function readSeoPreferences(ctx: PluginContext, companyId: string, fallback: SeoPreferenceValues): Promise<SeoPreferenceValues> {
  const values: PreferenceValues = await readPreferences(ctx, companyId, SEO_PREFERENCES);
  const mode = values.defaultAutopilotMode;
  return {
    timezone: validTimezone(values.timezone) ? String(values.timezone) : fallback.timezone,
    dailyHourLocal: Number.isInteger(values.dailyHourLocal) ? Number(values.dailyHourLocal) : fallback.dailyHourLocal,
    defaultAutopilotMode: AUTOPILOT_MODES.includes(mode as never) ? (mode as SeoPreferenceValues["defaultAutopilotMode"]) : fallback.defaultAutopilotMode,
  };
}

/** The company's own name for sign-offs and playbook titles. Never a hard-coded name. */
export async function companyDisplayName(ctx: PluginContext, companyId: string): Promise<string> {
  try {
    const name = (await ctx.companies.get(companyId))?.name?.trim();
    if (name) return name;
  } catch {
    // companies.read refused or failed: use the neutral wording below.
  }
  return "Your SEO team";
}
