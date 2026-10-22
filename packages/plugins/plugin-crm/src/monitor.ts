/**
 * Uptime, certificate and domain monitoring for the websites registered on
 * clients (`client_sites`), audit Q1b-10. Before this the only check was the
 * WordPress Connector's own ping, so a client's site could be down for days with
 * nobody told.
 *
 * Every five minutes the monitor checks the sites that are due (oldest first, a
 * few at a time, never the same site twice within four minutes, at most 40 a
 * run): one GET of the site's own address, repeated once straight away when it
 * fails so a single dropped request is not an outage. A site counts as down when
 * the page cannot be reached or answers with a server error, and the alarm
 * waits until it has been down for 5 minutes. Twice a day it reads the
 * certificate's expiry (one TLS handshake), and once a day it asks RDAP when the
 * domain expires. Alarms: down for 5 minutes, a certificate under 14 days (or one
 * that is not trusted), a domain under 30 days. Each opens one issue for the
 * Delivery Lead (once per outage or expiry date) in the client's project and shows
 * as a red or amber check in the Cockpit. Nothing else is touched: see
 * `monitor-net.ts` for the limits.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { safeFetch, type HealthCheck } from "@partnersinbiz/pib-plugin-kit";
import { clientInfo, clientProjectOf } from "./care-clients.js";
import { iso, type ClientKey } from "./care-store.js";
import { table } from "./db.js";
import { CrmError, type Viewer } from "./domain.js";
import { requireClient } from "./lookup.js";
import { openIssueOnce } from "./mail.js";
import { DOMAIN_WARN_DAYS, DOWN_AFTER_MINUTES, daysUntil, parseRdapExpiry, rdapProblem, rdapUrl, registrableDomain, tlsExpiry, TLS_WARN_DAYS, type DomainResult, type TlsResult } from "./monitor-net.js";
import { originFor } from "./origins.js";
import { companyPrefix, crmLink, type ClientKind } from "./refs.js";
import { deliveryLeadAssignee } from "./routing.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const USER_AGENT = "PiB-Uptime/1.0 (+https://partnersinbiz.online)";
/** A site is not checked again within this many minutes. */
export const MIN_INTERVAL_MINUTES = 4;
export const MAX_SITES_PER_RUN = 40;
const TLS_EVERY_HOURS = 12;
const DOMAIN_EVERY_HOURS = 24;
const DOMAIN_RETRY_HOURS = 72;
const CONCURRENCY = 4;
/** No new check starts after this long into a run, so a slow batch never overlaps the next run. */
const RUN_BUDGET_MS = 4 * MINUTE_MS;
const UPTIME_KEEP_DAYS = 120;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type MonitorStatus = "unknown" | "up" | "down";

export interface MonitorRow {
  siteId: string;
  companyId: string;
  enabled: boolean;
  status: MonitorStatus;
  httpStatus: number | null;
  responseMs: number | null;
  lastError: string | null;
  lastCheckedAt: string | null;
  lastOkAt: string | null;
  downSince: string | null;
  failures: number;
  tlsExpiresAt: string | null;
  tlsError: string | null;
  tlsCheckedAt: string | null;
  domain: string | null;
  domainExpiresAt: string | null;
  domainCheckedAt: string | null;
  domainError: string | null;
  domainManual: boolean;
  /** The latest outside fetch an agent recorded (PAR-4812): where, when, and whether the page answered. */
  outsideUrl: string | null;
  outsideVerdict: "up" | "down" | null;
  outsideCheckedAt: string | null;
}

interface MonitorDbRow {
  site_id: string;
  company_id: string;
  enabled: boolean;
  status: string;
  http_status: number | string | null;
  response_ms: number | string | null;
  last_error: string | null;
  last_checked_at: unknown;
  last_ok_at: unknown;
  down_since: unknown;
  failures: number | string;
  tls_expires_at: unknown;
  tls_error: string | null;
  tls_checked_at: unknown;
  domain: string | null;
  domain_expires_at: unknown;
  domain_checked_at: unknown;
  domain_error: string | null;
  domain_manual: boolean;
  outside_url: string | null;
  outside_verdict: string | null;
  outside_checked_at: unknown;
}

const MONITOR_COLUMNS = `site_id, company_id, enabled, status, http_status, response_ms, last_error, last_checked_at, last_ok_at, down_since, failures,
  tls_expires_at, tls_error, tls_checked_at, domain, domain_expires_at, domain_checked_at, domain_error, domain_manual,
  outside_url, outside_verdict, outside_checked_at`;

function mapMonitor(row: MonitorDbRow): MonitorRow {
  return {
    siteId: row.site_id,
    companyId: row.company_id,
    enabled: row.enabled !== false,
    status: row.status === "up" || row.status === "down" ? row.status : "unknown",
    httpStatus: row.http_status == null ? null : Number(row.http_status),
    responseMs: row.response_ms == null ? null : Number(row.response_ms),
    lastError: row.last_error ?? null,
    lastCheckedAt: iso(row.last_checked_at),
    lastOkAt: iso(row.last_ok_at),
    downSince: iso(row.down_since),
    failures: Number(row.failures ?? 0),
    tlsExpiresAt: iso(row.tls_expires_at),
    tlsError: row.tls_error ?? null,
    tlsCheckedAt: iso(row.tls_checked_at),
    domain: row.domain ?? null,
    domainExpiresAt: iso(row.domain_expires_at),
    domainCheckedAt: iso(row.domain_checked_at),
    domainError: row.domain_error ?? null,
    domainManual: row.domain_manual === true,
    outsideUrl: row.outside_url ?? null,
    outsideVerdict: row.outside_verdict === "up" || row.outside_verdict === "down" ? row.outside_verdict : null,
    outsideCheckedAt: iso(row.outside_checked_at),
  };
}

