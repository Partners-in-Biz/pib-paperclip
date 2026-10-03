/**
 * One-click unsubscribe (RFC 8058) for marketing mail.
 *
 * Two halves:
 *
 * - **The headers.** A marketing send carries `List-Unsubscribe` with an https
 *   address (when the caller supplied one, or the Mailbox made one, below) next
 *   to the mailto form, and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
 *   so Gmail and Yahoo show their Unsubscribe button. That is `suppression.ts`
 *   and `send.ts`.
 * - **The address.** The Mailbox declares a public webhook, `unsubscribe`
 *   (`POST /api/plugins/partnersinbiz.mailbox/webhooks/unsubscribe`). A mail client
 *   posts `List-Unsubscribe=One-Click` to the address in the header. The address
 *   carries a signed token (kit `signUnsubscribeToken`: company, address, whose
 *   list); the Mailbox verifies it with the company's unsubscribe secret, puts
 *   the address on that sender's marketing list and announces it
 *   (`contact.suppressed`, `consent.recorded`).
 *
 * What the host allows (checked in the host's plugin route): a webhook gets the
 * request headers and body, NOT the address it was posted to, so the token in a
 * `?token=` query never reaches the plugin by itself. The reverse proxy must pass
 * the request address on as a header: in the Caddy site block, a `handle` for
 * that path whose reverse_proxy has `header_up X-Original-Uri {uri}` (the exact
 * block is in the README). This module reads the token from, in order,
 * `X-Pib-Unsubscribe-Token`, the query of `X-Original-Uri` / `X-Forwarded-Uri`,
 * then a `token` field in the body.
 *
 * **The gate.** Without that proxy rule a one-click link is worse than none: the
 * mail client posts, the host answers 200, the recipient is told they are
 * unsubscribed, and nothing is recorded. So the Mailbox does not put its OWN
 * https link in a mail until it has proved the rule works, and keeps proving it:
 * every hour (and on "Check now") it posts a probe token to its own public
 * address, the way a mail client would (no special headers). The probe token is
 * signed with the company's unsubscribe secret for a reserved sender, so only the
 * Mailbox, or a person who was handed its link, can make one; when it reaches the
 * webhook through a header the proxy set, the webhook records the proof
 * (`ProxyProof`, company state). The link is made only while the last proof
 * passed and is under six hours old; a failed probe closes the gate at once.
 * Until then marketing mail carries the mailto form only, which always works.
 * A caller's own `unsubscribeUrl` is the caller's responsibility and is not gated.
 *
 * Nothing here can unsubscribe a stranger: a token is an HMAC over the company,
 * address and sender, made with a secret only the plugin and the company hold.
 * A bad or missing token changes nothing and says nothing. The probe token
 * unsubscribes nobody.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { HANDOFF_EVENTS, signUnsubscribeToken, verifyUnsubscribeToken, type MailSendRequested } from "@partnersinbiz/pib-plugin-kit";
import { loadMailboxConfig, type LoadedConfig } from "./config.js";
import { UNSUBSCRIBE_ENDPOINT } from "./constants.js";
import { announceOptOut } from "./erasure.js";
import { errorMessage, type Env } from "./gmail/env.js";
import { PLUGIN_ID } from "./namespace.js";
import { suppressionPayload } from "./suppression.js";

export const TOKEN_HEADER = "x-pib-unsubscribe-token";
const URI_HEADERS = ["x-original-uri", "x-forwarded-uri", "x-original-url"];

/** The https address a mail client posts to: the host's public webhook route with the token in the query. */
export function oneClickUrl(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl.replace(/\/$/, "")}/api/plugins/${PLUGIN_ID}/webhooks/${UNSUBSCRIBE_ENDPOINT}?token=${encodeURIComponent(token)}`;
}

function header(headers: PluginWebhookInput["headers"], name: string): string | null {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

/** Where a delivery's token was found: a header the proxy set, the original address' query, or the posted body. */
export type TokenSource = "header" | "uri" | "body";

/** The token a webhook delivery carries (see the file header for where) and where it was found, or null. */
export function tokenFromDelivery(input: Pick<PluginWebhookInput, "headers" | "rawBody" | "parsedBody">): { token: string; via: TokenSource } | null {
  const direct = header(input.headers, TOKEN_HEADER);
  if (direct) return { token: direct.slice(0, 2000), via: "header" };
  for (const name of URI_HEADERS) {
    const uri = header(input.headers, name);
    if (!uri) continue;
    try {
      const token = new URL(uri, "https://placeholder.invalid").searchParams.get("token");
      if (token) return { token: token.slice(0, 2000), via: "uri" };
    } catch {
      // not a URL: try the next header
    }
  }
  const body = input.parsedBody && typeof input.parsedBody === "object" ? (input.parsedBody as { token?: unknown }).token : null;
  if (typeof body === "string" && body) return { token: body.slice(0, 2000), via: "body" };
  if (input.rawBody && /(^|&)token=/.test(input.rawBody)) {
    const raw = new URLSearchParams(input.rawBody).get("token")?.slice(0, 2000);
    if (raw) return { token: raw, via: "body" };
  }
  return null;
}

/** The token a webhook delivery carries, or null. */
export function tokenFromWebhook(input: Pick<PluginWebhookInput, "headers" | "rawBody" | "parsedBody">): string | null {
  return tokenFromDelivery(input)?.token ?? null;
}

/** The company a token claims (unverified: only used to find the secret that verifies it). */
export function claimedCompany(token: string): string | null {
  try {
    const body = JSON.parse(Buffer.from(token.slice(0, token.indexOf(".")), "base64url").toString("utf8")) as { c?: unknown };
    return typeof body.c === "string" && body.c ? body.c : null;
  } catch {
    return null;
  }
}

export type UnsubscribeOutcome = "suppressed" | "already" | "invalid" | "no_token" | "unconfigured" | "probe_ok" | "probe_unproven";

/** Handles one delivery to the `unsubscribe` webhook. Returns what happened (nothing in it is shown to the caller). Never throws. */
export async function handleUnsubscribeWebhook(env: Pick<Env, "ctx" | "store" | "now">, input: PluginWebhookInput): Promise<UnsubscribeOutcome> {
  if (input.endpointKey !== UNSUBSCRIBE_ENDPOINT) return "invalid";
  const found = tokenFromDelivery(input);
  if (!found) return "no_token";
  const companyId = claimedCompany(found.token);
  if (!companyId) return "invalid";
  try {
    const secret = await (await loadMailboxConfig(env.ctx, companyId)).secrets.get("unsubscribe.secret");
    if (!secret) return "unconfigured";
    const payload = verifyUnsubscribeToken(found.token, secret);
    if (!payload || payload.companyId !== companyId) return "invalid";
    if (payload.email === PROBE_EMAIL && payload.senderKey.startsWith(PROBE_SENDER_PREFIX)) {
      // The Mailbox's own check that the proxy passes the address on. It unsubscribes nobody. A token that came in the body proves nothing about the proxy.
      if (found.via === "body") return "probe_unproven";
      await writeProxyProof(env.ctx, companyId, { ok: true, at: new Date(env.now()).toISOString(), detail: null, probe: payload.senderKey.slice(PROBE_SENDER_PREFIX.length) });
      return "probe_ok";
    }
    const stored = await env.store.upsertSuppression({ companyId, email: payload.email, scope: "marketing", reason: "unsubscribed", source: PLUGIN_ID, detail: "One-click unsubscribe link", senderKey: payload.senderKey });
    if (!stored.created) return "already";
    try {
      await env.ctx.events.emit(HANDOFF_EVENTS.contactSuppressed, companyId, suppressionPayload({ email: payload.email, reason: "unsubscribed", scope: "marketing", senderKey: payload.senderKey }) as unknown as Record<string, unknown>);
    } catch (error) {
      env.ctx.logger.info("contact.suppressed emit failed; the hourly job announces it again", { error: errorMessage(error) });
    }
    await announceOptOut(env, companyId, { email: payload.email, senderKey: payload.senderKey, source: "unsubscribe_link" });
    return "suppressed";
  } catch (error) {
    env.ctx.logger.info("One-click unsubscribe failed", { error: errorMessage(error) });
    return "invalid";
  }
}

// ---------------------------------------------------------------------------
// The gate: is the proxy rule proven?
// ---------------------------------------------------------------------------

/** The reserved address and sender (`probe:<one-off id>`) of the Mailbox's own probe token. The Mailbox never mints a real link for either. */
export const PROBE_EMAIL = "proxy-check@unsubscribe-probe.invalid";
export const PROBE_SENDER_PREFIX = "probe:";

/** A passed check keeps the https link switched on this long; the hourly job renews it. A failed check closes the gate at once. */
export const PROXY_PROOF_MAX_AGE_MS = 6 * 3_600_000;
const PROBE_TIMEOUT_MS = 10_000;

/** What the last check of the proxy rule found. */
export interface ProxyProof {
  ok: boolean;
  at: string;
  /** Why it failed (for the owner), null when it passed. */
  detail: string | null;
  /** The one-off id of the probe that passed: the check that sent it knows its own answer from an older one. */
  probe?: string | null;
}

const proofState = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "mailbox-unsubscribe", stateKey: "proxy-proof" });

export async function readProxyProof(ctx: Pick<PluginContext, "state">, companyId: string): Promise<ProxyProof | null> {
  try {
    const value = (await ctx.state.get(proofState(companyId))) as Partial<ProxyProof> | null;
    if (!value || typeof value !== "object" || typeof value.ok !== "boolean" || typeof value.at !== "string") return null;
    return { ok: value.ok, at: value.at, detail: typeof value.detail === "string" ? value.detail : null, probe: typeof value.probe === "string" ? value.probe : null };
  } catch {
    return null;
  }
}

async function writeProxyProof(ctx: Pick<PluginContext, "state">, companyId: string, proof: ProxyProof): Promise<void> {
  await ctx.state.set(proofState(companyId), proof);
}

/** A passed check that is recent enough. Anything else (never checked, failed, stale, from the future) keeps the https link off. */
export function proofIsFresh(proof: ProxyProof | null, now: number): boolean {
  if (!proof?.ok) return false;
  const at = Date.parse(proof.at);
  return Number.isFinite(at) && at <= now + 60_000 && now - at <= PROXY_PROOF_MAX_AGE_MS;
}

/** True while the Mailbox may put its own https one-click link in a mail for this company. */
export async function oneClickReady(env: Pick<Env, "ctx" | "now">, companyId: string): Promise<boolean> {
  return proofIsFresh(await readProxyProof(env.ctx, companyId), env.now());
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The probe address for a company: the one-click address with the reserved probe token, or null without a base URL and a secret of 16+ characters. */
export async function probeUrl(loaded: LoadedConfig, companyId: string, probeId: string = randomUUID()): Promise<string | null> {
  const secret = await loaded.secrets.get("unsubscribe.secret").catch(() => null);
  if (!loaded.config.publicBaseUrl || !secret || secret.length < 16) return null;
  return oneClickUrl(loaded.config.publicBaseUrl, signUnsubscribeToken({ companyId, email: PROBE_EMAIL, senderKey: `${PROBE_SENDER_PREFIX}${probeId}` }, secret));
}

/**
 * Posts the probe to the Mailbox's own public address, like a mail client's
 * one-click POST (no special headers), and records whether the token arrived.
 * Null when the company has no unsubscribe secret or public base URL (nothing to
 * check). Never throws: every failure is a recorded `ok: false` with the reason.
 */
export async function probeUnsubscribeProxy(env: Pick<Env, "ctx" | "now">, companyId: string): Promise<ProxyProof | null> {
  const loaded = await loadMailboxConfig(env.ctx, companyId);
  const probeId = randomUUID();
  const url = await probeUrl(loaded, companyId, probeId);
  if (!url) return null;
  let problem: string | null = null;
  try {
    const res = await withTimeout(env.ctx.http.fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }), PROBE_TIMEOUT_MS);
    if (!res.ok) problem = `The Mailbox's own address answered HTTP ${res.status}, so the check could not run.`;
  } catch (error) {
    problem = `The Mailbox could not reach its own public address (${errorMessage(error).slice(0, 120)}).`;
  }
  if (!problem) {
    const proof = await readProxyProof(env.ctx, companyId);
    // This probe's own answer, not an older pass.
    if (proof?.ok && proof.probe === probeId) return proof;
    problem = "The request arrived without the token: the reverse proxy does not pass the request address on, so a one-click unsubscribe would do nothing. Add the rule from the Mailbox README.";
  }
  const failed: ProxyProof = { ok: false, at: new Date(env.now()).toISOString(), detail: problem };
  try {
    await writeProxyProof(env.ctx, companyId, failed);
  } catch (error) {
    env.ctx.logger.info("Could not record the unsubscribe proxy check", { error: errorMessage(error) });
  }
  return failed;
}

