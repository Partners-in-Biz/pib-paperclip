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
/** Structural: the part of a KPI the number needs (no import of the snapshot types, so this file stays pure). */
export interface KpiLike {
  raw?: number | null;
  value: string;
}

export type Better = "lower" | "higher";

export interface MetricInfo {
  label: string;
  unit: string | null;
  better: Better;
}

export const COMPANY_METRICS = {
  fail_rate: { label: "Run failure rate (7 days)", unit: "%", better: "lower" },
  retry_rate: { label: "Share of runs that were retries (7 days)", unit: "%", better: "lower" },
  usd_per_day: { label: "Notional AI spend per day (7 days)", unit: "USD", better: "lower" },
  usd_per_done: { label: "Notional AI spend per finished issue (7 days)", unit: "USD", better: "lower" },
  issues_done_7d: { label: "Issues finished (7 days)", unit: "issues", better: "higher" },
  review_coverage: { label: "Finished code work that was reviewed (30 days)", unit: "%", better: "higher" },
  review_latency_p90_hours: { label: "Slowest 10% of reviews, hours (30 days)", unit: "h", better: "lower" },
  limit_failures_7d: { label: "Runs that hit the subscription limit (7 days)", unit: "runs", better: "lower" },
  blocked_no_way_out: { label: "Issues blocked with no way out", unit: "issues", better: "lower" },
  unassigned_old: { label: "Open issues nobody holds, older than a day", unit: "issues", better: "lower" },
  asks_open: { label: "Questions waiting on the owner", unit: "asks", better: "lower" },
  asks_oldest_days: { label: "Age of the oldest question to the owner, days", unit: "days", better: "lower" },
  memory_feedback_coverage: { label: "Memory briefs that got any feedback (30 days)", unit: "%", better: "higher" },
  pinned_tool_facts: { label: "Pinned facts that describe how a tool behaves", unit: "facts", better: "lower" },
  agents_in_error: { label: "Agents in error", unit: "agents", better: "lower" },
} as const satisfies Record<string, MetricInfo>;
export type CompanyMetric = keyof typeof COMPANY_METRICS;

export const AGENT_METRICS = {
  fail_rate: { label: "failure rate (7 days)", unit: "%", better: "lower" },
  retry_rate: { label: "retries as a share of runs (7 days)", unit: "%", better: "lower" },
  p90_sec: { label: "slowest 10% of runs, seconds (7 days)", unit: "s", better: "lower" },
  usd_per_done: { label: "notional spend per finished issue (7 days)", unit: "USD", better: "lower" },
  usd_7d: { label: "notional spend (7 days)", unit: "USD", better: "lower" },
  runs_7d: { label: "runs (7 days)", unit: "runs", better: "lower" },
} as const satisfies Record<string, MetricInfo>;
export type AgentMetric = keyof typeof AGENT_METRICS;

export type ParsedMetric =
  | { kind: "manual" }
  | { kind: "company"; metric: CompanyMetric }
  | { kind: "agent"; agentId: string; metric: AgentMetric }
  | { kind: "kpi"; plugin: string; kpi: string };

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/;

/** The key's meaning, or null when it is not a metric the Cockpit can read. */
export function parseMetricKey(key: string): ParsedMetric | null {
  const k = key.trim();
  if (k === "manual") return { kind: "manual" };
  const parts = k.split(":");
  if (parts[0] === "company" && parts.length === 2 && parts[1]! in COMPANY_METRICS) return { kind: "company", metric: parts[1] as CompanyMetric };
  if (parts[0] === "agent" && parts.length === 3 && ID.test(parts[1]!) && parts[2]! in AGENT_METRICS) return { kind: "agent", agentId: parts[1]!, metric: parts[2] as AgentMetric };
  if (parts[0] === "kpi" && parts.length === 3 && /^[a-z][a-z0-9.-]*$/.test(parts[1]!) && /^[a-z][a-z0-9_]*$/.test(parts[2]!)) return { kind: "kpi", plugin: parts[1]!, kpi: parts[2]! };
  return null;
}

export const METRIC_KEY_HELP =
  'A metric key: "company:<metric>" (e.g. company:fail_rate), "agent:<agentId>:<metric>" (fail_rate, retry_rate, p90_sec, usd_per_done, usd_7d, runs_7d), "kpi:<plugin>:<kpi key>" (a number a module reports, e.g. kpi:partnersinbiz.crm:new_leads_week) or "manual" (you record the value yourself).';

/** Which way is better when the key says so; null for `manual` and modules' KPIs (the caller says). */
export function metricBetter(parsed: ParsedMetric): Better | null {
  if (parsed.kind === "company") return COMPANY_METRICS[parsed.metric].better;
  if (parsed.kind === "agent") return AGENT_METRICS[parsed.metric].better;
  return null;
}

/** A KPI's number in whole units: a formatted amount ("R 12,400.00") carries minor units in `raw`. */
export function kpiNumber(kpi: KpiLike): number | null {
  if (typeof kpi.raw !== "number" || !Number.isFinite(kpi.raw)) return null;
  return /^(R |\$|€|£|[A-Z]{3} )-?[\d,]+(\.\d+)?$/.test(String(kpi.value).trim()) ? kpi.raw / 100 : kpi.raw;
}