export function emptyMonitor(siteId: string, companyId: string): MonitorRow {
  return {
    siteId, companyId, enabled: true, status: "unknown", httpStatus: null, responseMs: null, lastError: null, lastCheckedAt: null, lastOkAt: null, downSince: null, failures: 0,
    tlsExpiresAt: null, tlsError: null, tlsCheckedAt: null, domain: null, domainExpiresAt: null, domainCheckedAt: null, domainError: null, domainManual: false,
    outsideUrl: null, outsideVerdict: null, outsideCheckedAt: null,
  };
}

export async function listMonitors(ctx: PluginContext, companyId: string): Promise<MonitorRow[]> {
  const rows = await ctx.db.query<MonitorDbRow>(`SELECT ${MONITOR_COLUMNS} FROM ${table(ctx, "site_monitor")} WHERE company_id = $1 LIMIT 1000`, [companyId]);
  return rows.map(mapMonitor);
}

export async function getMonitor(ctx: PluginContext, companyId: string, siteId: string): Promise<MonitorRow | null> {
  const rows = await ctx.db.query<MonitorDbRow>(`SELECT ${MONITOR_COLUMNS} FROM ${table(ctx, "site_monitor")} WHERE company_id = $1 AND site_id = $2 LIMIT 1`, [companyId, siteId]);
  return rows[0] ? mapMonitor(rows[0]) : null;
}

