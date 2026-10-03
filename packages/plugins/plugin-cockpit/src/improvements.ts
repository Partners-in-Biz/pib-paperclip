/**
 * The improvements ledger, worker part (Q2-3, Q2-12): propose, list, resolve,
 * re-measure when due, and propose the pinned facts that belong in a skill.
 * The rules and the verdict are in `improvements-model.ts`; the numbers come
 * from `metrics.ts`, so a baseline and its re-check are read the same way.
 */
import { randomBytes } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { configSaved } from "@partnersinbiz/pib-plugin-kit";
import { recordActivity } from "./activity.js";
import { listRoles } from "./db.js";
import type { Env } from "./env.js";
import { message, throwIfEveryCompanyFailed } from "./env.js";
import {
  HIGHLY_USED,
  ImprovementError,
  improvementBrief,
  improvementVerdict,
  isDue,
  isOverdue,
  parseImprovementInput,
  skillCandidates,
  skillCandidateTitle,
  type ImprovementInput,
  type ImprovementRow,
  type ImprovementStatus,
  type Outcome,
} from "./improvements-model.js";
import * as memory from "./memory/store.js";
import { updateFact } from "./memory/service.js";
import { MetricReader, metricBetter, parseMetricKey } from "./metrics.js";
import { NAMESPACE } from "./namespace.js";
import { operatorAgentId } from "./roles.js";

const T = `${NAMESPACE}.improvements`;
type Raw = Record<string, unknown>;

const COLUMNS =
  "id, company_id, title, kind, target_ref, summary, owner_agent_id, owner_user_id, metric_key, metric_label, direction, baseline_value, baseline_at, target_value, recheck_at, status, outcome, result_value, measured_at, result_note, source_ref, source_issue_id, created_at, updated_at, resolved_at";

const iso = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  if (value == null || value === "") return null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const str = (value: unknown): string | null => (value == null || value === "" ? null : String(value));
const numOrNull = (value: unknown): number | null => (value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

function rowFrom(r: Raw): ImprovementRow {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    title: String(r.title ?? ""),
    kind: String(r.kind) as ImprovementRow["kind"],
    targetRef: str(r.target_ref),
    summary: str(r.summary),
    ownerAgentId: str(r.owner_agent_id),
    ownerUserId: str(r.owner_user_id),
    metricKey: String(r.metric_key),
    metricLabel: str(r.metric_label),
    direction: String(r.direction) === "higher" ? "higher" : "lower",
    baselineValue: numOrNull(r.baseline_value),
    baselineAt: iso(r.baseline_at),
    targetValue: numOrNull(r.target_value),
    recheckAt: iso(r.recheck_at) ?? new Date(0).toISOString(),
    status: String(r.status) as ImprovementStatus,
    outcome: r.outcome == null ? null : (String(r.outcome) as Outcome),
    resultValue: numOrNull(r.result_value),
    measuredAt: iso(r.measured_at),
    resultNote: str(r.result_note),
    sourceRef: str(r.source_ref),
    sourceIssueId: str(r.source_issue_id),
    createdAt: iso(r.created_at) ?? "",
    updatedAt: iso(r.updated_at) ?? "",
    resolvedAt: iso(r.resolved_at),
  };
}

function newId(): string {
  return `imp${randomBytes(6).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export async function getImprovement(ctx: PluginContext, companyId: string, id: string): Promise<ImprovementRow | null> {
  const rows = await ctx.db.query<Raw>(`SELECT ${COLUMNS} FROM ${T} WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return rows[0] ? rowFrom(rows[0]) : null;
}

export async function listImprovements(ctx: PluginContext, companyId: string, options: { status?: ImprovementStatus | "all"; limit?: number } = {}): Promise<ImprovementRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const rows =
    options.status && options.status !== "all"
      ? await ctx.db.query<Raw>(`SELECT ${COLUMNS} FROM ${T} WHERE company_id = $1 AND status = $2 ORDER BY recheck_at LIMIT $3`, [companyId, options.status, limit])
      : await ctx.db.query<Raw>(`SELECT ${COLUMNS} FROM ${T} WHERE company_id = $1 ORDER BY recheck_at LIMIT $2`, [companyId, limit]);
  return rows.map(rowFrom);
}

