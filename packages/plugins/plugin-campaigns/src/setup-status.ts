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
import { listSenderIdentityRows } from "./db.js";
import { linkConfig } from "./links.js";
import { messagingSetup } from "./messaging.js";
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
    title: "Smart reply sorting (optional)",
    status: jev ? "done" : "optional",
    required: false,
    detail: jev
      ? "Campaign replies are sorted by the smart sorting service."
      : "Optional. Sorts campaign replies more accurately (interested, not now, unsubscribe). Without it Campaigns uses its built-in rules.",
    href: settings,
    hrefLabel: "Open settings",
    steps: jev ? undefined : [
      "An admin creates an API key with the smart sorting service (typesafe.ai → API keys).",
      "In the Campaigns settings, find **Smart sorting (Jev by TypeSafe)** and pick or create a Paperclip secret for the API key.",
      "Click **Save Configuration**.",
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
      : "Campaigns set to email delivery send through the Mailbox (Gmail). Connect Gmail there first. Campaigns delivered as tasks for the agent need nothing more.",
    // The Mailbox page starts the Google sign-in at once from this link.
    href: blocked ? "/setup" : "/mailbox?tab=mailboxes&connect=gmail",
    hrefLabel: blocked ? "Turn on the Mailbox" : "Connect Gmail",
    agentNext: "Email campaigns send each due step without a person opening an issue.",
  });

  items.push(...(await messagingItems(ctx, companyId, config, { href: settings }, emailCampaigns > 0)));

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


const TWILIO_CONSOLE = "https://console.twilio.com/";
const TWILIO_NUMBERS = "https://console.twilio.com/us1/develop/phone-numbers/manage/search";
const TWILIO_WHATSAPP = "https://console.twilio.com/us1/develop/sms/senders/whatsapp-senders";
const TWILIO_TEMPLATES = "https://console.twilio.com/us1/develop/sms/content-template-builder";

/** Campaigns that still have a client, and the clients among them without a sender identity. */
async function clientsWithoutSender(ctx: PluginContext, companyId: string): Promise<string[]> {
  try {
    const rows = await ctx.db.query<{ client_kind: string | null; client_ref: string; client_name: string | null }>(
      `SELECT client_kind, client_ref, client_name FROM ${table(ctx, "campaigns")} WHERE company_id = $1 AND client_ref IS NOT NULL AND delivery <> 'issue' AND status <> 'completed'`,
      [companyId],
    );
    const have = new Set((await listSenderIdentityRows(ctx, companyId)).filter((row) => row.from_address).map((row) => row.sender_key));
    const missing = new Map<string, string>();
    for (const row of rows) {
      const key = `${row.client_kind === "contact" ? "contact" : "company"}:${row.client_ref}`;
      if (!have.has(key)) missing.set(key, row.client_name ?? key);
    }
    return [...missing.values()];
  } catch {
    return [];
  }
}

