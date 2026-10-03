/**
 * Checks before a campaign asks for approval and again before it launches.
 *
 * `evaluatePreflight` is pure: it takes the facts (steps, who sends, which
 * channels work, what the audience can receive) and returns findings. An
 * `error` stops the approval request and the launch; a `warning` is shown to the
 * approver. `gatherPreflight` collects the facts from the plugin (and, for
 * `links`, the web).
 *
 * What is checked:
 * - every step has what it needs (subject and text; a WhatsApp first message
 *   needs a template; SMS length, parts and characters that make it cost more);
 * - the sender: a client's campaign has its own sender (never PiB's Gmail), the
 *   Mailbox is on, and the sender's domain health (SPF, DKIM, DMARC) when the
 *   Mailbox has reported it;
 * - the unsubscribe: a client's email must carry a working unsubscribe link; the
 *   one-click header (RFC 8058) is advised. With issue delivery (an agent sends each
 *   email by hand) the step issue carries the footer; no link is a warning;
 * - links: not a test or private address, https, tokens filled; and a live check
 *   that each link answers (404 and unknown hosts are errors; a blocked or slow
 *   site is a warning, since many sites refuse robots);
 * - each channel is configured; who can actually receive each channel.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isModuleEnabled, PIB_PLUGINS, safeFetch } from "@partnersinbiz/pib-plugin-kit";
import { CHANNEL_LABELS, isMessagingChannel, smsLength, SMS_MAX_CHARS, SMS_SEGMENT_WARN, hasOptOutInstruction, withOptOutLine, WHATSAPP_SESSION_MAX, WHATSAPP_TEMPLATE_MAX, type Channel, type MessagingChannel } from "./channels.js";
import { launchAudience, channelsUsed, type LaunchAudience } from "./audience.js";
import { listSenderIdentityRows } from "./db.js";
import { stepChannel, type CampaignDraft, type CampaignStepDraft } from "./domain.js";
import { extractLinks, linkConfig, unsubscribeLinkProblem } from "./links.js";
import { messagingSetup, readinessOf } from "./messaging.js";
import { resolveEmailSender, resolveMessageSender, type EmailSender } from "./sender.js";

export type FindingLevel = "error" | "warning";

export interface PreflightFinding {
  level: FindingLevel;
  code: string;
  message: string;
  /** What to do about it, in the words of the tool or setting. */
  fix?: string;
}

export interface PreflightResult {
  ok: boolean;
  errors: PreflightFinding[];
  warnings: PreflightFinding[];
  /** "Name <address>, replies to ..." for the approver, or null when no email step. */
  sentAs: string | null;
  /** Per text channel: who sends and the send window. */
  channels: Array<{ channel: Channel; sentFrom: string | null; ready: boolean; note: string | null }>;
}

export interface SenderHealth {
  status: "ok" | "warn" | "bad" | "unknown";
  detail: string;
  checkedAt: string | null;
}

export interface LinkCheck {
  url: string;
  status: number | null;
  error: string | null;
}

export interface PreflightFacts {
  campaign: Pick<CampaignDraft, "name" | "delivery" | "clientKind" | "clientRef" | "clientName">;
  steps: CampaignStepDraft[];
  email: EmailSender | null;
  emailHealth: SenderHealth | null;
  mailboxOn: boolean;
  /** Why an unsubscribe link cannot be built, or null when it can. */
  linkProblem: string | null;
  oneClick: boolean;
  channels: Partial<Record<MessagingChannel, { ready: boolean; reason: string | null; sentFrom: string | null; senderError: string | null }>>;
  audience: Pick<LaunchAudience, "contacts" | "reach"> | null;
  liveLinks: LinkCheck[] | null;
}

const KNOWN_TOKENS = new Set(["first_name", "last_name", "name", "company", "email", "unsubscribe_url"]);

function stepName(step: CampaignStepDraft): string {
  return `Step ${step.position}${step.variant === "b" ? "B" : ""}`;
}

