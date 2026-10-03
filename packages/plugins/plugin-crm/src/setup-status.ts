/**
 * What the CRM still needs for a company, for the Setup plugin's checklist
 * (`GET /setup-status` and the hourly `setup.status` event).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  hireStatus,
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
import { teamSetupPath } from "@partnersinbiz/pib-plugin-kit/team";
import { ACCOUNT_MANAGER_ROLE, AM_NAME } from "./agent.js";
import { careSetupItems } from "./care-setup.js";
import { listSequences, sequenceDelivery, table } from "./db.js";
import { installSteps } from "./lead-embed.js";
import { activeLeadSources, NO_URLS_NOTE, turnstileReady, urlsFor, leadsConfig } from "./lead-capture.js";
import { PLUGIN_ID, PLUGIN_VERSION } from "./namespace.js";
import { crmLink, refOf } from "./refs.js";
import { heldLeadStats } from "./store.js";
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "27 Sep 2026" in South African time, as every PiB page shows a date. */
export function dayLabel(iso: string, timeZone = "Africa/Johannesburg"): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  let parts: { day: number; month: number; year: number };
  try {
    const pick = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { day: "numeric", month: "numeric", year: "numeric", timeZone }).formatToParts(date).map((part) => [part.type, part.value]),
    );
    parts = { day: Number(pick.day), month: Number(pick.month) - 1, year: Number(pick.year) };
  } catch {
    parts = { day: date.getUTCDate(), month: date.getUTCMonth(), year: date.getUTCFullYear() };
  }
  return `${parts.day} ${MONTHS[parts.month] ?? ""} ${parts.year}`;
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

  const held = await heldLeadStats(ctx, companyId).catch(() => ({ count: 0, oldest: null }));
  const settingsRow = settingsItem({
    saved,
    pluginId: uuid ?? "",
    title: "Save the CRM settings",
    agentNext: "Sequence steps open issues on time, held leads are added, and your clients are shared with the other plugins.",
    ...(held.count > 0 && !saved ? { detail: `${held.count} ${held.count === 1 ? "lead is" : "leads are"} waiting until the settings are saved. Until then the scheduled jobs cannot act for this company.` } : {}),
  });
  items.push({ ...settingsRow, href: settings });

  items.push(await agentItem(ctx, companyId));

  const jev = jevKeySet(config);
  items.push({
    key: "jev",
    title: "Smart sorting key (optional)",
    status: jev ? "done" : "optional",
    required: false,
    detail: jev
      ? "Lead scoring and reply sorting use smart sorting (Jev by TypeSafe)."
      : "Optional. Used for lead scoring and reply classification. Without it the CRM uses its built-in rules.",
    href: settings,
    hrefLabel: "Open settings",
    steps: jev ? undefined : [
      "Create an API key at typesafe.ai → API keys.",
      "In the CRM settings, under **Smart sorting (Jev by TypeSafe)**, pick or create a Paperclip secret for the TypeSafe API key.",
      "Click Save Configuration.",
    ],
    agentNext: "Scores new leads and sorts sequence replies (interested, not now, unsubscribe) on its own.",
  });

  items.push(...(await leadFormItems(ctx, companyId, settings)));

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
        ? `Last sent in full ${dayLabel(lastShare)}. Changes are sent again every 15 minutes.`
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

  // Client care: the monthly report, website monitoring and the data-processing register.
  items.push(...(await careSetupItems(ctx, companyId, { amLinked: items.find((item) => item.key === "agent")?.status === "done", mailboxOn }).catch(() => [])));

  return {
    plugin: PLUGIN_ID,
    module: moduleOfPlugin(PLUGIN_ID),
    title: "CRM",
    version: PLUGIN_VERSION,
    items,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * One item per active lead form ("Install the lead form on <site>", with the exact snippet in its steps),
 * and the optional spam-protection item. Nothing for a company with no lead forms.
 */
export async function leadFormItems(ctx: PluginContext, companyId: string, settingsHref: string): Promise<SetupItem[]> {
  const sources = await activeLeadSources(ctx, companyId).catch(() => []);
  if (sources.length === 0) return [];
  const urls = await urlsFor(ctx, companyId).catch(() => null);
  const items: SetupItem[] = [];
  for (const source of sources) {
    const site = source.siteUrl ? source.siteUrl.replace(/^https?:\/\//, "") : null;
    const clientRef = source.clientKind && source.clientRef ? refOf(source.clientKind, source.clientRef) : null;
    const taking = source.acceptedCount > 0;
    items.push({
      key: `lead-form:${source.id}`,
      title: site ? `Install the lead form on ${site}` : `Install the lead form: ${source.label}`,
      status: taking ? "done" : "missing",
      required: false,
      detail: taking
        ? `Taking leads: ${source.acceptedCount} so far${source.lastSubmissionAt ? `, the last on ${dayLabel(source.lastSubmissionAt)}` : ""}.`
        : `Waiting for the first lead: the snippet is not on the page yet, or nobody has sent a test enquiry.${clientRef ? " A lead through this form is the client's, kept on their CRM page." : ""}`,
      href: clientRef ? crmLink(null, source.clientKind!, source.clientRef!) : "/crm",
      hrefLabel: clientRef ? "Open the client page" : "Open CRM",
      steps: taking ? undefined : urls ? installSteps({ publicKey: source.publicKey, label: source.label, consentText: source.consentText, privacyUrl: source.privacyUrl, successMessage: source.successMessage, turnstileSiteKey: source.turnstileSiteKey }, urls, source.siteUrl) : [NO_URLS_NOTE],
      agentNext: "Once the first lead arrives, the Inbound Qualifier gets every lead from this form (a client's go to the client through an issue in their project) and answers within a working day. The agent installs the snippet through the client's repo project when the site has one.",
    });
  }
  const ready = await turnstileReady(ctx, companyId).catch(() => false);
  const site = (await leadsConfig(ctx, companyId).catch(() => null))?.turnstileSiteKey ?? null;
  items.push({
    key: "turnstile",
    title: "Spam protection for lead forms (optional)",
    status: ready ? "done" : "optional",
    required: false,
    detail: ready
      ? "Cloudflare Turnstile is on for new and rotated lead forms."
      : site
        ? "The Turnstile site key is saved but the secret is not, so the check is off. Add the secret."
        : "Lead forms already have a honeypot, rate limits, a throwaway-email block and one lead per email a day. Turnstile adds a bot check.",
    href: settingsHref,
    hrefLabel: "Open settings",
    steps: ready ? undefined : [
      "Open https://dash.cloudflare.com/?to=/:account/turnstile and add a widget (free). Add the hostname the Paperclip board is served from (paperclip.partnersinbiz.online). Choose Managed.",
      "Copy the widget's site key and secret key.",
      "In Paperclip, create a secret for the secret key (Company settings → Secrets).",
      "In the CRM settings, under Lead forms, paste the site key and pick the secret. Click Save Configuration.",
    ],
    agentNext: "New lead forms carry the check from then on. For forms already installed, list-lead-sources shows a warning: the agent rotates their key and installs the new snippet.",
  });
  return items;
}

/** The Account Manager, staffed in Setup → Team (kit TEAM_ROLES `account-manager`, item key `agent`). */
async function agentItem(ctx: PluginContext, companyId: string): Promise<SetupItem> {
  const base = {
    key: "agent",
    title: `Hire or link the ${AM_NAME}`,
    required: true,
    href: teamSetupPath("account-manager"),
    hrefLabel: "Open Team in Setup",
    agentNext: "Follows up leads, works sequence steps and replies, fills in client profiles and drafts quotes, invoices and client emails for approval.",
  };
  try {
    const hire = await hireStatus(ctx, companyId, ACCOUNT_MANAGER_ROLE);
    const agent = hire.agent;
    const openHire = hire.hire?.status === "open" ? hire.hire : null;
    return {
      ...base,
      status: agent ? "done" : "missing",
      detail: agent
        ? `${agent.name} is the ${AM_NAME} (${agent.status}).`
        : openHire
          ? `The hire task ${openHire.identifier ?? openHire.title} is open. The agent is linked once it appears, or pick one in Setup → Team.`
          : `No ${AM_NAME} yet, so lead follow-ups, replies and sequence steps go to the Operator or to you. A hire task asks your hiring agent (or a person) to create one; the CRM links and wires it.`,
      steps: agent ? undefined : [
        `Open Setup → Team → ${AM_NAME}.`,
        "Hire one (a hire task for your hiring agent or a person), or pick an agent you already have.",
        "Approve and resume the new agent once it exists.",
      ],
      action: !agent && !openHire ? { plugin: PLUGIN_ID, key: "crm.start-hire", params: {}, label: "Open a hire task" } : null,
    };
  } catch (error) {
    return { ...base, status: "unknown", detail: `Could not check the ${AM_NAME}: ${error instanceof Error ? error.message : String(error)}` };
  }
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
