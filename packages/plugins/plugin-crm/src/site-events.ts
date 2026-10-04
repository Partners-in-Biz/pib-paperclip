/**
 * Minimal site events (audit Q10-8, Q1a-14): `POST /api/plugins/partnersinbiz.crm/webhooks/ev`.
 *
 * A client's site reports page views, outbound clicks and named conversions through the script in `static/ev.js` (see
 * `events-embed.ts` for why it goes through an iframe). This module takes each request, checks it, classifies the visit's
 * channel and adds one to a daily count. The plugin stores no raw event, no visitor id and no personal data (`site-events-form.ts`
 * says exactly what is read), and answers nothing the page could use: the host discards the return value. What it does not control:
 * the host logs every public request itself (`plugin_webhook_deliveries`: body, the visitor's IP address and browser, for a few days
 * until ops purge it), so the privacy statements for a client's site must say that, not "no visitor identifier".
 *
 * The order of what it does with a request: size cap, JSON, a known and active key, the key's own hosts, rate limits per key
 * and per visitor (a keyed hash of the address, removed after two days), then each event is cut to size and counted. A
 * refusal is a plain message the host returns in its 502 body; the script ignores the answer.
 *
 * Limits, said plainly: anyone holding a site's key (it is in the page source) can add counts, so a count is an estimate. The
 * rate limits cap how much one source can add, and the distinct names a site may use in a day are capped, so a script cannot
 * grow the table. Visits are counted as "entrances" (the first page view of a browser tab's visit), not as people.
 */
import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { CHANNEL_LABELS, classifyChannel, UNATTRIBUTED, type Channel } from "./channels.js";
import { asRecord } from "./db.js";
import { CrmError, type Viewer } from "./domain.js";
import { EVENTS_ENDPOINT_KEY } from "./endpoints.js";
import { countPublicHits, recordPublicHit } from "./esign-store.js";
import { eventCurlExample, eventInstallSteps, eventSnippet, eventUrls, PRIVACY_NOTES, type EventUrls } from "./events-embed.js";
import { cleanText, clientIp, hashIp } from "./lead-form.js";
import { ipSalt, NO_URLS_NOTE, urlsFor } from "./lead-capture.js";
import { parseClientRef, requireClient, visibleClients } from "./lookup.js";
import { refOf, type ClientKind } from "./refs.js";
import { getSite } from "./sites.js";
import {
  CONSENT_MODES,
  dayOf,
  EVENT_KEY_GRACE_DAYS,
  EVENT_LIMITS,
  EVENT_RATE,
  EVENT_KEY_STATUSES,
  generateEventKey,
  eventKeyId,
  lastDays,
  parseEventsBody,
  periodDays,
  type ConsentMode,
  type EventKeyStatus,
  type ParsedEvent,
} from "./site-events-form.js";
import {
  bumpEventKey,
  bumpRollup,
  findEventKey,
  getEventKey,
  insertEventKey,
  listEventKeys,
  namesOnDay,
  rollupRows,
  saveEventKeySettings,
  saveRotatedEventKey,
  type EventKey,
  type RollupRow,
} from "./site-events-store.js";
import { hostOf } from "./channels.js";
import { eventKeyWarnings } from "./site-events-health.js";
import { randomUUID } from "node:crypto";

export { EVENTS_ENDPOINT_KEY };

/** The webhook answers with this when something is wrong with a request; the host passes the message on in its 502 body. */
export class EventsRejected extends Error {
  constructor(message: string, readonly outcome: string) {
    super(message);
    this.name = "EventsRejected";
  }
}

const NOT_ACTIVE = "This site key is not active.";
const ERROR_GENERIC = "Something went wrong on our side.";

