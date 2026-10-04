/**
 * Google Analytics 4 (read only) through the company's Google service account: connect a sprint's property (found by
 * the site's address, or given), pull the weekly numbers, and answer with organic traffic and key events attributed
 * to the sprint's pages. The Google calls are in integrations/ga4.ts, the arithmetic in engine/analytics.ts.
 *
 * The one-time grants are the same shape as Search Console's: the Google Cloud APIs are enabled once for the company
 * (`ga4_api`), and the property's owner adds the service account as a Viewer once per client (`ga4_access`). Both go
 * on the sprint's Needs you digest with exact steps, and close themselves when a pull works.
 */
import { randomUUID } from "node:crypto";
import * as db from "../db.js";
import {
  analyticsLine,
  analyticsSnapshot,
  completedWeeks,
  sprintPages,
  summarizeAnalytics,
  type AnalyticsSummary,
  type WeekRow,
} from "../engine/analytics.js";
import { ga4AccessItem, ga4ApiItem } from "../engine/items.js";
import { offMessage } from "../engine/switches.js";
import { daysBetween } from "../engine/time.js";
import { discoverGa4Property, fetchGa4Weeks, GA4_SCOPE, Ga4Error, ga4StreamHosts, parseGa4PropertyId, probeGa4Property, propertyName, siteHostOf, streamsMatchSite, type Ga4Discovery } from "../integrations/ga4.js";
import { serviceAccountToken } from "../integrations/google-sa.js";
import { actorId, companyInfo, errorMessage, num, reqStr, SeoError, str, type Actor, type CompanyInfo, type Env, type Params } from "./common.js";
import { requireSprint } from "./context.js";
import { loadServiceAccount } from "./google-access.js";
import { addNeedsYou, resolveNeedsYou } from "./needs-you.js";
import { requireOn } from "./switches.js";

/** The first pull reaches back this many completed weeks (a quarter of history before the sprint is the baseline). */
export const BACKFILL_WEEKS = 13;
/** Later pulls refresh the last few weeks: GA4 revises recent days for about two days. */
export const REFRESH_WEEKS = 3;
/** A sprint without a property is looked up again at most this often (days). */
export const DISCOVERY_EVERY_DAYS = 3;

export type Ga4State = "connected" | "no_service_account" | "needs_api" | "needs_access" | "needs_property" | "property_mismatch" | "bad_property" | "error";

export interface Ga4Connect {
  state: Ga4State;
  propertyId: string | null;
  message: string;
  serviceAccountEmail: string | null;
  /** The Needs you item raised or kept open. */
  needsYou: string | null;
  weeksPulled?: number;
  /** Properties whose web stream is this site's address (never other sites' properties the service account can also read). */
  candidates?: Array<{ id: string; displayName: string }>;
}

