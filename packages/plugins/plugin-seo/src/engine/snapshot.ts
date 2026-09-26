/**
 * Audit snapshot builder (pure). Traffic comes from the last GSC site totals
 * when they are fresh, otherwise from the tracked keywords. Only live
 * backlinks count as authority (the old platform counted every seeded row).
 */

export interface SnapshotInput {
  keywords: Array<{ currentPosition: number | null; impressions: number | null; clicks: number | null }>;
  gscTotals: { impressions: number; clicks: number; ctr: number; position: number | null; startDate?: string; endDate?: string } | null;
  backlinks: Array<{ domain: string; status: string; type: string }>;
  bingInboundLinks: number | null;
  content: Array<{ type: string; status: string }>;
  homeHealth: { performance: number | null; lcpMs: number | null; cls: number | null; inpMs: number | null; source: string } | null;
  taskStats: Record<string, number>;
}

export interface SnapshotBody {
  traffic: Record<string, unknown>;
  rankings: Record<string, unknown>;
  authority: Record<string, unknown>;
  content: Record<string, unknown>;
  cwv: Record<string, unknown>;
  tasks: Record<string, unknown>;
  source: "gsc" | "keywords" | "none";
}

function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function buildSnapshot(input: SnapshotInput): SnapshotBody {
  const positions = input.keywords.map((k) => k.currentPosition).filter((p): p is number => typeof p === "number" && p > 0);
  const kwImpressions = input.keywords.reduce((sum, k) => sum + (k.impressions ?? 0), 0);
  const kwClicks = input.keywords.reduce((sum, k) => sum + (k.clicks ?? 0), 0);
  let traffic: Record<string, unknown>;
  let source: SnapshotBody["source"];
  if (input.gscTotals) {
    source = "gsc";
    traffic = {
      scope: "site",
      impressions: input.gscTotals.impressions,
      clicks: input.gscTotals.clicks,
      ctr: round(input.gscTotals.ctr, 4),
      avgPosition: input.gscTotals.position != null ? round(input.gscTotals.position) : null,
      window: input.gscTotals.startDate && input.gscTotals.endDate ? `${input.gscTotals.startDate}..${input.gscTotals.endDate}` : null,
    };
  } else if (positions.length > 0 || kwImpressions > 0) {
    source = "keywords";
    traffic = {
      scope: "tracked_keywords",
      impressions: kwImpressions,
      clicks: kwClicks,
      ctr: kwImpressions > 0 ? round(kwClicks / kwImpressions, 4) : 0,
      avgPosition: positions.length > 0 ? round(positions.reduce((a, b) => a + b, 0) / positions.length) : null,
    };
  } else {
    source = "none";
    traffic = { scope: "none", impressions: 0, clicks: 0, ctr: 0, avgPosition: null };
  }
  const live = input.backlinks.filter((b) => b.status === "live");
  const liveContent = input.content.filter((c) => c.status === "live");
  const byType: Record<string, number> = {};
  for (const c of liveContent) byType[c.type] = (byType[c.type] ?? 0) + 1;
  const totalTasks = Object.values(input.taskStats).reduce((a, b) => a + b, 0);
  return {
    traffic,
    rankings: {
      tracked: input.keywords.length,
      withPosition: positions.length,
      top3: positions.filter((p) => p <= 3).length,
      top10: positions.filter((p) => p <= 10).length,
      top100: positions.filter((p) => p <= 100).length,
    },
    authority: {
      liveBacklinks: live.length,
      referringDomains: new Set(live.map((b) => b.domain.toLowerCase())).size,
      submitted: input.backlinks.filter((b) => b.status === "submitted").length,
      bingInboundLinks: input.bingInboundLinks,
    },
    content: {
      live: liveContent.length,
      byType,
      comparisonPagesLive: (byType.comparison ?? 0) + (byType.alternative ?? 0),
      inPipeline: input.content.filter((c) => c.status !== "live" && c.status !== "archived").length,
    },
    cwv: input.homeHealth
      ? { performance: input.homeHealth.performance, lcpMs: input.homeHealth.lcpMs, cls: input.homeHealth.cls, inpMs: input.homeHealth.inpMs, source: input.homeHealth.source }
      : {},
    tasks: { total: totalTasks, done: input.taskStats.done ?? 0, blocked: input.taskStats.blocked ?? 0, byStatus: input.taskStats },
    source,
  };
}
