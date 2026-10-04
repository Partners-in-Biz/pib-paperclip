/**
 * The public side of e-sign (audit Q1b-11, Q10-14): `POST /api/plugins/partnersinbiz.crm/webhooks/sign`.
 *
 * The signing page (a static file, see `esign-link.ts`) posts here, on the same origin, so no CORS is needed. The host
 * answers 200 when this returns and sends this module's error text back in a 502 body, which is how the page learns
 * that something the signer can fix is wrong; it cannot read any data back, which is why the page itself carries the
 * document. Three actions, all JSON, all small:
 *
 * - `view`    `{ action, pageId }`: the page was opened. Needs no token (the page id is already secret) and changes nothing
 *             but the "opened" status and count. A mail scanner that runs scripts can trigger it, so it proves nothing about who read it.
 * - `sign`    `{ action, pageId, token, typedName, consent: true, docSha256, consentSha256, t }`.
 * - `decline` `{ action, pageId, token, reason? }`.
 *
 * Checks, in order: size, JSON, the action, rate limits per visitor and per page, the page exists, then for sign and decline the
 * request must not come from this server itself, the token must be one that was made for this document, still live and
 * unexpired, the document must be open, and for a signature the text and the consent wording the signer saw must be
 * the ones on record, the box must be ticked, the name must be a name, and the page must have been open long enough to read.
 * Only one request can win a signature: the status change is a single guarded statement.
 *
 * A forged, expired, revoked or replayed link is refused with the same plain words, and a visitor who keeps trying is stopped.
 */
import { networkInterfaces } from "node:os";
import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { SIGN_ENDPOINT_KEY } from "./endpoints.js";
import { MIN_SIGN_MS } from "./esign-templates.js";
import { appendEvent } from "./esign-audit.js";
import { isPageId } from "./esign-pages.js";
import { applyDeclinedEffects, applySignedEffects, expireDoc, ensureSignedAudit } from "./esign.js";
import { isSignToken, publishPage } from "./esign-link.js";
import {
  countPublicHits,
  getDocByPage,
  moveDoc,
  recordPublicHit,
  revokeTokens,
  tokenByHash,
  tokenHash,
  useToken,
  type SignDocument,
} from "./esign-store.js";
import { asRecord } from "./db.js";
import { cleanText, clientIp, hashIp, headerValue } from "./lead-form.js";
import { ipSalt } from "./lead-capture.js";

export { SIGN_ENDPOINT_KEY };
/** The biggest request body read: a real one is a few hundred bytes. */
export const MAX_SIGN_BODY_BYTES = 4_096;
export { MIN_SIGN_MS };
/** An audit row for "opened" is written at most this often per document (the count still goes up). */
export const VIEW_LOG_GAP_MS = 10 * 60_000;

export const SIGN_RATE = {
  ipPerMinute: 20,
  ipPerHour: 120,
  pagePerHour: 60,
  /** Failed tries with a wrong or dead token from one visitor in an hour. */
  badTokenPerHour: 10,
  /** Sign or decline attempts on one document in an hour, however they ended. */
  attemptsPerDocHour: 12,
} as const;

/** The webhook answers with this when something the signer can fix is wrong; the host passes the message on in its 502 body. */
export class SignRejected extends Error {
  constructor(message: string, readonly outcome: string) {
    super(message);
    this.name = "SignRejected";
  }
}

const NOT_VALID = "This link is not valid, or it is no longer open. Ask the sender for a new one.";
const ERROR_GENERIC = "Something went wrong on our side. Please try again in a few minutes.";
const OPEN_FOR_SIGNING = ["awaiting_approval", "sent", "viewed"] as const;

/** A name a person would type: letters in it, not an address, not a handful of characters. */
export function cleanSignerName(value: unknown): string | null {
  const name = cleanText(value, 120);
  if (name.length < 2 || !/\p{L}/u.test(name)) return null;
  if (/https?:|www\.|@|<|>/i.test(name)) return null;
  return name;
}

function nameTokens(value: string): string[] {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((part) => part.length > 0);
}

/** Whether the typed name looks like the person the link went to: every word of the expected name appears in it. Null when there is no expected name. */
export function namesMatch(typed: string, expected: string | null): boolean | null {
  if (!expected) return null;
  const want = nameTokens(expected);
  if (want.length === 0) return null;
  const have = new Set(nameTokens(typed));
  return want.every((part) => have.has(part));
}

