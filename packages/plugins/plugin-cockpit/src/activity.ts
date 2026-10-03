/**
 * What the Cockpit records itself for "What the agents did": hand-offs from
 * other plugins (a won deal, a paid invoice), onboarding it opened, questions
 * the owner answered. One row per key, so a re-sent event never doubles a
 * line. The Cockpit's own snapshot shows the newest ones.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ActivityItem } from "@partnersinbiz/pib-plugin-kit";
import { NAMESPACE } from "./namespace.js";

const TABLE = `${NAMESPACE}.activity`;

export type ActivityKind = "acceptance" | "deal_won" | "invoice_paid" | "onboarding" | "ask_answered" | "ask_refused" | "ask_effect" | "improvement" | "closeout" | "business_review" | "credential" | "goal";

export interface ActivityRow {
  key: string;
  kind: ActivityKind;
  at: string;
  text: string;
  href: string | null;
  agentId: string | null;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
}

/** Records one line (idempotent by key). True when it was new. */
export async function recordActivity(ctx: PluginContext, companyId: string, row: ActivityRow): Promise<boolean> {
  const result = await ctx.db.execute(
    `INSERT INTO ${TABLE} (company_id, key, kind, at, text, href, agent_id) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (company_id, key) DO NOTHING`,
    [companyId, row.key.slice(0, 300), row.kind, iso(row.at), row.text.slice(0, 300), row.href, row.agentId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** The newest lines, newest first. */
export async function recentActivity(ctx: PluginContext, companyId: string, limit = 10): Promise<ActivityRow[]> {
  const rows = await ctx.db.query<Record<string, unknown>>(
    `SELECT key, kind, at, text, href, agent_id FROM ${TABLE} WHERE company_id = $1 ORDER BY at DESC LIMIT $2`,
    [companyId, Math.max(1, Math.min(50, limit))],
  );
  return rows.map((row) => ({
    key: String(row.key),
    kind: String(row.kind) as ActivityKind,
    at: iso(row.at),
    text: String(row.text ?? ""),
    href: row.href == null ? null : String(row.href),
    agentId: row.agent_id == null ? null : String(row.agent_id),
  }));
}

/** How many lines of one kind since a time (for health checks). */
export async function countActivitySince(ctx: PluginContext, companyId: string, kind: ActivityKind, since: string): Promise<number> {
  const rows = await ctx.db.query<{ key: string }>(`SELECT key FROM ${TABLE} WHERE company_id = $1 AND kind = $2 AND at >= $3 LIMIT 100`, [companyId, kind, since]);
  return rows.length;
}

export function toActivityItems(rows: ActivityRow[]): ActivityItem[] {
  return rows.map((row) => ({ at: row.at, text: row.text, href: row.href, agentId: row.agentId }));
}

/** `R 12,345.67` (ZAR) or `USD 12.00`: the money format every PiB page uses (worker side, no React). */
export function formatAmount(minor: number, currency = "ZAR"): string {
  if (!Number.isFinite(minor)) return "–";
  const symbols: Record<string, string> = { ZAR: "R ", USD: "$", EUR: "€", GBP: "£" };
  const text = (Math.abs(minor) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const symbol = symbols[currency.toUpperCase()] ?? `${currency.toUpperCase()} `;
  return `${minor < 0 ? "-" : ""}${symbol}${text}`;
}