export interface EventsResult {
  status: "counted";
  keyId: string;
  counted: number;
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

export interface CountRow {
  kind: "entrance" | "pageview" | "outbound" | "conversion";
  name: string;
  channel: string;
  firstChannel: string;
}

/** What one event adds to the daily counts (pure). `ownHosts` are the site's own hosts. */
export function countsFor(event: ParsedEvent, ownHosts: readonly string[]): CountRow[] {
  const touch = event.last ?? event.visit;
  const channel: string = touch ? classifyChannel(touch, ownHosts) : "";
  const first: string = event.first ? classifyChannel(event.first, ownHosts) : "";
  if (event.type === "pv") {
    const rows: CountRow[] = [{ kind: "pageview", name: event.bucket, channel: "", firstChannel: "" }];
    if (event.entrance) rows.push({ kind: "entrance", name: "", channel, firstChannel: first });
    return rows;
  }
  if (event.type === "out") return [{ kind: "outbound", name: event.name, channel: "", firstChannel: "" }];
  return [{ kind: "conversion", name: event.name, channel, firstChannel: first }];
}

/** The distinct-name caps per kind: past the cap a new name counts as `other`, so a script cannot grow the table. */
const CAPS: Record<CountRow["kind"], number> = { entrance: 1, pageview: EVENT_LIMITS.pathBucketsPerDay, outbound: EVENT_LIMITS.outboundHostsPerDay, conversion: EVENT_LIMITS.conversionNamesPerDay };
const OTHER: Record<CountRow["kind"], string> = { entrance: "", pageview: "/other", outbound: "other", conversion: "other" };

/** Names seen today per key and kind, kept for a few minutes so the cap does not cost a query per event. */
const seen = new Map<string, { at: number; names: Set<string> }>();
const SEEN_MS = 5 * 60_000;

/** Tests. */
export function resetEventCaches(): void {
  seen.clear();
}

async function capName(ctx: PluginContext, key: EventKey, day: string, kind: CountRow["kind"], name: string): Promise<string> {
  if (kind === "entrance") return "";
  const id = `${key.id}:${day}:${kind}`;
  let entry = seen.get(id);
  if (!entry || Date.now() - entry.at > SEEN_MS) {
    entry = { at: Date.now(), names: await namesOnDay(ctx, key.companyId, key.id, day, kind) };
    seen.set(id, entry);
    if (seen.size > 2_000) seen.clear();
  }
  if (entry.names.has(name)) return name;
  if (entry.names.size >= CAPS[kind]) return OTHER[kind];
  entry.names.add(name);
  return name;
}

function ownHostsOf(key: EventKey): string[] {
  const hosts = new Set(key.hosts);
  const site = hostOf(key.siteUrl);
  if (site) hosts.add(site);
  return [...hosts];
}

function originAllowed(key: EventKey, origin: string | null): boolean {
  if (!origin) return true;
  const hosts = ownHostsOf(key);
  if (hosts.length === 0) return true;
  return hosts.some((host) => origin === host || origin.endsWith(`.${host}`));
}

async function overLimit(ctx: PluginContext, key: EventKey, ipHash: string | null, now: Date): Promise<boolean> {
  const minuteAgo = new Date(now.getTime() - 60_000).toISOString();
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  if ((await countPublicHits(ctx, EVENTS_ENDPOINT_KEY, minuteAgo, EVENT_RATE.keyPerMinute, { subject: key.id })) >= EVENT_RATE.keyPerMinute) return true;
  if ((await countPublicHits(ctx, EVENTS_ENDPOINT_KEY, hourAgo, key.rateLimitPerHour, { subject: key.id })) >= key.rateLimitPerHour) return true;
  if (ipHash) {
    if ((await countPublicHits(ctx, EVENTS_ENDPOINT_KEY, minuteAgo, EVENT_RATE.ipPerMinute, { ipHash })) >= EVENT_RATE.ipPerMinute) return true;
    if ((await countPublicHits(ctx, EVENTS_ENDPOINT_KEY, hourAgo, EVENT_RATE.ipPerHour, { ipHash })) >= EVENT_RATE.ipPerHour) return true;
  }
  return false;
}

/** One delivery to the events endpoint. Throws `EventsRejected` with a plain message; returns what it counted. */
export async function handleEventsWebhook(ctx: PluginContext, input: PluginWebhookInput, options: { now?: Date } = {}): Promise<EventsResult> {
  const now = options.now ?? new Date();
  if (input.endpointKey !== EVENTS_ENDPOINT_KEY) throw new EventsRejected("Unknown endpoint.", "unknown");
  if (Buffer.byteLength(input.rawBody ?? "", "utf8") > EVENT_LIMITS.bodyBytes) throw new EventsRejected("The request is too large.", "too_large");
  const body = asRecord(input.parsedBody);
  if (Object.keys(body).length === 0) throw new EventsRejected("Send a JSON body (content-type: application/json).", "invalid");
  const parsed = parseEventsBody(body);
  if (!parsed.ok) throw new EventsRejected(parsed.message, "invalid");

  let key: EventKey | null;
  try {
    key = await findEventKey(ctx, parsed.key, now);
  } catch (error) {
    ctx.logger.error("CRM site events key lookup failed", { error: error instanceof Error ? error.message : String(error) });
    throw new EventsRejected(ERROR_GENERIC, "error");
  }
  const ip = clientIp(input.headers);
  let ipHash: string | null = null;
  try {
    ipHash = ip ? hashIp(await ipSalt(ctx), ip) : null;
  } catch {
    ipHash = null;
  }
  if (!key || key.status !== "active") {
    // An unknown key is counted against the visitor only, never against a key id someone made up, and only until the visitor is over the hourly
    // limit anyway (a row past it adds nothing), so a scanner cannot grow the request log from one address. No address, nothing to count against.
    const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
    if (ipHash && (await countPublicHits(ctx, EVENTS_ENDPOINT_KEY, hourAgo, EVENT_RATE.ipPerHour, { ipHash }).catch(() => EVENT_RATE.ipPerHour)) < EVENT_RATE.ipPerHour) {
      await recordPublicHit(ctx, EVENTS_ENDPOINT_KEY, "unknown", ipHash, "unknown_key").catch(() => undefined);
    }
    throw new EventsRejected(NOT_ACTIVE, "inactive");
  }
  try {
    if (await overLimit(ctx, key, ipHash, now)) throw new EventsRejected("Too many events. Slow down.", "rate_limited");
    if (!originAllowed(key, parsed.origin)) {
      await recordPublicHit(ctx, EVENTS_ENDPOINT_KEY, key.id, ipHash, "wrong_origin");
      await bumpEventKey(ctx, key.id, 0, 1).catch(() => undefined);
      throw new EventsRejected("This site is not allowed to use this key.", "wrong_origin");
    }
    const day = dayOf(now);
    const hosts = ownHostsOf(key);
    let counted = 0;
    for (const event of parsed.events) {
      for (const row of countsFor(event, hosts)) {
        const name = await capName(ctx, key, day, row.kind, row.name);
        await bumpRollup(ctx, { companyId: key.companyId, keyId: key.id, day, kind: row.kind, name, channel: row.channel, firstChannel: row.firstChannel });
      }
      counted += 1;
    }
    await recordPublicHit(ctx, EVENTS_ENDPOINT_KEY, key.id, ipHash, "ok");
    await bumpEventKey(ctx, key.id, counted, 0).catch(() => undefined);
    return { status: "counted", keyId: key.id, counted };
  } catch (error) {
    if (error instanceof EventsRejected) throw error;
    ctx.logger.error("CRM site events failed", { keyId: key.id, error: error instanceof Error ? error.message : String(error) });
    await recordPublicHit(ctx, EVENTS_ENDPOINT_KEY, key.id, ipHash, "error").catch(() => undefined);
    throw new EventsRejected(ERROR_GENERIC, "error");
  }
}

// ---------------------------------------------------------------------------
// Reading: what the counts say
// ---------------------------------------------------------------------------

export interface ChannelCounts {
  channel: string;
  label: string;
  entrances: number;
  conversions: number;
  /** Conversions per hundred visits that started from this channel, or null with no visits. */
  conversionRate: number | null;
  /** Conversions credited to this channel as the FIRST touch (only counts from visitors who allowed remembering). */
  firstTouchConversions: number;
}

export interface EventsSummary {
  range: { from: string; to: string };
  entrances: number;
  pageviews: number;
  outbound: { total: number; top: Array<{ host: string; n: number }> };
  conversions: { total: number; byName: Array<{ name: string; n: number }> };
  channels: ChannelCounts[];
  topPages: Array<{ path: string; n: number }>;
  /** Visits that had a remembered first touch (consent), as a share of conversions: how much of the first-touch view is real. */
  firstTouchCoverage: number | null;
}

const top = <T extends { n: number }>(rows: T[], max: number): T[] => [...rows].sort((a, b) => b.n - a.n).slice(0, max);

/** Totals, channels, top pages and conversions from rollup rows (pure). */
export function summariseRollup(rows: readonly RollupRow[], range: { from: string; to: string }): EventsSummary {
  let entrances = 0;
  let pageviews = 0;
  let outbound = 0;
  let conversions = 0;
  const pages = new Map<string, number>();
  const hosts = new Map<string, number>();
  const names = new Map<string, number>();
  const byChannel = new Map<string, { entrances: number; conversions: number; first: number }>();
  const slot = (channel: string) => {
    const key = channel || UNATTRIBUTED;
    let row = byChannel.get(key);
    if (!row) byChannel.set(key, (row = { entrances: 0, conversions: 0, first: 0 }));
    return row;
  };
  let withFirst = 0;
  for (const row of rows) {
    if (row.kind === "entrance") {
      entrances += row.n;
      slot(row.channel).entrances += row.n;
    } else if (row.kind === "pageview") {
      pageviews += row.n;
      pages.set(row.name, (pages.get(row.name) ?? 0) + row.n);
    } else if (row.kind === "outbound") {
      outbound += row.n;
      hosts.set(row.name, (hosts.get(row.name) ?? 0) + row.n);
    } else if (row.kind === "conversion") {
      conversions += row.n;
      names.set(row.name, (names.get(row.name) ?? 0) + row.n);
      slot(row.channel).conversions += row.n;
      if (row.firstChannel) {
        withFirst += row.n;
        slot(row.firstChannel).first += row.n;
      }
    }
  }
  const channels: ChannelCounts[] = [...byChannel.entries()]
    .map(([channel, c]) => ({ channel, label: CHANNEL_LABELS[channel as Channel] ?? channel, entrances: c.entrances, conversions: c.conversions, conversionRate: c.entrances > 0 ? Math.round((c.conversions / c.entrances) * 1000) / 10 : null, firstTouchConversions: c.first }))
    .sort((a, b) => b.entrances + b.conversions - (a.entrances + a.conversions));
  return {
    range,
    entrances,
    pageviews,
    outbound: { total: outbound, top: top([...hosts.entries()].map(([host, n]) => ({ host, n })), 5) },
    conversions: { total: conversions, byName: top([...names.entries()].map(([name, n]) => ({ name, n })), 10) },
    channels,
    topPages: top([...pages.entries()].map(([path, n]) => ({ path, n })), 10),
    firstTouchCoverage: conversions > 0 ? Math.round((withFirst / conversions) * 100) / 100 : null,
  };
}

/** The range a tool call asks for: a month (`period`), or the last `days` days (default 30). */
export function rangeOf(params: Record<string, unknown>, now = new Date()): { from: string; to: string; label: string } {
  if (typeof params.period === "string" && params.period.trim()) {
    const period = params.period.trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new CrmError("period must be YYYY-MM, e.g. 2026-09");
    return { ...periodDays(period), label: period };
  }
  const days = params.days == null || params.days === "" ? 30 : Number(params.days);
  if (!Number.isInteger(days) || days < 1 || days > 400) throw new CrmError("days must be a whole number from 1 to 400");
  return { ...lastDays(now, days), label: `the last ${days} days` };
}

/** The counts of every active or past key of a client (or of ours) in a range. */
export async function eventsSummaryFor(ctx: PluginContext, companyId: string, scope: { kind: ClientKind; id: string } | "own", range: { from: string; to: string }): Promise<{ summary: EventsSummary; keys: EventKey[] }> {
  const keys = await listEventKeys(ctx, companyId, scope);
  const rows: RollupRow[] = [];
  for (const key of keys) rows.push(...(await rollupRows(ctx, companyId, key.id, range.from, range.to)));
  return { summary: summariseRollup(rows, range), keys };
}

// ---------------------------------------------------------------------------
// Tools: keys, snippet, report
// ---------------------------------------------------------------------------

function actorOf(viewer: Viewer): string | null {
  return viewer.agentId ? `agent:${viewer.agentId}` : viewer.userId ? `user:${viewer.userId}` : null;
}

function label(value: unknown, fallback: string): string {
  return cleanText(value, 80) || fallback;
}

function siteOrigin(value: unknown): { origin: string; host: string } | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
    if (!url.hostname.includes(".")) return null;
    return { origin: url.origin, host: hostOf(url.hostname) ?? url.hostname };
  } catch {
    return null;
  }
}

