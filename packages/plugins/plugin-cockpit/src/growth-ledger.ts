/**
 * Growth ledger and metrics: experiment verdicts from every channel's
 * `growth.verdict` event (best effort; the weekly review reconciles through
 * `ledger-upsert`) and per-window channel numbers. Every write is one
 * statement and idempotent. Rows are keyed by company; a ledger row also
 * carries its scope key, so one client's verdicts never read as another's.
 */
import { randomBytes } from "node:crypto";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { parseScopeKey } from "@partnersinbiz/pib-plugin-kit";
import type { Env } from "./env.js";
import { NAMESPACE } from "./namespace.js";

const LEDGER = `${NAMESPACE}.growth_ledger`;
const METRICS = `${NAMESPACE}.growth_metrics`;

/** Event name each channel plugin emits (arrives as `plugin.<key>.growth.verdict`). */
export const GROWTH_VERDICT_EVENT = "growth.verdict";
/** Plugins whose verdicts the ledger keeps (Ads is not installed yet; its subscription is harmless until it is). */
export const GROWTH_VERDICT_SOURCES = ["partnersinbiz.social", "partnersinbiz.campaigns", "partnersinbiz.seo", "partnersinbiz.cockpit", "partnersinbiz.ads"];

export const VERDICTS = ["win", "loss", "no_change", "inconclusive"] as const;
export const DECISIONS = ["kept", "discarded", "pending"] as const;
export const METRIC_SOURCES = ["tool", "csv"] as const;

export class GrowthLedgerError extends Error {}

export interface LedgerInput {
  channel: string;
  scopeKey: string;
  experimentId: string;
  verdict: (typeof VERDICTS)[number] | null;
  relativeChange: number | null;
  items: number | null;
  minPerArm: number | null;
  playbookDecision: (typeof DECISIONS)[number] | null;
  decidedBy: string | null;
  decidedAt: string;
}

export interface LedgerRow extends LedgerInput {
  id: string;
  companyId: string;
  createdAt: string;
}

const newId = (prefix: string): string => `${prefix}${randomBytes(6).toString("hex")}`;

function str(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || !value.trim()) throw new GrowthLedgerError(`${field} is required`);
  return value.trim().slice(0, max);
}

function optStr(value: unknown, max = 200): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function optNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new GrowthLedgerError(`${field} must be one of ${allowed.join(", ")}`);
}

/** A scope key in the kit's format (own, client:<kind>:<ref>, product:<id>, book:<id>). */
export function scopeText(value: unknown, field = "scope"): string {
  const raw = str(value, field);
  try {
    parseScopeKey(raw);
  } catch {
    throw new GrowthLedgerError(`${field} must be own, client:company:<id>, client:contact:<id>, product:<projectId> or book:<projectId>`);
  }
  return raw;
}

/** Validates a verdict (an event payload or a tool's parameters). Throws GrowthLedgerError. */
export function parseLedgerInput(raw: Record<string, unknown>, now: Date, defaults: { channel?: string } = {}): LedgerInput {
  const decidedAtRaw = optStr(raw.decidedAt, 40);
  if (decidedAtRaw && Number.isNaN(Date.parse(decidedAtRaw))) throw new GrowthLedgerError("decidedAt must be a date and time");
  return {
    channel: str(raw.channel ?? defaults.channel, "channel", 60),
    scopeKey: scopeText(raw.scope ?? raw.scopeKey),
    experimentId: str(raw.experimentId, "experimentId", 80),
    verdict: oneOf(raw.verdict, VERDICTS, "verdict"),
    relativeChange: optNum(raw.relativeChange),
    items: optNum(raw.items) === null ? null : Math.trunc(optNum(raw.items) as number),
    minPerArm: optNum(raw.minPerArm) === null ? null : Math.trunc(optNum(raw.minPerArm) as number),
    playbookDecision: oneOf(raw.playbookDecision, DECISIONS, "playbookDecision"),
    decidedBy: optStr(raw.decidedBy, 120),
    decidedAt: decidedAtRaw ? new Date(decidedAtRaw).toISOString() : now.toISOString(),
  };
}

/**
 * Writes one verdict. A no-op (returns false) when the same decision is
 * already there: same experiment and time, or the same verdict and playbook
 * decision recorded at another time (a re-sent event, or the weekly reconcile
 * after the event arrived). A changed decision (pending to kept) is a new row.
 */