/** What is wrong with a link written in a message, or null. */
export function linkProblem(url: string): { level: FindingLevel; message: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { level: "error", message: `${url} is not a valid address.` };
  }
  const host = parsed.hostname.toLowerCase();
  if (/\{\{|\}\}|%7b%7b/i.test(url)) return { level: "warning", message: `${url} still has a {{token}} in it.` };
  if (host === "localhost" || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0)/.test(host) || host === "[::1]" || /\.(local|localhost|test|invalid|internal)$/.test(host) || /(^|\.)example\.(com|org|net)$/.test(host) || /(^|[.-])(staging|stage|dev|test)[.-]/.test(host)) {
    return { level: "error", message: `${url} looks like a test or private address.` };
  }
  if (parsed.protocol === "http:") return { level: "warning", message: `${url} is not https.` };
  return null;
}

/** ok, broken (a person following it would get an error page or nothing) or unsure (a site that refuses robots, a slow one). */
export function classifyLink(check: LinkCheck): "ok" | "broken" | "unsure" {
  if (check.status != null) {
    if (check.status === 404 || check.status === 410) return "broken";
    return check.status < 400 ? "ok" : "unsure";
  }
  return /ENOTFOUND|getaddrinfo|resolve|not found|no such host|Unknown host/i.test(check.error ?? "") ? "broken" : "unsure";
}