export async function eventKeyView(ctx: PluginContext, key: EventKey, urls: EventUrls | null, clientName: string | null, now = new Date()) {
  const warnings = eventKeyWarnings(key, now);
  return {
    id: key.id,
    label: key.label,
    client: key.clientKind && key.clientRef ? refOf(key.clientKind, key.clientRef) : null,
    clientName,
    ownedBy: key.clientKind ? "client" : "us",
    site: key.siteUrl,
    hosts: key.hosts,
    status: key.status,
    canary: key.canary,
    consentMode: key.consentMode,
    writeKey: key.writeKey,
    previousKeyValidUntil: key.previousKey ? key.previousKeyUntil : null,
    counted: key.acceptedCount,
    refused: key.rejectedCount,
    lastEventAt: key.lastEventAt,
    createdAt: key.createdAt,
    ...(warnings.length ? { warnings } : {}),
    install: urls ? { snippet: eventSnippet(key, urls), steps: eventInstallSteps(key, urls, key.siteUrl), curl: eventCurlExample(key, urls), endpoint: urls.endpointUrl, doNotInstallYourself: "This is text for the client's developer or a PR through the client's repo project, after the owner's OK. Never put it on a live site yourself." } : { installNote: NO_URLS_NOTE },
    privacy: PRIVACY_NOTES,
  };
}