/** Addresses of this machine: a request that comes from one of them did not come from a client's browser. */
export function serverAddresses(): Set<string> {
  const own = new Set(["127.0.0.1", "::1", "0.0.0.0", "::"]);
  try {
    for (const list of Object.values(networkInterfaces())) for (const entry of list ?? []) own.add(entry.address.toLowerCase().replace(/^::ffff:/, "").replace(/%.*$/, ""));
  } catch {
    // an unreadable interface list leaves the loopback names
  }
  return own;
}

export interface SignWebhookOptions {
  now?: Date;
  /** Tests: addresses that count as this server. */
  serverIps?: ReadonlySet<string>;
}

export type SignWebhookResult =
  | { status: "viewed" | "noop"; documentId: string }
  | { status: "signed"; documentId: string; effects: Promise<string[]> }
  | { status: "declined"; documentId: string; effects: Promise<void> };

async function overLimit(ctx: PluginContext, pageId: string, ipHash: string | null, now: Date): Promise<boolean> {
  const minuteAgo = new Date(now.getTime() - 60_000).toISOString();
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  if (ipHash) {
    if ((await countPublicHits(ctx, SIGN_ENDPOINT_KEY, minuteAgo, SIGN_RATE.ipPerMinute, { ipHash })) >= SIGN_RATE.ipPerMinute) return true;
    if ((await countPublicHits(ctx, SIGN_ENDPOINT_KEY, hourAgo, SIGN_RATE.ipPerHour, { ipHash })) >= SIGN_RATE.ipPerHour) return true;
    if ((await countPublicHits(ctx, SIGN_ENDPOINT_KEY, hourAgo, SIGN_RATE.badTokenPerHour, { ipHash, outcome: "bad_token" })) >= SIGN_RATE.badTokenPerHour) return true;
  }
  if (pageId && (await countPublicHits(ctx, SIGN_ENDPOINT_KEY, hourAgo, SIGN_RATE.pagePerHour, { subject: pageId })) >= SIGN_RATE.pagePerHour) return true;
  return false;
}

/** One delivery to the signing endpoint. Throws `SignRejected` with a plain message; returns what it did. */
export async function handleSignWebhook(ctx: PluginContext, input: PluginWebhookInput, options: SignWebhookOptions = {}): Promise<SignWebhookResult> {
  const now = options.now ?? new Date();
  if (input.endpointKey !== SIGN_ENDPOINT_KEY) throw new SignRejected("Unknown endpoint.", "unknown");
  if (Buffer.byteLength(input.rawBody ?? "", "utf8") > MAX_SIGN_BODY_BYTES) throw new SignRejected("The request is too large.", "too_large");
  const body = asRecord(input.parsedBody);
  if (Object.keys(body).length === 0) throw new SignRejected("Send a JSON body (content-type: application/json).", "invalid");
  const action = body.action;
  if (action !== "view" && action !== "sign" && action !== "decline") throw new SignRejected("The request is not one this page sends.", "invalid");
  const pageId = body.pageId;
  if (!isPageId(pageId)) throw new SignRejected(NOT_VALID, "invalid");

  const ip = clientIp(input.headers);
  let ipHash: string | null = null;
  try {
    ipHash = ip ? hashIp(await ipSalt(ctx), ip) : null;
    if (await overLimit(ctx, pageId, ipHash, now)) throw new SignRejected("Too many attempts. Please wait a few minutes and try again.", "rate_limited");
  } catch (error) {
    if (error instanceof SignRejected) throw error;
    ctx.logger.error("CRM signing endpoint limit check failed", { error: error instanceof Error ? error.message : String(error) });
    throw new SignRejected(ERROR_GENERIC, "error");
  }

  let doc: SignDocument | null;
  try {
    doc = await getDocByPage(ctx, pageId);
  } catch (error) {
    ctx.logger.error("CRM signing page lookup failed", { error: error instanceof Error ? error.message : String(error) });
    throw new SignRejected(ERROR_GENERIC, "error");
  }
  if (!doc) {
    await recordPublicHit(ctx, SIGN_ENDPOINT_KEY, "unknown", ipHash, "unknown_page").catch(() => undefined);
    throw new SignRejected(NOT_VALID, "unknown_page");
  }

  try {
    const result = action === "view" ? await view(ctx, doc, ipHash, headerValue(input.headers, "user-agent"), now) : await decide(ctx, doc, action, body, { ip, ipHash, userAgent: headerValue(input.headers, "user-agent") ?? "", now, serverIps: options.serverIps ?? serverAddresses() });
    await recordPublicHit(ctx, SIGN_ENDPOINT_KEY, pageId, ipHash, result.status).catch(() => undefined);
    return result;
  } catch (error) {
    if (error instanceof SignRejected) {
      await recordPublicHit(ctx, SIGN_ENDPOINT_KEY, pageId, ipHash, error.outcome).catch(() => undefined);
      throw error;
    }
    ctx.logger.error("CRM signing endpoint failed", { documentId: doc.id, error: error instanceof Error ? error.message : String(error) });
    await recordPublicHit(ctx, SIGN_ENDPOINT_KEY, pageId, ipHash, "error").catch(() => undefined);
    throw new SignRejected(ERROR_GENERIC, "error");
  }
}