export async function saveMonitor(ctx: PluginContext, m: MonitorRow): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "site_monitor")}
      (site_id, company_id, enabled, status, http_status, response_ms, last_error, last_checked_at, last_ok_at, down_since, failures,
       tls_expires_at, tls_error, tls_checked_at, domain, domain_expires_at, domain_checked_at, domain_error, domain_manual, outside_url, outside_verdict, outside_checked_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, now())
     ON CONFLICT (site_id) DO UPDATE SET
       enabled = EXCLUDED.enabled, status = EXCLUDED.status, http_status = EXCLUDED.http_status, response_ms = EXCLUDED.response_ms, last_error = EXCLUDED.last_error,
       last_checked_at = EXCLUDED.last_checked_at, last_ok_at = EXCLUDED.last_ok_at, down_since = EXCLUDED.down_since, failures = EXCLUDED.failures,
       tls_expires_at = EXCLUDED.tls_expires_at, tls_error = EXCLUDED.tls_error, tls_checked_at = EXCLUDED.tls_checked_at, domain = EXCLUDED.domain,
       domain_expires_at = EXCLUDED.domain_expires_at, domain_checked_at = EXCLUDED.domain_checked_at, domain_error = EXCLUDED.domain_error,
       domain_manual = EXCLUDED.domain_manual, outside_url = EXCLUDED.outside_url, outside_verdict = EXCLUDED.outside_verdict, outside_checked_at = EXCLUDED.outside_checked_at, updated_at = EXCLUDED.updated_at`,
    [m.siteId, m.companyId, m.enabled, m.status, m.httpStatus, m.responseMs, m.lastError, m.lastCheckedAt, m.lastOkAt, m.downSince, m.failures, m.tlsExpiresAt, m.tlsError, m.tlsCheckedAt, m.domain, m.domainExpiresAt, m.domainCheckedAt, m.domainError, m.domainManual, m.outsideUrl, m.outsideVerdict, m.outsideCheckedAt],
  );
}

/** Removes the monitoring rows and uptime history of a client's sites (called with the sites, when the client or a site is deleted). */
export async function deleteSiteMonitorOf(ctx: PluginContext, companyId: string, siteIds: string[]): Promise<void> {
  for (const siteId of siteIds) {
    await ctx.db.execute(`DELETE FROM ${table(ctx, "site_monitor")} WHERE company_id = $1 AND site_id = $2`, [companyId, siteId]);
    await ctx.db.execute(`DELETE FROM ${table(ctx, "site_uptime_days")} WHERE company_id = $1 AND site_id = $2`, [companyId, siteId]);
  }
}

export interface MonitorSite {
  id: string;
  companyId: string;
  client: ClientKey;
  label: string | null;
  url: string;
  projectId: string | null;
}

export async function listMonitorSites(ctx: PluginContext, companyId: string): Promise<MonitorSite[]> {
  const rows = await ctx.db.query<{ id: string; company_id: string; client_kind: string; client_ref: string; label: string | null; url: string; project_id: string | null }>(
    `SELECT id, company_id, client_kind, client_ref, label, url, project_id FROM ${table(ctx, "client_sites")} WHERE company_id = $1 ORDER BY created_at LIMIT 500`,
    [companyId],
  );
  return rows.map((row) => ({ id: row.id, companyId: row.company_id, client: { kind: (row.client_kind === "contact" ? "contact" : "company") as ClientKind, id: row.client_ref }, label: row.label ?? null, url: row.url, projectId: row.project_id ?? null }));
}

export function hostOf(url: string): string | null {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function siteName(site: Pick<MonitorSite, "label" | "url">): string {
  return site.label?.trim() || hostOf(site.url) || site.url;
}

// ---------------------------------------------------------------------------
// The checks (injectable, so tests never touch the network)
// ---------------------------------------------------------------------------

export interface PageResult {
  ok: boolean;
  status: number | null;
  ms: number;
  error: string | null;
}

export interface MonitorIo {
  page(url: string): Promise<PageResult>;
  tls(host: string): Promise<TlsResult>;
  rdap(domain: string): Promise<DomainResult>;
  sleep(ms: number): Promise<void>;
  /** A check of the same address from outside our network (optional: without it the monitor trusts its own check). */
  outside?(url: string): Promise<OutsideResult>;
}

/** What an independent outside check saw: "up" when any outside node got an answer, "down" when every node failed, "unknown" when the check itself could not run. */
export interface OutsideResult {
  verdict: "up" | "down" | "unknown";
  detail: string;
}

export const OUTSIDE_API = "https://check-host.net";
const OUTSIDE_NODES = 3;
const OUTSIDE_WAIT_MS = 12_000;

/** Reads a check-host.net check-result body: any node with a 2xx-4xx answer is up; every node answered with a failure is down; anything else is unknown. */
export function outsideVerdict(body: unknown): OutsideResult {
  if (!body || typeof body !== "object") return { verdict: "unknown", detail: "no result from the outside check" };
  const nodes = Object.entries(body as Record<string, unknown>);
  let up = 0;
  let failed = 0;
  for (const [, value] of nodes) {
    if (!Array.isArray(value) || !Array.isArray(value[0])) continue;
    const row = value[0] as unknown[];
    const code = Number(row[3]);
    if (row[0] === 1 && Number.isFinite(code) && code < 500) up += 1;
    else failed += 1;
  }
  if (up > 0) return { verdict: "up", detail: `${up} of ${nodes.length} outside nodes got an answer` };
  if (failed > 0 && failed === nodes.length) return { verdict: "down", detail: `all ${failed} outside nodes failed` };
  return { verdict: "unknown", detail: `outside check incomplete (${failed} failed, ${nodes.length - failed} pending)` };
}

async function outsideCheck(ctx: PluginContext, url: string, sleep: (ms: number) => Promise<void>): Promise<OutsideResult> {
  try {
    const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const start = await safeFetch(ctx, `${OUTSIDE_API}/check-http?host=${encodeURIComponent(target)}&max_nodes=${OUTSIDE_NODES}`, { method: "GET", headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, maxRedirects: 2, maxChars: 20_000 });
    const requestId = start.status === 200 ? (JSON.parse(start.text) as { request_id?: string }).request_id : undefined;
    if (!requestId || !/^[a-z0-9]+$/i.test(requestId)) return { verdict: "unknown", detail: `outside check did not start (${start.status})` };
    let last: OutsideResult = { verdict: "unknown", detail: "outside check pending" };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await sleep(OUTSIDE_WAIT_MS);
      const res = await safeFetch(ctx, `${OUTSIDE_API}/check-result/${requestId}`, { method: "GET", headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, maxRedirects: 2, maxChars: 20_000 });
      if (res.status !== 200) continue;
      last = outsideVerdict(JSON.parse(res.text) as unknown);
      if (last.verdict !== "unknown") return last;
    }
    return last;
  } catch (error) {
    return { verdict: "unknown", detail: `outside check failed (${(error instanceof Error ? error.message : String(error)).slice(0, 120)})` };
  }
}

/** One GET of the site's own address through the host's guarded fetch. A server error or no answer is down; a 4xx means the site answered. */
async function fetchPage(ctx: PluginContext, url: string): Promise<PageResult> {
  const started = Date.now();
  try {
    const res = await safeFetch(ctx, url, { method: "GET", headers: { "User-Agent": USER_AGENT, Range: "bytes=0-2047", Accept: "text/html,*/*;q=0.5" }, maxRedirects: 4, maxChars: 4_000 });
    return { ok: res.status < 500, status: res.status, ms: res.ms, error: res.status >= 500 ? `The site answered with an error (${res.status}).` : null };
  } catch (error) {
    return { ok: false, status: null, ms: Date.now() - started, error: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
  }
}

export function defaultIo(ctx: PluginContext): MonitorIo {
  return {
    page: (url) => fetchPage(ctx, url),
    tls: (host) => tlsExpiry(host),
    async rdap(domain) {
      try {
        const res = await safeFetch(ctx, rdapUrl(domain), { method: "GET", headers: { "User-Agent": USER_AGENT, Accept: "application/rdap+json, application/json" }, maxRedirects: 4, maxChars: 400_000 });
        if (res.status !== 200) return { expiresAt: null, error: rdapProblem(domain, res.status) };
        return parseRdapExpiry(JSON.parse(res.text) as unknown);
      } catch (error) {
        return { expiresAt: null, error: `The registry lookup failed (${(error instanceof Error ? error.message : String(error)).slice(0, 120)}).` };
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    outside: (url) => outsideCheck(ctx, url, (ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

/** Two tries, a couple of seconds apart: a dropped request is not an outage. */
export async function checkPage(io: MonitorIo, url: string, retryAfterMs = 2_000): Promise<PageResult> {
  const first = await io.page(url);
  if (first.ok) return first;
  await io.sleep(retryAfterMs);
  const second = await io.page(url);
  return second.ok ? second : { ...second, error: second.error ?? first.error };
}

/** The state after one page check. Down stays down since the first failure; up clears everything. */
export function afterPageCheck(prev: MonitorRow, result: PageResult, now: Date): MonitorRow {
  const at = now.toISOString();
  if (result.ok) {
    return { ...prev, status: "up", httpStatus: result.status, responseMs: result.ms, lastError: null, lastCheckedAt: at, lastOkAt: at, downSince: null, failures: 0 };
  }
  return {
    ...prev,
    status: "down",
    httpStatus: result.status,
    responseMs: result.ms,
    lastError: result.error,
    lastCheckedAt: at,
    downSince: prev.status === "down" && prev.downSince ? prev.downSince : at,
    failures: prev.failures + 1,
  };
}

export function downMinutes(m: Pick<MonitorRow, "status" | "downSince">, now: number): number {
  if (m.status !== "down" || !m.downSince) return 0;
  return Math.max(0, Math.floor((now - Date.parse(m.downSince)) / MINUTE_MS));
}

/** How long a recorded outside pass keeps a VPS-only timeout from raising or holding an outage. After this an agent has to look again and record it again. */
export const OUTSIDE_PASS_TTL_HOURS = 24;
const OUTSIDE_PASS_SKEW_MS = 5 * MINUTE_MS;
/** What our own fetch says when nothing came back at all: a timeout or a dropped connection (not a 5xx, not a name that does not resolve). */
const NO_ANSWER_ERROR = /timed? ?out|timeout|etimedout|econnreset|econnaborted|epipe|socket hang up|connection (?:was )?(?:reset|closed|dropped|terminated)|connect(?:ion)? aborted|operation was aborted|fetch failed/i;

/** True when this machine got no answer (timeout or dropped connection) rather than a server error or a DNS failure. */
export function isNoAnswerError(m: Pick<MonitorRow, "httpStatus" | "lastError">): boolean {
  return m.httpStatus === null && Boolean(m.lastError) && NO_ANSWER_ERROR.test(m.lastError!);
}

/**
 * True when the site is down only from our server: the monitor got no answer (a timeout or a dropped connection, not an HTTP 5xx from the origin),
 * and the latest outside fetch an agent recorded found the page up, was taken after the outage began and is not older than OUTSIDE_PASS_TTL_HOURS.
 */
export function outsidePassCovers(m: MonitorRow, now: number): boolean {
  if (m.status !== "down" || !m.downSince || m.outsideVerdict !== "up" || !m.outsideCheckedAt) return false;
  const at = Date.parse(m.outsideCheckedAt);
  if (!Number.isFinite(at) || at < Date.parse(m.downSince) || at > now + OUTSIDE_PASS_SKEW_MS || now - at > OUTSIDE_PASS_TTL_HOURS * HOUR_MS) return false;
  return isNoAnswerError(m);
}

const dueAfter = (checkedAt: string | null, hours: number, now: number) => !checkedAt || now - Date.parse(checkedAt) >= hours * HOUR_MS;

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

export interface MonitorRun {
  checked: number;
  down: number;
  tlsChecked: number;
  domainChecked: number;
  issues: number;
}

export interface MonitorOptions {
  io?: MonitorIo;
  now?: () => Date;
  maxSites?: number;
  budgetMs?: number;
  retryAfterMs?: number;
}

/** Checks the sites of one company that are due, saves their state, and raises the alarms. */
export async function runSiteMonitor(ctx: PluginContext, companyId: string, options: MonitorOptions = {}): Promise<MonitorRun> {
  const io = options.io ?? defaultIo(ctx);
  const clock = options.now ?? (() => new Date());
  const started = clock().getTime();
  const run: MonitorRun = { checked: 0, down: 0, tlsChecked: 0, domainChecked: 0, issues: 0 };
  const [sites, monitors] = await Promise.all([listMonitorSites(ctx, companyId), listMonitors(ctx, companyId)]);
  const byId = new Map(monitors.map((m) => [m.siteId, m]));
  // A site whose client was deleted is nobody's to watch.
  const clientKnown = new Map<string, boolean>();
  const known = async (client: ClientKey) => {
    const key = `${client.kind}:${client.id}`;
    if (!clientKnown.has(key)) clientKnown.set(key, Boolean(await clientInfo(ctx, companyId, client).catch(() => null)));
    return clientKnown.get(key)!;
  };
  const candidates: Array<{ site: MonitorSite; state: MonitorRow }> = [];
  for (const site of sites) {
    const state = byId.get(site.id) ?? emptyMonitor(site.id, companyId);
    if (!state.enabled || (state.lastCheckedAt && started - Date.parse(state.lastCheckedAt) < MIN_INTERVAL_MINUTES * MINUTE_MS)) continue;
    if (await known(site.client)) candidates.push({ site, state });
  }
  const due = candidates
    .sort((a, b) => (Date.parse(a.state.lastCheckedAt ?? "") || 0) - (Date.parse(b.state.lastCheckedAt ?? "") || 0))
    .slice(0, options.maxSites ?? MAX_SITES_PER_RUN);
  const domainsDone = new Map<string, Promise<DomainResult>>();
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = due[index];
      if (!item) return;
      if (clock().getTime() - started > (options.budgetMs ?? RUN_BUDGET_MS)) return;
      try {
        await checkSite(ctx, io, clock, item.site, item.state, domainsDone, run, options.retryAfterMs);
      } catch (error) {
        ctx.logger.info("CRM site check skipped", { siteId: item.site.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, () => worker()));
  // The history is kept for the monthly figure only.
  const cutoff = new Date(started - UPTIME_KEEP_DAYS * DAY_MS).toISOString().slice(0, 10);
  await ctx.db.execute(`DELETE FROM ${table(ctx, "site_uptime_days")} WHERE company_id = $1 AND day < $2`, [companyId, cutoff]).catch(() => undefined);
  return run;
}

async function checkSite(
  ctx: PluginContext,
  io: MonitorIo,
  clock: () => Date,
  site: MonitorSite,
  prev: MonitorRow,
  domainsDone: Map<string, Promise<DomainResult>>,
  run: MonitorRun,
  retryAfterMs?: number,
): Promise<void> {
  const result = await checkPage(io, site.url, retryAfterMs);
  const now = clock();
  let state = afterPageCheck(prev, result, now);
  run.checked += 1;
  if (!result.ok) run.down += 1;
  await recordUptimeDay(ctx, site.companyId, site.id, !result.ok, now);

  const host = hostOf(site.url);
  const https = /^https:\/\//i.test(site.url) || !/^[a-z]+:\/\//i.test(site.url);
  if (host && https && dueAfter(state.tlsCheckedAt, TLS_EVERY_HOURS, now.getTime())) {
    const tls = await io.tls(host);
    state = { ...state, tlsExpiresAt: tls.expiresAt ?? (tls.error ? state.tlsExpiresAt : null), tlsError: tls.error, tlsCheckedAt: now.toISOString() };
    run.tlsChecked += 1;
  }
  const domain = host ? registrableDomain(host) : null;
  if (domain && !state.domainManual && dueAfter(state.domainCheckedAt, state.domainError && !state.domainExpiresAt ? DOMAIN_RETRY_HOURS : DOMAIN_EVERY_HOURS, now.getTime())) {
    // The promise is shared, so two sites on one domain asked at the same moment still make one registry call.
    if (!domainsDone.has(domain)) domainsDone.set(domain, io.rdap(domain));
    const found = await domainsDone.get(domain)!;
    state = { ...state, domain, domainExpiresAt: found.expiresAt ?? (found.error ? state.domainExpiresAt : null), domainError: found.error, domainCheckedAt: now.toISOString() };
    run.domainChecked += 1;
  } else if (domain && !state.domain) {
    state = { ...state, domain };
  }
  await saveMonitor(ctx, state);
  run.issues += await raiseAlarms(ctx, site, prev, state, now, io);
}

async function recordUptimeDay(ctx: PluginContext, companyId: string, siteId: string, failed: boolean, now: Date): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  const id = `${siteId}:${day}`;
  // Bump the day's counters; the first check of the day makes the row. (Two statements: a counter bump inside ON CONFLICT would be ambiguous.)
  const bump = () => ctx.db.execute(`UPDATE ${table(ctx, "site_uptime_days")} SET checks = checks + 1${failed ? ", failed = failed + 1" : ""}, updated_at = now() WHERE id = $1 AND company_id = $2`, [id, companyId]);
  if (((await bump()).rowCount ?? 0) > 0) return;
  const inserted = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "site_uptime_days")} (id, site_id, company_id, day, checks, failed, updated_at)
     VALUES ($1, $2, $3, $4, 1, ${failed ? 1 : 0}, now())
     ON CONFLICT (id) DO NOTHING`,
    [id, siteId, companyId, day],
  );
  if ((inserted.rowCount ?? 0) === 0) await bump();
}