async function embedUrlsOf(ctx: PluginContext, companyId: string): Promise<EventUrls | null> {
  const base = await urlsFor(ctx, companyId);
  return base ? eventUrls(base) : null;
}

async function clientNameOf(ctx: PluginContext, viewer: Viewer, client: { kind: ClientKind; id: string } | null): Promise<string | null> {
  return client ? requireClient(ctx, viewer, client) : null;
}

/** `create-event-key`: a write key and snippet for one client's site (or ours). Idempotent per client and label. */
export async function createEventKey(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, options: { canary?: boolean } = {}) {
  const client = params.client == null || params.client === "" ? null : parseClientRef(params.client);
  const clientName = await clientNameOf(ctx, viewer, client);
  const name = label(params.label, clientName ? `${clientName} website` : "Website");
  const urls = await embedUrlsOf(ctx, viewer.companyId);
  const existing = (await listEventKeys(ctx, viewer.companyId, client ?? "own")).find((row) => row.status !== "revoked" && row.label.toLowerCase() === name.toLowerCase());
  if (existing) return { created: false, key: await eventKeyView(ctx, existing, urls, clientName), note: "A key with this label already exists: it was not changed. Use rotate-event-key for a new one." };

  let siteId: string | null = null;
  let site: { origin: string; host: string } | null = null;
  if (typeof params.siteId === "string" && params.siteId.trim()) {
    if (!client) throw new CrmError("siteId belongs to a client: pass client too");
    const found = await getSite(ctx, viewer.companyId, params.siteId.trim());
    if (!found || found.clientKind !== client.kind || found.clientRef !== client.id) throw new CrmError("That site is not one of this client's websites (list-client-sites shows them)");
    siteId = found.id;
    site = siteOrigin(found.url);
  } else {
    site = siteOrigin(params.siteUrl);
    if (typeof params.siteUrl === "string" && params.siteUrl.trim() && !site) throw new CrmError("siteUrl must be a web address, e.g. https://example.co.za");
  }
  const mode = params.consentMode == null || params.consentMode === "" ? "anonymous" : String(params.consentMode);
  if (!(CONSENT_MODES as readonly string[]).includes(mode)) throw new CrmError(`consentMode must be ${CONSENT_MODES.join(" or ")}`);
  const key = {
    id: randomUUID(),
    companyId: viewer.companyId,
    clientKind: client?.kind ?? null,
    clientRef: client?.id ?? null,
    label: name,
    siteId,
    siteUrl: site?.origin ?? null,
    hosts: site ? [site.host] : [],
    writeKey: generateEventKey(),
    status: "active" as const,
    // The canary client's keys are the canary's: they never count for a real report.
    canary: options.canary === true || (client ? client.id.startsWith("canary-") : false),
    consentMode: mode as ConsentMode,
    rateLimitPerHour: 3000,
    createdBy: actorOf(viewer),
  };
  await insertEventKey(ctx, key);
  return {
    created: true,
    key: await eventKeyView(ctx, { ...key, previousKey: null, previousKeyUntil: null, acceptedCount: 0, rejectedCount: 0, lastEventAt: null, createdAt: new Date().toISOString() }, urls, clientName),
    next: urls ? "Give the snippet to the client's developer or put it in a PR through the client's repo project, after the owner has said yes. Do not install it yourself." : NO_URLS_NOTE,
  };
}