/** The page was opened: first time moves the status to viewed; every time counts. */
async function view(ctx: PluginContext, doc: SignDocument, ipHash: string | null, userAgent: string | undefined, now: Date): Promise<SignWebhookResult> {
  if (!(OPEN_FOR_SIGNING as readonly string[]).includes(doc.status)) return { status: "noop", documentId: doc.id };
  if (doc.expiresAt && Date.parse(doc.expiresAt) <= now.getTime()) {
    await expireDoc(ctx, doc);
    return { status: "noop", documentId: doc.id };
  }
  const first = doc.viewedAt == null;
  const moved = await moveDoc(ctx, doc.companyId, doc.id, [...OPEN_FOR_SIGNING], { status: "viewed", viewedAt: doc.viewedAt ?? now.toISOString(), lastViewedAt: now.toISOString(), viewCount: doc.viewCount + 1 });
  if (!moved) return { status: "noop", documentId: doc.id };
  const gap = doc.lastViewedAt ? now.getTime() - Date.parse(doc.lastViewedAt) : Number.POSITIVE_INFINITY;
  if (first || gap > VIEW_LOG_GAP_MS) await appendEvent(ctx, doc, { kind: "viewed", actor: "signer", ipHash, userAgent: userAgent ? cleanText(userAgent, 300) : null, detail: { views: doc.viewCount + 1 } });
  return { status: "viewed", documentId: doc.id };
}

interface Visitor {
  ip: string | null;
  ipHash: string | null;
  userAgent: string;
  now: Date;
  serverIps: ReadonlySet<string>;
}

async function decide(ctx: PluginContext, doc: SignDocument, action: "sign" | "decline", body: Record<string, unknown>, visitor: Visitor): Promise<SignWebhookResult> {
  const { now } = visitor;
  // A signature must come from a client's own browser through the proxy: a request with no address, or from this machine, is refused.
  if (!visitor.ip || visitor.serverIps.has(visitor.ip.toLowerCase())) throw new SignRejected("This request did not come from a web browser, so it was not accepted.", "not_a_browser");
  if (visitor.userAgent.trim().length < 8) throw new SignRejected("This request did not come from a web browser, so it was not accepted.", "not_a_browser");

  // The link: made for this document, never revoked, not run out. Everything else looks the same to the sender of it.
  const token = body.token;
  if (!isSignToken(token)) throw new SignRejected(NOT_VALID, "bad_token");
  const row = await tokenByHash(ctx, tokenHash(token)).catch(() => null);
  if (!row || row.docId !== doc.id || row.companyId !== doc.companyId || row.revokedAt || (row.expiresAt && Date.parse(row.expiresAt) <= now.getTime())) throw new SignRejected(NOT_VALID, "bad_token");

  if (doc.status === "signed") throw new SignRejected("This document has already been signed. Thank you.", "already_signed");
  if (doc.status === "declined") throw new SignRejected("This document was declined and can no longer be signed.", "closed");
  if (doc.status === "void") throw new SignRejected("This document was withdrawn by the sender and can no longer be signed.", "closed");
  if (!(OPEN_FOR_SIGNING as readonly string[]).includes(doc.status)) throw new SignRejected(NOT_VALID, "closed");
  if (doc.expiresAt && Date.parse(doc.expiresAt) <= now.getTime()) {
    await expireDoc(ctx, doc);
    throw new SignRejected("This link has expired. Ask the sender for a new one.", "expired");
  }
  const tries = await countPublicHits(ctx, SIGN_ENDPOINT_KEY, new Date(now.getTime() - 3_600_000).toISOString(), SIGN_RATE.attemptsPerDocHour, { subject: doc.pageId, outcome: "refused" });
  if (tries >= SIGN_RATE.attemptsPerDocHour) throw new SignRejected("Too many attempts on this document. Please wait an hour.", "rate_limited");

  if (action === "decline") return declineDoc(ctx, doc, body, visitor, tokenHash(token));
  return signDoc(ctx, doc, body, visitor, tokenHash(token));
}

