/**
 * Metrics the Cockpit can read by key: what an improvement is measured by
 * (Q2-3) and what a goal is compared to (Q10-3). One reader, so a number means
 * the same in a retro, a re-check and a business review.
 *
 * Keys:
 * - `company:<metric>`        a measure of the whole company (`COMPANY_METRICS`)
 * - `agent:<agentId>:<metric>` one agent over 7 days (`AGENT_METRICS`)
 * - `kpi:<plugin>:<kpi key>`   a number a module reports on its Cockpit snapshot
 *                              (leads this week, keywords in the top 10, posts published...)
 * - `manual`                   nobody reads it; a person or agent records it
 *
 * Ratios are percentages (0 to 100) so a target reads the way a person says it
 * ("failure rate under 10"). Money from a module is in whole currency units.
 * A metric that cannot be read gives `value: null` with a note, never 0.
 */
import { isModuleEnabled } from "@partnersinbiz/pib-plugin-kit";
import { listSnapshots } from "./db.js";
import type { Env } from "./env.js";
import { message } from "./env.js";
import { isToolBehaviourFact } from "./improvements-model.js";
import { readAgentRuns, measureReviewCoverage, readLimitFailures } from "./measure.js";
import { failRate, round } from "./measure-model.js";
import { parseSnapshot } from "./merge.js";
import { memoryStats } from "./memory/store.js";
import { AGENT_METRICS, COMPANY_METRICS, kpiNumber, parseMetricKey, type AgentMetric, type Better, type CompanyMetric } from "./metrics-keys.js";
import { NAMESPACE } from "./namespace.js";

export * from "./metrics-keys.js";

export interface MetricReading {
  key: string;
  label: string;
  unit: string | null;
  /** null when it cannot be read right now (see `note`). */
  value: number | null;
  note: string | null;
}

const WEEK_MS = 7 * 86_400_000;

/** Reads metrics for one company; each expensive read is done once per reader. */
export class MetricReader {
  private memo = new Map<string, Promise<unknown>>();

  constructor(
    private readonly env: Env,
    private readonly companyId: string,
  ) {}

  private once<T>(key: string, load: () => Promise<T>): Promise<T> {
    let hit = this.memo.get(key) as Promise<T> | undefined;
    if (!hit) {
      hit = load();
      this.memo.set(key, hit);
    }
    return hit;
  }

  private week() {
    return this.once("week", () => readAgentRuns(this.env.ctx, this.companyId, new Date(this.env.now().getTime() - WEEK_MS).toISOString()));
  }

  private coverage() {
    return this.once("coverage", () => measureReviewCoverage(this.env, this.companyId, 30));
  }

  private stats() {
    return this.once("memory", () => memoryStats(this.env.ctx, this.companyId));
  }

  private async count(sql: string, params: unknown[]): Promise<number> {
    const rows = await this.env.ctx.db.query<Record<string, unknown>>(sql, params);
    return Number(rows[0]?.n ?? 0) || 0;
  }

  async read(key: string): Promise<MetricReading> {
    const parsed = parseMetricKey(key);
    if (!parsed) return { key, label: key, unit: null, value: null, note: "Not a metric the Cockpit knows." };
    if (parsed.kind === "manual") return { key, label: "Recorded by hand", unit: null, value: null, note: "Nobody reads this one; a value is recorded when someone measures it." };
    try {
      if (parsed.kind === "company") return await this.company(key, parsed.metric);
      if (parsed.kind === "agent") return await this.agent(key, parsed.agentId, parsed.metric);
      return await this.kpi(key, parsed.plugin, parsed.kpi);
    } catch (error) {
      this.env.ctx.logger.info("Cockpit metric unreadable", { companyId: this.companyId, key, error: message(error) });
      const info = parsed.kind === "company" ? COMPANY_METRICS[parsed.metric] : parsed.kind === "agent" ? AGENT_METRICS[parsed.metric] : null;
      return { key, label: info?.label ?? key, unit: info?.unit ?? null, value: null, note: `Could not read it: ${message(error).slice(0, 120)}` };
    }
  }