async function requireKey(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>): Promise<EventKey> {
  const id = typeof params.keyId === "string" ? params.keyId.trim() : "";
  if (!id) throw new CrmError("keyId is required (list-event-keys shows the ids)");
  const key = await getEventKey(ctx, viewer.companyId, id);
  if (!key) throw new CrmError(`Event key ${id} was not found (list-event-keys shows the ids)`);
  if (key.clientKind && key.clientRef) await requireClient(ctx, viewer, { kind: key.clientKind, id: key.clientRef });
  return key;
}

export async function listEventKeysTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const client = params.client == null || params.client === "" ? null : parseClientRef(params.client);
  if (client) await requireClient(ctx, viewer, client);
  const rows = await listEventKeys(ctx, viewer.companyId, params.ownOnly === true ? "own" : client ?? undefined);
  const urls = await embedUrlsOf(ctx, viewer.companyId);
  const seenClients = client || !rows.some((row) => row.clientKind) ? null : await visibleClients(ctx, viewer);
  const keys = [];
  for (const row of rows) {
    if (seenClients && row.clientKind && row.clientRef && !seenClients.has(row.clientKind, row.clientRef)) continue;
    keys.push(await eventKeyView(ctx, row, urls, null));
  }
  return { keys, ...(keys.length === 0 ? { next: "No event keys yet. create-event-key makes one for a client's site (or ours, with no client)." } : {}), ...(urls ? {} : { note: NO_URLS_NOTE }) };
}