/** The hourly sweep: checks every given company that has the unsubscribe settings. Returns how many were checked. */
export async function probeCompanies(env: Pick<Env, "ctx" | "now">, companyIds: string[]): Promise<number> {
  let checked = 0;
  for (const companyId of companyIds) {
    try {
      if (await probeUnsubscribeProxy(env, companyId)) checked += 1;
    } catch (error) {
      env.ctx.logger.info("Unsubscribe proxy check skipped", { companyId, error: errorMessage(error) });
    }
  }
  return checked;
}

/**
 * The https unsubscribe address for a marketing send the caller gave none for:
 * only when an unsubscribe secret and the public base URL are set, there is
 * exactly one recipient (a link opts out one address) AND the proxy rule has
 * been proved (see the file header). Null otherwise: the mailto form stays.
 */
export async function ownOneClickUrl(env: Pick<Env, "ctx" | "now">, loaded: LoadedConfig, request: Pick<MailSendRequested, "to" | "cc" | "bcc" | "marketing">, companyId: string, senderKey: string): Promise<string | null> {
  if (request.marketing !== true) return null;
  const everyone = [...request.to, ...(request.cc ?? []), ...(request.bcc ?? [])];
  if (everyone.length !== 1 || !loaded.config.publicBaseUrl) return null;
  const secret = await loaded.secrets.get("unsubscribe.secret").catch(() => null);
  if (!secret || secret.length < 16) return null;
  if (!(await oneClickReady(env, companyId))) return null;
  return oneClickUrl(loaded.config.publicBaseUrl, signUnsubscribeToken({ companyId, email: everyone[0]!.email, senderKey }, secret));
}

export { UNSUBSCRIBE_ENDPOINT };