async function signDoc(ctx: PluginContext, doc: SignDocument, body: Record<string, unknown>, visitor: Visitor, hash: string): Promise<SignWebhookResult> {
  const refuse = (message: string) => new SignRejected(message, "refused");
  if (body.consent !== true) throw refuse("Please tick the box to say you agree, then sign.");
  const name = cleanSignerName(body.typedName);
  if (!name) throw refuse("Please type your full name.");
  if (body.docSha256 !== doc.contentSha256) throw refuse("The document you are looking at is not the one on record. Reload the page from your email link.");
  if (body.consentSha256 !== doc.consentSha256) throw refuse("The wording you agreed to is not the one on record. Reload the page from your email link.");
  const elapsed = typeof body.t === "number" && Number.isFinite(body.t) ? body.t : null;
  if (elapsed === null || elapsed < MIN_SIGN_MS) throw refuse("Please read the document before you sign.");

  const at = visitor.now.toISOString();
  const agent = cleanText(visitor.userAgent, 300);
  const won = await moveDoc(ctx, doc.companyId, doc.id, [...OPEN_FOR_SIGNING], {
    status: "signed",
    signedAt: at,
    signerName: name,
    signerIpHash: visitor.ipHash,
    signerUserAgent: agent,
    nameMatches: namesMatch(name, doc.recipientName),
    nextReminderAt: null,
    sentAt: doc.sentAt ?? at,
    viewedAt: doc.viewedAt ?? at,
  });
  if (!won) {
    // Another request signed, declined or withdrew it a moment ago. Say what is true now.
    throw new SignRejected("This document is no longer open for signing.", "closed");
  }
  await useToken(ctx, hash).catch(() => false);
  await revokeTokens(ctx, doc.companyId, doc.id);
  // The trail, the page and the signed copy are written before the answer; everything that follows (the deal, Billing, the email draft) runs on its own.
  let signed: SignDocument = { ...doc, status: "signed", signedAt: at, signerName: name, signerIpHash: visitor.ipHash, signerUserAgent: agent, nameMatches: namesMatch(name, doc.recipientName), auditHead: null };
  try {
    signed = await ensureSignedAudit(ctx, signed);
    const written = publishPage(signed);
    if (!written.ok) ctx.logger.info("CRM signed page not written", { documentId: doc.id, reason: written.reason });
  } catch (error) {
    ctx.logger.error("CRM signature trail not finished; the care job finishes it", { documentId: doc.id, error: error instanceof Error ? error.message : String(error) });
  }
  const effects = applySignedEffects(ctx, signed).catch((error) => {
    ctx.logger.error("CRM signature follow-up failed; the care job retries", { documentId: doc.id, error: error instanceof Error ? error.message : String(error) });
    return ["follow-up"];
  });
  return { status: "signed", documentId: doc.id, effects };
}

async function declineDoc(ctx: PluginContext, doc: SignDocument, body: Record<string, unknown>, visitor: Visitor, hash: string): Promise<SignWebhookResult> {
  const reason = cleanText(body.reason, 500) || null;
  const at = visitor.now.toISOString();
  const won = await moveDoc(ctx, doc.companyId, doc.id, [...OPEN_FOR_SIGNING], { status: "declined", declinedAt: at, declineReason: reason, nextReminderAt: null });
  if (!won) throw new SignRejected("This document is no longer open.", "closed");
  await useToken(ctx, hash).catch(() => false);
  await revokeTokens(ctx, doc.companyId, doc.id);
  const declined: SignDocument = { ...doc, status: "declined", declinedAt: at, declineReason: reason };
  await appendEvent(ctx, doc, { kind: "declined", actor: "signer", at, ipHash: visitor.ipHash, userAgent: cleanText(visitor.userAgent, 300), detail: { reason } });
  publishPage(declined);
  const effects = applyDeclinedEffects(ctx, declined).catch((error) => ctx.logger.info("CRM decline follow-up failed", { documentId: doc.id, error: error instanceof Error ? error.message : String(error) }));
  return { status: "declined", documentId: doc.id, effects };
}
