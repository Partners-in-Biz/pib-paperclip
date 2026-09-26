/**
 * What Campaigns still needs for a company, for the Setup plugin's checklist
 * (`GET /setup-status` and the hourly `setup.status` event).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  isModuleEnabled,
  isSecretRef,
  moduleOfPlugin,
  PIB_PLUGINS,
  pluginUiBase,
  publishSetupStatus,
  readConfig,
  settingsItem,
  valueAtPath,
  type SetupItem,
  type SetupStatus,
} from "@partnersinbiz/pib-plugin-kit";
import { PLUGIN_ID, PLUGIN_VERSION } from "./namespace.js";

const SETTINGS_FALLBACK = "/company/settings/instance/plugins";
const KNOWN = { scopeKind: "instance" as const, namespace: "campaigns-setup", stateKey: "known-companies" };

/** Settings page href: the plugin's own page once the installation uuid is known. */
export async function settingsHref(ctx: PluginContext): Promise<{ href: string; uuid: string | null }> {
  const base = await pluginUiBase(ctx);
  const uuid = base ? /^\/_plugins\/([0-9a-f-]{36})\/ui\/$/.exec(base)?.[1] ?? null : null;
  return { href: uuid ? `${SETTINGS_FALLBACK}/${uuid}` : SETTINGS_FALLBACK, uuid };
}

export function jevKeySet(config: Record<string, unknown>): boolean {
  const jev = config.jev as { enabled?: unknown } | undefined;
  if (jev?.enabled === false) return false;
  const value = valueAtPath(config, "jev.apiKey");
  if (isSecretRef(value)) return Boolean(value.secretId);
  return typeof value === "string" && value.trim().length > 0;
}

function table(ctx: PluginContext, name: string): string {
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace) || !/^[a-z_]+$/.test(name)) throw new Error("Unsafe identifier");
  return `${ctx.db.namespace}.${name}`;
}

/** Companies that opened the Campaigns page, so ones without campaigns still get a status. */
export async function rememberCompany(ctx: PluginContext, companyId: string): Promise<void> {
  try {
    const known = asList(await ctx.state.get(KNOWN));
    if (known.includes(companyId)) return;
    await ctx.state.set(KNOWN, [...known, companyId]);
  } catch {
    // best effort
  }
}

export async function knownCompanies(ctx: PluginContext): Promise<string[]> {
  let fromRows: string[] = [];
  try {
    const rows = await ctx.db.query<{ company_id: string }>(`SELECT DISTINCT company_id FROM ${table(ctx, "campaigns")}`);
    fromRows = rows.map((row) => row.company_id);
  } catch {
    fromRows = [];
  }
  let fromState: string[] = [];
  try {
    fromState = asList(await ctx.state.get(KNOWN));
  } catch {
    fromState = [];
  }
  return [...new Set([...fromRows, ...fromState])];
}

function asList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

export async function setupStatus(ctx: PluginContext, companyId: string): Promise<SetupStatus> {
  let config: Record<string, unknown> = {};
  try {
    config = await readConfig(ctx, companyId);
  } catch {
    config = {};
  }
  const saved = Object.keys(config).length > 0;
  const { href: settings, uuid } = await settingsHref(ctx);
  const items: SetupItem[] = [];

  const settingsRow = settingsItem({
    saved,
    pluginId: uuid ?? "",
    title: "Save the Campaigns settings",
    agentNext: "Due campaign steps open issues or send email on time.",
  });
  items.push({ ...settingsRow, href: settings });

  const jev = jevKeySet(config);
  items.push({
    key: "jev",
    title: "Add the Jev (TypeSafe) key",
    status: jev ? "done" : "optional",
    required: false,
    detail: jev
      ? "Campaign replies are sorted with Jev."
      : "Optional. Used to sort campaign replies (interested, not now, unsubscribe). Without it Campaigns uses its built-in rules.",
    href: settings,
    hrefLabel: "Open settings",
    steps: jev ? undefined : [
      "Create an API key at typesafe.ai → API keys.",
      "In the Campaigns settings, pick or create a Paperclip secret for Jev → TypeSafe API key.",
      "Click Save Configuration.",
    ],
    agentNext: "Stops a contact's campaign when they reply, and hands interested replies to a person.",
  });

  let emailCampaigns = 0;
  try {
    const rows = await ctx.db.query<{ id: string }>(
      `SELECT id FROM ${table(ctx, "campaigns")} WHERE company_id = $1 AND delivery = 'email' AND status = 'active'`,
      [companyId],
    );
    emailCampaigns = rows.length;
  } catch {
    emailCampaigns = 0;
  }
  const mailboxOn = await isModuleEnabled(ctx, companyId, PIB_PLUGINS.mailbox);
  const blocked = emailCampaigns > 0 && !mailboxOn;
  items.push({
    key: "mailbox",
    title: "Connect the Mailbox for email delivery",
    status: blocked ? "blocked" : "optional",
    required: false,
    detail: blocked
      ? "Active campaigns send email, but the Mailbox module is switched off. Turn it on in Setup and connect Gmail."
      : "Campaigns set to email delivery send through the Mailbox (Gmail). Connect Gmail there first. Campaigns set to issues need nothing more.",
    href: "/mailbox",
    hrefLabel: "Open Mailbox",
    agentNext: "Email campaigns send each due step without a person opening an issue.",
  });

  return {
    plugin: PLUGIN_ID,
    module: moduleOfPlugin(PLUGIN_ID),
    title: "Campaigns",
    version: PLUGIN_VERSION,
    items,
    checkedAt: new Date().toISOString(),
  };
}

/** Hourly: push the status of every company Campaigns knows with saved settings. */
export async function publishAllSetupStatus(ctx: PluginContext): Promise<number> {
  let published = 0;
  for (const companyId of await knownCompanies(ctx)) {
    try {
      const config = await readConfig(ctx, companyId);
      if (Object.keys(config).length === 0) continue;
      await publishSetupStatus(ctx, companyId, await setupStatus(ctx, companyId));
      published += 1;
    } catch (error) {
      ctx.logger.info("Campaigns setup status skipped", { companyId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return published;
}
