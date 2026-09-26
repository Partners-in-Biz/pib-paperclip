/**
 * Optimization measurement. A baseline is captured when a proposal is
 * approved; 14 days later the same metrics are read again and classified.
 *
 * - win: average position improves by ≥ 2, or impressions rise ≥ 20 %
 * - loss: average position worsens by ≥ 2, or impressions fall ≥ 20 %
 * - no_change: neither, or the signals disagree (one wins, one loses)
 * - inconclusive: no position and no impressions in either window
 *
 * Impression rules only count once either window has ≥ 20 impressions, so
 * 5 → 7 impressions is not a "win". A page going from 0 to ≥ 20 impressions is.
 */

export interface KeywordMetric {
  id: string;
  phrase?: string;
  position: number | null;
  impressions: number;
  clicks: number;
}

export interface PageMetric {
  url: string;
  lcpMs: number | null;
  cls: number | null;
  performance: number | null;
}

export interface MetricSet {
  scope: "keywords" | "site" | "none";
  keywords: KeywordMetric[];
  avgPosition: number | null;
  impressions: number;
  clicks: number;
  page: PageMetric | null;
  capturedOn: string;
}

export interface SiteTotals {
  impressions: number;
  clicks: number;
  position: number | null;
}

function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function buildMetricSet(input: {
  keywords: KeywordMetric[];
  page?: PageMetric | null;
  siteTotals?: SiteTotals | null;
  capturedOn: string;
}): MetricSet {
  const page = input.page ?? null;
  if (input.keywords.length > 0) {
    const positions = input.keywords.map((k) => k.position).filter((p): p is number => typeof p === "number" && p > 0);
    return {
      scope: "keywords",
      keywords: input.keywords.map((k) => ({ ...k, impressions: k.impressions || 0, clicks: k.clicks || 0 })),
      avgPosition: positions.length > 0 ? round(positions.reduce((a, b) => a + b, 0) / positions.length) : null,
      impressions: input.keywords.reduce((sum, k) => sum + (k.impressions || 0), 0),
      clicks: input.keywords.reduce((sum, k) => sum + (k.clicks || 0), 0),
      page,
      capturedOn: input.capturedOn,
    };
  }
  if (input.siteTotals) {
    return {
      scope: "site",
      keywords: [],
      avgPosition: input.siteTotals.position != null ? round(input.siteTotals.position) : null,
      impressions: input.siteTotals.impressions,
      clicks: input.siteTotals.clicks,
      page,
      capturedOn: input.capturedOn,
    };
  }
  return { scope: "none", keywords: [], avgPosition: null, impressions: 0, clicks: 0, page, capturedOn: input.capturedOn };
}

export type MeasureResult = "win" | "loss" | "no_change" | "inconclusive";

export interface Outcome {
  result: MeasureResult;
  positionDelta: number | null;
  impressionsChange: number | null;
  clicksChange: number | null;
  reasons: string[];
}

export const POSITION_THRESHOLD = 2;
export const IMPRESSIONS_THRESHOLD = 0.2;
export const MIN_IMPRESSIONS_FOR_RATE = 20;

export function classifyOutcome(baseline: MetricSet, current: MetricSet): Outcome {
  const reasons: string[] = [];
  const positionDelta =
    baseline.avgPosition != null && current.avgPosition != null ? round(baseline.avgPosition - current.avgPosition) : null;
  const base = baseline.impressions;
  const cur = current.impressions;
  const impressionsChange = base > 0 ? round((cur - base) / base, 4) : null;
  const clicksChange = baseline.clicks > 0 ? round((current.clicks - baseline.clicks) / baseline.clicks, 4) : null;

  if (positionDelta == null && base === 0 && cur === 0) {
    return { result: "inconclusive", positionDelta, impressionsChange, clicksChange, reasons: ["No position or impression data in either window."] };
  }

  const volumeOk = Math.max(base, cur) >= MIN_IMPRESSIONS_FOR_RATE;
  const posUp = positionDelta != null && positionDelta >= POSITION_THRESHOLD;
  const posDown = positionDelta != null && positionDelta <= -POSITION_THRESHOLD;
  const impUp = volumeOk && (base > 0 ? (impressionsChange ?? 0) >= IMPRESSIONS_THRESHOLD : cur >= MIN_IMPRESSIONS_FOR_RATE);
  const impDown = volumeOk && base > 0 && (impressionsChange ?? 0) <= -IMPRESSIONS_THRESHOLD;

  if (posUp) reasons.push(`Average position improved by ${positionDelta}.`);
  if (posDown) reasons.push(`Average position worsened by ${Math.abs(positionDelta ?? 0)}.`);
  if (impUp) reasons.push(base > 0 ? `Impressions up ${Math.round((impressionsChange ?? 0) * 100)}%.` : `Impressions went from 0 to ${cur}.`);
  if (impDown) reasons.push(`Impressions down ${Math.round(Math.abs(impressionsChange ?? 0) * 100)}%.`);

  const anyWin = posUp || impUp;
  const anyLoss = posDown || impDown;
  let result: MeasureResult = "no_change";
  if (anyWin && !anyLoss) result = "win";
  else if (anyLoss && !anyWin) result = "loss";
  else if (anyWin && anyLoss) reasons.push("Signals disagree; recorded as no change.");
  else reasons.push("Movement stayed under the thresholds.");
  return { result, positionDelta, impressionsChange, clicksChange, reasons };
}

export interface ScoreEntry {
  wins: number;
  losses: number;
  noChange: number;
  inconclusive: number;
}

export type Scoreboard = Record<string, ScoreEntry>;

export function updateScoreboard(scoreboard: Scoreboard | null | undefined, hypothesisType: string, result: MeasureResult): Scoreboard {
  const next: Scoreboard = { ...(scoreboard ?? {}) };
  const prev = next[hypothesisType];
  const entry: ScoreEntry = { wins: prev?.wins ?? 0, losses: prev?.losses ?? 0, noChange: prev?.noChange ?? 0, inconclusive: prev?.inconclusive ?? 0 };
  if (result === "win") entry.wins += 1;
  else if (result === "loss") entry.losses += 1;
  else if (result === "no_change") entry.noChange += 1;
  else entry.inconclusive += 1;
  next[hypothesisType] = entry;
  return next;
}

/** Win-rate score used to prefer hypotheses that worked before on this site. */
export function hypothesisScore(entry: ScoreEntry | undefined): number {
  if (!entry) return 0;
  const total = entry.wins + entry.losses + entry.noChange;
  return total > 0 ? (entry.wins - entry.losses) / total : 0;
}