export function propertyIdOf(integration: Pick<db.Integration, "propertyUrl" | "settings"> | null): string | null {
  const fromSettings = typeof integration?.settings?.propertyId === "string" ? integration.settings.propertyId : null;
  const fromUrl = integration?.propertyUrl?.replace(/^properties\//, "") ?? null;
  const id = fromSettings ?? fromUrl;
  return id && /^\d+$/.test(id) ? id : null;
}

export function ga4View(integration: db.Integration | null) {
  const propertyId = propertyIdOf(integration);
  return {
    connected: integration?.status === "connected" && Boolean(propertyId),
    propertyId,
    status: integration?.status ?? "disconnected",
    lastPullAt: integration?.lastPullAt ?? null,
    lastError: integration?.lastError ?? null,
  };
}

async function ga4Integration(env: Env, sprint: db.Sprint): Promise<db.Integration> {
  let integration = await db.getIntegration(env.ctx.db, sprint.companyId, sprint.id, "ga4");
  if (!integration) {
    await db.ensureIntegration(env.ctx.db, { id: randomUUID(), companyId: sprint.companyId, sprintId: sprint.id, provider: "ga4", status: "disconnected" });
    integration = await db.getIntegration(env.ctx.db, sprint.companyId, sprint.id, "ga4");
  }
  if (!integration) throw new SeoError("The Google Analytics integration row could not be created");
  return integration;
}

/** A service account token for Google Analytics (its own scope, so Search Console tokens stay as narrow as before). */
async function ga4Access(env: Env, info: CompanyInfo): Promise<{ token: string; email: string } | null> {
  const sa = await loadServiceAccount(info);
  if (sa.error) throw new SeoError(`The Google service account cannot be used: ${sa.error}`);
  if (!sa.key) return null;
  return { token: await serviceAccountToken(env.fetch, sa.key, [GA4_SCOPE], env.now().getTime()), email: sa.key.clientEmail };
}

async function raise(env: Env, info: CompanyInfo, sprint: db.Sprint, item: ReturnType<typeof ga4AccessItem>, reopen: boolean): Promise<string> {
  await addNeedsYou(env, info, sprint, item, { reopen }).catch((error: unknown) => env.ctx.logger.info("SEO GA4 needs-you item not added", { sprintId: sprint.id, key: item.key, error: errorMessage(error) }));
  return item.key;
}

/** Pull the weekly numbers (a first pull reaches back BACKFILL_WEEKS, later ones refresh the last REFRESH_WEEKS). */
export async function pullGa4(env: Env, info: CompanyInfo, sprint: db.Sprint, integration: db.Integration, token: string, propertyId: string, extraSettings: Record<string, unknown> = {}): Promise<number> {
  const first = (await db.listGa4Weeks(env.ctx.db, sprint.companyId, sprint.id, 1)).length === 0;
  const weeks = await fetchGa4Weeks(env.fetch, token, propertyId, completedWeeks(info.today, first ? BACKFILL_WEEKS : REFRESH_WEEKS));
  for (const week of weeks) await db.upsertGa4Week(env.ctx.db, { id: randomUUID(), companyId: sprint.companyId, sprintId: sprint.id, propertyId, ...week });
  const last = weeks[weeks.length - 1];
  await db.updateIntegration(env.ctx.db, sprint.companyId, integration.id, {
    status: "connected",
    property_url: propertyName(propertyId),
    last_pull_at: new Date().toISOString(),
    last_error: null,
    settings: { ...integration.settings, auth: "service_account", propertyId, pulledOn: info.today, ...extraSettings },
    stats: last ? { week: last.weekStart, sessions: last.sessions, organicSessions: last.organic.sessions, organicKeyEvents: last.organic.keyEvents, weeks: weeks.length } : {},
  });
  return weeks.length;
}

/**
 * Connect a sprint to its GA4 property and pull its first weeks. Finds the property by the site's address through the
 * Admin API unless one is given; raises the matching Needs you item when a grant is missing. Never throws for a state a
 * person can fix: the answer says which.
 *
 * The service account is a Viewer on every client's property, so a property id someone gives is checked against the
 * sprint's own site before any number is read: its web streams must include the site's address. An agent that pastes
 * another client's id is refused (`property_mismatch`); a person (`allowMismatch`) may confirm one that is right for a
 * reason the streams cannot show, and the confirmation is kept on the integration. Nothing about other properties is
 * returned: candidates are only properties for this site.
 */
export async function connectGa4(env: Env, info: CompanyInfo, sprint: db.Sprint, opts: { propertyId?: string | null; allowMismatch?: boolean; confirmedBy?: string | null } = {}): Promise<Ga4Connect> {
  // Every Google call for a sprint's analytics starts here: none for a sprint a person has not switched it on for.
  requireOn(sprint, "ga4", offMessage("ga4"));
  const integration = await ga4Integration(env, sprint);
  const wasConnected = integration.status === "connected";
  const access = await ga4Access(env, info);
  if (!access) return { state: "no_service_account", propertyId: null, message: "No Google service account key is set yet (it is on Needs you); Google Analytics uses the same key as Search Console.", serviceAccountEmail: null, needsYou: null };
  const base = { serviceAccountEmail: access.email };
  const given = opts.propertyId ?? null;
  // A sprint that already works must not be knocked over by someone trying another property id: that attempt is answered and left unrecorded.
  const working = wasConnected ? propertyIdOf(integration) : null;
  const trying = Boolean(given && working && given !== working);
  const remember = (patch: Record<string, unknown>) => (trying ? Promise.resolve(0) : db.updateIntegration(env.ctx.db, sprint.companyId, integration.id, patch));
  const ask = async (item: ReturnType<typeof ga4AccessItem>): Promise<string | null> => (trying ? null : raise(env, info, sprint, item, wasConnected));
  /** The answer for a Google error a person can act on. null: not one of those (the caller rethrows). */
  const explain = async (error: unknown, propertyId: string): Promise<Ga4Connect | null> => {
    if (!(error instanceof Ga4Error)) return null;
    // Only a state that says the connection itself is wrong flips it to disconnected: a one-off quota or server blip keeps what worked.
    const lost = error.kind === "api_disabled" || error.kind === "no_access" || error.kind === "bad_property";
    await remember({ property_url: propertyName(propertyId), ...(lost ? { status: "disconnected" } : {}), last_error: error.message.slice(0, 300), settings: { ...integration.settings, propertyId, lastTryOn: info.today } });
    if (error.kind === "api_disabled") return { ...base, state: "needs_api", propertyId, message: error.message, needsYou: await ask(ga4ApiItem()) };
    if (error.kind === "no_access") return { ...base, state: "needs_access", propertyId, message: `${error.message} The service account ${access.email} is not a Viewer on property ${propertyId} yet.`, needsYou: await ask(ga4AccessItem(sprint, access.email, propertyId)) };
    if (error.kind === "bad_property") return { ...base, state: "bad_property", propertyId, message: `Google does not know property ${propertyId}: ${error.message}`, needsYou: null };
    return { ...base, state: "error", propertyId, message: error.message, needsYou: null };
  };
  let propertyId = given ?? propertyIdOf(integration);
  let discovery: Ga4Discovery | null = null;
  let confirmation: string | null = null;
  if (given) {
    // A property id someone supplied: it must be this site's.
    try {
      if (!streamsMatchSite(await ga4StreamHosts(env.fetch, access.token, given), sprint.siteUrl)) {
        if (!opts.allowMismatch) {
          await remember({ settings: { ...integration.settings, lastTryOn: info.today }, last_error: `Property ${given} has no web stream for ${siteHostOf(sprint.siteUrl)}` });
          return { ...base, state: "property_mismatch", propertyId: null, message: `Property ${given} has no web data stream for ${siteHostOf(sprint.siteUrl)}, so it looks like another site's property. Nothing was connected or read. The service account can read other clients' properties, so the id has to come from this site's owner (Analytics → Admin → Property settings), or a person can connect it from the SEO page.`, needsYou: null };
        }
        confirmation = opts.confirmedBy ?? "a person";
      }
    } catch (error) {
      const answer = await explain(error, given);
      if (answer) return answer;
      throw error;
    }
  } else if (!propertyId) {
    try {
      discovery = await discoverGa4Property(env.fetch, access.token, sprint.siteUrl);
    } catch (error) {
      if (error instanceof Ga4Error && error.kind === "api_disabled") {
        await remember({ settings: { ...integration.settings, lastTryOn: info.today }, last_error: "The Google Analytics Admin API is not enabled" });
        return { ...base, state: "needs_api", propertyId: null, message: error.message, needsYou: await raise(env, info, sprint, ga4ApiItem(), wasConnected) };
      }
      await remember({ settings: { ...integration.settings, lastTryOn: info.today }, last_error: errorMessage(error).slice(0, 300) });
      return { ...base, state: "error", propertyId: null, message: errorMessage(error), needsYou: null };
    }
    propertyId = discovery.propertyId;
    if (!propertyId) {
      await remember({ settings: { ...integration.settings, lastTryOn: info.today }, last_error: discovery.reason.slice(0, 300) });
      return {
        ...base,
        state: discovery.visible.length > 0 ? "needs_property" : "needs_access",
        propertyId: null,
        message: discovery.reason,
        needsYou: await raise(env, info, sprint, ga4AccessItem(sprint, access.email, null), wasConnected),
        // Only properties for this site. The others the service account can read belong to other clients: never listed.
        ...(discovery.matches.length > 0 ? { candidates: discovery.matches.slice(0, 10) } : {}),
      };
    }
  }
  try {
    await probeGa4Property(env.fetch, access.token, propertyId!, info.today);
  } catch (error) {
    const answer = await explain(error, propertyId!);
    if (answer) return answer;
    throw error;
  }
  const weeksPulled = await pullGa4(env, info, sprint, integration, access.token, propertyId!, confirmation ? { propertyConfirmedBy: confirmation, propertyConfirmedOn: info.today } : {});
  for (const key of ["ga4_access", "ga4_api"]) await resolveNeedsYou(env, info, sprint, key, "the Google Analytics connection works").catch(() => undefined);
  const note = confirmation ? ` ${confirmation} confirmed it although none of its web streams is ${siteHostOf(sprint.siteUrl)}.` : "";
  return { ...base, state: "connected", propertyId: propertyId!, message: `Connected to property ${propertyId}${discovery ? ` (${discovery.reason})` : ""}.${note}`, needsYou: null, weeksPulled };
}

// ---------------------------------------------------------------------------
// The summary every reader uses
// ---------------------------------------------------------------------------

async function pagesOf(env: Env, sprint: db.Sprint) {
  const [content, keywords, optimizations] = await Promise.all([
    db.listContent(env.ctx.db, sprint.companyId, sprint.id),
    db.listKeywords(env.ctx.db, sprint.companyId, sprint.id),
    db.listOptimizations(env.ctx.db, sprint.companyId, sprint.id),
  ]);
  return sprintPages({
    siteUrl: sprint.siteUrl,
    content: content.map((c) => ({ title: c.title, targetUrl: c.targetUrl, status: c.status, publishedOn: c.publishedOn })),
    keywords: keywords.map((k) => ({ targetUrl: k.targetUrl })),
    optimizations: optimizations.map((o) => ({ targetUrl: o.targetUrl, status: o.status, approvedAt: o.approvedAt })),
  });
}

/** The GA4 summary of a sprint from the stored weeks; null while no week has been pulled. */
export async function ga4Summary(env: Env, sprint: db.Sprint, opts: { weeks?: number } = {}): Promise<AnalyticsSummary | null> {
  if (!sprint.ga4Enabled) return null;
  const weeks = await db.listGa4Weeks(env.ctx.db, sprint.companyId, sprint.id, opts.weeks ?? 26);
  if (weeks.length === 0) return null;
  const integration = await db.getIntegration(env.ctx.db, sprint.companyId, sprint.id, "ga4");
  return summarizeAnalytics(weeks as WeekRow[], await pagesOf(env, sprint), { propertyId: propertyIdOf(integration) });
}

/** The `analytics` part of a snapshot: small, from stored numbers; empty without GA4. Never throws. */
export async function ga4ForSnapshot(env: Env, sprint: db.Sprint): Promise<Record<string, unknown>> {
  try {
    return analyticsSnapshot(await ga4Summary(env, sprint));
  } catch (error) {
    env.ctx.logger.info("SEO GA4 numbers for the snapshot failed", { sprintId: sprint.id, error: errorMessage(error) });
    return {};
  }
}

/** One line for the weekly review, or null without numbers. */
export async function ga4Line(env: Env, sprint: db.Sprint): Promise<string | null> {
  try {
    return analyticsLine(await ga4Summary(env, sprint, { weeks: 6 }));
  } catch {
    return null;
  }
}

/** Whether a sprint's Google Analytics connection works (the Needs you check). */
export async function ga4Connected(env: Env, sprint: db.Sprint): Promise<boolean> {
  const integration = await db.getIntegration(env.ctx.db, sprint.companyId, sprint.id, "ga4");
  return integration?.status === "connected" && Boolean(propertyIdOf(integration));
}

// ---------------------------------------------------------------------------
// The daily run
// ---------------------------------------------------------------------------

/**
 * Once a day per sprint: pull the last weeks when connected; otherwise look for the property (every few days) and keep the
 * Needs you item open. Returns a warning for the daily record, or null. Never throws.
 */
export async function ga4Daily(env: Env, info: CompanyInfo, sprint: db.Sprint): Promise<string | null> {
  // Off unless a person switched it on for this sprint: no look-up, no pull, no Needs you line, no Google call at all.
  if (!sprint.ga4Enabled) return null;
  try {
    const sa = await loadServiceAccount(info);
    if (!sa.key) return null;
    const integration = await ga4Integration(env, sprint);
    const propertyId = propertyIdOf(integration);
    const pulledOn = typeof integration.settings.pulledOn === "string" ? integration.settings.pulledOn : null;
    if (integration.status === "connected" && propertyId) {
      if (pulledOn === info.today) return null;
      const result = await connectGa4(env, info, sprint);
      return result.state === "connected" ? null : `GA4: ${result.message}`;
    }
    const tried = typeof integration.settings.lastTryOn === "string" ? integration.settings.lastTryOn : null;
    if (tried && daysBetween(tried, info.today) < (propertyId ? 1 : DISCOVERY_EVERY_DAYS)) return null;
    const result = await connectGa4(env, info, sprint);
    return result.state === "connected" || result.state === "needs_access" || result.state === "needs_property" || result.state === "needs_api" ? null : `GA4: ${result.message}`;
  } catch (error) {
    return `GA4: ${errorMessage(error)}`;
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export async function connectGa4Tool(env: Env, companyId: string, actor: Actor, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  requireOn(sprint, "ga4", offMessage("ga4"));
  const info = await companyInfo(env, companyId);
  const raw = str(params, "propertyId", { max: 300 });
  let propertyId: string | null = null;
  if (raw) {
    const parsed = parseGa4PropertyId(raw);
    if (!parsed.ok) throw new SeoError(parsed.reason);
    propertyId = parsed.id;
  }
  // Only a person may connect a property whose web streams do not show this site's address.
  const person = actor.kind === "user";
  const result = await connectGa4(env, info, sprint, { propertyId, allowMismatch: person, confirmedBy: person ? actorId(actor) : null });
  const summary = result.state === "connected" ? await ga4Summary(env, sprint) : null;
  return {
    sprintId: sprint.id,
    ...result,
    ...(summary ? { line: analyticsLine(summary), last4: summary.last4 } : {}),
    next:
      result.state === "connected"
        ? "Connected. list-ga4-summary shows organic traffic and key events attributed to this sprint's pages; the plugin pulls every morning."
        : result.state === "needs_access"
          ? "The service account is not a Viewer on the property yet: the one-time grant is on this sprint's Needs you digest (ga4_access) with the steps and, for a client, the email. The plugin retries every morning; carry on with other work."
          : result.state === "needs_api"
            ? "The Google Analytics APIs are not enabled for the service account's project: one-time switch on Needs you (ga4_api). The plugin retries every morning."
            : result.state === "needs_property"
              ? "The service account can read properties, but none has a web stream for this site. Do not try ids you did not get from this site's owner: ask the owner (or the client) for the property ID (Admin → Property settings → Property ID), then call connect-ga4 again with propertyId."
              : result.state === "property_mismatch"
                ? "That property is not this site's. Do not try other ids: ask the site's owner for the right property ID, and say so on the task. A person can connect an unusual property from the SEO page."
                : result.state === "bad_property"
                  ? "Check the property ID (Admin → Property settings → Property ID) and call connect-ga4 again."
                  : result.state === "no_service_account"
                    ? "Google Analytics needs the Google service account key first (Needs you / setup checklist)."
                    : "Try again later; if it persists, the message above says why.",
  };
}

export async function listGa4SummaryTool(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  if (!sprint.ga4Enabled) return { sprintId: sprint.id, enabled: false, connected: false, weeks: [], next: offMessage("ga4") };
  const integration = await db.getIntegration(env.ctx.db, companyId, sprint.id, "ga4");
  const view = ga4View(integration);
  const summary = await ga4Summary(env, sprint, { weeks: num(params, "weeks", { integer: true, min: 1, max: 26 }) ?? 8 });
  if (!summary) {
    return {
      sprintId: sprint.id,
      ...view,
      weeks: [],
      next: view.connected ? "Connected, but no week has been pulled yet: the plugin pulls every morning (or call connect-ga4)." : "Google Analytics is not connected for this sprint: call connect-ga4 (it finds the property by the site's address and raises the one-time grant on Needs you).",
    };
  }
  return {
    sprintId: sprint.id,
    ...view,
    line: analyticsLine(summary),
    weeks: summary.weeks,
    lastWeek: summary.lastWeek,
    previousWeek: summary.previousWeek,
    change: summary.change,
    last4: summary.last4,
    organicShare: summary.organicShare,
    attribution: summary.attribution,
    keyEvents: summary.keyEvents,
    aiReferrals: summary.aiReferrals,
    topSources: summary.topSources,
    howToRead: "Organic = GA4's Organic Search channel. Key events are what the property marks as key events (leads, sign-ups, purchases). attribution splits the last four weeks' organic sessions between the pages this sprint made or targets (live content, keyword targets, approved optimizations) and every other page; landingCoverage below about 0.8 means the per-page rows undercount the long tail. A week with no sessions is a zero, not a gap. Never quote a number this tool did not return.",
  };
}
