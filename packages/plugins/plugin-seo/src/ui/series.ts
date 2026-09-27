/**
 * Status tones and chart series for the SEO page (pure, no React).
 */
import type { BarListItem, Segment, ToneName } from "@partnersinbiz/pib-plugin-ui";
import { taskState, type TaskState, type TimedTask } from "../engine/due.js";
import { STATE_SHORT, STATE_TONE } from "./words.js";

// ── One status → tone mapping for the whole page ────────────────────────────

const OK = ["done", "live", "active", "connected", "enabled", "win", "top_3", "top_10", "measured", "published", "compounding"];
const WARN = ["pending", "due", "review", "submitted", "proposed", "expiring", "medium", "stale", "inconclusive", "paused_pending"];
const BAD = ["failed", "blocked", "needs_reconnect", "error", "loss", "rejected", "lost", "critical", "high", "overdue"];
const INFO = ["in_progress", "scheduled", "draft", "drafting", "approved", "pre_launch", "idea", "running", "measuring"];

export function statusTone(status: string | null | undefined): ToneName {
  if (!status) return "neutral";
  if (OK.includes(status)) return "ok";
  if (BAD.includes(status)) return "bad";
  if (WARN.includes(status)) return "warn";
  if (INFO.includes(status)) return "info";
  return "neutral";
}

// ── Tasks ───────────────────────────────────────────────────────────────────
// A task's state comes from engine/due.ts, the same rules the tools and the Cockpit use.

export type ChipState = TaskState;

export const CHIP_TONE: Record<ChipState, ToneName> = STATE_TONE;
export const CHIP_LABEL: Record<ChipState, string> = STATE_SHORT;

/** The stacked bar and the plan legend, in this order. */
export const CHIP_ORDER: ChipState[] = ["done", "in_progress", "due", "overdue", "waiting", "stuck", "upcoming", "skipped"];

export function chipState(task: TimedTask, day: number, canWork = true): ChipState {
  return taskState(task, day, canWork);
}

/** Tasks by plan state, for a StackedBar and the legend. */
export function taskSegments(tasks: TimedTask[], day: number, canWork = true): Segment[] {
  const counts = Object.fromEntries(CHIP_ORDER.map((k) => [k, 0])) as Record<ChipState, number>;
  for (const task of tasks) counts[chipState(task, day, canWork)] += 1;
  return CHIP_ORDER.map((key) => ({ key, label: CHIP_LABEL[key], value: counts[key], tone: CHIP_TONE[key] }));
}

// ── Keywords ────────────────────────────────────────────────────────────────

export interface KeywordLike {
  currentPosition: number | null;
  retiredAt: string | null;
}

/** Tracked keywords by position band: top 3 / 4–10 / 11–20 / 21+ / not ranking yet. */
export function positionBuckets(keywords: KeywordLike[]): BarListItem[] {
  const b = { top3: 0, top10: 0, top20: 0, rest: 0, none: 0 };
  for (const k of keywords) {
    if (k.retiredAt) continue;
    const p = k.currentPosition;
    if (p == null || !Number.isFinite(p)) b.none += 1;
    else if (p <= 3) b.top3 += 1;
    else if (p <= 10) b.top10 += 1;
    else if (p <= 20) b.top20 += 1;
    else b.rest += 1;
  }
  return [
    { label: "Top 3", value: b.top3, tone: "ok" },
    { label: "4–10", value: b.top10, tone: "info" },
    { label: "11–20", value: b.top20, tone: "warn" },
    { label: "21+", value: b.rest, tone: "neutral" },
    { label: "Not ranking yet", value: b.none, tone: "neutral" },
  ];
}

/** Position trend of one keyword: lower is better, so "ok" when it moved up the results. */
export function positionTrendTone(positions: number[]): ToneName {
  if (positions.length < 2) return "neutral";
  const delta = positions[positions.length - 1]! - positions[0]!;
  if (Math.abs(delta) < 0.5) return "neutral";
  return delta < 0 ? "ok" : "bad";
}

// ── Search Console traffic ──────────────────────────────────────────────────

export interface TrafficDay {
  on: string;
  impressions: number;
  clicks: number;
}

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function label(d: string): string {
  return `${Number(d.slice(8, 10))} ${MONTH[Number(d.slice(5, 7)) - 1]}`;
}

