/**
 * SMS and WhatsApp behind a provider interface.
 *
 * Campaign email goes through the Mailbox (`mail.send.requested`). SMS and
 * WhatsApp have no such plugin, so Campaigns talks to the provider itself
 * through `MessagingProvider`:
 *
 * - `TwilioProvider` is the real adapter, written against Twilio's documented
 *   REST API (Programmable Messaging: `POST /Accounts/{sid}/Messages.json`,
 *   `GET .../Messages.json` to read replies, `GET .../Messages/{sid}.json` for
 *   the delivery status; WhatsApp is the same API with `whatsapp:` addresses and
 *   a Content template for the first message to someone). It is DISABLED until a
 *   company has saved the account SID, an auth token secret and a sender number
 *   in the Campaigns settings: `messagingSetup` returns a provider only then, and
 *   a campaign launch refuses a channel that has none (`channelReadiness`).
 * - A test provider can be injected with `setMessagingProvider`; the tests use
 *   one that records what would have been sent. Nothing in a test touches the
 *   network or an account.
 *
 * Sending is at-most-once. A text cannot be taken back, so a send whose outcome
 * is unknown (the request timed out, a 5xx came back) is never repeated by the
 * plugin: it is recorded as `unknown` and a person checks the provider's log.
 * Only an answer that says the message was not accepted (a 429, a 503) is retried.
 *
 * Replies are read by polling `GET Messages.json` for the plugin's own numbers
 * (the host's webhook route only takes JSON, and Twilio posts forms), so the
 * STOP words work without a public endpoint. Twilio also blocks a recipient who
 * said STOP at its end (error 21610), which this adapter reports as `optedOut`.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { readConfig, SecretResolver } from "@partnersinbiz/pib-plugin-kit";
import { parseSendWindows, normalizePhone, type MessagingChannel, type SendWindows } from "./channels.js";

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface OutboundMessage {
  channel: MessagingChannel;
  /** E.164. */
  to: string;
  /** E.164 sender number, or a Twilio Messaging Service SID (`MG...`). */
  from: string;
  /** The text. For a template send it is the preview kept for the approver, not sent. */
  body: string;
  /** WhatsApp first contact: the approved template and its numbered variables. */
  template?: { ref: string; vars: Record<string, string> } | null;
  /** Our key for the send (`campaigns:msg:<enrollment>:<position>`), for logs only. */
  reference: string;
}

export type SendOutcome =
  | { ok: true; providerId: string; status: string; segments: number | null }
  | {
    ok: false;
    /**
     * rejected: not accepted, will not work on retry. retry: not accepted, try later (429, 503).
     * unknown: no answer or a 5xx: it may have been sent. config: the account or sender is wrong for every send.
     */
    kind: "rejected" | "retry" | "unknown" | "config";
    code: string | null;
    error: string;
    /** The recipient said STOP at the provider (Twilio 21610). */
    optedOut?: boolean;
    /** The number is not a number we can text. */
    invalidRecipient?: boolean;
    /** WhatsApp: a template is needed (the 24 hour window is closed). */
    needsTemplate?: boolean;
  };

export interface InboundMessage {
  providerId: string;
  channel: MessagingChannel;
  /** E.164 of the person. */
  from: string;
  /** E.164 of our number that received it. */
  to: string;
  body: string;
  receivedAt: string;
}

export interface MessageStatus {
  providerId: string;
  /** The provider's word: queued, sent, delivered, undelivered, failed, read... */
  status: string;
  errorCode: string | null;
}

export interface MessagingProvider {
  readonly id: string;
  send(message: OutboundMessage): Promise<SendOutcome>;
  /** Replies received on these numbers since `since`. */
  inbound(input: { since: Date; numbers: Array<{ channel: MessagingChannel; address: string }> }): Promise<InboundMessage[]>;
  /** The delivery status of messages we sent. */
  statuses(providerIds: string[]): Promise<MessageStatus[]>;
}

