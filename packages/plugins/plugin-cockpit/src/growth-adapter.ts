/**
 * Generic growth metrics adapter: reads growth_metrics for any channel (website, aso, book, revenue)
 * and scores experiment items. Used by growth experiments across channels.
 */
import type { ItemState } from "@partnersinbiz/pib-plugin-kit";
import type { Env } from "./env.js";
import { NAMESPACE } from "./namespace.js";

/** The plan gives no per-channel numbers: kit defaults, changed here in one place. */
export const GROWTH_CHANNELS = {
  website: { defaultMetric: "site_conversions", windowDays: 7, minPerArm: 3 },
  aso: { defaultMetric: "installs", windowDays: 7, minPerArm: 3 },
  book: { defaultMetric: "units", windowDays: 7, minPerArm: 3 },
  revenue: { defaultMetric: "revenue", windowDays: 7, minPerArm: 3 },
} as const;


export function isGrowthChannel(channel: unknown): channel is keyof typeof GROWTH_CHANNELS {
  return typeof channel === "string" && Object.prototype.hasOwnProperty.call(GROWTH_CHANNELS, channel);
}

export interface MetricRow {
  window: string;
  value: number;
}

/**
 * Reads the metric rows of the given windows (company, channel and scope bound). A window with no row is
 * simply absent; `itemStates` leaves an item with a missing window unpublished.
 */
export async function readMetricRows(
  env: Env,
  companyId: string,
  channel: string,
  scopeKey: string,
  metric: string,
  windows: string[],
): Promise<MetricRow[]> {
  if (windows.length === 0) return [];

  const METRICS = `${NAMESPACE}.growth_metrics`;

  // Generate placeholders for the IN clause: $5, $6, ...
  const placeholders = windows.map((_, i) => `$${5 + i}`).join(",");
  const params = [companyId, channel, scopeKey, metric, ...windows];

  const rows = await env.ctx.db.query<{ window: string; value: string | number }>(
    `SELECT "window", value::float AS value FROM ${METRICS}
     WHERE company_id = $1 AND channel = $2 AND subject = $3 AND metric = $4 AND "window" IN (${placeholders})
     ORDER BY "window"`,
    params,
  );

  return rows.map((r) => ({ window: r.window, value: Number(r.value) }));
}

/**
 * Converts item labels (which may be joined with "+") into windows, and reads their metric values.
 * Outputs ItemState[] in the same order as input items. published = value !== null.
 */
export function itemStates(items: { arm: string; subjectId: string }[], rows: MetricRow[]): ItemState[] {
  // Build a map of window -> value for fast lookup
  const valueByWindow = new Map(rows.map((r) => [r.window, r.value]));

  return items.map((item) => {
    // Parse windows from label (may be "2026-W41+2026-W42" or single "2026-W41")
    const windows = item.subjectId
      .split("+")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (windows.length === 0) {
      return {
        subjectId: item.subjectId,
        arm: item.arm,
        published: false,
        value: null,
      };
    }

    // Check if all windows are present in the rows
    const values = windows
      .map((w) => valueByWindow.get(w))
      .filter((v) => v !== undefined) as number[];

    if (values.length !== windows.length) {
      // A window is missing
      return {
        subjectId: item.subjectId,
        arm: item.arm,
        published: false,
        value: null,
      };
    }

    // Compute mean
    const mean = values.reduce((a, b) => a + b, 0) / values.length;

    return {
      subjectId: item.subjectId,
      arm: item.arm,
      published: true,
      value: mean,
    };
  });
}

/**
 * Scores experiment items by reading metric rows for the given windows.
 * Returns ItemState[] with published status and values for each item.
 */
export async function scoreExperimentItems(
  env: Env,
  companyId: string,
  config: { channel: string; scopeKey: string; metric: string },
  items: { arm: string; subjectId: string }[],
): Promise<ItemState[]> {
  // Collect all unique windows from item labels
  const windowSet = new Set<string>();
  for (const item of items) {
    const windows = item.subjectId
      .split("+")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    windows.forEach((w) => windowSet.add(w));
  }

  const windows = Array.from(windowSet);
  const rows = await readMetricRows(env, companyId, config.channel, config.scopeKey, config.metric, windows);
  return itemStates(items, rows);
}
