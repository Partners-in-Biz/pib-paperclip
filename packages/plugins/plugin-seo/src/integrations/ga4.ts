/**
 * Google Analytics 4, read only, through the same Google service account as Search Console.
 *
 * - The Data API (`runReport`) gives weekly sessions, engaged sessions, key events, organic landing pages, source /
 *   medium and AI-assistant referrals. Five small reports cover the whole period whatever the number of weeks (the
 *   `isoYearIsoWeek` dimension groups them).
 * - The Admin API (`accountSummaries`, `dataStreams`) lets the plugin find a client's property by its site address
 *   once the client has added the service account, so nobody has to look an id up. Both APIs must be enabled once in
 *   the service account's Google Cloud project.
 *
 * Native `fetch` against fixed Google hosts (no SSRF risk), injectable for tests. Never writes to a property.
 */
import { addDays } from "../engine/time.js";
import { GoogleApiError, type FetchLike } from "./google.js";

export const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const DATA_API = "https://analyticsdata.googleapis.com/v1beta";
const ADMIN_API = "https://analyticsadmin.googleapis.com/v1beta";

export type Ga4ErrorKind = "api_disabled" | "no_access" | "bad_property" | "quota" | "other";

export class Ga4Error extends GoogleApiError {
  constructor(message: string, status: number, readonly kind: Ga4ErrorKind) {
    super(message, status, false);
    this.name = "Ga4Error";
  }
}