/** Uptime of one site over a month, from the daily counts: null when it was not checked. */
export async function uptimeFigures(ctx: PluginContext, companyId: string, siteId: string, period: string): Promise<{ checks: number; failed: number; pct: number } | null> {
  const rows = await ctx.db.query<{ day: string; checks: number | string; failed: number | string }>(
    `SELECT day, checks, failed FROM ${table(ctx, "site_uptime_days")} WHERE company_id = $1 AND site_id = $2 LIMIT 400`,
    [companyId, siteId],
  );
  let checks = 0;
  let failed = 0;
  for (const row of rows) {
    if (!String(row.day).startsWith(period)) continue;
    checks += Number(row.checks);
    failed += Number(row.failed);
  }
  return checks > 0 ? { checks, failed, pct: Math.round((1 - failed / checks) * 10_000) / 100 } : null;
}

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

const compact = (isoTime: string) => isoTime.replace(/[-:T]/g, "").slice(0, 12);

async function raiseAlarms(ctx: PluginContext, site: MonitorSite, prev: MonitorRow, state: MonitorRow, now: Date, io?: MonitorIo): Promise<number> {
  let opened = 0;
  const name = siteName(site);
  const info = await clientInfo(ctx, site.companyId, site.client).catch(() => null);
  const clientName = info?.name ?? "a client";
  const prefix = await companyPrefix(ctx, site.companyId);
  const projectId = site.projectId ?? (await clientProjectOf(ctx, site.companyId, site.client));
  const link = crmLink(prefix, site.client.kind, site.client.id);
  const common = { companyId: site.companyId, assignee: await deliveryLeadAssignee(ctx, site.companyId), projectId, priority: "high" as const };

  if (state.status === "down" && state.downSince && downMinutes(state, now.getTime()) >= DOWN_AFTER_MINUTES) {
    const before = (await ctx.issues.list({ companyId: site.companyId, originKind: "plugin:partnersinbiz.crm", originId: originFor.siteDown(site.id, compact(state.downSince)), limit: 1 }).catch(() => []))[0];
    // Before a new issue: is it down for everyone, or only unreachable from our server (a host firewall blocking our IP)?
    // A recorded outside pass (an agent's own fetch) says the same; a live outside check that finds it down still wins.
    const recorded = outsidePassCovers(state, now.getTime());
    const outside = (!before || recorded) && io?.outside ? await io.outside(site.url) : null;
    const vpsOnly = outside?.verdict === "up" || (recorded && outside?.verdict !== "down");
    if (vpsOnly) {
      ctx.logger.warn("CRM site monitor: only our server cannot reach this site; no issue opened", { siteId: site.id, url: site.url, downSince: state.downSince, lastError: state.lastError, outside: outside?.detail ?? null, recordedOutsidePassAt: recorded ? state.outsideCheckedAt : null });
    } else await openIssueOnce(ctx, {
      ...common,
      originId: originFor.siteDown(site.id, compact(state.downSince)),
      title: `Site down: ${name} (${clientName})`.slice(0, 200),
      description: [
        `${site.url} has not answered since ${state.downSince} (${downMinutes(state, now.getTime())} minutes, ${state.failures} failed checks). Last error: ${state.lastError ?? "none recorded"}.`,
        ...(outside ? [`Outside check: ${outside.detail}.`] : []),
        "",
        "Find out why and fix it, or tell the client. Look at: the host and DNS, the certificate, a failed deploy or plugin update (the client's repo project and the deploy log), and whether a person changed something. Keep the client informed through a Mailbox draft a person approves; never promise a time you cannot keep.",
        "",
        `Client: ${link}. The monitor checks every 5 minutes; when the site answers again it adds a comment here.`,
        "",
        "**Done when** the site answers. Closing checks it with a fresh look.",
      ].join("\n"),
      wakeReason: "A client's website is down",
    });
    if (!before && !vpsOnly) opened += 1;
  }
  // Back up: say so on the outage's issue.
  if (prev.status === "down" && state.status === "up" && prev.downSince) {
    const issue = (await ctx.issues.list({ companyId: site.companyId, originKind: "plugin:partnersinbiz.crm", originId: originFor.siteDown(site.id, compact(prev.downSince)), limit: 1 }).catch(() => []))[0];
    if (issue) {
      await ctx.issues.createComment(issue.id, `${site.url} answers again (checked ${now.toISOString()}). It was down from ${prev.downSince}. Closing this issue automatically.`, site.companyId).catch(() => undefined);
      const open = !["done", "cancelled"].includes(String((issue as { status?: string }).status ?? ""));
      if (open) await ctx.issues.update(issue.id, { status: "done" }, site.companyId).catch((error: unknown) => ctx.logger.info("CRM site-down auto-close failed", { issueId: issue.id, error: error instanceof Error ? error.message : String(error) }));
    }
  }

  const tlsDays = daysUntil(state.tlsExpiresAt, now.getTime());
  if (state.tlsExpiresAt && tlsDays !== null && tlsDays < TLS_WARN_DAYS) {
    await openIssueOnce(ctx, {
      ...common,
      originId: originFor.siteTls(site.id, state.tlsExpiresAt.slice(0, 10)),
      title: `${tlsDays < 0 ? "Certificate expired" : "Certificate expires soon"}: ${name} (${clientName})`.slice(0, 200),
      description: [
        `The certificate of ${hostOf(site.url)} ${tlsDays < 0 ? `expired on ${state.tlsExpiresAt.slice(0, 10)}` : `expires on ${state.tlsExpiresAt.slice(0, 10)} (${tlsDays} days)`}. Visitors get a browser warning once it has.`,
        "",
        "Renew or fix the automatic renewal (Let's Encrypt or the host's own), then check the site in a browser. If it is the client's own hosting, ask the client or their host through a Mailbox draft a person approves.",
        "",
        `Client: ${link}`,
        "",
        "**Done when** the certificate is renewed. Closing checks it with a fresh look.",
      ].join("\n"),
      wakeReason: "A certificate is about to expire",
    });
    opened += 1;
  } else if (state.tlsError && state.tlsError.startsWith("The certificate is not trusted") && !prev.tlsError) {
    await openIssueOnce(ctx, {
      ...common,
      originId: originFor.siteTls(site.id, `untrusted-${now.toISOString().slice(0, 7)}`),
      title: `Certificate not trusted: ${name} (${clientName})`.slice(0, 200),
      description: [`${hostOf(site.url)}: ${state.tlsError}`, "", "Fix the certificate (a missing chain, a wrong name, an expired intermediate), then check the site in a browser.", "", `Client: ${link}`].join("\n"),
      wakeReason: "A certificate is not trusted",
    });
    opened += 1;
  }

  const domainDays = daysUntil(state.domainExpiresAt, now.getTime());
  if (state.domainExpiresAt && domainDays !== null && domainDays < DOMAIN_WARN_DAYS) {
    await openIssueOnce(ctx, {
      ...common,
      originId: originFor.siteDomain(site.id, state.domainExpiresAt.slice(0, 10)),
      title: `${domainDays < 0 ? "Domain expired" : "Domain expires soon"}: ${state.domain ?? name} (${clientName})`.slice(0, 200),
      description: [
        `The domain ${state.domain ?? hostOf(site.url)} ${domainDays < 0 ? `expired on ${state.domainExpiresAt.slice(0, 10)}` : `expires on ${state.domainExpiresAt.slice(0, 10)} (${domainDays} days)`}. If it lapses the website and the email on that domain stop working.`,
        "",
        "Find out who owns the registration (the client or us) and make sure it is renewed. If the client holds it, ask them through a Mailbox draft a person approves. Renewal and payment are the owner's: put a Needs-you item on it when money is needed.",
        "",
        `Client: ${link}`,
        "",
        "**Done when** the domain is renewed. Closing checks the expiry date again.",
      ].join("\n"),
      wakeReason: "A domain is about to expire",
    });
    opened += 1;
  }
  return opened;
}

