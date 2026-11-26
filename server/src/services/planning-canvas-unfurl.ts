import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  PLANNING_CANVAS_LIMITS as L,
  planningCanvasWebLinkUrlProblem,
  type PlanningCanvasWebLinkPreview,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { createInviteRateLimiter } from "./invite-rate-limit.js";
import { isLegacyIpv6EmbeddedOrReserved, isPrivateOrReservedIp, type RemoteHttpEndpointLookup } from "./remote-http-endpoint-guard.js";
import { guardedRemoteHttpFetch, type GuardedRemoteHttpFetchOptions } from "./remote-http-fetch.js";

/**
 * Web link preview fetch (plan PAR-14389 C.5 "Preview fetch", "Rate limit",
 * "Outbound guard" steps 1 to 9; D3). A strict wrapper over
 * `guardedRemoteHttpFetch`: the route reads the URL from the stored node and
 * calls this only on a person's click, behind `PLANNING_CANVAS_UNFURL`.
 * Every failure is the same `null`; the reason is logged with the host only.
 */

export const UNFURL_DEADLINE_MS = 5_000;
export const UNFURL_MAX_BODY_BYTES = 512 * 1024;
export const UNFURL_MAX_REDIRECTS = 3;
export const UNFURL_USER_AGENT = "PaperclipLinkPreview/1.0";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

export type PlanningCanvasUnfurlFetch = (url: URL, init: RequestInit, options: GuardedRemoteHttpFetchOptions) => Promise<Response>;

export interface PlanningCanvasUnfurlDeps {
  /** The name lookup under the strict address rule (default: the system resolver). */
  lookup?: RemoteHttpEndpointLookup;
  /** Test seam over the guarded fetch; production uses `guardedRemoteHttpFetch`. */
  fetch?: PlanningCanvasUnfurlFetch;
  deadlineMs?: number;
  now?: () => Date;
  /** Where a refusal is reported: the host and a reason, never the path or query. */
  log?: (host: string, reason: string) => void;
}

class UnfurlRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Step 2: an address may be dialled only when it is public IPv4 by `isPrivateOrReservedIp`, or
 * IPv6 inside `2000::/3`, outside `3ffe::/16` and not refused by `isPrivateOrReservedIp`. That
 * refuses `::7f00:1`, `::ffff:0:7f00:1`, `fec0::1` and `3ffe::1` here, whatever PAR-14396 decides.
 */
export function planningCanvasUnfurlAddressAllowed(address: string): boolean {
  const raw = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (raw.includes("%")) return false;
  if (isIP(raw) === 4) return !isPrivateOrReservedIp(raw);
  if (isIP(raw) !== 6) return false;
  // The canonical compressed form, so the prefix checks of `isPrivateOrReservedIp` see `2001:db8::`, not `2001:0db8::`.
  const ip = new URL(`https://[${raw}]/`).hostname.slice(1, -1);
  const first = ip.startsWith("::") ? 0 : Number.parseInt(ip.split(":")[0] ?? "", 16);
  if (!Number.isInteger(first) || (first & 0xe000) !== 0x2000 || first === 0x3ffe) return false;
  return !isLegacyIpv6EmbeddedOrReserved(ip) && !isPrivateOrReservedIp(ip);
}

/** Step 1, on the first URL and on every hop: https, no userinfo, the default port, a name (no IP literal). */
function hopProblem(url: URL): string | null {
  if (url.protocol !== "https:") return "not_https";
  if (url.username || url.password) return "userinfo";
  if (url.port !== "") return "port";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || isIP(host) !== 0) return "ip_literal";
  return null;
}

function defaultLookup(hostname: string) {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

/** Step 6: status 200, an HTML type, and charset absent or UTF-8. */
function htmlProblem(response: Response): string | null {
  if (response.status !== 200) return "status";
  const [type = "", ...params] = (response.headers.get("content-type") ?? "").split(";").map((part) => part.trim().toLowerCase());
  if (!HTML_TYPES.has(type)) return "content_type";
  const charset = params.find((param) => param.startsWith("charset="))?.slice("charset=".length).replace(/^"|"$/g, "");
  if (charset !== undefined && charset !== "utf-8" && charset !== "utf8") return "charset";
  return null;
}

/** Step 7: the decoded body (after the guard's gunzip), cancelled past the cap. */
async function readCapped(response: Response, track: (reader: ReadableStreamDefaultReader<Uint8Array>) => void): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  track(reader);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > UNFURL_MAX_BODY_BYTES) throw new UnfurlRefused("too_large");
    chunks.push(value);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new UnfurlRefused("charset");
  }
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
// C0, C1, zero-width, bidi overrides and isolates, and the byte-order mark.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