/** The numeric id of a GA4 property from what a person pastes: `123456789`, `properties/123456789`, or an Analytics address. */
export function parseGa4PropertyId(input: string): { ok: true; id: string } | { ok: false; reason: string } {
  const text = input.trim();
  if (/^G-[A-Z0-9]+$/i.test(text)) return { ok: false, reason: `${text} is a measurement ID (it starts with G-), not the property ID. The property ID is the number under Admin → Property settings → Property ID.` };
  if (/^UA-\d+/i.test(text)) return { ok: false, reason: "UA- numbers belong to Universal Analytics, which Google switched off in 2023. Use the GA4 property ID: the number under Admin → Property settings → Property ID." };
  const found = /^(?:properties\/)?p?(\d{6,12})$/i.exec(text) ?? /[#/]a\d+w\d+p(\d{6,12})\b/.exec(text) ?? /[#/]p(\d{6,12})(?:\/|$)/.exec(text);
  if (!found) return { ok: false, reason: `"${text.slice(0, 60)}" is not a GA4 property ID. It is a number of 6 to 12 digits (Admin → Property settings → Property ID), also accepted as properties/<number>.` };
  return { ok: true, id: found[1]! };
}

export function propertyName(id: string): string {
  return `properties/${id}`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function timed(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs = 25_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Ga4Error(`Google Analytics did not answer within ${Math.round(timeoutMs / 1000)} s`, 504, "other");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

/** Sort Google's answer into what a person has to do about it. */
export function classifyGa4Error(status: number, body: Record<string, unknown>): { kind: Ga4ErrorKind; message: string } {
  const err = (body.error && typeof body.error === "object" ? body.error : {}) as Record<string, unknown>;
  const message = typeof err.message === "string" ? err.message : typeof body.error === "string" ? body.error : `HTTP ${status}`;
  const code = typeof err.status === "string" ? err.status : "";
  const reasons = JSON.stringify(err.details ?? "");
  if (status === 403 && (/SERVICE_DISABLED|accessNotConfigured/.test(`${code} ${reasons}`) || /has not been used in project|is disabled|API has not been used/i.test(message))) return { kind: "api_disabled", message };
  if (status === 403 || status === 401) return { kind: "no_access", message };
  if (status === 400 || status === 404) return { kind: "bad_property", message };
  if (status === 429) return { kind: "quota", message };
  return { kind: "other", message };
}

async function call(fetchImpl: FetchLike, token: string, method: "GET" | "POST", url: string, label: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await timed(fetchImpl, url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await readJson(res);
  if (!res.ok) {
    const { kind, message } = classifyGa4Error(res.status, json);
    throw new Ga4Error(`${label}: ${message}`, res.status, kind);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export interface Ga4Row {
  dims: string[];
  metrics: number[];
}

export interface ReportRequest {
  dateRanges: Array<{ startDate: string; endDate: string }>;
  dimensions?: Array<{ name: string }>;
  metrics: Array<{ name: string }>;
  dimensionFilter?: unknown;
  metricFilter?: unknown;
  orderBys?: unknown[];
  limit?: number;
}

export function ga4Rows(body: Record<string, unknown>): Ga4Row[] {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  return rows.map((raw) => {
    const row = raw as { dimensionValues?: Array<{ value?: unknown }>; metricValues?: Array<{ value?: unknown }> };
    return {
      dims: (row.dimensionValues ?? []).map((d) => String(d.value ?? "")),
      metrics: (row.metricValues ?? []).map((m) => {
        const n = Number(m.value ?? 0);
        return Number.isFinite(n) ? n : 0;
      }),
    };
  });
}

export async function runReport(fetchImpl: FetchLike, token: string, propertyId: string, request: ReportRequest): Promise<Ga4Row[]> {
  const body = await call(fetchImpl, token, "POST", `${DATA_API}/${propertyName(propertyId)}:runReport`, "Google Analytics", request);
  return ga4Rows(body);
}

/** The smallest report there is: proves the service account can read the property and the Data API is on. */
export async function probeGa4Property(fetchImpl: FetchLike, token: string, propertyId: string, today: string): Promise<{ sessionsLast7Days: number }> {
  const rows = await runReport(fetchImpl, token, propertyId, { dateRanges: [{ startDate: addDays(today, -7), endDate: addDays(today, -1) }], metrics: [{ name: "sessions" }], limit: 1 });
  return { sessionsLast7Days: rows[0]?.metrics[0] ?? 0 };
}

export interface Ga4Metrics {
  sessions: number;
  engagedSessions: number;
  users: number;
  keyEvents: number;
}

export interface Ga4Week extends Ga4Metrics {
  /** The Monday of the ISO week. */
  weekStart: string;
  /** Sessions whose default channel group is Organic Search. */
  organic: Ga4Metrics;
  channels: Array<{ channel: string; sessions: number; engagedSessions: number; keyEvents: number }>;
  /** Organic landing pages (top 25 by sessions); `path` has no query string. */
  landingPages: Array<{ path: string; sessions: number; engagedSessions: number; keyEvents: number }>;
  sources: Array<{ source: string; sessions: number; engagedSessions: number; keyEvents: number }>;
  keyEventNames: Array<{ name: string; count: number }>;
  /** Sessions that came from an AI assistant (ChatGPT, Perplexity, Gemini, Copilot, Claude …). */
  aiReferrals: Array<{ assistant: string; sessions: number; keyEvents: number }>;
}

export const ORGANIC_CHANNEL = "Organic Search";
const LANDING_PAGES_PER_WEEK = 25;
const SOURCES_PER_WEEK = 15;

/** The Monday of an ISO week code such as `202641` (ISO year 2026, week 41). */
export function isoWeekMonday(code: string | number): string | null {
  const text = String(code);
  if (!/^\d{6}$/.test(text)) return null;
  const year = Number(text.slice(0, 4));
  const week = Number(text.slice(4));
  if (week < 1 || week > 53) return null;
  // Week 1 is the week with January 4th: its Monday is the 4th minus (weekday - 1).
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const weekday = jan4.getUTCDay() || 7;
  const monday = Date.UTC(year, 0, 4 - (weekday - 1) + (week - 1) * 7);
  return new Date(monday).toISOString().slice(0, 10);
}

const AI_SOURCES: Array<[RegExp, string]> = [
  [/chatgpt\.com|chat\.openai\.com|^openai$/i, "ChatGPT"],
  [/perplexity/i, "Perplexity"],
  [/gemini\.google\.com|bard\.google\.com|^gemini$/i, "Gemini"],
  [/copilot\.microsoft\.com|copilot\.cloud\.microsoft|^copilot$/i, "Copilot"],
  [/claude\.ai|^claude$/i, "Claude"],
  [/(^|\.)you\.com$|phind\.com|poe\.com|meta\.ai|duck\.ai/i, "Other AI assistants"],
];

/** The assistant a `source / medium` value (or a bare source) belongs to, or null when it is not an AI assistant. */
export function aiAssistantOf(sourceMedium: string): string | null {
  const source = sourceMedium.split(" / ")[0]!.trim();
  return AI_SOURCES.find(([re]) => re.test(source))?.[1] ?? null;
}

const weekRange = (weekStarts: string[]) => ({ startDate: weekStarts[0]!, endDate: addDays(weekStarts[weekStarts.length - 1]!, 6) });
const BY_SESSIONS = [{ metric: { metricName: "sessions" }, desc: true }];

/**
 * Weekly numbers for the given Mondays (ascending, completed weeks): five reports, however many weeks. `engaged`
 * sessions and `keyEvents` are GA4's own names; a property with no key events reports zeros.
 */
export async function fetchGa4Weeks(fetchImpl: FetchLike, token: string, propertyId: string, weekStarts: string[]): Promise<Ga4Week[]> {
  if (weekStarts.length === 0) return [];
  const dateRanges = [weekRange(weekStarts)];
  const week = { name: "isoYearIsoWeek" };
  const core = [{ name: "sessions" }, { name: "engagedSessions" }, { name: "keyEvents" }];
  const [totals, channels, pages, sources, events] = [
    await runReport(fetchImpl, token, propertyId, { dateRanges, dimensions: [week], metrics: [...core, { name: "totalUsers" }], limit: 100 }),
    await runReport(fetchImpl, token, propertyId, { dateRanges, dimensions: [week, { name: "sessionDefaultChannelGroup" }], metrics: [...core, { name: "totalUsers" }], limit: 1000 }),
    await runReport(fetchImpl, token, propertyId, {
      dateRanges,
      dimensions: [week, { name: "landingPage" }],
      metrics: core,
      dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { matchType: "EXACT", value: ORGANIC_CHANNEL } } },
      orderBys: BY_SESSIONS,
      limit: 1000,
    }),
    await runReport(fetchImpl, token, propertyId, { dateRanges, dimensions: [week, { name: "sessionSourceMedium" }], metrics: core, orderBys: BY_SESSIONS, limit: 1000 }),
    await runReport(fetchImpl, token, propertyId, {
      dateRanges,
      dimensions: [week, { name: "eventName" }],
      metrics: [{ name: "keyEvents" }],
      metricFilter: { filter: { fieldName: "keyEvents", numericFilter: { operation: "GREATER_THAN", value: { int64Value: "0" } } } },
      limit: 500,
    }),
  ];
  const wanted = new Set(weekStarts);
  const byWeek = new Map<string, Ga4Week>();
  const weekOf = (code: string | undefined): Ga4Week | null => {
    const monday = code ? isoWeekMonday(code) : null;
    if (!monday || !wanted.has(monday)) return null;
    let w = byWeek.get(monday);
    if (!w) {
      w = { weekStart: monday, sessions: 0, engagedSessions: 0, users: 0, keyEvents: 0, organic: { sessions: 0, engagedSessions: 0, users: 0, keyEvents: 0 }, channels: [], landingPages: [], sources: [], keyEventNames: [], aiReferrals: [] };
      byWeek.set(monday, w);
    }
    return w;
  };
  for (const row of totals) {
    const w = weekOf(row.dims[0]);
    if (w) Object.assign(w, { sessions: row.metrics[0] ?? 0, engagedSessions: row.metrics[1] ?? 0, keyEvents: row.metrics[2] ?? 0, users: row.metrics[3] ?? 0 });
  }
  for (const row of channels) {
    const w = weekOf(row.dims[0]);
    if (!w) continue;
    const channel = row.dims[1] || "(not set)";
    w.channels.push({ channel, sessions: row.metrics[0] ?? 0, engagedSessions: row.metrics[1] ?? 0, keyEvents: row.metrics[2] ?? 0 });
    if (channel === ORGANIC_CHANNEL) w.organic = { sessions: row.metrics[0] ?? 0, engagedSessions: row.metrics[1] ?? 0, keyEvents: row.metrics[2] ?? 0, users: row.metrics[3] ?? 0 };
  }
  for (const row of pages) {
    const w = weekOf(row.dims[0]);
    if (w && w.landingPages.length < LANDING_PAGES_PER_WEEK && row.dims[1]) w.landingPages.push({ path: row.dims[1], sessions: row.metrics[0] ?? 0, engagedSessions: row.metrics[1] ?? 0, keyEvents: row.metrics[2] ?? 0 });
  }
  const ai = new Map<string, Map<string, { sessions: number; keyEvents: number }>>();
  for (const row of sources) {
    const w = weekOf(row.dims[0]);
    if (!w) continue;
    const source = row.dims[1] || "(not set)";
    if (w.sources.length < SOURCES_PER_WEEK) w.sources.push({ source, sessions: row.metrics[0] ?? 0, engagedSessions: row.metrics[1] ?? 0, keyEvents: row.metrics[2] ?? 0 });
    const assistant = aiAssistantOf(source);
    if (!assistant) continue;
    const perWeek = ai.get(w.weekStart) ?? new Map();
    const sum = perWeek.get(assistant) ?? { sessions: 0, keyEvents: 0 };
    perWeek.set(assistant, { sessions: sum.sessions + (row.metrics[0] ?? 0), keyEvents: sum.keyEvents + (row.metrics[2] ?? 0) });
    ai.set(w.weekStart, perWeek);
  }
  for (const [monday, perWeek] of ai) byWeek.get(monday)!.aiReferrals = [...perWeek.entries()].map(([assistant, v]) => ({ assistant, ...v })).sort((a, b) => b.sessions - a.sessions);
  for (const row of events) {
    const w = weekOf(row.dims[0]);
    if (w && row.dims[1] && (row.metrics[0] ?? 0) > 0) w.keyEventNames.push({ name: row.dims[1], count: row.metrics[0]! });
  }
  for (const w of byWeek.values()) w.keyEventNames.sort((a, b) => b.count - a.count).splice(10);
  // A week GA4 has no rows for was a week with no sessions: it is still a week (zeros), so trends do not skip it.
  return weekStarts.map((monday) => byWeek.get(monday) ?? { weekStart: monday, sessions: 0, engagedSessions: 0, users: 0, keyEvents: 0, organic: { sessions: 0, engagedSessions: 0, users: 0, keyEvents: 0 }, channels: [], landingPages: [], sources: [], keyEventNames: [], aiReferrals: [] });
}

// ---------------------------------------------------------------------------
// Finding the property (Admin API)
// ---------------------------------------------------------------------------

export interface Ga4PropertySummary {
  id: string;
  displayName: string;
}

/** Properties the service account can read (account summaries; needs the Analytics Admin API on). */
export async function listGa4Properties(fetchImpl: FetchLike, token: string): Promise<Ga4PropertySummary[]> {
  const out: Ga4PropertySummary[] = [];
  let pageToken = "";
  for (let page = 0; page < 3; page += 1) {
    const body = await call(fetchImpl, token, "GET", `${ADMIN_API}/accountSummaries?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, "Google Analytics Admin");
    for (const account of Array.isArray(body.accountSummaries) ? body.accountSummaries : []) {
      for (const raw of Array.isArray((account as Record<string, unknown>).propertySummaries) ? ((account as Record<string, unknown>).propertySummaries as unknown[]) : []) {
        const p = raw as Record<string, unknown>;
        const id = typeof p.property === "string" ? p.property.replace(/^properties\//, "") : "";
        if (/^\d+$/.test(id)) out.push({ id, displayName: typeof p.displayName === "string" ? p.displayName : id });
      }
    }
    pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : "";
    if (!pageToken) break;
  }
  return out;
}

/** The hosts of a property's web data streams (their default address). */
export async function ga4StreamHosts(fetchImpl: FetchLike, token: string, propertyId: string): Promise<string[]> {
  const body = await call(fetchImpl, token, "GET", `${ADMIN_API}/${propertyName(propertyId)}/dataStreams?pageSize=50`, "Google Analytics Admin");
  const hosts: string[] = [];
  for (const raw of Array.isArray(body.dataStreams) ? body.dataStreams : []) {
    const web = (raw as Record<string, unknown>).webStreamData as Record<string, unknown> | undefined;
    const uri = typeof web?.defaultUri === "string" ? web.defaultUri : "";
    if (!uri) continue;
    try {
      hosts.push(new URL(/^https?:\/\//i.test(uri) ? uri : `https://${uri}`).hostname.replace(/^www\./, "").toLowerCase());
    } catch {
      // not a URL: ignored
    }
  }
  return hosts;
}

export interface Ga4Discovery {
  /** The one property whose web stream is this site; null when there is none or more than one. */
  propertyId: string | null;
  /** Properties whose stream matches the site. */
  matches: Ga4PropertySummary[];
  /** Everything the service account can read. */
  visible: Ga4PropertySummary[];
  reason: string;
}

function sameSite(streamHost: string, siteHost: string): boolean {
  return streamHost === siteHost || streamHost.endsWith(`.${siteHost}`) || siteHost.endsWith(`.${streamHost}`);
}

/** The host of a site address, without `www.`, lower case. */
export function siteHostOf(siteUrl: string): string {
  return new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`).hostname.replace(/^www\./, "").toLowerCase();
}

/** Whether any of a property's web stream hosts is the site (or a subdomain of it, or the site is a subdomain of the stream). */
export function streamsMatchSite(streamHosts: string[], siteUrl: string): boolean {
  const siteHost = siteHostOf(siteUrl);
  return streamHosts.some((host) => sameSite(host, siteHost));
}

/**
 * Find the GA4 property of a site among the properties the service account can read, by the address of their web
 * streams. Reads at most 25 properties' streams. A site with two properties is not guessed at.
 */
export async function discoverGa4Property(fetchImpl: FetchLike, token: string, siteUrl: string): Promise<Ga4Discovery> {
  const siteHost = siteHostOf(siteUrl);
  const visible = await listGa4Properties(fetchImpl, token);
  if (visible.length === 0) return { propertyId: null, matches: [], visible, reason: "The service account cannot read any GA4 property yet: nobody has added it as a viewer." };
  const matches: Array<Ga4PropertySummary & { exact: boolean }> = [];
  for (const property of visible.slice(0, 25)) {
    const hosts = await ga4StreamHosts(fetchImpl, token, property.id).catch(() => [] as string[]);
    if (hosts.some((h) => sameSite(h, siteHost))) matches.push({ ...property, exact: hosts.includes(siteHost) });
  }
  const exact = matches.filter((m) => m.exact);
  const pick = exact.length === 1 ? exact[0]! : matches.length === 1 ? matches[0]! : null;
  const plain = (m: Array<Ga4PropertySummary & { exact: boolean }>) => m.map(({ id, displayName }) => ({ id, displayName }));
  if (pick) return { propertyId: pick.id, matches: plain(matches), visible, reason: `Matched ${pick.displayName} (${pick.id}) by its web stream address.` };
  return {
    propertyId: null,
    matches: plain(matches),
    visible,
    reason: matches.length > 1 ? `${matches.length} properties have a web stream for ${siteHost}: pass the property ID you want.` : `None of the ${visible.length} readable propert${visible.length === 1 ? "y has" : "ies have"} a web stream for ${siteHost}: pass the property ID, or the client has not added the service account to the right property.`,
  };
}