/** Findings for one batch of steps. Pure. */
export function evaluatePreflight(facts: PreflightFacts): PreflightResult {
  const errors: PreflightFinding[] = [];
  const warnings: PreflightFinding[] = [];
  const add = (level: FindingLevel, code: string, message: string, fix?: string) => (level === "error" ? errors : warnings).push({ level, code, message, ...(fix ? { fix } : {}) });
  const { campaign, steps } = facts;
  const isClient = Boolean(campaign.clientRef);
  const used = channelsUsed(steps);
  // A campaign that opens an issue per step has an agent send each email by hand: there is no automatic sender to check.
  const automatic = campaign.delivery !== "issue";

  if (steps.length === 0) add("error", "no-steps", "The campaign has no steps.", "add-campaign-step");

  for (const step of steps) {
    const channel = stepChannel(step);
    const where = stepName(step);
    const text = step.body.trim();
    if (channel === "email") {
      if (!step.subject.trim()) add("error", "empty-subject", `${where} has no subject.`, "add-campaign-step or create-ab-variant with a subject");
      if (!text && !(step.htmlBody ?? "").trim()) add("error", "empty-body", `${where} has no text.`);
    } else {
      if (!text) add("error", "empty-body", `${where} (${CHANNEL_LABELS[channel]}) has no text.`);
    }
    for (const match of `${step.subject} ${step.body} ${step.htmlBody ?? ""}`.matchAll(/\{\{\s*([a-z_]+)\s*(?:\|[^}]*)?\}\}/gi)) {
      if (!KNOWN_TOKENS.has(match[1]!.toLowerCase())) add("warning", "unknown-token", `${where} uses {{${match[1]}}}, which is not filled in and goes out as typed. Known: first_name, last_name, name, company, email, unsubscribe_url.`);
    }
    for (const url of extractLinks(`${step.body} ${step.htmlBody ?? ""}`)) {
      const problem = linkProblem(url);
      if (problem) add(problem.level, "link", `${where}: ${problem.message}`);
    }
    if (channel === "sms") {
      const length = smsLength(withOptOutLine(step.body));
      if (text.length + 24 > SMS_MAX_CHARS) add("error", "sms-too-long", `${where} is too long for one SMS (the limit is ${SMS_MAX_CHARS} characters).`);
      else if (length.segments > SMS_SEGMENT_WARN) add("warning", "sms-parts", `${where} is ${length.segments} SMS parts (${length.units} ${length.encoding === "gsm7" ? "characters" : "units"}); each part is billed. Shorten it.`);
      if (length.encoding === "ucs2") add("warning", "sms-ucs2", `${where} has ${length.nonGsm.slice(0, 5).join(" ")} which switches the whole message to 70 characters a part; plain characters keep it at 160.`);
    }
    if (channel === "whatsapp") {
      if (!step.templateRef) {
        add("warning", "whatsapp-template", `${where} has no WhatsApp template. A free-form message only reaches people who wrote to us in the last 24 hours; everyone else needs an approved template.`, "add-campaign-step with templateRef (from the Twilio Content Template Builder)");
      } else {
        if (!hasOptOutInstruction(step.body)) add("warning", "whatsapp-stop", `${where}: the approved template text must say how to opt out (reply STOP); make sure it does.`);
        if (text.length > WHATSAPP_TEMPLATE_MAX) add("error", "whatsapp-too-long", `${where} is over the ${WHATSAPP_TEMPLATE_MAX} character limit for a template.`);
      }
      if (!step.templateRef && text.length > WHATSAPP_SESSION_MAX) add("error", "whatsapp-too-long", `${where} is over the ${WHATSAPP_SESSION_MAX} character limit.`);
    }
  }

  // Channels
  const channels: PreflightResult["channels"] = [];
  for (const channel of used) {
    if (channel === "email") {
      if (automatic && !facts.mailboxOn) add("error", "mailbox-off", "The campaign sends email but the Mailbox module is switched off.", "Turn the Mailbox on in Setup and connect Gmail.");
      continue;
    }
    if (campaign.delivery !== "auto") add("error", "needs-auto", `${CHANNEL_LABELS[channel]} steps are sent by the plugin itself, so the campaign's delivery must be auto.`, "update-campaign with delivery auto");
    const info = facts.channels[channel];
    if (!info || !info.ready) {
      add("error", "channel-not-ready", `${CHANNEL_LABELS[channel]} steps cannot go out: ${info?.reason ?? "no provider is set up"}`, "Finish the SMS and WhatsApp items on the Setup page (provider account, auth token secret, sender number).");
      channels.push({ channel, sentFrom: null, ready: false, note: info?.reason ?? null });
      continue;
    }
    if (info.senderError) add("error", "no-sender-number", info.senderError, "set-sender-identity");
    channels.push({ channel, sentFrom: info.sentFrom, ready: !info.senderError, note: info.senderError });
  }

  // Email sender, domain and unsubscribe
  let sentAs: string | null = null;
  if (automatic && used.includes("email")) {
    if (facts.email && !facts.email.ok) add("error", "no-sender", facts.email.error, "set-sender-identity");
    if (facts.email?.ok) {
      const from = facts.email.identity?.fromAddress;
      sentAs = `${facts.email.fromName ? `${facts.email.fromName} ` : ""}${from ? `<${from}>` : "(the Mailbox's default account)"}${facts.email.replyTo ? `, replies to ${facts.email.replyTo}` : ""}`.trim();
      if (!facts.email.replyTo && isClient) add("warning", "no-reply-to", "No reply-to is set, so replies go to the sending mailbox.");
      const health = facts.emailHealth;
      if (!health || health.status === "unknown") {
        add("warning", "domain-unknown", `The sender's domain health (SPF, DKIM, DMARC) has not been reported by the Mailbox, so it is not known whether this email will reach inboxes${from ? ` from ${from.split("@")[1] ?? "this domain"}` : ""}.`);
      } else if (health.status === "bad") {
        add("error", "domain-bad", `The sender's domain is not set up to send: ${health.detail}`, "Fix the DNS records (SPF, DKIM, DMARC) for the sending domain, then check again.");
      } else if (health.status === "warn") {
        add("warning", "domain-warn", `The sender's domain has a problem: ${health.detail}`);
      }
    }
    if (facts.linkProblem) {
      add(isClient ? "error" : "warning", "no-unsubscribe-link", `Emails cannot carry an unsubscribe link yet: ${facts.linkProblem}`, "Set the public base URL in the Campaigns settings and open the Campaigns page once.");
    }
    if (!facts.oneClick) add("warning", "no-one-click", "The one-click unsubscribe header (RFC 8058) is not on: mail clients show their own Unsubscribe button only with it, and Gmail and Yahoo expect it from bulk senders. The footer link and reply STOP still work.", "Save the one-click unsubscribe address in the Campaigns settings (Setup shows the steps).");
  }

  // Issue delivery: an agent sends each email by hand from an issue that carries the footer; without a link it says reply STOP only.
  if (!automatic && used.includes("email") && facts.linkProblem) {
    add("warning", "no-unsubscribe-link", `The step issues will end with "reply STOP" only, without an unsubscribe link: ${facts.linkProblem}`, "Set the public base URL in the Campaigns settings and open the Campaigns page once.");
  }

  // Live links
  for (const check of facts.liveLinks ?? []) {
    const verdict = classifyLink(check);
    if (verdict === "broken") add("error", "broken-link", `${check.url} does not work (${check.status ?? check.error ?? "no answer"}).`);
    else if (verdict === "unsure") add("warning", "link-unsure", `${check.url} could not be confirmed (${check.status ?? check.error ?? "no answer"}). Open it yourself.`);
  }

  // Audience
  const audience = facts.audience;
  if (audience) {
    for (const channel of used) {
      const reach = audience.reach[channel];
      if (channel !== "email" && reach === 0) add("error", "nobody-reachable", `Nobody in the audience can receive ${CHANNEL_LABELS[channel]}: a contact needs a mobile number and a recorded opt-in for this sender.`, "record-channel-consent for people who agreed, with the evidence");
      else if (channel !== "email" && reach < audience.contacts.length) add("warning", "partly-reachable", `${reach} of ${audience.contacts.length} contacts can receive ${CHANNEL_LABELS[channel]} (a mobile number and a recorded opt-in for this sender); the rest skip those steps.`);
      else if (channel === "email" && audience.contacts.length > 0 && reach === 0) add("error", "nobody-reachable", "Nobody in the audience has an email address that is not on the do-not-email list.");
    }
  }

  return { ok: errors.length === 0, errors, warnings, sentAs, channels };
}

