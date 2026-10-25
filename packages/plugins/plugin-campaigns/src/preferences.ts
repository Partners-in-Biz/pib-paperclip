import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  definePreferences,
  describePreferences,
  readPreferences,
  savePreferences,
  type PreferencesActionContext,
  type PreferenceValue,
} from "@partnersinbiz/pib-plugin-kit";

/** The instance's own company (PAR) keeps the old defaults; every other company reads neutral ones. */
const OWN_COMPANY_PREFIX = "PAR";

/** What a company owner or admin edits on the Campaigns page. Everything else stays in the host form. */
export const campaignsPreferences = definePreferences({
  id: "campaigns",
  fields: {
    timezone: {
      type: "string",
      label: "Timezone",
      help: "Also the clock the SMS and WhatsApp send windows use, e.g. Africa/Johannesburg.",
      default: "Africa/Johannesburg",
      legacy: "timezone",
      max: 64,
    },
    defaultFromName: {
      type: "string",
      label: "Default sender name",
      help: "Shown as the sender when a campaign and its sender identity have no name of their own.",
      default: ({ companyName }) => companyName,
      legacy: "defaultFromName",
      max: 120,
    },
  },
  ownCompanyPins: { defaultFromName: "Partners in Biz" },
  isOwnCompany: async (ctx, companyId) => (await ctx.companies.get(companyId))?.issuePrefix === OWN_COMPANY_PREFIX,
});

export const readCampaignPreferences = (ctx: PluginContext, companyId: string) => readPreferences(ctx, companyId, campaignsPreferences);

export async function preferencesLoad(ctx: PluginContext, companyId: string) {
  return { fields: describePreferences(campaignsPreferences), values: await readCampaignPreferences(ctx, companyId) };
}

export const preferencesSave = (ctx: PluginContext, context: PreferencesActionContext, patch: Record<string, PreferenceValue | null>) =>
  savePreferences(ctx, context, campaignsPreferences, patch);
