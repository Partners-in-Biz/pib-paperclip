/**
 * Weekly health detectors. Pure functions over sprint data; the weekly job
 * loads the data, runs them, and turns signals into proposals.
 */
import { addDays } from "../engine/time.js";

export type SignalType =
  | "stuck_page"
  | "lost_keyword"
  | "zero_impression_content"
  | "unindexed_page"
  | "directory_silence"
  | "cwv_regression"
  | "keyword_misalignment"
  | "pillar_orphan"
  | "compound_stagnation";

export type Severity = "low" | "medium" | "high";

export interface HealthSignal {
  type: SignalType;
  severity: Severity;
  /** Stable subject (keyword id, content id, url…) used to avoid duplicate proposals. */
  subject: string;
  evidence: Record<string, unknown>;
}

export interface PositionPoint {
  on: string;
  position: number;
}

export interface DetectorInput {
  today: string;
  day: number;
  week: number;
  phase: number;
  /** True once GSC has delivered data; GSC-based detectors stay silent before that. */
  gscConnected: boolean;
  keywords: Array<{
    id: string;
    phrase: string;
    targetUrl: string | null;
    currentPosition: number | null;
    impressions: number | null;
    clicks: number | null;
    ctr: number | null;
  }>;
  /** Positions per keyword id, oldest first. */
  history: Record<string, PositionPoint[]>;
  content: Array<{
    id: string;
    title: string;
    type: string;
    status: string;
    targetUrl: string | null;
    publishedOn: string | null;
    impressions: number | null;
    linksToPillarIds: string[];
  }>;
  backlinks: Array<{ id: string; source: string; domain: string; status: string; submittedOn: string | null }>;
  /** Latest health per URL. */
  pageHealth: Array<{ url: string; lcpMs: number | null; cls: number | null; inpMs: number | null }>;
  /** Audit snapshots, oldest first. */
  snapshots: Array<{ day: number; impressions: number | null }>;
}

export const STUCK_MIN = 8;
export const STUCK_MAX = 20;

export function stuckPage(input: DetectorInput): HealthSignal[] {
  if (!input.gscConnected) return [];
  const out: HealthSignal[] = [];
  for (const k of input.keywords) {
    const recent = (input.history[k.id] ?? []).slice(-3);
    if (recent.length < 3) continue;
    const inBand = recent.every((p) => p.position >= STUCK_MIN && p.position <= STUCK_MAX);
    const improvement = recent[0]!.position - recent[recent.length - 1]!.position;
    if (inBand && improvement < 2) {
      out.push({
        type: "stuck_page",
        severity: "medium",
        subject: k.id,
        evidence: { keywordId: k.id, keyword: k.phrase, url: k.targetUrl, recentPositions: recent.map((p) => p.position) },
      });
    }
  }
  return out;
}

export function lostKeyword(input: DetectorInput): HealthSignal[] {
  if (!input.gscConnected) return [];
  const out: HealthSignal[] = [];
  for (const k of input.keywords) {
    const points = input.history[k.id] ?? [];
    if (points.length < 2) continue;
    const latest = points[points.length - 1]!;
    const cutoff = addDays(latest.on, -7);
    const earlier = [...points].reverse().find((p) => p.on <= cutoff);
    if (!earlier) continue;
    if (latest.position - earlier.position >= 5) {
      out.push({
        type: "lost_keyword",
        severity: "high",
        subject: k.id,
        evidence: {
          keywordId: k.id,
          keyword: k.phrase,
          url: k.targetUrl,
          previousPosition: earlier.position,
          previousOn: earlier.on,
          currentPosition: latest.position,
          currentOn: latest.on,
        },
      });
    }
  }
  return out;
}

export function zeroImpressionContent(input: DetectorInput): HealthSignal[] {
  if (!input.gscConnected) return [];
  const cutoff = addDays(input.today, -14);
  const out: HealthSignal[] = [];
  for (const c of input.content) {
    if (c.status !== "live" || !c.publishedOn || c.publishedOn > cutoff) continue;
    const impressions = c.impressions ?? 0;
    if (impressions < 5) {
      out.push({
        type: "zero_impression_content",
        severity: "medium",
        subject: c.id,
        evidence: { contentId: c.id, title: c.title, url: c.targetUrl, publishedOn: c.publishedOn, impressions },
      });
    }
  }
  return out;
}