  private async company(key: string, metric: CompanyMetric): Promise<MetricReading> {
    const info = COMPANY_METRICS[metric];
    const reading = (value: number | null, note: string | null = null): MetricReading => ({ key, label: info.label, unit: info.unit, value: value === null ? null : round(value, 2), note });
    const companyId = this.companyId;
    const now = this.env.now();
    switch (metric) {
      case "fail_rate": {
        const { aggregates } = await this.week();
        let ok = 0;
        let failed = 0;
        for (const a of aggregates.values()) {
          ok += a.succeeded;
          failed += a.failed;
        }
        const rate = failRate({ succeeded: ok, failed });
        return reading(rate === null ? null : rate * 100, rate === null ? "No finished runs in the window." : null);
      }
      case "retry_rate": {
        const { aggregates } = await this.week();
        let runs = 0;
        let retries = 0;
        for (const a of aggregates.values()) {
          runs += a.runs;
          retries += a.retries;
        }
        return reading(runs === 0 ? null : (retries / runs) * 100, runs === 0 ? "No runs in the window." : null);
      }
      case "usd_per_day": {
        const { aggregates } = await this.week();
        let usd = 0;
        for (const a of aggregates.values()) usd += a.usd;
        return reading(usd / 7);
      }
      case "usd_per_done": {
        const { aggregates, done } = await this.week();
        let usd = 0;
        for (const a of aggregates.values()) usd += a.usd;
        const finished = [...done.values()].reduce((sum, d) => sum + d, 0);
        return reading(finished === 0 ? null : usd / finished, finished === 0 ? "Nothing was finished in the window." : null);
      }
      case "issues_done_7d": {
        const { done } = await this.week();
        return reading([...done.values()].reduce((sum, d) => sum + d, 0));
      }
      case "review_coverage": {
        const c = await this.coverage();
        return reading(c?.coverage == null ? null : c.coverage * 100, c?.coverage == null ? "No finished code work in the window (or it could not be read)." : null);
      }
      case "review_latency_p90_hours": {
        const c = await this.coverage();
        return reading(c?.latencyP90Hours ?? null, c?.latencyP90Hours == null ? "No finished reviews in the window." : null);
      }
      case "limit_failures_7d":
        return reading((await readLimitFailures(this.env.ctx, companyId, new Date(now.getTime() - WEEK_MS).toISOString())).total);
      case "blocked_no_way_out":
        return reading(
          await this.count(
            `SELECT count(*)::text AS n FROM public.issues i
              WHERE i.company_id = $1::uuid AND i.status = 'blocked' AND i.hidden_at IS NULL AND i.assignee_user_id IS NULL
                AND jsonb_typeof(i.unblock_descriptor) IS DISTINCT FROM 'object'
                AND NOT EXISTS (SELECT 1 FROM public.issue_relations r JOIN public.issues b ON b.id = r.issue_id
                                 WHERE r.company_id = i.company_id AND r.related_issue_id = i.id AND r.type = 'blocks' AND b.status NOT IN ('done', 'cancelled'))
                AND NOT EXISTS (SELECT 1 FROM ${NAMESPACE}.asks a WHERE a.company_id = i.company_id::text AND a.issue_id = i.id::text AND a.status = 'open')`,
            [companyId],
          ),
        );
      case "unassigned_old":
        return reading(
          await this.count(
            `SELECT count(*)::text AS n FROM public.issues WHERE company_id = $1::uuid AND assignee_agent_id IS NULL AND assignee_user_id IS NULL AND hidden_at IS NULL
                AND status IN ('todo', 'in_progress', 'in_review', 'blocked') AND created_at < $2::timestamptz`,
            [companyId, new Date(now.getTime() - 86_400_000).toISOString()],
          ),
        );
      case "asks_open":
        return reading(await this.count(`SELECT count(*)::text AS n FROM ${NAMESPACE}.asks WHERE company_id = $1 AND status = 'open'`, [companyId]));
      case "asks_oldest_days": {
        const rows = await this.env.ctx.db.query<Record<string, unknown>>(`SELECT min(asked_at) AS first FROM ${NAMESPACE}.asks WHERE company_id = $1 AND status = 'open'`, [companyId]);
        const first = rows[0]?.first ? Date.parse(String(rows[0].first)) : Number.NaN;
        return reading(Number.isFinite(first) ? (now.getTime() - first) / 86_400_000 : 0);
      }
      case "memory_feedback_coverage": {
        const s = await this.stats();
        return reading(s.briefs30d.total === 0 ? null : (s.feedback30d.briefsWithFeedback / s.briefs30d.total) * 100, s.briefs30d.total === 0 ? "No briefs in the window." : null);
      }
      case "pinned_tool_facts": {
        const rows = await this.env.ctx.db.query<Record<string, unknown>>(`SELECT text FROM ${NAMESPACE}.memory_facts WHERE company_id = $1 AND status = 'active' AND pinned = true AND client_ref IS NULL`, [companyId]);
        return reading(rows.filter((r) => isToolBehaviourFact(String(r.text ?? ""))).length);
      }
      case "agents_in_error": {
        const agents = (await this.env.ctx.agents.list({ companyId, limit: 200 })) as unknown as Array<Record<string, unknown>>;
        return reading(agents.filter((a) => String(a.status) === "error").length);
      }
    }
  }

