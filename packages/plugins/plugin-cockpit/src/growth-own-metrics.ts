/**
 * Subscriber for CRM's `own.metrics.updated` event (from `own-metrics.ts` in plugin-crm).
 * Reads the event, validates it, and writes each metric to growth_metrics via recordMetric.
 */
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { recordMetric } from "./growth-ledger.js";
import type { Env } from "./env.js";

export const OWN_METRICS_EVENT = "own.metrics.updated";

/**
 * Converts a Date to ISO week format (e.g., "2026-W41").
 * Uses the Thursday rule: a date belongs to the week of that week's Thursday.
 */
export function isoWeek(date: Date): string {
  // Use UTC to be consistent with the date operations
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Get day of week (1 = Monday, 7 = Sunday)
  const dayNum = d.getUTCDay() || 7;
  // Move to the Thursday of the same week
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  // Get the year of this Thursday
  const year = d.getUTCFullYear();
  // Calculate the week number by finding days since Jan 1 and dividing by 7
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const weekNum = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${year}-W${String(weekNum).padStart(2, "0")}`;
}

export interface OwnMetric {
  key: string;
  label: string;
  value: number;
  unit: string;
  period: string;
}

export interface OwnMetricsEventPayload {
  scope: "own";
  metrics: OwnMetric[];
  updatedAt?: string;
}

/**
 * Event handler: consumes CRM's own.metrics.updated event and writes each metric to growth_metrics.
 * Returns the number of rows written. Drops malformed or companyless events without throwing.
 */
export async function onOwnMetricsEvent(env: Env, event: Pick<PluginEvent, "companyId" | "payload">): Promise<number> {
  if (!event.companyId) return 0;

  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return 0;

  const p = payload as Record<string, unknown>;
  if (p.scope !== "own") return 0;
  if (!Array.isArray(p.metrics)) return 0;

  const metrics = p.metrics as Array<Record<string, unknown>>;
  let updatedAt = env.now();

  if (typeof p.updatedAt === "string" && !Number.isNaN(Date.parse(p.updatedAt))) {
    updatedAt = new Date(p.updatedAt);
  }

  let written = 0;

  for (const metric of metrics) {
    const key = typeof metric.key === "string" ? metric.key.trim() : "";
    if (!key || key.length === 0) continue;

    const value = metric.value;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;

    // Determine channel: "revenue.*" -> "revenue", otherwise "website"
    const channel = key.startsWith("revenue.") ? "revenue" : "website";

    // Window is ISO week of updatedAt
    const window = isoWeek(updatedAt);

    // Subject is always "own"
    const subject = "own";

    // Metric key (truncate to 80 chars to match parseMetricInput)
    const metricKey = key.slice(0, 80);

    // Source is "tool"
    const source = "tool" as const;

    try {
      await recordMetric(env, event.companyId, {
        channel,
        subject,
        metric: metricKey,
        window,
        value,
        source,
      });
      written += 1;
    } catch (error) {
      env.ctx.logger.info("Failed to record own metric", { companyId: event.companyId, key: metricKey, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return written;
}
