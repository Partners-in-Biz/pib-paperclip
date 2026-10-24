import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  definePreferences,
  describePreferences,
  readPreferences,
  savePreferences,
  type PreferencesActionContext,
  type PreferenceValue,
  type PreferenceValues,
} from "@partnersinbiz/pib-plugin-kit";

/** The instance's own company (PAR) keeps the old defaults; every other company reads neutral ones. */
const OWN_COMPANY_PREFIX = "PAR";

/** What a company owner or admin edits on the Mailbox page. Keys, URLs, secrets and the email provider stay in the host form. */
export const mailboxPreferences = definePreferences({
  id: "mailbox",
  fields: {
    fromName: {
      type: "string",
      label: "Sender name",
      help: "Optional name shown next to the Gmail address on mail the plugins send. Empty: just the address.",
      default: "",
      legacy: "fromName",
      max: 120,
    },
    labelPrefix: {
      type: "string",
      label: "Gmail label prefix",
      help: "Triage labels are added as <prefix>/<Category>. Empty: the company's short name.",
      default: ({ shortName }) => shortName,
      legacy: "labelPrefix",
      max: 40,
    },
    replyIssues: {
      type: "bool",
      label: "Open reply issues",
      help: "Mail from a client, a known lead or support that needs a reply opens one issue per thread for the agent who answers it.",
      default: true,
      legacy: "replyIssues",
    },
    triageIssueAssignee: {
      type: "string",
      label: "Assign reply issues to",
      help: "An agent id, or user:<id> for a person. Empty: the Account Manager, else the Operator, else the owner.",
      default: "",
      legacy: "triageIssueAssignee",
      max: 120,
    },
    autoDelegate: {
      type: "enum",
      label: "Mailbox access given without asking",
      help: "Who gets read and draft access (never sending) on the company's own Gmail mailboxes. operator: only the Operator. operator+roles: also the Account Manager and the Bookkeeper. off: nobody.",
      options: ["operator", "operator+roles", "off"],
      default: "operator",
      legacy: "autoDelegate",
    },
  },
  ownCompanyPins: { labelPrefix: "PiB" },
  isOwnCompany: async (ctx, companyId) => (await ctx.companies.get(companyId))?.issuePrefix === OWN_COMPANY_PREFIX,
});

/** The five settings for a company: saved preferences, else the old host form value, else the neutral default. Null when they cannot be read. */
export async function mailboxPrefs(ctx: PluginContext, companyId: string): Promise<PreferenceValues | null> {
  try {
    return await readPreferences(ctx, companyId, mailboxPreferences);
  } catch {
    return null;
  }
}

export async function preferencesLoad(ctx: PluginContext, companyId: string) {
  return { fields: describePreferences(mailboxPreferences), values: await readPreferences(ctx, companyId, mailboxPreferences) };
}

export const preferencesSave = (ctx: PluginContext, context: PreferencesActionContext, patch: Record<string, PreferenceValue | null>) =>
  savePreferences(ctx, context, mailboxPreferences, patch);