export async function upsertLedger(env: Env, companyId: string, input: LedgerInput): Promise<boolean> {
  const result = await env.ctx.db.execute(
    `INSERT INTO ${LEDGER} (id, company_id, channel, scope_key, experiment_id, verdict, relative_change, items, min_per_arm, playbook_decision, decided_by, decided_at)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
     WHERE NOT EXISTS (
       SELECT 1 FROM ${LEDGER}
       WHERE company_id = $13 AND channel = $14 AND experiment_id = $15
         AND (decided_at = $16 OR (verdict IS NOT DISTINCT FROM $17 AND playbook_decision IS NOT DISTINCT FROM $18))
     )
     ON CONFLICT (company_id, channel, experiment_id, decided_at) DO NOTHING`,
    [
      newId("gled"), companyId, input.channel, input.scopeKey, input.experimentId, input.verdict, input.relativeChange, input.items, input.minPerArm, input.playbookDecision, input.decidedBy, input.decidedAt,
      companyId, input.channel, input.experimentId, input.decidedAt, input.verdict, input.playbookDecision,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/** The event handler: a malformed or companyless event is dropped (false), never thrown. */
/**
 * The kit emits `GrowthVerdictEvent` in snake_case, with `scope_key` as `<kind>:<id>` (null for the company's own work); the ledger works in
 * camelCase with the full scope key. Already-camelCase payloads pass through.
 */
export function ledgerPayloadFromEvent(payload: Record<string, unknown>): Record<string, unknown> {
  if (!("experiment_id" in payload) && !("scope_key" in payload)) return payload;
  const scope = payload.scope_key;
  return {
    channel: payload.channel,
    scope: scope === null || scope === undefined || scope === "" ? "own" : typeof scope === "string" && /^(own|client:|product:|book:)/.test(scope) ? scope : `client:${String(scope)}`,
    experimentId: payload.experiment_id,
    verdict: payload.verdict,
    relativeChange: payload.relative_change,
    items: payload.items,
    minPerArm: payload.min_per_arm,
    playbookDecision: payload.playbook_decision,
    decidedBy: payload.decided_by,
    decidedAt: payload.decided_at,
  };
}

export async function onGrowthVerdictEvent(env: Env, pluginKey: string, event: Pick<PluginEvent, "companyId" | "payload">): Promise<boolean> {
  const payload = event.payload;
  if (!event.companyId || !payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  let input: LedgerInput;
  try {
    input = parseLedgerInput(ledgerPayloadFromEvent(payload as Record<string, unknown>), env.now(), { channel: pluginKey.split(".").pop() });
  } catch (error) {
    env.ctx.logger.info("Growth verdict dropped", { pluginKey, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
  return upsertLedger(env, event.companyId, input);
}

interface LedgerSqlRow {
  id: string;
  company_id: string;
  channel: string;
  scope_key: string;
  experiment_id: string;
  verdict: string | null;
  relative_change: string | number | null;
  items: number | null;
  min_per_arm: number | null;
  playbook_decision: string | null;
  decided_by: string | null;
  decided_at: string | Date;
  created_at: string | Date;
}

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

export async function listLedger(env: Env, companyId: string, filter: { channel?: string | null; scopeKey?: string | null; experimentId?: string | null; limit?: number }): Promise<LedgerRow[]> {
  const rows = await env.ctx.db.query<LedgerSqlRow>(
    `SELECT * FROM ${LEDGER}
     WHERE company_id = $1 AND ($2::text IS NULL OR channel = $3) AND ($4::text IS NULL OR scope_key = $5) AND ($6::text IS NULL OR experiment_id = $7)
     ORDER BY decided_at DESC, created_at DESC LIMIT $8`,
    [companyId, filter.channel ?? null, filter.channel ?? null, filter.scopeKey ?? null, filter.scopeKey ?? null, filter.experimentId ?? null, filter.experimentId ?? null, Math.min(Math.max(filter.limit ?? 50, 1), 200)],
  );
  return rows.map((r) => ({
    id: r.id,
    companyId: r.company_id,
    channel: r.channel,
    scopeKey: r.scope_key,
    experimentId: r.experiment_id,
    verdict: r.verdict as LedgerRow["verdict"],
    relativeChange: r.relative_change === null ? null : Number(r.relative_change),
    items: r.items,
    minPerArm: r.min_per_arm,
    playbookDecision: r.playbook_decision as LedgerRow["playbookDecision"],
    decidedBy: r.decided_by,
    decidedAt: iso(r.decided_at),
    createdAt: iso(r.created_at),
  }));
}

export interface MetricInput {
  channel: string;
  subject: string;
  metric: string;
  window: string;
  value: number;
  source: (typeof METRIC_SOURCES)[number];
}

export function parseMetricInput(raw: Record<string, unknown>): MetricInput {
  if (typeof raw.value !== "number" || !Number.isFinite(raw.value)) throw new GrowthLedgerError("value must be a number");
  return {
    channel: str(raw.channel, "channel", 60),
    subject: scopeText(raw.subject ?? raw.scope, "subject"),
    metric: str(raw.metric, "metric", 80),
    window: str(raw.window, "window", 40),
    value: raw.value,
    source: oneOf(raw.source, METRIC_SOURCES, "source") ?? "tool",
  };
}

/** One number per company, channel, subject, metric and window: a second call for the same window replaces the value. */
export async function recordMetric(env: Env, companyId: string, input: MetricInput): Promise<void> {
  await env.ctx.db.execute(
    `INSERT INTO ${METRICS} (id, company_id, channel, subject, metric, "window", value, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (company_id, channel, subject, metric, "window")
     DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source, updated_at = now()`,
    [newId("gmet"), companyId, input.channel, input.subject, input.metric, input.window, input.value, input.source],
  );
}
