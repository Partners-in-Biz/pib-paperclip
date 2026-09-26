/**
 * Audit snapshots (scheduled on day 0/30/60/90 and monthly after) and the
 * audit summary tool.
 */
import { randomUUID } from "node:crypto";
import { comparableUrl } from "../checks/parse.js";
import * as db from "../db.js";
import { buildSnapshot } from "../engine/snapshot.js";
import { auditCapturePlan } from "../engine/sprint.js";
import { daysBetween } from "../engine/time.js";
import { companyInfo, num, reqStr, str, type CompanyInfo, type Env, type Params } from "./common.js";
import { clockFor, requireSprint } from "./context.js";

export async function captureSnapshot(
  env: Env,
  info: CompanyInfo,
  sprint: db.Sprint,
  input: { day: number; kind: "scheduled" | "manual"; notes?: string | null },
): Promise<{ snapshotId: string; created: boolean; source: string }> {
  const [keywords, integrations, backlinks, content, health, taskStats] = await Promise.all([
    db.listKeywords(env.ctx.db, sprint.companyId, sprint.id),
    db.listIntegrations(env.ctx.db, sprint.companyId, sprint.id),
    db.listBacklinks(env.ctx.db, sprint.companyId, sprint.id),
    db.listContent(env.ctx.db, sprint.companyId, sprint.id),
    db.latestPageHealth(env.ctx.db, sprint.id),
    db.taskStats(env.ctx.db, sprint.id),
  ]);
  const gsc = integrations.find((i) => i.provider === "gsc");
  const bing = integrations.find((i) => i.provider === "bing");
  const totals = (gsc?.stats?.siteTotals ?? null) as { impressions: number; clicks: number; ctr: number; position: number | null; startDate?: string; endDate?: string } | null;
  const pulledOn = typeof gsc?.stats?.pulledOn === "string" ? gsc.stats.pulledOn : null;
  const fresh = totals && pulledOn && Math.abs(daysBetween(pulledOn, info.today)) <= 2 ? totals : null;
  const home = comparableUrl(sprint.siteUrl);
  const homeHealth = health.find((h) => h.strategy === "mobile" && comparableUrl(h.url) === home) ?? null;
  const body = buildSnapshot({
    keywords,
    gscTotals: fresh,
    backlinks,
    bingInboundLinks: typeof bing?.stats?.totalInboundLinks === "number" ? (bing.stats.totalInboundLinks as number) : null,
    content,
    homeHealth,
    taskStats,
  });
  const id = randomUUID();
  const created = await db.insertSnapshot(env.ctx.db, {
    id,
    companyId: sprint.companyId,
    sprintId: sprint.id,
    day: input.day,
    kind: input.kind,
    capturedOn: info.today,
    ...body,
    notes: input.notes ?? null,
  });
  return { snapshotId: id, created, source: body.source };
}

/** Scheduled snapshots, idempotent via `audit_days_done` and the unique (sprint, day) index. */
export async function scheduledSnapshots(env: Env, info: CompanyInfo, sprint: db.Sprint, day: number): Promise<number | null> {
  const plan = auditCapturePlan(day, sprint.auditDaysDone);
  if (plan.capture == null) return null;
  const late = day !== plan.capture;
  await captureSnapshot(env, info, sprint, {
    day: plan.capture,
    kind: "scheduled",
    notes: late ? `Captured on day ${day} (scheduled for day ${plan.capture}).` : null,
  });
  const done = [...new Set([...sprint.auditDaysDone, ...plan.markDone])].sort((a, b) => a - b);
  await db.updateSprint(env.ctx.db, sprint.companyId, sprint.id, { audit_days_done: done });
  return plan.capture;
}

export async function runAuditSnapshotTool(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  const clock = clockFor(sprint, info.today);
  const day = num(params, "day", { integer: true, min: 0, max: 3650 }) ?? Math.max(clock.day, 0);
  const result = await captureSnapshot(env, info, sprint, { day, kind: "manual", notes: str(params, "notes", { max: 2000 }) ?? null });
  return { sprintId: sprint.id, day, ...result };
}

export async function auditSummaryTool(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const [snapshots, findings] = await Promise.all([
    db.listSnapshots(env.ctx.db, companyId, sprint.id),
    db.listFindings(env.ctx.db, companyId, sprint.id, { status: "open", limit: 200 }),
  ]);
  const bySeverity: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    byCategory[f.category ?? "general"] = (byCategory[f.category ?? "general"] ?? 0) + 1;
  }
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const trafficOf = (s: db.Snapshot | undefined) => (s ? (s.traffic as { impressions?: number; clicks?: number; avgPosition?: number | null }) : null);
  return {
    sprintId: sprint.id,
    snapshots: snapshots.map((s) => ({ snapshotId: s.id, day: s.day, kind: s.kind, capturedOn: s.capturedOn, source: s.source, traffic: s.traffic, rankings: s.rankings, authority: s.authority, content: s.content, notes: s.notes })),
    change: first && last && first !== last ? { fromDay: first.day, toDay: last.day, from: trafficOf(first), to: trafficOf(last) } : null,
    openFindings: findings.length,
    bySeverity,
    byCategory,
    findings: findings.slice(0, 60).map((f) => ({ findingId: f.id, severity: f.severity, category: f.category, url: f.url || null, finding: f.finding, source: f.source })),
  };
}