// ---------------------------------------------------------------------------
// Done-checks (they read the monitor row, and look again when it is stale)
// ---------------------------------------------------------------------------

export type CheckResult = { done: true } | { done: false; missing: string[] };

/** A fresh look for a closing issue: the site is checked once more when the last check is older than 10 minutes (or tls/domain older than a day). */
export async function siteIssueResolved(ctx: PluginContext, companyId: string, originId: string, io: MonitorIo = defaultIo(ctx), now = new Date()): Promise<CheckResult> {
  const parts = originId.split(":");
  const kind = parts[1] ?? "";
  const siteId = parts[2] ?? "";
  const site = (await listMonitorSites(ctx, companyId)).find((row) => row.id === siteId);
  if (!site) return { done: true };
  let state = (await getMonitor(ctx, companyId, siteId)) ?? emptyMonitor(siteId, companyId);
  const stale = (at: string | null, minutes: number) => !at || now.getTime() - Date.parse(at) > minutes * MINUTE_MS;
  if (kind === "site-down") {
    if (stale(state.lastCheckedAt, 10)) {
      state = afterPageCheck(state, await checkPage(io, site.url), now);
      await saveMonitor(ctx, state);
    }
    if (state.status === "down" && outsidePassCovers(state, now.getTime())) {
      // Only our server cannot reach it and an agent's outside fetch found it up: not an outage, unless a live outside check now says it is down.
      const outside = io.outside ? await io.outside(site.url) : null;
      if (outside?.verdict !== "down") return { done: true };
    }
    return state.status === "down" ? { done: false, missing: [`${site.url} still does not answer (${state.lastError ?? "no answer"}): fix it, or say in a comment why it cannot be fixed and block the issue.`] } : { done: true };
  }
  const host = hostOf(site.url);
  if (kind === "site-tls" && host) {
    if (stale(state.tlsCheckedAt, 24 * 60)) {
      const tls = await io.tls(host);
      state = { ...state, tlsExpiresAt: tls.expiresAt ?? state.tlsExpiresAt, tlsError: tls.error, tlsCheckedAt: now.toISOString() };
      await saveMonitor(ctx, state);
    }
    const days = daysUntil(state.tlsExpiresAt, now.getTime());
    return days !== null && days < TLS_WARN_DAYS ? { done: false, missing: [`The certificate of ${host} still expires on ${state.tlsExpiresAt?.slice(0, 10)}: renew it, then close this issue.`] } : { done: true };
  }
  if (kind === "site-domain" && host) {
    const domain = registrableDomain(host);
    if (domain && !state.domainManual && stale(state.domainCheckedAt, 24 * 60)) {
      const found = await io.rdap(domain);
      state = { ...state, domain, domainExpiresAt: found.expiresAt ?? state.domainExpiresAt, domainError: found.error, domainCheckedAt: now.toISOString() };
      await saveMonitor(ctx, state);
    }
    const days = daysUntil(state.domainExpiresAt, now.getTime());
    return days !== null && days < DOMAIN_WARN_DAYS ? { done: false, missing: [`The domain ${state.domain ?? host} still expires on ${state.domainExpiresAt?.slice(0, 10)}: renew it (or, when it was renewed but the registry has not caught up, set the new date with \`set-site-monitoring\` domainExpiresAt), then close this issue.`] } : { done: true };
  }
  return { done: true };
}