function dayList(today: string, days: number): string[] {
  const end = Date.parse(`${today.slice(0, 10)}T12:00:00Z`);
  return Array.from({ length: days }, (_, i) => new Date(end - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

export interface TrafficSeries {
  labels: string[];
  impressions: number[];
  clicks: number[];
  totals: { impressions: number; clicks: number };
  /** Last day of the window (`D Mon`). */
  end: string;
  previous: { impressions: number; clicks: number };
  hasData: boolean;
}

/**
 * The last `days` days (missing days are 0) and the same number of days
 * before them, for the Search Console trend and its KPI deltas.
 */
export function trafficSeries(traffic: TrafficDay[] | null | undefined, today: string, days = 28): TrafficSeries {
  // Search Console is 2–3 days behind: end on the latest day with data, not on today.
  const latest = (traffic ?? []).map((t) => t.on.slice(0, 10)).filter((d) => d <= today.slice(0, 10)).sort().at(-1);
  const end = latest && Date.parse(`${today.slice(0, 10)}T12:00:00Z`) - Date.parse(`${latest}T12:00:00Z`) < days * 86_400_000 ? latest : today;
  const window = dayList(end, days);
  const before = new Set(dayList(new Date(Date.parse(`${window[0]}T12:00:00Z`) - 86_400_000).toISOString(), days));
  const map = new Map((traffic ?? []).map((t) => [t.on.slice(0, 10), t]));
  const previous = { impressions: 0, clicks: 0 };
  for (const t of traffic ?? []) {
    if (before.has(t.on.slice(0, 10))) {
      previous.impressions += t.impressions;
      previous.clicks += t.clicks;
    }
  }
  const impressions = window.map((d) => map.get(d)?.impressions ?? 0);
  const clicks = window.map((d) => map.get(d)?.clicks ?? 0);
  return {
    labels: window.map(label),
    end: label(window[window.length - 1]!),
    impressions,
    clicks,
    totals: { impressions: impressions.reduce((a, b) => a + b, 0), clicks: clicks.reduce((a, b) => a + b, 0) },
    previous,
    hasData: window.some((d) => map.has(d)),
  };
}

/** "+12% vs the 28 days before", or null without a base. */
export function changeText(current: number, previous: number, period: string): string | null {
  if (previous <= 0) return current > 0 ? `+${current} vs ${period}` : null;
  const change = Math.round(((current - previous) / previous) * 100);
  return change === 0 ? `same as ${period}` : `${change > 0 ? "+" : "−"}${Math.abs(change)}% vs ${period}`;
}

// ── Health and optimizations ────────────────────────────────────────────────

/** Sprint health score 0–100: 80+ ok, 50+ warn, below bad. */
export function healthTone(score: number | null | undefined): ToneName {
  if (score == null || !Number.isFinite(score)) return "neutral";
  return score >= 80 ? "ok" : score >= 50 ? "warn" : "bad";
}

export interface ScoreboardEntry {
  wins: number;
  losses: number;
  noChange: number;
  inconclusive?: number;
}

/** Win / loss / no change / inconclusive across the scoreboard, else across measured optimizations. */
export function optimizationSegments(scoreboard: Record<string, ScoreboardEntry> | null | undefined, optimizations: Array<{ result: string | null }> = []): Segment[] {
  const c = { win: 0, loss: 0, no_change: 0, inconclusive: 0 };
  const board = Object.values(scoreboard ?? {});
  if (board.length) {
    for (const e of board) {
      c.win += e.wins ?? 0;
      c.loss += e.losses ?? 0;
      c.no_change += e.noChange ?? 0;
      c.inconclusive += e.inconclusive ?? 0;
    }
  } else {
    for (const o of optimizations) if (o.result && o.result in c) c[o.result as keyof typeof c] += 1;
  }
  return [
    { key: "win", label: "Win", value: c.win, tone: "ok" },
    { key: "loss", label: "Loss", value: c.loss, tone: "bad" },
    { key: "no_change", label: "No change", value: c.no_change, tone: "neutral" },
    { key: "inconclusive", label: "Inconclusive", value: c.inconclusive, tone: "warn" },
  ];
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

/** Open findings by severity (critical and high are red, medium amber, low grey). */
export function severitySegments(findings: Array<{ severity: string }>): Segment[] {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  return SEVERITY_ORDER.map((sev) => ({ key: sev, label: sev[0]!.toUpperCase() + sev.slice(1), value: counts.get(sev) ?? 0, tone: sev === "low" ? "neutral" : statusTone(sev) }));
}

/** Backlinks by status: live → submitted → in progress → not started → rejected/lost. */
export function backlinkSegments(backlinks: Array<{ status: string }>): Segment[] {
  const order = ["live", "submitted", "in_progress", "not_started", "rejected", "lost"];
  const label: Record<string, string> = { live: "Live", submitted: "Submitted", in_progress: "In progress", not_started: "Not started", rejected: "Rejected", lost: "Lost" };
  const counts = new Map<string, number>();
  for (const b of backlinks) counts.set(b.status, (counts.get(b.status) ?? 0) + 1);
  return order.filter((s) => counts.get(s)).map((s) => ({ key: s, label: label[s] ?? s, value: counts.get(s)!, tone: statusTone(s) }));
}
