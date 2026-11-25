/**
 * The per-company access switch as one plugin holds it (PAR-12578 plan, 4.2 and 4.3).
 *
 * Setup is the source. Each guarded plugin keeps a copy of the company row in its
 * own state (written by `registerAccessReceiver`) and reads it here on every
 * guarded call. When the copy is missing or stale, the plugin asks Setup again
 * with `access.request`, at most once a minute per company.
 *
 * | stored row        | mode      | the guard ...                              |
 * |-------------------|-----------|--------------------------------------------|
 * | absent            | `off`     | passes everything and asks Setup           |
 * | `off`             | `off`     | passes everything, no further host calls   |
 * | `report`          | `report`  | decides, lets the call through, reports    |
 * | `enforce`         | `enforce` | decides and refuses                        |
 * | read throws       | `enforce` | decides and refuses (fail closed)          |
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";

export const ACCESS_MODES = ["off", "report", "enforce"] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

/** Event names. Setup emits `updated`; each guarded plugin emits `synced` and `request`. */
export const ACCESS_EVENTS = {
  /** Setup -> plugins: `{ companyId, rev, mode, userIds, part, parts, grants }`. */
  updated: "access.updated",
  /** Plugin -> Setup: `{ companyId, rev, pluginKey }` after a receive (or a re-send of the stored `rev`). */
  synced: "access.synced",
  /** Plugin -> Setup: `{ companyId, pluginKey, rev }` when the plugin has no row or a stale one. */
  request: "access.request",
} as const;

/** The plugin's copy of Setup's company row. Written last by the receiver. */
export interface AccessCompanyRow {
  mode: AccessMode;
  rev: number;
  userIds: string[];
  receivedAt: string;
}

export const ACCESS_NAMESPACE = "access";
export const accessCompanyScope = (companyId: string) => ({
  scopeKind: "company" as const,
  scopeId: companyId,
  namespace: ACCESS_NAMESPACE,
  stateKey: "company",
});

/** A stored row older than this, under `report` or `enforce`, makes the plugin ask again. */
export const ACCESS_STALE_MS = 10 * 60_000;
/** At most one `access.request` per company in this window. */
export const ACCESS_ASK_INTERVAL_MS = 60_000;
const MAX_ASK_ENTRIES = 5_000;

export const isAccessMode = (v: unknown): v is AccessMode => typeof v === "string" && (ACCESS_MODES as readonly string[]).includes(v);
export const isAccessRev = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * Reads a stored row. `null` means none was ever stored. Anything else that is not
 * a valid row is `"invalid"`: the switch fails closed on it and the receiver
 * overwrites it with the next payload.
 */
export function parseAccessRow(raw: unknown): AccessCompanyRow | null | "invalid" {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  const r = raw as Partial<AccessCompanyRow>;
  if (!isAccessMode(r.mode) || !isAccessRev(r.rev)) return "invalid";
  return {
    mode: r.mode,
    rev: r.rev,
    userIds: Array.isArray(r.userIds) ? r.userIds.filter((x): x is string => typeof x === "string" && x.length > 0) : [],
    receivedAt: typeof r.receivedAt === "string" ? r.receivedAt : "",
  };
}

export interface AccessSwitchState {
  /** What the guard does: `off` passes everything. */
  mode: AccessMode;
  /** Where the mode came from. `absent` and `read-failed` have no row. */
  source: "row" | "absent" | "invalid" | "read-failed";
  row: AccessCompanyRow | null;
  /** True when this read sent an `access.request`. */
  asked: boolean;
}

export interface AccessSwitchOptions {
  /** Clock, for tests. */
  now?: () => number;
}

// Last ask per company, per plugin context (so two harnesses in one test file do not share it).
const lastAsk = new WeakMap<PluginContext, Map<string, number>>();

function askAllowed(ctx: PluginContext, companyId: string, now: number): boolean {
  let asks = lastAsk.get(ctx);
  if (!asks) lastAsk.set(ctx, (asks = new Map()));
  const last = asks.get(companyId);
  if (last !== undefined && now - last < ACCESS_ASK_INTERVAL_MS) return false;
  // Recorded before the emit, so two calls in flight together send one ask.
  asks.delete(companyId);
  asks.set(companyId, now);
  if (asks.size > MAX_ASK_ENTRIES) asks.delete(asks.keys().next().value as string);
  return true;
}

/** Sends `access.request` unless one went out for this company in the last minute. Never throws. */
export async function askForAccess(
  ctx: PluginContext,
  companyId: string,
  pluginKey: string,
  storedRev: number,
  options: AccessSwitchOptions = {},
): Promise<boolean> {
  const now = (options.now ?? Date.now)();
  if (!askAllowed(ctx, companyId, now)) return false;
  try {
    await ctx.events.emit(ACCESS_EVENTS.request, companyId, { companyId, pluginKey, rev: storedRev });
  } catch (error) {
    ctx.logger.info("Access request to Setup failed", { companyId, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}

function isStale(row: AccessCompanyRow, now: number): boolean {
  const at = Date.parse(row.receivedAt);
  return !Number.isFinite(at) || now - at > ACCESS_STALE_MS;
}

/**
 * The switch for one guarded call. Exactly one state read; under a stored `off`
 * nothing else. Asks Setup (once a minute at most) when there is no row, the row
 * is unreadable, or the row is `report` / `enforce` and older than 10 minutes.
 * Call it only inside a call from the host (action, route, tool, event): the host
 * refuses a company-scoped emit from start-up for most companies (plan F34).
 */
export async function readAccessSwitch(
  ctx: PluginContext,
  companyId: string,
  pluginKey: string,
  options: AccessSwitchOptions = {},
): Promise<AccessSwitchState> {
  let raw: unknown;
  try {
    raw = await ctx.state.get(accessCompanyScope(companyId));
  } catch (error) {
    ctx.logger.info("Access switch read failed; treating as enforce", { companyId, error: error instanceof Error ? error.message : String(error) });
    return { mode: "enforce", source: "read-failed", row: null, asked: false };
  }
  const row = parseAccessRow(raw);
  if (row === null) {
    const asked = await askForAccess(ctx, companyId, pluginKey, 0, options);
    return { mode: "off", source: "absent", row: null, asked };
  }
  if (row === "invalid") {
    const asked = await askForAccess(ctx, companyId, pluginKey, 0, options);
    return { mode: "enforce", source: "invalid", row: null, asked };
  }
  if (row.mode === "off") return { mode: "off", source: "row", row, asked: false };
  const now = (options.now ?? Date.now)();
  const asked = isStale(row, now) ? await askForAccess(ctx, companyId, pluginKey, row.rev, options) : false;
  return { mode: row.mode, source: "row", row, asked };
}
