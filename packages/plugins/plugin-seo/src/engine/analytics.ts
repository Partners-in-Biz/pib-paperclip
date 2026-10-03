/**
 * What the GA4 weekly numbers mean for a sprint, from numbers already pulled. Pure.
 *
 * "Organic" is GA4's own Organic Search channel group. Traffic and key events are attributed to the sprint's pages
 * by landing page: a page counts as the sprint's when the sprint made it, targets a keyword at it, or approved an
 * optimization on it. The rest of the organic traffic is reported as other pages (the channel totals are exact, so
 * the split does not depend on how many landing pages were stored).
 */
import type { Ga4Week } from "../integrations/ga4.js";
import { addDays } from "./time.js";

export interface WeekRow extends Ga4Week {
  propertyId?: string;
  pulledAt?: string | null;
}

/** The Monday of the week containing `date`. */
export function mondayOf(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, day === 0 ? -6 : 1 - day);
}

/** The Mondays of the last `count` completed weeks (ascending). A week is complete once its Sunday has passed. */
export function completedWeeks(today: string, count: number): string[] {
  const last = addDays(mondayOf(today), -7);
  return Array.from({ length: Math.max(0, count) }, (_, i) => addDays(last, -7 * (count - 1 - i)));
}

/** A path as GA4 reports it (no query, no fragment, no trailing slash except the home page), for comparing. */
export function normalisePath(value: string): string {
  let path = value.trim();
  try {
    path = /^https?:\/\//i.test(path) ? new URL(path).pathname : path;
  } catch {
    // keep the text
  }
  path = path.split("#")[0]!.split("?")[0]!;
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/{2,}/g, "/");
  return path.length > 1 ? path.replace(/\/+$/, "") : "/";
}

export interface SprintPage {
  path: string;
  url: string;
  title: string | null;
  /** Why the page counts as the sprint's. */
  reason: "content" | "keyword" | "optimization";
  /** The day the page went live (content published), when known. */
  liveOn: string | null;
}

/** The pages the sprint works on: live content, keyword targets and approved optimizations; the home page is not one of them. */
export function sprintPages(input: {
  siteUrl: string;
  content: Array<{ title: string; targetUrl: string | null; status: string; publishedOn: string | null }>;
  keywords: Array<{ targetUrl: string | null }>;
  optimizations: Array<{ targetUrl: string | null; status: string; approvedAt?: string | null }>;
}): SprintPage[] {
  const pages = new Map<string, SprintPage>();
  const add = (url: string | null, reason: SprintPage["reason"], title: string | null, liveOn: string | null) => {
    if (!url) return;
    let absolute = url;
    try {
      absolute = new URL(url, input.siteUrl).toString();
    } catch {
      return;
    }
    const path = normalisePath(absolute);
    if (path === "/") return;
    const kept = pages.get(path);
    if (!kept) pages.set(path, { path, url: absolute, title, reason, liveOn });
    else if (!kept.liveOn && liveOn) kept.liveOn = liveOn;
  };
  for (const c of input.content) if (c.status === "live") add(c.targetUrl, "content", c.title, c.publishedOn);
  for (const k of input.keywords) add(k.targetUrl, "keyword", null, null);
  for (const o of input.optimizations) if (o.status === "approved" || o.status === "measured") add(o.targetUrl, "optimization", null, o.approvedAt?.slice(0, 10) ?? null);
  return [...pages.values()];
}

export interface WeekSummary {
  weekStart: string;
  sessions: number;
  engagedSessions: number;
  keyEvents: number;
  organicSessions: number;
  organicEngagedSessions: number;
  organicKeyEvents: number;
  aiReferralSessions: number;
}

function weekSummary(w: WeekRow): WeekSummary {
  return {
    weekStart: w.weekStart,
    sessions: w.sessions,
    engagedSessions: w.engagedSessions,
    keyEvents: w.keyEvents,
    organicSessions: w.organic.sessions,
    organicEngagedSessions: w.organic.engagedSessions,
    organicKeyEvents: w.organic.keyEvents,
    aiReferralSessions: w.aiReferrals.reduce((sum, a) => sum + a.sessions, 0),
  };
}

function pct(now: number, before: number): number | null {
  if (!Number.isFinite(before) || before <= 0) return null;
  return Math.round(((now - before) / before) * 1000) / 10;
}