/** `update-event-key`: rename, pause, resume, or change the consent mode. An agent may pause and resume; only a person revokes. */
export async function updateEventKey(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, source: "agent" | "human") {
  const row = await requireKey(ctx, viewer, params);
  const next = { ...row };
  if ("label" in params) next.label = label(params.label, row.label);
  if (typeof params.consentMode === "string") {
    if (!(CONSENT_MODES as readonly string[]).includes(params.consentMode)) throw new CrmError(`consentMode must be ${CONSENT_MODES.join(" or ")}`);
    next.consentMode = params.consentMode as ConsentMode;
  }
  if (typeof params.status === "string") {
    if (!(EVENT_KEY_STATUSES as readonly string[]).includes(params.status)) throw new CrmError(`status must be ${EVENT_KEY_STATUSES.join(", ")}`);
    const status = params.status as EventKeyStatus;
    if (row.status === "revoked" && status !== "revoked") throw new CrmError("A key that was switched off for good cannot be turned on again: make a new one.");
    if (status === "revoked" && (source !== "human" || viewer.agentId)) throw new CrmError("Only a person can switch a key off for good. Pause it (status paused) and put it on Needs you.");
    next.status = status;
  }
  await saveEventKeySettings(ctx, next);
  return { key: await eventKeyView(ctx, next, await embedUrlsOf(ctx, viewer.companyId), null) };
}