// ---------------------------------------------------------------------------
// The Cockpit
// ---------------------------------------------------------------------------

/** Up to three checks (uptime, certificates, domains) over every monitored site of the company. Nothing for a company with no sites. */
export async function siteMonitorHealth(ctx: PluginContext, companyId: string, now = Date.now()): Promise<HealthCheck[]> {
  const [sites, monitors] = await Promise.all([listMonitorSites(ctx, companyId), listMonitors(ctx, companyId)]);
  if (sites.length === 0) return [];
  const byId = new Map(monitors.map((m) => [m.siteId, m]));
  const watched = sites.filter((site) => byId.get(site.id)?.enabled !== false);
  const name = (site: MonitorSite) => siteName(site);
  const checks: HealthCheck[] = [];

  const downAll = watched.filter((site) => downMinutes(byId.get(site.id) ?? emptyMonitor(site.id, companyId), now) >= DOWN_AFTER_MINUTES);
  // Down only from our server, with a recorded outside pass: not a client outage.
  const vpsOnly = downAll.filter((site) => outsidePassCovers(byId.get(site.id)!, now));
  const down = downAll.filter((site) => !vpsOnly.includes(site));
  checks.push(down.length > 0
    ? {
      key: "sites:uptime", title: "Client websites up", status: "bad",
      detail: `${down.length} client website${down.length === 1 ? " is" : "s are"} down: ${down.slice(0, 3).map((site) => `${name(site)} (${downMinutes(byId.get(site.id)!, now)} min)`).join(", ")}${down.length > 3 ? ", ..." : ""}.`,
      href: "/crm", fix: "The Delivery Lead has an issue for each outage. Check the host, DNS and the last deploy.",
      since: down.map((site) => byId.get(site.id)?.downSince).filter((at): at is string => Boolean(at)).sort()[0] ?? null,
    }
    : { key: "sites:uptime", title: "Client websites up", status: "ok", detail: `${watched.length} monitored, none down.${vpsOnly.length ? ` ${vpsOnly.length} unreachable from our server only (an outside check found ${vpsOnly.length === 1 ? "it" : "them"} up): ${vpsOnly.slice(0, 3).map(name).join(", ")}.` : ""}` });

  const certs = watched.map((site) => ({ site, days: daysUntil(byId.get(site.id)?.tlsExpiresAt ?? null, now), untrusted: Boolean(byId.get(site.id)?.tlsError?.startsWith("The certificate is not trusted")) }));
  const certBad = certs.filter((c) => (c.days !== null && c.days < 3) || c.untrusted);
  const certWarn = certs.filter((c) => c.days !== null && c.days >= 3 && c.days < TLS_WARN_DAYS);
  checks.push(certBad.length || certWarn.length
    ? {
      key: "sites:tls", title: "Client certificates", status: certBad.length ? "bad" : "warn",
      detail: [...certBad, ...certWarn].slice(0, 3).map((c) => `${name(c.site)}: ${c.untrusted ? "not trusted" : c.days! < 0 ? "expired" : `${c.days} days left`}`).join("; ") + ".",
      href: "/crm", fix: "Renew the certificate (or its automatic renewal). The Delivery Lead has an issue for each.",
    }
    : { key: "sites:tls", title: "Client certificates", status: "ok", detail: certs.some((c) => c.days !== null) ? `Every certificate has more than ${TLS_WARN_DAYS} days left.` : "No certificate has been read yet." });

  const domains = watched.map((site) => ({ site, days: daysUntil(byId.get(site.id)?.domainExpiresAt ?? null, now) })).filter((d) => d.days !== null && d.days < DOMAIN_WARN_DAYS);
  checks.push(domains.length
    ? {
      key: "sites:domain", title: "Client domains", status: domains.some((d) => d.days! < 7) ? "bad" : "warn",
      detail: domains.slice(0, 3).map((d) => `${name(d.site)}: ${d.days! < 0 ? "expired" : `${d.days} days left`}`).join("; ") + ".",
      href: "/crm", fix: "Make sure the registration is renewed. The Delivery Lead has an issue for each; payment is the owner's.",
    }
    : { key: "sites:domain", title: "Client domains", status: "ok", detail: "No domain is close to expiring (or its expiry is not known yet)." });
  return checks;
}