export interface PageAttribution {
  path: string;
  title: string | null;
  reason: SprintPage["reason"];
  sessions: number;
  engagedSessions: number;
  keyEvents: number;
  /** Sessions since the Monday of the week the page went live (null when the go-live day is unknown). */
  sessionsSinceLive: number | null;
  liveOn: string | null;
}

export interface AnalyticsSummary {
  propertyId: string | null;
  weeks: WeekSummary[];
  lastWeek: WeekSummary | null;
  previousWeek: WeekSummary | null;
  change: { organicSessionsPct: number | null; organicKeyEventsPct: number | null; sessionsPct: number | null };
  /** The last four completed weeks added up. */
  last4: Omit<WeekSummary, "weekStart"> & { weeks: number; from: string | null; to: string | null };
  /** Organic sessions as a share of all sessions over the last four weeks (0 to 1). */
  organicShare: number | null;
  attribution: {
    sprintPages: { count: number; organicSessions: number; organicEngagedSessions: number; organicKeyEvents: number; shareOfOrganicSessions: number | null; shareOfOrganicKeyEvents: number | null };
    otherPages: { organicSessions: number; organicKeyEvents: number };
    top: PageAttribution[];
    /** Share of the organic sessions that the stored landing pages cover; below about 0.8 the per-page numbers undercount the long tail. */
    landingCoverage: number | null;
  };
  keyEvents: Array<{ name: string; count: number }>;
  aiReferrals: Array<{ assistant: string; sessions: number }>;
  topSources: Array<{ source: string; sessions: number }>;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** The last four completed weeks and the week before, attributed to the sprint's pages. */
export function summarizeAnalytics(weeks: WeekRow[], pages: SprintPage[], opts: { propertyId?: string | null } = {}): AnalyticsSummary {
  const sorted = [...weeks].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  const summaries = sorted.map(weekSummary);
  const lastWeek = summaries[summaries.length - 1] ?? null;
  const previousWeek = summaries[summaries.length - 2] ?? null;
  const recent = sorted.slice(-4);
  const last4 = {
    weeks: recent.length,
    from: recent[0]?.weekStart ?? null,
    to: recent.length ? addDays(recent[recent.length - 1]!.weekStart, 6) : null,
    sessions: sum(recent.map((w) => w.sessions)),
    engagedSessions: sum(recent.map((w) => w.engagedSessions)),
    keyEvents: sum(recent.map((w) => w.keyEvents)),
    organicSessions: sum(recent.map((w) => w.organic.sessions)),
    organicEngagedSessions: sum(recent.map((w) => w.organic.engagedSessions)),
    organicKeyEvents: sum(recent.map((w) => w.organic.keyEvents)),
    aiReferralSessions: sum(recent.map((w) => sum(w.aiReferrals.map((a) => a.sessions)))),
  };
  const byPath = new Map(pages.map((p) => [normalisePath(p.path), p]));
  const perPage = new Map<string, PageAttribution>();
  let storedSessions = 0;
  for (const week of recent) {
    for (const lp of week.landingPages) {
      storedSessions += lp.sessions;
      const path = normalisePath(lp.path);
      const page = byPath.get(path);
      if (!page) continue;
      const row = perPage.get(path) ?? { path, title: page.title, reason: page.reason, sessions: 0, engagedSessions: 0, keyEvents: 0, sessionsSinceLive: page.liveOn ? 0 : null, liveOn: page.liveOn };
      row.sessions += lp.sessions;
      row.engagedSessions += lp.engagedSessions;
      row.keyEvents += lp.keyEvents;
      if (page.liveOn && week.weekStart >= mondayOf(page.liveOn)) row.sessionsSinceLive = (row.sessionsSinceLive ?? 0) + lp.sessions;
      perPage.set(path, row);
    }
  }
  const attributed = [...perPage.values()];
  const sprintSessions = sum(attributed.map((p) => p.sessions));
  const sprintKeyEvents = sum(attributed.map((p) => p.keyEvents));
  const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null);
  const keyEvents = new Map<string, number>();
  const sources = new Map<string, number>();
  const assistants = new Map<string, number>();
  for (const week of recent) {
    for (const k of week.keyEventNames) keyEvents.set(k.name, (keyEvents.get(k.name) ?? 0) + k.count);
    for (const s of week.sources) sources.set(s.source, (sources.get(s.source) ?? 0) + s.sessions);
    for (const a of week.aiReferrals) assistants.set(a.assistant, (assistants.get(a.assistant) ?? 0) + a.sessions);
  }
  const top = <T extends [string, number]>(map: Map<string, number>, n: number): T[] => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n) as T[];
  return {
    propertyId: opts.propertyId ?? sorted[sorted.length - 1]?.propertyId ?? null,
    weeks: summaries,
    lastWeek,
    previousWeek,
    change: {
      organicSessionsPct: lastWeek && previousWeek ? pct(lastWeek.organicSessions, previousWeek.organicSessions) : null,
      organicKeyEventsPct: lastWeek && previousWeek ? pct(lastWeek.organicKeyEvents, previousWeek.organicKeyEvents) : null,
      sessionsPct: lastWeek && previousWeek ? pct(lastWeek.sessions, previousWeek.sessions) : null,
    },
    last4,
    organicShare: share(last4.organicSessions, last4.sessions),
    attribution: {
      sprintPages: {
        count: pages.length,
        organicSessions: sprintSessions,
        organicEngagedSessions: sum(attributed.map((p) => p.engagedSessions)),
        organicKeyEvents: sprintKeyEvents,
        shareOfOrganicSessions: share(sprintSessions, last4.organicSessions),
        shareOfOrganicKeyEvents: share(sprintKeyEvents, last4.organicKeyEvents),
      },
      otherPages: { organicSessions: Math.max(0, last4.organicSessions - sprintSessions), organicKeyEvents: Math.max(0, last4.organicKeyEvents - sprintKeyEvents) },
      top: attributed.sort((a, b) => b.sessions - a.sessions || b.keyEvents - a.keyEvents).slice(0, 10),
      landingCoverage: share(storedSessions, last4.organicSessions),
    },
    keyEvents: top(keyEvents, 8).map(([name, count]) => ({ name, count })),
    aiReferrals: top(assistants, 6).map(([assistant, sessions]) => ({ assistant, sessions })),
    topSources: top(sources, 8).map(([source, sessions]) => ({ source, sessions })),
  };
}

