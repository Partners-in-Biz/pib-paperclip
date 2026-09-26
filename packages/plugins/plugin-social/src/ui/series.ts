/**
 * Chart series and status tones for the Social page (pure, no React).
 * Days are UTC, like the worker's `stats`.
 */
import type { ChartSeries, ColumnDatum, Segment, ToneName } from "@partnersinbiz/pib-plugin-ui";
import { ALL_PLATFORMS, PLATFORM_LABELS, isSocialPlatform } from "../platforms.js";
import type { ScopeStats } from "../stats.js";
import type { GrowthExperiment, Post } from "./types.js";

// ── Status tones (one mapping for the whole page) ───────────────────────────

export const POST_TONE: Record<string, ToneName> = {
  draft: "info",
  review: "warn",
  approved: "info",
  scheduled: "info",
  publishing: "info",
  published: "ok",
  partially_published: "bad",
  failed: "bad",
};

export const DEST_TONE: Record<string, ToneName> = {
  pending: "warn",
  publishing: "info",
  retrying: "warn",
  published: "ok",
  failed: "bad",
};

export const ACCOUNT_TONE: Record<string, ToneName> = {
  connected: "ok",
  expiring: "warn",
  needs_reconnect: "bad",
  disabled: "neutral",
};

export const EXPERIMENT_TONE: Record<string, ToneName> = {
  proposed: "warn",
  running: "info",
  measured: "ok",
  rejected: "neutral",
  abandoned: "neutral",
};

export const VERDICT_TONE: Record<string, ToneName> = {
  win: "ok",
  loss: "bad",
  no_change: "neutral",
  inconclusive: "warn",
};

export const AGENT_TONE: Record<string, ToneName> = {
  active: "ok",
  idle: "ok",
  running: "info",
  paused: "warn",
  pending_approval: "warn",
  error: "bad",
  terminated: "neutral",
};

export function toneOf(map: Record<string, ToneName>, status: string | null | undefined): ToneName {
  return (status && map[status]) || "neutral";
}