// ---------------------------------------------------------------------------
// Twilio
// ---------------------------------------------------------------------------

export interface TwilioOptions {
  accountSid: string;
  authToken: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

/** Replies are read this many to a page and this many pages per number each time. */
const INBOUND_PAGE_SIZE = 100;
const INBOUND_MAX_PAGES = 5;
/** A read that returns this many messages may have left some unread. */
export const INBOUND_READ_CAP = INBOUND_PAGE_SIZE * INBOUND_MAX_PAGES;

/** Twilio error codes by what they mean for the contact or the account. */
const TWILIO_OPTED_OUT = new Set(["21610"]);
const TWILIO_INVALID_RECIPIENT = new Set(["21211", "21214", "21217", "21612", "21614", "63024", "63032"]);
const TWILIO_CONFIG = new Set(["20003", "20404", "21212", "21408", "21606", "21608", "21659", "63007", "63112", "21618"]);
const TWILIO_RETRY = new Set(["20429"]);
/** WhatsApp: a free-form message outside the 24 hour window needs an approved template. */
const TWILIO_NEEDS_TEMPLATE = new Set(["63016"]);

/** Turns a Twilio error answer into a `SendOutcome` (exported so the mapping is tested on its own). */
export function classifyTwilioFailure(status: number | null, code: string | number | null | undefined, message: string): Extract<SendOutcome, { ok: false }> {
  const c = code == null ? null : String(code);
  const base = { code: c, error: message.replace(/\s+/g, " ").slice(0, 300) };
  if (c && TWILIO_OPTED_OUT.has(c)) return { ok: false, kind: "rejected", ...base, optedOut: true };
  if (c && TWILIO_NEEDS_TEMPLATE.has(c)) return { ok: false, kind: "rejected", ...base, needsTemplate: true };
  if (c && TWILIO_INVALID_RECIPIENT.has(c)) return { ok: false, kind: "rejected", ...base, invalidRecipient: true };
  if (status === 401 || status === 403 || (c && TWILIO_CONFIG.has(c))) return { ok: false, kind: "config", ...base };
  if (status === 429 || status === 503 || (c && TWILIO_RETRY.has(c))) return { ok: false, kind: "retry", ...base };
  if (status != null && status >= 500) return { ok: false, kind: "unknown", ...base };
  return { ok: false, kind: "rejected", ...base };
}

/** Network errors that mean the request never left this machine (no DNS answer, nothing listening, a bad certificate). */
const NOT_SENT_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
]);

/**
 * True when the error proves Twilio never received the request, so sending again cannot
 * duplicate a text. A timeout, an aborted request or a reset connection could have come
 * after Twilio accepted it, so those are not here.
 */