// ---------------------------------------------------------------------------
// The tool and the client page
// ---------------------------------------------------------------------------

/** Reads the three outside-check fields of set-site-monitoring: the address checked (the site's own host, with or without www), when, and whether it answered. */
function recordOutsideCheck(site: MonitorSite, state: MonitorRow, params: Record<string, unknown>, now: number): MonitorRow {
  const verdict = params.outsideVerdict;
  if (verdict !== "up" && verdict !== "down") throw new CrmError("outsideVerdict must be \"up\" or \"down\" (record an outside fetch with outsideUrl, outsideCheckedAt and outsideVerdict together)");
  const url = typeof params.outsideUrl === "string" ? params.outsideUrl.trim() : "";
  const checkedAt = Date.parse(String(params.outsideCheckedAt ?? ""));
  if (!url || !Number.isFinite(checkedAt)) throw new CrmError("outsideUrl and outsideCheckedAt (a date and time, e.g. 2026-10-22T23:12:00Z) are required with outsideVerdict");
  const bare = (host: string | null) => host?.replace(/^www\./, "") ?? null;
  const host = bare(hostOf(url));
  if (!host || host !== bare(hostOf(site.url))) throw new CrmError(`outsideUrl must be this site's own address (${site.url}), not ${url}`);
  if (checkedAt > now + MINUTE_MS * 5) throw new CrmError("outsideCheckedAt is in the future");
  return { ...state, outsideUrl: url.slice(0, 500), outsideVerdict: verdict, outsideCheckedAt: new Date(checkedAt).toISOString() };
}