/** The small form kept on a snapshot. */
export function analyticsSnapshot(summary: AnalyticsSummary | null) {
  if (!summary || summary.weeks.length === 0) return {};
  return {
    propertyId: summary.propertyId,
    from: summary.last4.from,
    to: summary.last4.to,
    weeks: summary.last4.weeks,
    sessions: summary.last4.sessions,
    organicSessions: summary.last4.organicSessions,
    organicEngagedSessions: summary.last4.organicEngagedSessions,
    organicKeyEvents: summary.last4.organicKeyEvents,
    organicShare: summary.organicShare,
    aiReferralSessions: summary.last4.aiReferralSessions,
    sprintPages: { count: summary.attribution.sprintPages.count, organicSessions: summary.attribution.sprintPages.organicSessions, organicKeyEvents: summary.attribution.sprintPages.organicKeyEvents },
    topPages: summary.attribution.top.slice(0, 5).map((p) => ({ path: p.path, sessions: p.sessions, keyEvents: p.keyEvents })),
    lastWeek: summary.lastWeek ? { weekStart: summary.lastWeek.weekStart, organicSessions: summary.lastWeek.organicSessions, organicKeyEvents: summary.lastWeek.organicKeyEvents } : null,
  };
}

/** One line for a digest or the approval issue: "Organic traffic last week: 120 sessions (+8%), 6 key events; 4 weeks: …". */
export function analyticsLine(summary: AnalyticsSummary | null): string | null {
  if (!summary?.lastWeek) return null;
  const w = summary.lastWeek;
  const delta = summary.change.organicSessionsPct;
  const parts = [`Organic traffic (GA4) week of ${w.weekStart}: ${w.organicSessions} session${w.organicSessions === 1 ? "" : "s"}${delta == null ? "" : ` (${delta >= 0 ? "+" : ""}${delta}% on the week before)`}, ${w.organicKeyEvents} key event${w.organicKeyEvents === 1 ? "" : "s"}`];
  const sp = summary.attribution.sprintPages;
  if (sp.count > 0) parts.push(`${sp.organicSessions} of the last ${summary.last4.weeks} weeks' ${summary.last4.organicSessions} organic sessions landed on the ${sp.count} page${sp.count === 1 ? "" : "s"} this sprint works on`);
  if (summary.last4.aiReferralSessions > 0) parts.push(`${summary.last4.aiReferralSessions} sessions came from AI assistants`);
  return `${parts.join("; ")}.`;
}