// ── Days ────────────────────────────────────────────────────────────────────

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The last `days` UTC dates (`YYYY-MM-DD`), oldest first, ending today. */
export function lastDays(now: Date, days: number): string[] {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, i) => new Date(end - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

function dayLabels(date: string): { label: string; title: string } {
  const d = new Date(`${date}T12:00:00Z`);
  return { label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, title: `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}` };
}

/** Series colour index per platform, picked so the common ones never share a colour. */
const PLATFORM_COLOR: Record<string, number> = {
  facebook: 0,
  instagram: 4,
  linkedin: 7,
  x: 1,
  tiktok: 2,
  youtube: 6,
  bluesky: 3,
  pinterest: 5,
  threads: 1,
  reddit: 6,
  mastodon: 2,
  dribbble: 4,
};

/** Stable categorical colour index per platform (same platform, same colour everywhere). */
export function platformIndex(platform: string): number {
  return PLATFORM_COLOR[platform] ?? 5;
}

function platformOrder(platform: string): number {
  const i = (ALL_PLATFORMS as string[]).indexOf(platform);
  return i < 0 ? ALL_PLATFORMS.length : i;
}

function label(platform: string): string {
  return isSocialPlatform(platform) ? PLATFORM_LABELS[platform] : platform;
}

export interface PublishedSeries {
  data: ColumnDatum[];
  /** Platforms with posts in the window, busiest first. `color` is left to the page (seriesColor(platformIndex)). */
  series: Array<ChartSeries & { platform: string }>;
  /** Destinations published per day, for a sparkline. */
  totals: number[];
  /** Published in the window and in the same number of days before it. */
  total: number;
  previous: number;
}

/** Destinations published per day over the last `days` days, stacked by platform. */
export function publishedSeries(stats: ScopeStats | null | undefined, now: Date, days = 14): PublishedSeries {
  const window = lastDays(now, days);
  const before = new Set(lastDays(new Date(Date.parse(`${window[0]}T12:00:00Z`) - 86_400_000), days));
  const inWindow = new Set(window);
  const perDay = new Map(window.map((d) => [d, {} as Record<string, number>]));
  const perPlatform = new Map<string, number>();
  let previous = 0;
  for (const row of stats?.publishedPerDay ?? []) {
    if (inWindow.has(row.date)) {
      const day = perDay.get(row.date)!;
      day[row.platform] = (day[row.platform] ?? 0) + row.count;
      perPlatform.set(row.platform, (perPlatform.get(row.platform) ?? 0) + row.count);
    } else if (before.has(row.date)) previous += row.count;
  }
  const platforms = [...perPlatform.entries()].sort((a, b) => b[1] - a[1] || platformOrder(a[0]) - platformOrder(b[0])).map(([p]) => p);
  const data = window.map((date) => {
    const values: Record<string, number> = {};
    for (const p of platforms) values[p] = perDay.get(date)![p] ?? 0;
    return { ...dayLabels(date), values };
  });
  const totals = window.map((date) => Object.values(perDay.get(date)!).reduce((a, b) => a + b, 0));
  return {
    data,
    series: platforms.map((platform) => ({ key: platform, label: label(platform), platform })),
    totals,
    total: totals.reduce((a, b) => a + b, 0),
    previous,
  };
}

/** "+3 vs the 14 days before", "−20% vs …", or null when there is nothing to compare. */
export function countDelta(current: number, previous: number, period: string): string | null {
  if (previous === 0) return current > 0 ? `+${current} vs ${period}` : null;
  const change = Math.round(((current - previous) / previous) * 100);
  if (change === 0) return `same as ${period}`;
  return `${change > 0 ? "+" : "−"}${Math.abs(change)}% vs ${period}`;
}

/** Weekly median lift as percentages, for a TrendChart. */
export function liftTrend(stats: ScopeStats | null | undefined): { labels: string[]; values: number[]; posts: number } {
  const weeks = stats?.liftPerWeek ?? [];
  return {
    labels: weeks.map((w) => {
      const d = new Date(`${w.week}T12:00:00Z`);
      return `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
    }),
    values: weeks.map((w) => Math.round(w.medianLift * 1000) / 10),
    posts: weeks.reduce((a, w) => a + w.posts, 0),
  };
}

const POST_ORDER = ["published", "scheduled", "approved", "review", "draft", "publishing", "partially_published", "failed"];
const DEST_ORDER = ["published", "publishing", "pending", "retrying", "failed"];

function words(status: string): string {
  const text = status.replace(/_/g, " ");
  return text[0]!.toUpperCase() + text.slice(1);
}

/** Posts per status, toned, in pipeline order. */
export function postSegments(posts: Pick<Post, "status">[]): Segment[] {
  const counts = new Map<string, number>();
  for (const p of posts) counts.set(p.status, (counts.get(p.status) ?? 0) + 1);
  return [...counts.keys()]
    .sort((a, b) => (POST_ORDER.indexOf(a) + 99) % 99 - (POST_ORDER.indexOf(b) + 99) % 99)
    .map((status) => ({ key: status, label: status === "review" ? "In review" : words(status), value: counts.get(status)!, tone: toneOf(POST_TONE, status) }));
}

/** Destinations per status (worker `stats.destinationStatus`), toned. */
export function destinationSegments(counts: Record<string, number> | null | undefined): Segment[] {
  return Object.entries(counts ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => (DEST_ORDER.indexOf(a[0]) + 99) % 99 - (DEST_ORDER.indexOf(b[0]) + 99) % 99)
    .map(([status, value]) => ({ key: status, label: words(status), value, tone: toneOf(DEST_TONE, status) }));
}

/** Measured experiments by verdict: win / loss / no change / inconclusive. */
export function verdictSegments(experiments: Pick<GrowthExperiment, "verdict">[]): Segment[] {
  const counts = { win: 0, loss: 0, no_change: 0, inconclusive: 0 };
  for (const e of experiments) if (e.verdict && e.verdict in counts) counts[e.verdict] += 1;
  return [
    { key: "win", label: "Win", value: counts.win, tone: "ok" },
    { key: "loss", label: "Loss", value: counts.loss, tone: "bad" },
    { key: "no_change", label: "No change", value: counts.no_change, tone: "neutral" },
    { key: "inconclusive", label: "Inconclusive", value: counts.inconclusive, tone: "warn" },
  ];
}

export interface Activity {
  id: string;
  at: string;
  kind: "published" | "failed" | "scheduled";
  platform: string | null;
  accountName: string;
  postId: string;
  body: string;
  error: string | null;
}

/** Recent publish results (and upcoming scheduled posts), newest first. */
export function recentActivity(posts: Post[], now: Date, limit = 8): Activity[] {
  const out: Activity[] = [];
  for (const post of posts) {
    for (const d of post.destinations) {
      if (d.status === "published" && d.publishedAt) out.push({ id: d.id, at: d.publishedAt, kind: "published", platform: d.platform, accountName: d.accountName, postId: post.id, body: post.body, error: null });
      else if (d.status === "failed") out.push({ id: d.id, at: post.updatedAt ?? post.createdAt ?? now.toISOString(), kind: "failed", platform: d.platform, accountName: d.accountName, postId: post.id, body: post.body, error: d.lastError });
    }
  }
  return out.filter((a) => Date.parse(a.at) <= now.getTime() + 60_000).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** Posts scheduled from now on, soonest first. */
export function upcoming(posts: Post[], now: Date, limit = 5): Post[] {
  return posts
    .filter((p) => p.status === "scheduled" && p.scheduledAt && Date.parse(p.scheduledAt) >= now.getTime() - 60_000)
    .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)))
    .slice(0, limit);
}

/** Short platform monogram for a badge: "f", "in", "X", "IG"… */
export const PLATFORM_MONOGRAM: Record<string, string> = {
  facebook: "f",
  instagram: "IG",
  linkedin: "in",
  x: "X",
  tiktok: "TT",
  pinterest: "P",
  reddit: "R",
  bluesky: "BS",
  threads: "@",
  youtube: "YT",
  mastodon: "M",
  dribbble: "Dr",
};
