/**
 * Social company preferences: the choices a company owner or admin edits on the
 * Social page without an instance admin. Keys, URLs and platform apps stay in
 * the host settings form.
 *
 * Precedence (kit): the company's saved preference, else the value saved in the
 * old host form, else the neutral default. The instance's own company
 * (`ownerCompany` in the host form) keeps the old PiB wording through a pin.
 */
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import {
  definePreferences,
  describePreferences,
  readPreferences,
  savePreferences,
  type PreferenceValues,
} from "@partnersinbiz/pib-plugin-kit";

export const DEFAULT_TIMEZONE = "Africa/Johannesburg";

/** Fallback when a company has no name the host can give us. */
const NO_NAME = "Your company";

export const SOCIAL_PREFERENCES = definePreferences({
  id: "social",
  fields: {
    timezone: {
      type: "string",
      label: "Time zone",
      help: `Used for the calendar and the weekly review, as a name like ${DEFAULT_TIMEZONE} or UTC.`,
      default: DEFAULT_TIMEZONE,
      legacy: "timezone",
      max: 64,
    },
    allowAgentReplies: {
      type: "bool",
      label: "Agents may send inbox replies",
      help: "Off: an agent's reply is saved as a suggestion that a person sends. On: agent replies publish immediately.",
      default: false,
      legacy: "allowAgentReplies",
    },
    ownSocialName: {
      type: "string",
      label: "Name for your own social",
      help: "How your own (no client) work is named in Growth Lab titles, for example \"Acme\" gives \"Acme social\".",
      default: ({ companyName }) => companyName || NO_NAME,
      max: 80,
    },
  },
  ownCompanyPins: { ownSocialName: "PiB" },
  isOwnCompany: (_ctx, _companyId, raw) => raw.ownerCompany === true,
});

/** True when `Intl` accepts the name; a bad one would make every date format throw. */
export function validTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function companyOf(context: PluginPerformActionContext): string {
  const companyId = context.companyId ?? context.actor?.companyId;
  if (!companyId) throw new Error("Company is required");
  return companyId;
}

export async function loadPreferencesAction(ctx: PluginContext, context: PluginPerformActionContext) {
  const values = await readPreferences(ctx, companyOf(context), SOCIAL_PREFERENCES);
  return { fields: describePreferences(SOCIAL_PREFERENCES), values };
}

export async function savePreferencesAction(ctx: PluginContext, context: PluginPerformActionContext, params: Record<string, unknown>) {
  const patch = params.patch && typeof params.patch === "object" && !Array.isArray(params.patch) ? (params.patch as Record<string, never>) : null;
  if (!patch) return { ok: false as const, error: "Nothing to save" };
  if ("timezone" in patch && !validTimezone(patch.timezone)) return { ok: false as const, error: "Time zone is not a known name" };
  return savePreferences(ctx, { companyId: companyOf(context), actor: context.actor }, SOCIAL_PREFERENCES, patch as PreferenceValues);
}

/** The own-work name for Growth Lab titles; never throws (a read failure gives the neutral name). */
export async function ownSocialName(ctx: PluginContext, companyId: string): Promise<string> {
  try {
    const values = await readPreferences(ctx, companyId, SOCIAL_PREFERENCES);
    return typeof values.ownSocialName === "string" && values.ownSocialName.trim() ? values.ownSocialName.trim() : NO_NAME;
  } catch {
    return NO_NAME;
  }
}