// ---------------------------------------------------------------------------
// The Mailbox's report on a sender's domain
// ---------------------------------------------------------------------------

/**
 * The Mailbox may announce how a connected account's domain is set up (SPF, DKIM,
 * DMARC) as the event `sender.health`: `{ accountAddress, domain?, default?,
 * status: ok | warn | bad, detail?, checkedAt }`. Campaigns keeps the last report
 * per account. Until the Mailbox sends one the preflight says the health is unknown.
 */
export const SENDER_HEALTH_EVENT = "sender.health";
const healthState = (companyId: string, account: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "campaigns-senders", stateKey: `health:${account.toLowerCase()}` });

export async function rememberSenderHealth(ctx: PluginContext, companyId: string, payload: unknown): Promise<boolean> {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const status = p.status === "ok" || p.status === "warn" || p.status === "bad" ? p.status : null;
  const account = typeof p.accountAddress === "string" && p.accountAddress.includes("@") ? p.accountAddress.trim().toLowerCase() : p.default === true ? "default" : null;
  if (!status || !account) return false;
  const health: SenderHealth = { status, detail: typeof p.detail === "string" ? p.detail.slice(0, 300) : "", checkedAt: typeof p.checkedAt === "string" ? p.checkedAt : new Date().toISOString() };
  await ctx.state.set(healthState(companyId, account), health);
  return true;
}