async function openBySource(ctx: PluginContext, companyId: string, sourceRef: string): Promise<ImprovementRow | null> {
  const rows = await ctx.db.query<Raw>(`SELECT ${COLUMNS} FROM ${T} WHERE company_id = $1 AND source_ref = $2 AND status = 'open'`, [companyId, sourceRef]);
  return rows[0] ? rowFrom(rows[0]) : null;
}

/** True when this source already has an improvement of any status newer than `sinceIso` (so a resolved one is not proposed again at once). */
async function recentBySource(ctx: PluginContext, companyId: string, sourceRef: string, sinceIso: string): Promise<boolean> {
  const rows = await ctx.db.query<Raw>(`SELECT id FROM ${T} WHERE company_id = $1 AND source_ref = $2 AND created_at >= $3 LIMIT 1`, [companyId, sourceRef, sinceIso]);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Propose
// ---------------------------------------------------------------------------

export interface ProposeResult {
  improvement: ImprovementRow;
  /** Where the baseline came from. */
  baselineFrom: "given" | "measured" | "none";
  deduped: boolean;
  message: string;
}

/**
 * Records an improvement. The baseline is the number as it stands NOW: the
 * caller's own, or (for a metric the Cockpit reads) measured here, so it is
 * never a guess. A target that does not point the right way is refused.
 */
export async function proposeImprovement(env: Env, companyId: string, raw: Record<string, unknown>, actor: { agentId: string | null; userId: string | null }): Promise<ProposeResult> {
  const now = env.now();
  const input: ImprovementInput = parseImprovementInput(raw, now);
  const parsed = parseMetricKey(input.metricKey)!;
  const direction = input.direction ?? metricBetter(parsed);
  if (!direction) throw new ImprovementError('direction is required for this metric: "lower" or "higher", whichever is better.');
  let sourceRef = input.sourceRef;
  if (input.sourceFactId) {
    const fact = await memory.getFact(env.ctx, companyId, input.sourceFactId);
    if (!fact) throw new ImprovementError(`Fact ${input.sourceFactId} was not found in this company's memory.`);
    sourceRef = sourceRef ?? `fact:${fact.id}`;
  }
  if (sourceRef) {
    const existing = await openBySource(env.ctx, companyId, sourceRef);
    if (existing) return { improvement: existing, baselineFrom: existing.baselineValue === null ? "none" : "given", deduped: true, message: `There is already an open improvement for ${sourceRef} (${existing.id}); nothing was added.` };
  }
  let baseline = input.baselineValue;
  let baselineFrom: ProposeResult["baselineFrom"] = baseline === null ? "none" : "given";
  let metricLabel = input.metricLabel;
  if (baseline === null && parsed.kind !== "manual") {
    const reading = await new MetricReader(env, companyId).read(input.metricKey);
    metricLabel = metricLabel ?? reading.label;
    if (reading.value === null) throw new ImprovementError(`The Cockpit cannot read ${input.metricKey} right now (${reading.note ?? "no value"}). Give baselineValue yourself, or pick a metric it can read.`);
    baseline = reading.value;
    baselineFrom = "measured";
  }
  if (input.targetValue !== null && baseline !== null && (direction === "lower" ? input.targetValue >= baseline : input.targetValue <= baseline)) {
    throw new ImprovementError(`The target ${input.targetValue} does not point the right way: the baseline is ${baseline} and ${direction} is better, so the target must be ${direction === "lower" ? "below" : "above"} it.`);
  }
  let ownerAgentId = input.ownerAgentId ?? actor.agentId;
  if (ownerAgentId) {
    const agent = await env.ctx.agents.get(ownerAgentId, companyId).catch(() => null);
    if (!agent) {
      if (input.ownerAgentId) throw new ImprovementError("ownerAgentId is not an agent of this company.");
      ownerAgentId = null;
    }
  }
  const id = newId();
  const stamp = now.toISOString();
  await env.ctx.db.execute(
    `INSERT INTO ${T} (id, company_id, title, kind, target_ref, summary, owner_agent_id, owner_user_id, metric_key, metric_label, direction, baseline_value, baseline_at, target_value, recheck_at, status, source_ref, source_issue_id, created_by_agent_id, created_by_user_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'open', $16, $17, $18, $19, $20, $21)`,
    [id, companyId, input.title, input.kind, input.targetRef, input.summary, ownerAgentId, ownerAgentId ? null : actor.userId, input.metricKey, metricLabel, direction, baseline, baseline === null ? null : stamp, input.targetValue, input.recheckAt, sourceRef, input.sourceIssueId, actor.agentId, actor.userId, stamp, stamp],
  );
  const improvement = (await getImprovement(env.ctx, companyId, id))!;
  const goal = input.targetValue !== null ? ` toward ${input.targetValue}` : "";
  return {
    improvement,
    baselineFrom,
    deduped: false,
    message: `Recorded ${id}: ${metricLabel ?? input.metricKey} is ${baseline === null ? "not yet known" : baseline}${goal} (${direction} is better). It is measured again on ${input.recheckAt.slice(0, 10)}, and shows on the Operator's brief until then.`,
  };
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

async function finish(env: Env, row: ImprovementRow, patch: { status: ImprovementStatus; outcome: Outcome | null; resultValue: number | null; note: string | null }): Promise<ImprovementRow> {
  const now = env.now().toISOString();
  await env.ctx.db.execute(
    `UPDATE ${T} SET status = $3, outcome = $4, result_value = $5, measured_at = $6, result_note = $7, resolved_at = $8, updated_at = $9 WHERE company_id = $1 AND id = $2 AND status = 'open'`,
    [row.companyId, row.id, patch.status, patch.outcome, patch.resultValue, now, patch.note, now, now],
  );
  return (await getImprovement(env.ctx, row.companyId, row.id)) ?? row;
}

export interface ResolveInput {
  id: string;
  /** The number measured now, for a metric the Cockpit does not read (or to override its reading). */
  resultValue?: number | null;
  note?: string | null;
  /** Close it without a verdict: it was not done, or no longer matters. */
  drop?: boolean;
  /** Archive the memory fact this improvement folds into a skill (once the skill carries it). */
  archiveFact?: boolean;
}

/** Archives the memory fact an improvement was opened for (a fact promotion). Null when it has none or the archive failed. */
async function archiveSourceFact(env: Env, companyId: string, row: ImprovementRow): Promise<string | null> {
  if (!row.sourceRef?.startsWith("fact:")) return null;
  try {
    await updateFact(env, companyId, { id: row.sourceRef.slice(5), status: "archived" });
    return row.sourceRef.slice(5);
  } catch (error) {
    env.ctx.logger.info("Improvement: the fact could not be archived", { id: row.id, error: message(error) });
    return null;
  }
}

/** Records the verdict (improved / no change / worse) from the baseline and the number measured now, or drops the improvement. */
export async function resolveImprovement(env: Env, companyId: string, input: ResolveInput): Promise<{ improvement: ImprovementRow; message: string; archivedFact: string | null }> {
  const row = await getImprovement(env.ctx, companyId, input.id);
  if (!row) throw new ImprovementError(`Improvement ${input.id} was not found in this company.`);
  const hasFact = !!row.sourceRef?.startsWith("fact:");
  if (row.status !== "open") {
    // A fact promotion is re-checked on its date (and resolved "no change") whether or not the skill change has shipped yet. Folding the rule
    // into the skill can come later, and archiving the fact must still work then: it only archives, the recorded verdict stays as it was.
    if (input.archiveFact && hasFact && !input.drop && input.resultValue == null) {
      const archived = await archiveSourceFact(env, companyId, row);
      if (!archived) throw new ImprovementError(`Improvement ${input.id} is already ${row.status}, and its memory fact could not be archived (it may be gone already).`);
      return { improvement: row, message: `Archived fact ${archived}. Improvement ${row.id} stays ${row.status}${row.outcome ? ` (${row.outcome.replace("_", " ")})` : ""}.`, archivedFact: archived };
    }
    throw new ImprovementError(`Improvement ${input.id} is already ${row.status}${row.outcome ? ` (${row.outcome.replace("_", " ")})` : ""}.${hasFact && !input.archiveFact ? " Pass archiveFact to archive its memory fact." : ""}`);
  }
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 400) : null;
  const archivedFact = input.archiveFact ? await archiveSourceFact(env, companyId, row) : null;
  if (input.drop) {
    const done = await finish(env, row, { status: "dropped", outcome: null, resultValue: null, note: note ?? "Dropped." });
    return { improvement: done, message: `Dropped ${row.id}.${archivedFact ? ` Archived fact ${archivedFact}.` : ""}`, archivedFact };
  }
  let value: number | null = typeof input.resultValue === "number" && Number.isFinite(input.resultValue) ? input.resultValue : null;
  let label = row.metricLabel;
  if (value === null) {
    if (parseMetricKey(row.metricKey)?.kind === "manual") throw new ImprovementError("This metric is recorded by hand: pass resultValue, the number measured now.");
    const reading = await new MetricReader(env, companyId).read(row.metricKey);
    label = label ?? reading.label;
    value = reading.value;
  }
  const verdict = improvementVerdict({ direction: row.direction, baseline: row.baselineValue, target: row.targetValue, result: value, label });
  const done = await finish(env, row, { status: "resolved", outcome: verdict.outcome, resultValue: value, note: [verdict.detail, note].filter(Boolean).join(" ") });
  return { improvement: done, message: `${verdict.detail}${archivedFact ? ` Archived fact ${archivedFact}.` : ""}`, archivedFact };
}

// ---------------------------------------------------------------------------
// The daily job
// ---------------------------------------------------------------------------

export interface RecheckResult {
  measured: number;
  improved: number;
  noChange: number;
  worse: number;
  unreadable: number;
  manual: number;
  proposed: number;
}

/** Re-measures every automatic improvement whose date has come, one company at a time, and writes the verdict with its numbers. */
export async function recheckCompany(env: Env, companyId: string): Promise<RecheckResult> {
  const result: RecheckResult = { measured: 0, improved: 0, noChange: 0, worse: 0, unreadable: 0, manual: 0, proposed: 0 };
  const now = env.now();
  const reader = new MetricReader(env, companyId);
  for (const row of await listImprovements(env.ctx, companyId, { status: "open", limit: 100 })) {
    if (!isDue(row, now)) continue;
    if (parseMetricKey(row.metricKey)?.kind === "manual") {
      result.manual += 1;
      continue;
    }
    const reading = await reader.read(row.metricKey);
    if (reading.value === null) {
      result.unreadable += 1;
      // Look again tomorrow; it becomes overdue (and shows red in the retro) if it stays unreadable.
      await env.ctx.db.execute(`UPDATE ${T} SET result_note = $3, updated_at = $4 WHERE company_id = $1 AND id = $2 AND status = 'open'`, [companyId, row.id, `Could not be measured on ${now.toISOString().slice(0, 10)}: ${reading.note ?? "no value"}`.slice(0, 400), now.toISOString()]).catch(() => undefined);
      continue;
    }
    const verdict = improvementVerdict({ direction: row.direction, baseline: row.baselineValue, target: row.targetValue, result: reading.value, label: row.metricLabel ?? reading.label });
    const done = await finish(env, row, { status: "resolved", outcome: verdict.outcome, resultValue: reading.value, note: verdict.detail });
    result.measured += 1;
    if (verdict.outcome === "improved") result.improved += 1;
    else if (verdict.outcome === "worse") result.worse += 1;
    else if (verdict.outcome === "no_change") result.noChange += 1;
    await recordActivity(env.ctx, companyId, {
      key: `improvement:${done.id}`,
      kind: "improvement",
      at: now.toISOString(),
      text: `Improvement checked: ${done.title}. ${verdict.detail}`,
      href: "/cockpit",
      agentId: done.ownerAgentId,
    }).catch(() => false);
  }
  return result;
}

/** How many pinned-fact promotions one daily run may open, so the ledger does not flood the retro. */
export const PROMOTION_BATCH = 3;
/** A resolved or dropped promotion is not proposed again for this long. */
export const PROMOTION_COOLDOWN_DAYS = 60;

/** Opens an improvement for each pinned or much-used company-wide fact that describes a tool (Q2-12), a few at a time. */
export async function proposeFactPromotions(env: Env, companyId: string): Promise<number> {
  const now = env.now();
  const facts = skillCandidates(await memory.activeFacts(env.ctx, companyId, 5000));
  if (facts.length === 0) return 0;
  const owner = await operatorAgentId(env, companyId).catch(() => null);
  const since = new Date(now.getTime() - PROMOTION_COOLDOWN_DAYS * 86_400_000).toISOString();
  let opened = 0;
  for (const fact of facts) {
    if (opened >= PROMOTION_BATCH) break;
    const sourceRef = `fact:${fact.id}`;
    if (await recentBySource(env.ctx, companyId, sourceRef, since)) continue;
    try {
      await proposeImprovement(
        env,
        companyId,
        {
          title: skillCandidateTitle(fact),
          kind: "skill",
          targetRef: null,
          summary: `A ${fact.pinned ? "pinned" : `much-used (${HIGHLY_USED}+ briefs)`} company-wide fact describes how a tool or skill behaves, so it rides in every brief instead of being fixed once at its source. Put it in the owning skill (a plugin change, deployed), then archive the fact: improvement-resolve with archiveFact.`,
          ownerAgentId: owner,
          metricKey: "company:pinned_tool_facts",
          direction: "lower",
          sourceRef,
          sourceFactId: fact.id,
          recheckInDays: 14,
        },
        { agentId: null, userId: null },
      );
      opened += 1;
    } catch (error) {
      env.ctx.logger.info("Improvement: a fact promotion was not opened", { companyId, factId: fact.id, error: message(error) });
    }
  }
  return opened;
}

/** Daily job: every company with saved Cockpit settings. */
export async function recheckImprovements(env: Env): Promise<Record<string, number>> {
  const total: Record<string, number> = { companies: 0, measured: 0, improved: 0, noChange: 0, worse: 0, unreadable: 0, manual: 0, proposed: 0, failed: 0 };
  for (const row of await listRoles(env.ctx)) {
    if (!(await configSaved(env.ctx, row.companyId))) continue;
    total.companies = (total.companies ?? 0) + 1;
    try {
      const r = await recheckCompany(env, row.companyId);
      r.proposed = await proposeFactPromotions(env, row.companyId);
      for (const [key, value] of Object.entries(r)) total[key] = (total[key] ?? 0) + value;
    } catch (error) {
      total.failed = (total.failed ?? 0) + 1;
      env.ctx.logger.info("Improvements re-check failed for a company", { companyId: row.companyId, error: message(error) });
    }
  }
  throwIfEveryCompanyFailed("The improvements re-check", total.companies ?? 0, total.failed ?? 0);
  return total;
}

// ---------------------------------------------------------------------------
// What the brief and the retro show
// ---------------------------------------------------------------------------

/** Open, due and overdue improvements and the latest outcomes, short: what the Operator's brief and the weekly retro carry. */
export async function improvementsBrief(env: Env, companyId: string): Promise<{
  open: number;
  due: number;
  overdue: number;
  items: Array<Record<string, unknown>>;
  recent: Array<Record<string, unknown>>;
}> {
  const now = env.now();
  const open = await listImprovements(env.ctx, companyId, { status: "open", limit: 100 });
  const resolved = (await listImprovements(env.ctx, companyId, { status: "resolved", limit: 200 })).filter((r) => r.resolvedAt && now.getTime() - Date.parse(r.resolvedAt) < 21 * 86_400_000);
  const due = open.filter((r) => isDue(r, now));
  const overdue = open.filter((r) => isOverdue(r, now));
  // Overdue first, then due, then the rest by re-check date.
  const order = (r: ImprovementRow) => (isOverdue(r, now) ? 0 : isDue(r, now) ? 1 : 2);
  const items = [...open].sort((a, b) => order(a) - order(b) || Date.parse(a.recheckAt) - Date.parse(b.recheckAt)).slice(0, 8).map((r) => improvementBrief(r, now));
  const recent = resolved.sort((a, b) => Date.parse(b.resolvedAt!) - Date.parse(a.resolvedAt!)).slice(0, 5).map((r) => improvementBrief(r, now));
  return { open: open.length, due: due.length, overdue: overdue.length, items, recent };
}