/** Pause or resume monitoring of a site, set its domain expiry by hand (when the registry lookup does not know the domain), or record an outside fetch of it. */
export async function setSiteMonitoringTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const siteId = typeof params.siteId === "string" ? params.siteId.trim() : "";
  if (!siteId) throw new CrmError("siteId is required (list-client-sites shows them)");
  const site = (await listMonitorSites(ctx, viewer.companyId)).find((row) => row.id === siteId);
  if (!site) throw new CrmError("That website was not found");
  await requireClient(ctx, viewer, site.client);
  let state = (await getMonitor(ctx, viewer.companyId, siteId)) ?? emptyMonitor(siteId, viewer.companyId);
  if (typeof params.enabled === "boolean") state = { ...state, enabled: params.enabled };
  if (params.domainExpiresAt !== undefined) {
    if (params.domainExpiresAt === "" || params.domainExpiresAt === null) {
      state = { ...state, domainManual: false, domainExpiresAt: null, domainCheckedAt: null };
    } else {
      const at = Date.parse(String(params.domainExpiresAt));
      if (!Number.isFinite(at)) throw new CrmError("domainExpiresAt must be a date, e.g. 2027-03-31 (an empty value goes back to the registry lookup)");
      state = { ...state, domainManual: true, domainExpiresAt: new Date(at).toISOString(), domainError: null, domainCheckedAt: new Date().toISOString(), domain: registrableDomain(hostOf(site.url) ?? "") ?? state.domain };
    }
  }
  if (params.outsideVerdict !== undefined || params.outsideUrl !== undefined || params.outsideCheckedAt !== undefined) {
    state = recordOutsideCheck(site, state, params, Date.now());
  }
  await saveMonitor(ctx, state);
  return monitorView(site, state, Date.now());
}

export function monitorView(site: MonitorSite, state: MonitorRow | null, now: number) {
  const m = state ?? emptyMonitor(site.id, site.companyId);
  return {
    siteId: site.id,
    url: site.url,
    monitored: m.enabled,
    status: m.status,
    downMinutes: downMinutes(m, now),
    httpStatus: m.httpStatus,
    responseMs: m.responseMs,
    lastCheckedAt: m.lastCheckedAt,
    certificate: { expiresAt: m.tlsExpiresAt, daysLeft: daysUntil(m.tlsExpiresAt, now), problem: m.tlsError },
    domain: { name: m.domain, expiresAt: m.domainExpiresAt, daysLeft: daysUntil(m.domainExpiresAt, now), manual: m.domainManual, problem: m.domainExpiresAt ? null : m.domainError },
    lastError: m.lastError,
    outsideCheck: m.outsideCheckedAt ? { url: m.outsideUrl, checkedAt: m.outsideCheckedAt, verdict: m.outsideVerdict, holdsBackOutage: outsidePassCovers(m, now) } : null,
  };
}

/** What the client page shows for each of its sites. */
export async function monitorViews(ctx: PluginContext, companyId: string, client: ClientKey) {
  const sites = (await listMonitorSites(ctx, companyId)).filter((site) => site.client.kind === client.kind && site.client.id === client.id);
  if (sites.length === 0) return [];
  const states = new Map((await listMonitors(ctx, companyId)).map((m) => [m.siteId, m]));
  const now = Date.now();
  return sites.map((site) => monitorView(site, states.get(site.id) ?? null, now));
}