/** Does any open campaign have an SMS or WhatsApp step? */
async function textStepsInUse(ctx: PluginContext, companyId: string): Promise<boolean> {
  try {
    const rows = await ctx.db.query<{ id: string }>(
      `SELECT id FROM ${table(ctx, "campaign_steps")} WHERE company_id = $1 AND channel <> 'email' LIMIT 1`,
      [companyId],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * The items that make client email, SMS and WhatsApp work. All are optional for
 * the Setup page's progress (PiB's own email needs none of them), but each says
 * exactly what the owner does, with the links, and what the agent does after.
 */
export async function messagingItems(ctx: PluginContext, companyId: string, config: Record<string, unknown>, settings: { href: string }, emailActive: boolean): Promise<SetupItem[]> {
  const items: SetupItem[] = [];
  const links = await linkConfig(ctx, companyId);
  const urlDone = Boolean(links.publicBase && links.uiBase);
  items.push({
    key: "public_url",
    title: "Public address for unsubscribe links",
    status: urlDone ? "done" : emailActive ? "missing" : "optional",
    required: false,
    detail: urlDone ? undefined : links.publicBase
      ? "Open the Campaigns page once so the plugin learns its public path; then every email carries a working unsubscribe link."
      : "Emails carry an unsubscribe link only when the plugin knows the public address of this Paperclip. A client's campaign cannot be approved without one.",
    href: settings.href,
    hrefLabel: "Open settings",
    steps: urlDone ? undefined : [
      "Open the Campaigns settings (Settings, Plugins, Campaigns).",
      "Set Public base URL to the address people reach Paperclip on, for example https://paperclip.partnersinbiz.online.",
      "Click Save Configuration, then open the Campaigns page once.",
    ],
    agentNext: "Every email ends with who sent it and an unsubscribe link, and a client's campaign can be approved.",
  });
  const oneClick = Boolean(links.oneClick);
  items.push({
    key: "one_click",
    title: "One-click unsubscribe (RFC 8058)",
    status: oneClick ? "done" : "optional",
    required: false,
    detail: oneClick ? undefined : "Mail clients show their own Unsubscribe button, and Gmail and Yahoo expect it from bulk senders, only when the email carries a one-click header. The host cannot serve it alone: the server operator adds one front-door rule (the Campaigns README has it), then the address is saved here.",
    href: settings.href,
    hrefLabel: "Open settings",
    steps: oneClick ? undefined : [
      "The server operator adds the Caddy rule from the Campaigns README (it forwards POST /u to the plugin's unsubscribe webhook) and reloads Caddy.",
      "Set One-click unsubscribe address to https://<your host>/u in the Campaigns settings and click Save Configuration.",
    ],
    agentNext: "Every campaign email carries the List-Unsubscribe-Post header, so mail clients unsubscribe people in one tap.",
  });
  const missingSenders = await clientsWithoutSender(ctx, companyId);
  items.push({
    key: "client_senders",
    title: "Who each client's email goes out as",
    status: missingSenders.length > 0 ? "missing" : "done",
    required: false,
    detail: missingSenders.length > 0
      ? `These clients have automatic campaigns but no sender: ${missingSenders.slice(0, 5).join(", ")}${missingSenders.length > 5 ? ", ..." : ""}. Their email will not go out, and it is never sent from PiB's own Gmail.`
      : "Every client with an automatic campaign has a sender.",
    href: "/mailbox?tab=mailboxes&connect=gmail",
    hrefLabel: "Connect the client's mailbox",
    steps: missingSenders.length > 0 ? [
      "Connect the client's own Gmail in the Mailbox (a one-time Google sign-in by the client or by you with their login).",
      "Ask the Account Manager to run set-sender-identity for the client with that mailbox, the client's name and a reply-to.",
    ] : undefined,
    agentNext: "The client's campaigns can be approved, and each email goes out as the client with replies to them.",
  });

  const setup = await messagingSetup(ctx, companyId).catch(() => null);
  const textsNeeded = await textStepsInUse(ctx, companyId);
  const providerOk = Boolean(setup?.provider);
  const m = (config.messaging && typeof config.messaging === "object" ? config.messaging : {}) as Record<string, unknown>;
  items.push({
    key: "twilio",
    title: "SMS and WhatsApp provider (Twilio)",
    status: providerOk ? "done" : textsNeeded ? "missing" : "optional",
    required: false,
    detail: providerOk ? undefined : `${setup?.sms.reason ?? "Twilio is not set up."} Nothing is sent until the account SID and the auth token secret are saved. This needs a Twilio account, which only a person can create.`,
    href: TWILIO_CONSOLE,
    hrefLabel: "Open the Twilio console",
    steps: providerOk ? undefined : [
      "Create a Twilio account at https://www.twilio.com/try-twilio and upgrade it (a trial account can only message numbers you verified).",
      "On the console home page, Account Info, copy the Account SID (starts with AC) and the Auth Token.",
      "In Paperclip open Settings, Plugins, Campaigns. Under SMS and WhatsApp (Twilio) paste the Account SID, create a Paperclip secret for the Auth Token and pick it, then click Save Configuration. Never paste the token into an issue or chat.",
    ],
    agentNext: "SMS and WhatsApp steps can be approved and sent inside the send window; replies, STOP words and delivery results are read every 10 minutes.",
  });
  const smsNumber = Boolean(m.smsFrom || m.messagingServiceSid);
  // A Messaging Service sends, but replies are read on a number: without one a STOP text is not read here.
  const serviceOnly = Boolean(m.messagingServiceSid && !m.smsFrom);
  items.push({
    key: "sms_sender",
    title: "SMS sender number",
    status: smsNumber ? "done" : textsNeeded ? "missing" : "optional",
    required: false,
    detail: serviceOnly
      ? "Only a Messaging Service is set. It sends, but replies (including STOP) are read on a number: add the SMS sender number too, or STOP texts are not read here (Twilio still blocks a recipient who replied STOP to its own number)."
      : smsNumber ? undefined : "The number SMS goes out from, and the number replies are read on. A client's campaign needs its own number (set-sender-identity smsFrom); it is never sent from PiB's number.",
    href: TWILIO_NUMBERS,
    hrefLabel: "Buy or register a number",
    steps: smsNumber ? undefined : [
      "In the Twilio console choose Phone Numbers, Manage, Buy a number, and pick one that can send SMS to South Africa (Twilio's South Africa guidelines list what a sender must register; if they do not suit, a South African SMS gateway can be added behind the same provider interface).",
      "Enter it with its country code under SMS sender number in the Campaigns settings, then Save Configuration.",
    ],
    agentNext: "SMS campaigns send from that number and only to people with a recorded opt-in; a STOP reply stops them at once.",
  });
  const waNumber = Boolean(m.whatsappFrom);
  items.push({
    key: "whatsapp_sender",
    title: "WhatsApp sender and templates",
    status: waNumber ? "done" : "optional",
    required: false,
    detail: waNumber ? undefined : "WhatsApp needs a registered business sender, and the first message to someone must use a template Meta approved. Optional: skip it if you only text.",
    href: TWILIO_WHATSAPP,
    hrefLabel: "Open WhatsApp senders",
    steps: waNumber ? undefined : [
      "In the Twilio console open Messaging, Senders, WhatsApp senders and register the business number (Meta asks for business verification; Twilio walks through it).",
      `Create the message templates in the Content Template Builder (${TWILIO_TEMPLATES}), submit them for WhatsApp approval, and wait for approval. Each template must say how to opt out.`,
      "Enter the number under WhatsApp sender number in the Campaigns settings and Save Configuration. A WhatsApp step then uses the template's SID (HX...) as its templateRef.",
    ],
    agentNext: "WhatsApp campaign steps send with the approved template, to people who opted in; replies open an issue for the campaign's agent.",
  });
  return items;
}