export function requestNeverSent(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && NOT_SENT_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const wa = (address: string, channel: MessagingChannel) => (channel === "whatsapp" ? `whatsapp:${address.replace(/^whatsapp:/i, "")}` : address.replace(/^whatsapp:/i, ""));

export class TwilioProvider implements MessagingProvider {
  readonly id = "twilio";
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly auth: string;

  constructor(options: TwilioOptions) {
    if (!/^AC[0-9a-zA-Z]{8,}$/.test(options.accountSid)) throw new Error("The Twilio account SID should start with AC.");
    if (!options.authToken) throw new Error("The Twilio auth token is not set.");
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.base = `${(options.baseUrl ?? "https://api.twilio.com").replace(/\/$/, "")}/2010-04-01/Accounts/${options.accountSid}`;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.auth = `Basic ${Buffer.from(`${options.accountSid}:${options.authToken}`).toString("base64")}`;
  }

  private async call(path: string, init: { method: "GET" | "POST"; body?: URLSearchParams }): Promise<{ status: number; json: Record<string, unknown> | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base}${path}`, {
        method: init.method,
        headers: { Authorization: this.auth, Accept: "application/json", ...(init.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
        ...(init.body ? { body: init.body.toString() } : {}),
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      return { status: res.status, json: json && typeof json === "object" ? json : null };
    } finally {
      clearTimeout(timer);
    }
  }

  async send(message: OutboundMessage): Promise<SendOutcome> {
    const form = new URLSearchParams();
    form.set("To", wa(message.to, message.channel));
    if (/^MG[0-9a-zA-Z]{20,}$/.test(message.from)) form.set("MessagingServiceSid", message.from);
    else form.set("From", wa(message.from, message.channel));
    if (message.template) {
      form.set("ContentSid", message.template.ref);
      form.set("ContentVariables", JSON.stringify(message.template.vars));
    } else {
      form.set("Body", message.body);
    }
    let answer: { status: number; json: Record<string, unknown> | null };
    try {
      answer = await this.call("/Messages.json", { method: "POST", body: form });
    } catch (error) {
      // The request never left (DNS, connection refused, certificate): nothing was sent, so it is safe to try later.
      if (requestNeverSent(error)) return { ok: false, kind: "retry", code: null, error: "Twilio could not be reached; the message was not sent." };
      // Any other failure: the message may have been accepted. Never send it again by itself.
      return { ok: false, kind: "unknown", code: null, error: `No answer from Twilio (${error instanceof Error ? error.name : "error"}).` };
    }
    const json = answer.json ?? {};
    if (answer.status >= 200 && answer.status < 300 && typeof json.sid === "string") {
      return { ok: true, providerId: json.sid, status: String(json.status ?? "queued"), segments: json.num_segments == null ? null : Number(json.num_segments) };
    }
    return classifyTwilioFailure(answer.status, json.code as string | number | undefined, String(json.message ?? `Twilio answered ${answer.status}`));
  }

  async inbound(input: { since: Date; numbers: Array<{ channel: MessagingChannel; address: string }> }): Promise<InboundMessage[]> {
    const out: InboundMessage[] = [];
    // DateSent> filters by UTC date only; the exact moment is filtered below.
    const day = input.since.toISOString().slice(0, 10);
    for (const number of input.numbers) {
      const params = new URLSearchParams({ To: wa(number.address, number.channel), "DateSent>": day, PageSize: String(INBOUND_PAGE_SIZE) });
      let path: string | null = `/Messages.json?${params.toString()}`;
      for (let page = 0; path && page < INBOUND_MAX_PAGES; page += 1) {
        const { status, json } = await this.call(path, { method: "GET" });
        if (status < 200 || status >= 300) throw new Error(`Twilio answered ${status} when reading messages${json?.code ? ` (code ${String(json.code)})` : ""}.`);
        const messages = Array.isArray(json?.messages) ? (json!.messages as Array<Record<string, unknown>>) : [];
        for (const m of messages) {
          if (m.direction !== "inbound" || typeof m.sid !== "string") continue;
          const at = Date.parse(String(m.date_created ?? m.date_sent ?? ""));
          if (!Number.isFinite(at) || at < input.since.getTime()) continue;
          const from = normalizePhone(String(m.from ?? ""), "+");
          if (!from) continue;
          out.push({ providerId: m.sid, channel: number.channel, from, to: number.address, body: String(m.body ?? ""), receivedAt: new Date(at).toISOString() });
        }
        const next = json?.next_page_uri;
        // next_page_uri is a path under /2010-04-01/...; keep only what follows the account.
        path = typeof next === "string" && next.includes("/Messages.json") ? next.slice(next.indexOf("/Messages.json")) : null;
      }
    }
    return out.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }

  async statuses(providerIds: string[]): Promise<MessageStatus[]> {
    const out: MessageStatus[] = [];
    for (const id of providerIds.slice(0, 50)) {
      if (!/^(SM|MM)[0-9a-f]{32}$/i.test(id)) continue;
      const { status, json } = await this.call(`/Messages/${id}.json`, { method: "GET" });
      if (status === 404) {
        out.push({ providerId: id, status: "failed", errorCode: "404" });
        continue;
      }
      if (status < 200 || status >= 300 || !json) continue;
      out.push({ providerId: id, status: String(json.status ?? "unknown"), errorCode: json.error_code == null ? null : String(json.error_code) });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Settings and readiness
// ---------------------------------------------------------------------------

export interface MessagingConfig {
  accountSid: string | null;
  smsFrom: string | null;
  messagingServiceSid: string | null;
  whatsappFrom: string | null;
  defaultCountry: string;
  windows: SendWindows;
  timezone: string;
}

export interface ChannelReadiness {
  ready: boolean;
  /** Why not, in words for the person fixing it. */
  reason: string | null;
}

export interface MessagingSetup {
  config: MessagingConfig;
  provider: MessagingProvider | null;
  sms: ChannelReadiness;
  whatsapp: ChannelReadiness;
}

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; value: MessagingSetup }>();
let providerOverride: ((config: MessagingConfig, companyId: string) => MessagingProvider) | null = null;

/** Tests: use this provider instead of Twilio (null puts Twilio back). Clears the cache. */
export function setMessagingProvider(factory: typeof providerOverride): void {
  providerOverride = factory;
  cache.clear();
  breakers.clear();
}

export function clearMessagingCache(): void {
  cache.clear();
  heldLogged.clear();
  inboundSecrets.clear();
  breakers.clear();
}

// ---------------------------------------------------------------------------
// Pausing a provider that keeps failing
// ---------------------------------------------------------------------------

/**
 * After this many provider failures in a row for a company (no answer, a refused
 * account, a rate limit), calls to it pause for ten minutes. Without this a Twilio or
 * network outage would make every due step in a run call a dead provider and open an
 * issue per contact, and a refused account would be asked again for every contact every
 * five minutes (repeated failed sign-ins can lock the account). Nothing is lost: the
 * paused steps stay due and go out when the provider answers again.
 */
export const BREAKER_FAILURES = 3;
export const BREAKER_PAUSE_MS = 10 * 60_000;
const breakers = new Map<string, { failures: number; lastFailureAt: number; pausedUntil: number }>();

export function providerPaused(companyId: string, now = Date.now()): boolean {
  const state = breakers.get(companyId);
  return Boolean(state && state.pausedUntil > now);
}

/**
 * Records one answer. `healthy` is true when the provider answered about the message
 * (sent, or refused it for its own reasons). A failure counts only with the ones in the
 * last ten minutes, so a lone message retried every ten minutes does not add up to a pause.
 * Returns true when this answer paused the provider.
 */
export function recordProviderResult(companyId: string, healthy: boolean, now = Date.now()): boolean {
  if (healthy) {
    breakers.delete(companyId);
    return false;
  }
  const state = breakers.get(companyId) ?? { failures: 0, lastFailureAt: 0, pausedUntil: 0 };
  if (now - state.lastFailureAt > BREAKER_PAUSE_MS) state.failures = 0;
  state.failures += 1;
  state.lastFailureAt = now;
  const opens = state.failures >= BREAKER_FAILURES;
  if (opens) {
    state.pausedUntil = now + BREAKER_PAUSE_MS;
    state.failures = 0;
  }
  breakers.set(companyId, state);
  return opens;
}

/** Lets calls through again at once (an operator who fixed the provider, and tests). */
export function resetProviderBreaker(companyId?: string): void {
  if (companyId) breakers.delete(companyId);
  else breakers.clear();
}

const heldLogged = new Map<string, number>();

/** True the first time a `key` is seen in an hour: a campaign that cannot send is logged once, not once per contact per run. */
export function firstHeldLog(key: string, now = Date.now()): boolean {
  const last = heldLogged.get(key);
  if (last !== undefined && now - last < 3_600_000) return false;
  heldLogged.set(key, now);
  return true;
}

const inboundSecrets = new Map<string, { at: number; value: string | null }>();

/**
 * The shared secret for the reply webhook, resolved at most once in five minutes
 * per company: the host limits secret reads, and the webhook is public, so a flood
 * of requests must not be able to use the allowance up.
 */
export async function inboundWebhookSecret(ctx: PluginContext, companyId: string): Promise<string | null> {
  const hit = inboundSecrets.get(companyId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let value: string | null = null;
  try {
    const raw = await readConfig(ctx, companyId);
    value = (await new SecretResolver(ctx, companyId, raw).get("messaging.inboundWebhookSecret")) ?? null;
  } catch {
    value = null;
  }
  inboundSecrets.set(companyId, { at: Date.now(), value });
  return value;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The settings block of a company's config (no secrets resolved). */
export function messagingConfigFrom(config: Record<string, unknown>): MessagingConfig {
  const m = (config.messaging && typeof config.messaging === "object" ? config.messaging : {}) as Record<string, unknown>;
  const country = text(m.defaultCountry) ?? "+27";
  return {
    accountSid: text(m.accountSid),
    smsFrom: normalizePhone(text(m.smsFrom), country),
    messagingServiceSid: text(m.messagingServiceSid),
    whatsappFrom: normalizePhone(text(m.whatsappFrom), country),
    defaultCountry: country.startsWith("+") ? country : `+${country}`,
    windows: parseSendWindows(m),
    timezone: text(config.timezone) ?? "Africa/Johannesburg",
  };
}

const NOT_SET = "Twilio is not set up for this company yet.";

/**
 * What can send for a company: the provider (null until it has an account SID, an
 * auth token secret and at least one sender) and, per channel, whether a launch
 * may use it and what is missing when not. Cached five minutes (the host limits
 * secret reads).
 */
export async function messagingSetup(ctx: PluginContext, companyId: string, options: { fresh?: boolean } = {}): Promise<MessagingSetup> {
  const hit = cache.get(companyId);
  if (hit && !options.fresh && Date.now() - hit.at < CACHE_MS) return hit.value;
  let raw: Record<string, unknown> = {};
  try {
    raw = await readConfig(ctx, companyId);
  } catch {
    raw = {};
  }
  const config = messagingConfigFrom(raw);
  let provider: MessagingProvider | null = null;
  let tokenProblem: string | null = null;
  if (providerOverride) {
    provider = providerOverride(config, companyId);
  } else if (config.accountSid) {
    try {
      const token = await new SecretResolver(ctx, companyId, raw).get("messaging.authToken");
      if (!token) tokenProblem = "The Twilio auth token is not set. Pick or create the secret in the Campaigns settings.";
      else provider = new TwilioProvider({ accountSid: config.accountSid, authToken: token });
    } catch (error) {
      tokenProblem = `The Twilio account could not be used: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const missing = (sender: string | null, label: string): ChannelReadiness => {
    if (!provider) return { ready: false, reason: tokenProblem ?? (config.accountSid ? NOT_SET : `${NOT_SET} Add the account SID and the auth token secret in the Campaigns settings.`) };
    if (!sender) return { ready: false, reason: `No ${label} sender is set. Add it in the Campaigns settings.` };
    return { ready: true, reason: null };
  };
  const value: MessagingSetup = {
    config,
    provider,
    sms: missing(config.smsFrom ?? config.messagingServiceSid, "SMS"),
    whatsapp: missing(config.whatsappFrom, "WhatsApp"),
  };
  cache.set(companyId, { at: Date.now(), value });
  return value;
}

export function readinessOf(setup: MessagingSetup, channel: MessagingChannel): ChannelReadiness {
  return channel === "sms" ? setup.sms : setup.whatsapp;
}

/** The number a company-level (own) send uses, or null when none is set. */
export function defaultSender(setup: MessagingSetup, channel: MessagingChannel): string | null {
  return channel === "sms" ? setup.config.smsFrom ?? setup.config.messagingServiceSid : setup.config.whatsappFrom;
}