export async function senderHealthFor(ctx: PluginContext, companyId: string, account: string | null | undefined): Promise<SenderHealth | null> {
  try {
    const stored = (await ctx.state.get(healthState(companyId, account ?? "default"))) as SenderHealth | null;
    return stored && typeof stored === "object" && stored.status ? stored : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gathering the facts
// ---------------------------------------------------------------------------

const MAX_LINKS = 12;
const LINK_TIMEOUT_MS = 8_000;

async function checkOne(ctx: PluginContext, url: string): Promise<LinkCheck> {
  const attempt = async (method: "HEAD" | "GET") => {
    const timer = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("timed out")), LINK_TIMEOUT_MS));
    return Promise.race([safeFetch(ctx, url, { method, maxRedirects: 4, maxChars: 4_000 }), timer]);
  };
  try {
    let res = await attempt("HEAD");
    // Many sites refuse HEAD; ask for the page itself before calling the link broken.
    if (res.status === 405 || res.status === 501 || res.status === 403) res = await attempt("GET");
    return { url, status: res.status, error: null };
  } catch (error) {
    return { url, status: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Asks each link whether it answers (up to 12 distinct links, four at a time). Never throws. */
export async function checkLinks(ctx: PluginContext, urls: string[]): Promise<LinkCheck[]> {
  const list = [...new Set(urls)].filter((url) => !linkProblem(url)).slice(0, MAX_LINKS);
  const out: LinkCheck[] = [];
  for (let i = 0; i < list.length; i += 4) out.push(...(await Promise.all(list.slice(i, i + 4).map((url) => checkOne(ctx, url)))));
  return out;
}

export interface GatherOptions {
  /** Also ask the web whether each link works (the approval request does; a launch check does not). */
  network?: boolean;
  /** Also count who can receive each channel. */
  audience?: boolean;
}

export async function gatherPreflight(ctx: PluginContext, companyId: string, campaign: CampaignDraft, steps: CampaignStepDraft[], options: GatherOptions = {}): Promise<PreflightResult> {
  const used = channelsUsed(steps);
  const identityRows = await listSenderIdentityRows(ctx, companyId);
  const setup = await messagingSetup(ctx, companyId);
  const channels: PreflightFacts["channels"] = {};
  for (const channel of used) {
    if (!isMessagingChannel(channel)) continue;
    const readiness = readinessOf(setup, channel);
    const sender = readiness.ready ? await resolveMessageSender(ctx, companyId, campaign, channel, setup, identityRows) : null;
    channels[channel] = { ready: readiness.ready, reason: readiness.reason, sentFrom: sender?.ok ? sender.from : null, senderError: sender && !sender.ok ? sender.error : null };
  }
  const automatic = campaign.delivery !== "issue";
  const email = automatic && used.includes("email") ? await resolveEmailSender(ctx, companyId, campaign, identityRows) : null;
  const facts: PreflightFacts = {
    campaign,
    steps,
    email,
    emailHealth: email?.ok ? await senderHealthFor(ctx, companyId, email.identity?.fromAddress ?? null) : null,
    mailboxOn: await isModuleEnabled(ctx, companyId, PIB_PLUGINS.mailbox),
    linkProblem: used.includes("email") ? await unsubscribeLinkProblem(ctx, companyId) : null,
    oneClick: Boolean((await linkConfig(ctx, companyId)).oneClick),
    channels,
    audience: options.audience === false ? null : await launchAudience(ctx, companyId, campaign, steps, [], setup.config.defaultCountry).catch(() => null),
    liveLinks: options.network ? await checkLinks(ctx, steps.flatMap((step) => extractLinks(`${step.body} ${step.htmlBody ?? ""}`))) : null,
  };
  const result = evaluatePreflight(facts);
  return result;
}

/** The result as lines for the approval issue and the tool answer. */
export function preflightLines(result: PreflightResult): string[] {
  const lines: string[] = [];
  for (const finding of result.errors) lines.push(`- **Fix before approval:** ${finding.message}${finding.fix ? ` (${finding.fix})` : ""}`);
  for (const finding of result.warnings) lines.push(`- Check: ${finding.message}`);
  return lines;
}
