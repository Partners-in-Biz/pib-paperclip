/**
 * What the other modules say about one client, for the monthly report and the
 * health score (`client.signal`).
 *
 * The CRM cannot read another plugin's tables, so SEO, Social, Campaigns,
 * Billing and the Mailbox each announce a client's numbers as an event, the same
 * way they receive clients. The event name is `client.signal`; the module is
 * taken from the plugin that sent it, never from the payload, so a plugin cannot
 * write another module's section. The payload:
 *
 *   { clientKind: "company" | "contact", clientRef, period?: "YYYY-MM",
 *     headline?: [{ label, value, delta? }], bullets?: [text],
 *     health?: { score?: 0-100, overdueCount?, overdueMinor?, currency?, note? },
 *     note?, updatedAt? }
 *
 * `period` empty means the client's current state (the health inputs); a month
 * is that month's numbers for the report. Where a module does not send it yet,
 * the agent reads the module's own tools and records the same shape with
 * `record-client-signal`; the report says which module came from where.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { PIB_PLUGINS, pluginEvent } from "@partnersinbiz/pib-plugin-kit";
import { upsertSignal, type ClientKey, type SignalRow } from "./care-store.js";
import { asRecord } from "./db.js";
import { CrmError, type Viewer } from "./domain.js";
import { parseClientRef, requireClient } from "./lookup.js";
import { refOf, type ClientKind } from "./refs.js";

export const CLIENT_SIGNAL_EVENT = "client.signal";

/** Plugin id to the report module it speaks for. */
export const SIGNAL_SENDERS: Record<string, string> = {
  [PIB_PLUGINS.seo]: "seo",
  [PIB_PLUGINS.social]: "social",
  [PIB_PLUGINS.campaigns]: "campaigns",
  [PIB_PLUGINS.billing]: "billing",
  [PIB_PLUGINS.mailbox]: "mailbox",
};

/** The modules a report has a section for, in the order it shows them. */
export const REPORT_MODULES = ["seo", "social", "campaigns", "billing", "mailbox", "website"] as const;
export type ReportModule = (typeof REPORT_MODULES)[number];

export const MODULE_TITLES: Record<string, string> = {
  seo: "Search (SEO)",
  social: "Social media",
  campaigns: "Email campaigns",
  billing: "Billing",
  mailbox: "Email and support",
  website: "Website",
};

/** The tools an agent calls when a module has not sent its numbers, so the report is never silently thin. */
export const MODULE_TOOLS: Record<string, { plugin: string; tools: string[]; ask: string }> = {
  seo: { plugin: "partnersinbiz.seo", tools: ["get-sprint", "list-keywords", "keyword-history", "gsc-query", "audit-summary", "list-ga4-summary"], ask: "positions gained or lost, impressions and clicks against last month, tasks done, and the sprint health" },
  social: { plugin: "partnersinbiz.social", tools: ["list-posts", "account-analytics", "post-analytics", "performance-review"], ask: "posts published and their engagement, followers gained, the best post" },
  campaigns: { plugin: "partnersinbiz.campaigns", tools: ["list-campaigns", "campaign-stats"], ask: "emails sent, opens, clicks and replies for the campaigns that ran" },
  billing: { plugin: "partnersinbiz.billing", tools: ["list-open-invoices", "billing-report", "invoice-detail"], ask: "invoices sent and paid this month and what is overdue" },
  mailbox: { plugin: "partnersinbiz.mailbox", tools: ["list-threads", "mail-status"], ask: "how many messages they sent us and how fast we answered" },
};

const MAX_HEADLINE = 10;
const MAX_BULLETS = 8;