export function unindexedPage(input: DetectorInput): HealthSignal[] {
  if (!input.gscConnected || input.week < 2) return [];
  const out: HealthSignal[] = [];
  for (const k of input.keywords) {
    if (!k.targetUrl) continue;
    if ((input.history[k.id] ?? []).length === 0) {
      out.push({
        type: "unindexed_page",
        severity: "high",
        subject: k.id,
        evidence: { keywordId: k.id, keyword: k.phrase, url: k.targetUrl },
      });
    }
  }
  return out;
}

export function directorySilence(input: DetectorInput): HealthSignal[] {
  const cutoff = addDays(input.today, -30);
  return input.backlinks
    .filter((b) => b.status === "submitted" && b.submittedOn && b.submittedOn < cutoff)
    .map((b) => ({
      type: "directory_silence" as const,
      severity: "low" as const,
      subject: b.id,
      evidence: { backlinkId: b.id, source: b.source, domain: b.domain, submittedOn: b.submittedOn },
    }));
}

export function cwvRegression(input: DetectorInput): HealthSignal[] {
  const out: HealthSignal[] = [];
  for (const p of input.pageHealth) {
    const lcp = p.lcpMs ?? 0;
    const cls = p.cls ?? 0;
    if (lcp > 2500 || cls > 0.1) {
      out.push({
        type: "cwv_regression",
        severity: lcp > 4000 || cls > 0.25 ? "high" : "medium",
        subject: p.url,
        evidence: { url: p.url, lcpMs: p.lcpMs, cls: p.cls, inpMs: p.inpMs },
      });
    }
  }
  return out;
}

export function keywordMisalignment(input: DetectorInput): HealthSignal[] {
  if (!input.gscConnected) return [];
  const out: HealthSignal[] = [];
  for (const k of input.keywords) {
    const impressions = k.impressions ?? 0;
    const ctr = k.ctr ?? 0;
    if (impressions > 100 && ctr < 0.01) {
      out.push({
        type: "keyword_misalignment",
        severity: "medium",
        subject: k.id,
        evidence: { keywordId: k.id, keyword: k.phrase, url: k.targetUrl, impressions, ctr },
      });
    }
  }
  return out;
}

export function pillarOrphan(input: DetectorInput): HealthSignal[] {
  const out: HealthSignal[] = [];
  for (const pillar of input.content) {
    if (pillar.type !== "pillar" || pillar.status !== "live") continue;
    const inbound = input.content.filter((c) => c.id !== pillar.id && c.linksToPillarIds.includes(pillar.id)).length;
    if (inbound < 3) {
      out.push({
        type: "pillar_orphan",
        severity: "medium",
        subject: pillar.id,
        evidence: { contentId: pillar.id, title: pillar.title, url: pillar.targetUrl, inboundCount: inbound },
      });
    }
  }
  return out;
}

export function compoundStagnation(input: DetectorInput): HealthSignal[] {
  if (input.phase !== 4 || input.snapshots.length < 5) return [];
  const last5 = input.snapshots.slice(-5);
  const deltas: number[] = [];
  for (let i = 1; i < last5.length; i += 1) {
    const prev = last5[i - 1]!.impressions ?? 0;
    const curr = last5[i]!.impressions ?? 0;
    deltas.push(prev > 0 ? (curr - prev) / prev : curr > 0 ? 1 : 0);
  }
  if (deltas.every((d) => Math.abs(d) < 0.05)) {
    return [{
      type: "compound_stagnation",
      severity: "medium",
      subject: "site",
      evidence: { snapshotDays: last5.map((s) => s.day), deltas: deltas.map((d) => Math.round(d * 1000) / 1000) },
    }];
  }
  return [];
}

export const DETECTORS: Array<(input: DetectorInput) => HealthSignal[]> = [
  stuckPage,
  lostKeyword,
  zeroImpressionContent,
  unindexedPage,
  directorySilence,
  cwvRegression,
  keywordMisalignment,
  pillarOrphan,
  compoundStagnation,
];

export function runDetectors(input: DetectorInput): HealthSignal[] {
  const out: HealthSignal[] = [];
  for (const detector of DETECTORS) {
    try {
      out.push(...detector(input));
    } catch {
      // One bad row must not hide the other signals.
    }
  }
  return out;
}

const SEVERITY_WEIGHT: Record<Severity, number> = { low: 3, medium: 8, high: 15 };

export function healthScore(signals: HealthSignal[]): number {
  return Math.max(0, 100 - signals.reduce((sum, s) => sum + SEVERITY_WEIGHT[s.severity], 0));
}