function decodeEntities(text: string): string {
  // One pass, so `&amp;lt;` stays `&lt;` as text.
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, name: string) => {
    if (name[0] !== "#") return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "";
  });
}

function cleanText(raw: string | undefined, max: number): string {
  if (!raw) return "";
  const text = decodeEntities(raw).replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

const META_TAG = /<meta\b([^>]{0,2000})>/gi;
const ATTRIBUTE = /([^\s"'=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
const OG_KEYS = new Set(["og:title", "og:description", "og:site_name"]);

/**
 * Step 8: a bounded scan (no DOM library) for `<title>`, `og:title`, `og:description` and
 * `og:site_name`. The result is plain text: markup inside a title stays as characters.
 */
export function parsePlanningCanvasWebLinkHtml(html: string): Omit<PlanningCanvasWebLinkPreview, "fetchedAt"> | null {
  const og: Record<string, string> = {};
  let seen = 0;
  for (const match of html.matchAll(META_TAG)) {
    if (++seen > 1000) break;
    const attrs: Record<string, string> = {};
    for (const attr of (match[1] ?? "").matchAll(ATTRIBUTE)) {
      attrs[attr[1]!.toLowerCase()] ??= attr[2] ?? attr[3] ?? attr[4] ?? "";
    }
    const key = (attrs.property ?? attrs.name ?? "").trim().toLowerCase();
    if (OG_KEYS.has(key) && og[key] === undefined && attrs.content !== undefined) og[key] = attrs.content;
  }
  const titleTag = /<title\b[^>]{0,500}>([\s\S]{0,4000}?)<\/title\s*>/i.exec(html)?.[1];
  const preview = {
    title: cleanText(og["og:title"], L.webLinkPreviewTitleMaxLength) || cleanText(titleTag, L.webLinkPreviewTitleMaxLength),
    description: cleanText(og["og:description"], L.webLinkPreviewDescriptionMaxLength),
    siteName: cleanText(og["og:site_name"], L.webLinkPreviewSiteNameMaxLength),
  };
  return preview.title || preview.description || preview.siteName ? preview : null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid";
  }
}

/**
 * Fetches the preview text of a stored web link URL, or null. One 5-second deadline covers DNS,
 * connect, every hop and the body (step 5); redirects are followed by hand, at most 3 (step 4).
 */
export async function fetchPlanningCanvasWebLinkPreview(storedUrl: string, deps: PlanningCanvasUnfurlDeps = {}): Promise<PlanningCanvasWebLinkPreview | null> {
  const deadlineMs = deps.deadlineMs ?? UNFURL_DEADLINE_MS;
  const startedAt = Date.now();
  const controller = new AbortController();
  const state: { host: string; reason?: string; reader?: ReadableStreamDefaultReader<Uint8Array>; body?: ReadableStream | null } = { host: hostOf(storedUrl) };
  const baseLookup = deps.lookup ?? defaultLookup;
  const fetchHop = deps.fetch ?? ((url, init, options) => guardedRemoteHttpFetch(url, init, options));
  // The guard's own timeouts are backstops just past the one deadline, so the race below always decides (step 5).
  const backstop = () => Math.max(1, deadlineMs - (Date.now() - startedAt)) + 1_000;

  // Step 2: the whole answer is refused unless every address passes.
  const lookup: RemoteHttpEndpointLookup = async (hostname) => {
    const answers = await baseLookup(hostname);
    if (answers.length === 0 || answers.some((answer) => !planningCanvasUnfurlAddressAllowed(answer.address))) {
      state.reason = "address_refused";
      throw new UnfurlRefused("address_refused");
    }
    return answers;
  };

  const work = async (): Promise<PlanningCanvasWebLinkPreview> => {
    if (planningCanvasWebLinkUrlProblem(storedUrl)) throw new UnfurlRefused("stored_url");
    let url = new URL(storedUrl);
    for (let redirects = 0; ; redirects += 1) {
      state.host = url.hostname;
      const problem = hopProblem(url);
      if (problem) throw new UnfurlRefused(problem);
      // Step 3: GET, exactly these headers, nothing carried between hops.
      const response = await fetchHop(url, {
        method: "GET",
        headers: { accept: "text/html", "accept-encoding": "identity", "user-agent": UNFURL_USER_AGENT },
        redirect: "manual",
        signal: controller.signal,
      }, {
        allowPrivateNetwork: false,
        lookup,
        dnsTimeoutMs: backstop(),
        connectTimeoutMs: backstop(),
        responseTimeoutMs: backstop(),
        error: (_message, code) => new UnfurlRefused(code),
      });
      state.body = response.body;
      if (REDIRECT_STATUSES.has(response.status)) {
        void response.body?.cancel().catch(() => {});
        if (redirects >= UNFURL_MAX_REDIRECTS) throw new UnfurlRefused("too_many_redirects");
        const location = response.headers.get("location");
        if (!location) throw new UnfurlRefused("redirect_without_location");
        try {
          url = new URL(location, url);
        } catch {
          throw new UnfurlRefused("bad_location");
        }
        continue;
      }
      const htmlIssue = htmlProblem(response);
      if (htmlIssue) throw new UnfurlRefused(htmlIssue);
      const parsed = parsePlanningCanvasWebLinkHtml(await readCapped(response, (reader) => (state.reader = reader)));
      if (!parsed) throw new UnfurlRefused("no_preview_text");
      return { ...parsed, fetchedAt: (deps.now?.() ?? new Date()).toISOString() };
    }
  };

  let timer: NodeJS.Timeout | undefined;
  const running = work();
  running.catch(() => {});
  try {
    return await Promise.race([
      running,
      new Promise<never>((_, reject) => {
        // The signal does not cover the DNS lookup, so the race holds the deadline for everything.
        timer = setTimeout(() => {
          controller.abort();
          reject(new UnfurlRefused("deadline"));
        }, deadlineMs);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    const reason = state.reason ?? (error instanceof UnfurlRefused ? error.reason : "fetch_failed");
    (deps.log ?? ((host, why) => logger.info({ host, reason: why }, "planning canvas link preview refused")))(state.host, reason);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    if (state.reader) void state.reader.cancel().catch(() => {});
    else if (state.body && !state.body.locked) void state.body.cancel().catch(() => {});
  }
}

export interface PlanningCanvasUnfurlGateOptions {
  perHour?: number;
  personInFlight?: number;
  processInFlight?: number;
  now?: () => number;
}

export type PlanningCanvasUnfurlTicket =
  | { ok: true; release: () => void }
  | { ok: false; refusal: "busy" }
  | { ok: false; refusal: "rate"; retryAfterSeconds: number };

/**
 * Rate limit (C.5): 30 per person per company per hour (not per board), at most 2 in flight per
 * person and 6 per process. In memory, per process; counters reset on a restart.
 */
export function createPlanningCanvasUnfurlGate(options: PlanningCanvasUnfurlGateOptions = {}) {
  const hourly = createInviteRateLimiter({ windowMs: 60 * 60_000, maxRequests: options.perHour ?? 30, now: options.now });
  const personInFlight = options.personInFlight ?? 2;
  const processInFlight = options.processInFlight ?? 6;
  const inFlight = new Map<string, number>();
  let total = 0;
  return {
    tryStart(companyId: string, userId: string): PlanningCanvasUnfurlTicket {
      // In-flight first, so a refused "busy" click does not use up the hourly allowance.
      if (total >= processInFlight || (inFlight.get(userId) ?? 0) >= personInFlight) return { ok: false, refusal: "busy" };
      const limit = hourly.consume(JSON.stringify([companyId, userId]));
      if (!limit.allowed) return { ok: false, refusal: "rate", retryAfterSeconds: limit.retryAfterSeconds };
      total += 1;
      inFlight.set(userId, (inFlight.get(userId) ?? 0) + 1);
      let released = false;
      return {
        ok: true,
        release: () => {
          if (released) return;
          released = true;
          total -= 1;
          const left = (inFlight.get(userId) ?? 1) - 1;
          if (left > 0) inFlight.set(userId, left);
          else inFlight.delete(userId);
        },
      };
    },
  };
}