function clean(value: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex
  return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export interface SignalLine {
  label: string;
  value: string;
  delta?: string | null;
}

export interface SignalHealth {
  /** 0 to 100, 100 best (SEO sprint health). */
  score?: number;
  overdueCount?: number;
  overdueMinor?: number;
  currency?: string;
  note?: string;
}

export interface SignalPayload {
  headline: SignalLine[];
  bullets: string[];
  health?: SignalHealth;
  note?: string;
}

function intOrUndefined(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : undefined;
}

/** A well-formed signal body from untrusted input (an event or an agent), strings clamped, or null when it says nothing. */
export function parseSignalPayload(input: unknown): SignalPayload | null {
  const v = asRecord(input);
  const headline: SignalLine[] = (Array.isArray(v.headline) ? v.headline : [])
    .map(asRecord)
    .map((line) => ({ label: clean(line.label, 60), value: clean(line.value, 80), delta: clean(line.delta, 60) || null }))
    .filter((line) => line.label && line.value)
    .slice(0, MAX_HEADLINE);
  const bullets = (Array.isArray(v.bullets) ? v.bullets : []).map((item) => clean(item, 240)).filter(Boolean).slice(0, MAX_BULLETS);
  const h = asRecord(v.health);
  const health: SignalHealth = {};
  const score = intOrUndefined(h.score, 0, 100);
  if (score !== undefined) health.score = score;
  const overdueCount = intOrUndefined(h.overdueCount, 0, 100_000);
  if (overdueCount !== undefined) health.overdueCount = overdueCount;
  const overdueMinor = intOrUndefined(h.overdueMinor, 0, Number.MAX_SAFE_INTEGER);
  if (overdueMinor !== undefined) health.overdueMinor = overdueMinor;
  if (typeof h.currency === "string" && /^[A-Z]{3}$/.test(h.currency)) health.currency = h.currency;
  const healthNote = clean(h.note, 240);
  if (healthNote) health.note = healthNote;
  const note = clean(v.note, 400);
  const hasHealth = Object.keys(health).length > 0;
  if (headline.length === 0 && bullets.length === 0 && !hasHealth && !note) return null;
  return { headline, bullets, ...(hasHealth ? { health } : {}), ...(note ? { note } : {}) };
}

/** `YYYY-MM` or empty. */
export function periodOrEmpty(value: unknown): string | null {
  if (value == null || value === "") return "";
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : null;
}

export interface ParsedSignalEvent {
  client: ClientKey;
  period: string;
  payload: SignalPayload;
  signalAt: string;
}

export function asClientSignal(payload: unknown): ParsedSignalEvent | null {
  const v = asRecord(payload);
  const kind = v.clientKind === "company" || v.clientKind === "contact" ? (v.clientKind as ClientKind) : null;
  const ref = typeof v.clientRef === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v.clientRef) ? v.clientRef : null;
  const period = periodOrEmpty(v.period);
  const body = parseSignalPayload(v);
  if (!kind || !ref || period === null || !body) return null;
  const at = typeof v.updatedAt === "string" && Number.isFinite(Date.parse(v.updatedAt)) ? new Date(v.updatedAt).toISOString() : new Date().toISOString();
  return { client: { kind, id: ref }, period, payload: body, signalAt: at };
}

/** Subscribes to `client.signal` from each module that may send it (call once in setup). */
export function registerClientSignals(ctx: PluginContext): void {
  for (const [plugin, module] of Object.entries(SIGNAL_SENDERS)) {
    ctx.events.on(pluginEvent(plugin, CLIENT_SIGNAL_EVENT), async (event: PluginEvent) => {
      if (!event.companyId) return;
      try {
        await onClientSignal(ctx, event.companyId, module, event.payload);
      } catch (error) {
        ctx.logger.info("CRM client signal skipped", { module, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }
}

export async function onClientSignal(ctx: PluginContext, companyId: string, module: string, payload: unknown): Promise<boolean> {
  const parsed = asClientSignal(payload);
  if (!parsed) return false;
  return upsertSignal(ctx, { companyId, client: parsed.client, module, period: parsed.period, payload: parsed.payload as unknown as Record<string, unknown>, source: "event", recordedBy: pluginIdOf(module), signalAt: parsed.signalAt });
}

function pluginIdOf(module: string): string | null {
  return Object.entries(SIGNAL_SENDERS).find(([, value]) => value === module)?.[0] ?? null;
}

/** The agent tool: record what a module's own tools showed about one client, in the same shape a module would send. */
export async function recordClientSignalTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const client = parseClientRef(params.client);
  const name = await requireClient(ctx, viewer, client);
  const module = typeof params.module === "string" ? params.module : "";
  if (![...REPORT_MODULES, "other"].includes(module as ReportModule | "other")) throw new CrmError(`module must be one of ${[...REPORT_MODULES, "other"].join(", ")}`);
  const period = periodOrEmpty(params.period);
  if (period === null) throw new CrmError("period must be YYYY-MM (the month the numbers are for), or empty for the client's current state");
  const body = parseSignalPayload(params);
  if (!body) throw new CrmError("Send at least one headline line (label and value), a bullet, health figures or a note");
  const stored = await upsertSignal(ctx, {
    companyId: viewer.companyId,
    client,
    module,
    period,
    payload: body as unknown as Record<string, unknown>,
    source: "agent",
    recordedBy: viewer.agentId ? `agent:${viewer.agentId}` : viewer.userId ? `user:${viewer.userId}` : null,
    signalAt: new Date().toISOString(),
  });
  return {
    client: refOf(client.kind, client.id),
    name,
    module,
    period: period || "current",
    stored,
    next: period ? "Run build-client-report again so the report carries it." : "The health score reads it at its next run.",
  };
}

/** The signal body of one module for a month, falling back to nothing (a month's numbers are never a stand-in for another month's). */
export function signalFor(rows: SignalRow[], module: string, period: string): { payload: SignalPayload; source: "event" | "agent"; updatedAt: string | null } | null {
  const row = rows.find((item) => item.module === module && item.period === period);
  if (!row) return null;
  const parsed = parseSignalPayload(row.payload);
  return parsed ? { payload: parsed, source: row.source, updatedAt: row.updatedAt } : null;
}

/** The current-state signal of a module (`period` empty), for the health score. */
export function currentSignal(rows: SignalRow[], module: string): SignalPayload | null {
  return signalFor(rows, module, "")?.payload ?? null;
}