  private async agent(key: string, agentId: string, metric: AgentMetric): Promise<MetricReading> {
    const info = AGENT_METRICS[metric];
    const { aggregates, done } = await this.week();
    const a = aggregates.get(agentId);
    const label = `Agent ${agentId.slice(0, 8)}: ${info.label}`;
    if (!a) return { key, label, unit: info.unit, value: metric === "runs_7d" || metric === "usd_7d" ? 0 : null, note: "The agent had no runs in the window." };
    const finished = done.get(agentId) ?? 0;
    const rate = failRate(a);
    const values: Record<AgentMetric, number | null> = {
      fail_rate: rate === null ? null : rate * 100,
      retry_rate: a.runs === 0 ? null : (a.retries / a.runs) * 100,
      p90_sec: a.p90Sec,
      usd_per_done: finished === 0 ? null : a.usd / finished,
      usd_7d: a.usd,
      runs_7d: a.runs,
    };
    const value = values[metric];
    return { key, label, unit: info.unit, value: value === null ? null : round(value, 2), note: value === null ? "Not enough data in the window." : null };
  }

  private async kpi(key: string, plugin: string, kpiKey: string): Promise<MetricReading> {
    const rows = await listSnapshots(this.env.ctx, this.companyId, "cockpit");
    const row = rows.find((r) => r.pluginKey === plugin);
    if (!row) return { key, label: key, unit: null, value: null, note: `${plugin} has not reported to the Cockpit.` };
    if (!(await isModuleEnabled(this.env.ctx, this.companyId, plugin))) return { key, label: key, unit: null, value: null, note: `${plugin} is switched off for this company.` };
    const snapshot = parseSnapshot(row.payload, plugin);
    const kpi = snapshot?.kpis.find((k) => k.key === kpiKey);
    if (!snapshot || !kpi) return { key, label: key, unit: null, value: null, note: `${plugin} does not report a "${kpiKey}" number.` };
    const stale = this.env.now().getTime() - Date.parse(row.checkedAt) > 6 * 3_600_000;
    return { key, label: kpi.label, unit: null, value: kpiNumber(kpi), note: stale ? `${plugin} last reported on ${row.checkedAt.slice(0, 16).replace("T", " ")}.` : null };
  }
}

/** Every metric a person or agent can pick: the company's and an agent's fixed ones, and the numbers each module reports now. */
export async function metricCatalog(env: Env, companyId: string): Promise<{
  company: Array<{ key: string; label: string; unit: string | null; better: Better }>;
  agent: Array<{ key: string; label: string; unit: string | null; better: Better }>;
  kpis: Array<{ key: string; label: string; plugin: string; current: number | null }>;
}> {
  const kpis: Array<{ key: string; label: string; plugin: string; current: number | null }> = [];
  for (const row of await listSnapshots(env.ctx, companyId, "cockpit").catch(() => [])) {
    if (!(await isModuleEnabled(env.ctx, companyId, row.pluginKey))) continue;
    const snapshot = parseSnapshot(row.payload, row.pluginKey);
    for (const kpi of snapshot?.kpis ?? []) if (kpi.raw != null && /^[a-z][a-z0-9_]*$/.test(kpi.key)) kpis.push({ key: `kpi:${row.pluginKey}:${kpi.key}`, label: kpi.label, plugin: row.pluginKey, current: kpiNumber(kpi) });
  }
  return {
    company: (Object.keys(COMPANY_METRICS) as CompanyMetric[]).map((m) => ({ key: `company:${m}`, ...COMPANY_METRICS[m] })),
    agent: (Object.keys(AGENT_METRICS) as AgentMetric[]).map((m) => ({ key: `agent:<agentId>:${m}`, ...AGENT_METRICS[m] })),
    kpis,
  };
}

