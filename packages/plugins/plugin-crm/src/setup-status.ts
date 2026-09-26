/**
 * What the CRM still needs for a company, for the Setup plugin's checklist
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
import { listSequences, sequenceDelivery, table } from "./db.js";
import { PLUGIN_ID, PLUGIN_VERSION } from "./namespace.js";
import { crmCompanyIds } from "./sync.js";

const SETTINGS_FALLBACK = "/company/settings/instance/plugins";
const FULL_SHARE = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "crm-setup", stateKey: "last-full-share" });
const KNOWN = { scopeKind: "instance" as const, namespace: "crm-setup", stateKey: "known-companies" };

/** Settings page href: the plugin's own page once the installation uuid is known. */
export async function settingsHref(ctx: PluginContext): Promise<{ href: string; uuid: string | null }> {
  const base = await pluginUiBase(ctx);
  const uuid = base ? /^\/_plugins\/([0-9a-f-]{36})\/ui\/$/.exec(base)?.[1] ?? null : null;
  return { href: uuid ? `${SETTINGS_FALLBACK}/${uuid}` : SETTINGS_FALLBACK, uuid };
}

export function hasConfigValue(config: Record<string, unknown>, path: string): boolean {
  const value = valueAtPath(config, path);
  if (isSecretRef(value)) return Boolean(value.secretId);
  return typeof value === "string" && value.trim().length > 0;
}

export function jevKeySet(config: Record<string, unknown>): boolean {
  const jev = config.jev as { enabled?: unknown } | undefined;
  return jev?.enabled !== false && hasConfigValue(config, "jev.apiKey");
}

/** Called after a full share (resync action or nightly job). */
export async function recordFullShare(ctx: PluginContext, companyId: string): Promise<void> {
  try {
    await ctx.state.set(FULL_SHARE(companyId), new Date().toISOString());
  } catch (error) {
    ctx.logger.info("CRM share time not saved", { companyId, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Companies that opened the CRM page, so ones without rows still get a status. */
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
  const fromRows = await crmCompanyIds(ctx).catch(() => [] as string[]);
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
    title: "Save the CRM settings",
    agentNext: "Sequence steps open issues on time and your clients are shared with the other plugins.",
  });
  items.push({ ...settingsRow, href: settings });

  const jev = jevKeySet(config);
  items.push({
    key: "jev",
    title: "Add the Jev (TypeSafe) key",
    status: jev ? "done" : "optional",
    required: false,
    detail: jev
      ? "Lead scoring and reply classification use Jev."
      : "Optional. Used for lead scoring and reply classification. Without it the CRM uses its built-in rules.",
    href: settings,
    hrefLabel: "Open settings",
    steps: jev ? undefined : [
      "Create an API key at typesafe.ai → API keys.",
      "In the CRM settings, pick or create a Paperclip secret for Jev → TypeSafe API key.",
      "Click Save Configuration.",
    ],
    agentNext: "Scores new leads and sorts sequence replies (interested, not now, unsubscribe) on its own.",
  });

  const hasClients = await companyHasClients(ctx, companyId);
  items.push({
    key: "clients",
    title: "Add your first clients",
    status: hasClients ? "done" : "optional",
    required: false,
    detail: hasClients ? "Companies or contacts are in the CRM." : "Add a company or contact, or import contacts from a CSV.",
    href: "/crm",
    hrefLabel: "Open CRM",
    steps: hasClients ? undefined : ["Open the CRM.", "Click + Company or + Contact, or use Import on the Contacts tab."],
    agentNext: "Agents can work these clients: sequences, deals and follow-ups.",
  });

  let lastShare: string | null = null;
  try {
    const stored = await ctx.state.get(FULL_SHARE(companyId));
    lastShare = typeof stored === "string" ? stored : null;
  } catch {
    lastShare = null;
  }
  items.push({
    key: "shared",
    title: "Send clients to the other plugins",
    status: !hasClients ? "optional" : lastShare ? "done" : "missing",
    required: hasClients,
    detail: !hasClients
      ? "Nothing to send yet."
      : lastShare
        ? `Last sent in full ${lastShare.slice(0, 10)}. Changes are sent again every 15 minutes.`
        : "Billing, Social, SEO and Campaigns pick clients from the CRM. Send the list once now; after that it is sent nightly.",
    href: "/crm",
    hrefLabel: "Open CRM",
    blockedBy: saved ? undefined : ["settings"],
    action: hasClients && saved ? { plugin: PLUGIN_ID, key: "crm.resync", label: "Send clients to the other plugins" } : null,
    agentNext: "Other plugins show these clients in their client pickers.",
  });

  const emailSequences = await listSequences(ctx, companyId)
    .then((rows) => rows.filter((row) => sequenceDelivery(row) === "email").length)
    .catch(() => 0);
  const mailboxOn = await isModuleEnabled(ctx, companyId, PIB_PLUGINS.mailbox);
  const mailboxBlocked = emailSequences > 0 && !mailboxOn;
  items.push({
    key: "mailbox",
    title: "Connect the Mailbox for email sequences",
    status: mailboxBlocked ? "blocked" : "optional",
    required: false,
    detail: mailboxBlocked
      ? "Some sequences send email, but the Mailbox module is switched off. Turn it on in Setup and connect Gmail."
      : "Sequences set to send email go out through the Mailbox (Gmail). Connect Gmail there before switching a sequence to email.",
    href: "/mailbox",
    hrefLabel: "Open Mailbox",
    agentNext: "Agent-owned sequences send their emails without a person opening each step.",
  });

  return {
    plugin: PLUGIN_ID,
    module: moduleOfPlugin(PLUGIN_ID),
    title: "CRM",
    version: PLUGIN_VERSION,
    items,
    checkedAt: new Date().toISOString(),
  };
}

async function companyHasClients(ctx: PluginContext, companyId: string): Promise<boolean> {
  try {
    const companies = await ctx.db.query<{ id: string }>(`SELECT id FROM ${table(ctx, "companies")} WHERE company_id = $1 LIMIT 1`, [companyId]);
    if (companies.length > 0) return true;
    const contacts = await ctx.db.query<{ id: string }>(`SELECT id FROM ${table(ctx, "contacts")} WHERE company_id = $1 LIMIT 1`, [companyId]);
    return contacts.length > 0;
  } catch {
    return false;
  }
}

/** Hourly: push the status of every company the CRM knows with saved settings. */
export async function publishAllSetupStatus(ctx: PluginContext): Promise<number> {
  let published = 0;
  for (const companyId of await knownCompanies(ctx)) {
    try {
      const config = await readConfig(ctx, companyId);
      if (Object.keys(config).length === 0) continue;
      await publishSetupStatus(ctx, companyId, await setupStatus(ctx, companyId));
      published += 1;
    } catch (error) {
      ctx.logger.info("CRM setup status skipped", { companyId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return published;
}