/** `rotate-event-key`: a new write key; the old one counts for 7 more days so the snippet can be swapped. */
export async function rotateEventKey(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, now = new Date()) {
  const row = await requireKey(ctx, viewer, params);
  if (row.status === "revoked") throw new CrmError("This key was switched off for good. Make a new one with create-event-key.");
  const writeKey = generateEventKey();
  const until = new Date(now.getTime() + EVENT_KEY_GRACE_DAYS * 86_400_000).toISOString();
  await saveRotatedEventKey(ctx, { companyId: viewer.companyId, id: row.id, writeKey, previousKey: row.writeKey, previousKeyUntil: until });
  const fresh = (await getEventKey(ctx, viewer.companyId, row.id)) ?? { ...row, writeKey, previousKey: row.writeKey, previousKeyUntil: until };
  return { key: await eventKeyView(ctx, fresh, await embedUrlsOf(ctx, viewer.companyId), null, now), oldKeyValidUntil: until, next: `Give the new snippet to the client's developer within ${EVENT_KEY_GRACE_DAYS} days; the old key keeps counting until then.` };
}

/** `site-events-report`: visits, conversions and where they came from, for one client's sites (or ours). */
export async function siteEventsReportTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const client = params.client == null || params.client === "" ? null : parseClientRef(params.client);
  const clientName = await clientNameOf(ctx, viewer, client);
  const range = rangeOf(params);
  const { summary, keys } = await eventsSummaryFor(ctx, viewer.companyId, client ?? "own", range);
  if (keys.length === 0) return { client: client ? refOf(client.kind, client.id) : null, clientName, period: range.label, keys: 0, note: "This site has no event key, so nothing is counted. create-event-key makes one (installing the snippet needs the owner's OK).", ...summary };
  const funnel = [
    { step: "Visits (a visit starts with its first page)", n: summary.entrances },
    { step: "Pages viewed", n: summary.pageviews },
    { step: "Clicks to other sites", n: summary.outbound.total },
    { step: "Conversions (form sent, call or WhatsApp pressed, named actions)", n: summary.conversions.total },
  ];
  return {
    client: client ? refOf(client.kind, client.id) : null,
    clientName,
    period: range.label,
    keys: keys.length,
    funnel,
    ...summary,
    notes: [
      "A visit is the first page view of a browser tab's visit, not a person. Counts are estimates: anyone holding the site key can add to them, and visitors whose browser says Do Not Track are not counted.",
      "Conversions by source use the visit's own channel. The first-touch column only has visitors whose site banner allowed remembering earlier visits (firstTouchCoverage says how many).",
      "For enquiries, customers and revenue by source, use attribution-report.",
    ],
  };
}
