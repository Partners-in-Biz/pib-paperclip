/**
 * What Setup hears back from the guarded plugins, and the re-sends (PAR-12578 plan, 4.2 and 4.4).
 *
 * Setup listens to the exact names `plugin.<id>.access.synced`, `.access.request`
 * and `.access.refusal` of each of the other 14 guarded plugins, never a wildcard.
 * Setup itself is the 15th: its guard reads its own tables, so it is always current.
 *
 * The plugin is the one named in the event; the host sets the event's company.
 * A payload that names another plugin or company is dropped.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { ACCESS_EVENTS, ACCESS_REFUSAL_EVENT, GUARDED_PLUGINS, configSaved, isAccessRev, pluginEvent, resolveAccess, type ActorInput } from "@partnersinbiz/pib-plugin-kit";
import { publishAccess } from "./access-publish.js";
import { getAccessSettings, listAccessSettings, listAccessSync, raiseAccessRev, recordAccessRefusal, recordAccessSync, type AccessSettings } from "./access-store.js";
import { PLUGIN_ID } from "./namespace.js";

/** The guarded plugins that confirm by event: all 15 but Setup. */
export const ACCESS_PEERS: readonly string[] = GUARDED_PLUGINS.filter((key) => key !== PLUGIN_ID);
/** The minute job re-sends for this long after the last change. */
export const ACCESS_RESEND_WINDOW_MS = 15 * 60_000;

type Clock = () => number;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The event's company and the plugin's `rev`, or null when the payload names another plugin or company. */
function readEvent(pluginKey: string, event: PluginEvent): { companyId: string; payload: Record<string, unknown> } | null {
  const companyId = str(event.companyId);
  const payload = (event.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>;
  if (!companyId) return null;
  if (payload.companyId !== undefined && payload.companyId !== companyId) return null;
  if (payload.pluginKey !== undefined && payload.pluginKey !== pluginKey) return null;
  return { companyId, payload };
}

/** Plugins confirm the current `rev`, or a higher one, to count as confirmed. */
export async function unconfirmedPlugins(ctx: PluginContext, companyId: string, rev: number): Promise<string[]> {
  const confirmed = new Map((await listAccessSync(ctx, companyId)).map((row) => [row.pluginKey, row.rev]));
  return ACCESS_PEERS.filter((key) => (confirmed.get(key) ?? -1) < rev);
}

/**
 * The plugin's `rev` against Setup's. Higher than Setup's: Setup raises its own
 * above it and sends. A company with no settings row is left alone here (the
 * switch-lost note is part 2). Returns true when it already sent.
 */
async function compareRev(ctx: PluginContext, settings: AccessSettings | null, companyId: string, pluginKey: string, rev: number, now: string): Promise<boolean> {
  if (!settings || rev <= settings.rev) return false;
  const raised = await raiseAccessRev(ctx, companyId, rev, now);
  ctx.logger.info("A plugin held a higher access rev; Setup raised its own", { companyId, pluginKey, reported: rev, rev: raised });
  await publishAccess(ctx, companyId);
  return true;
}

/** `access.synced { companyId, rev, pluginKey }`: record the confirmation. */
export async function onAccessSynced(ctx: PluginContext, pluginKey: string, event: PluginEvent, now: Clock = Date.now): Promise<void> {
  const read = readEvent(pluginKey, event);
  if (!read || !isAccessRev(read.payload.rev)) return;
  const at = new Date(now()).toISOString();
  await recordAccessSync(ctx, { companyId: read.companyId, pluginKey, rev: read.payload.rev, syncedAt: at });
  await compareRev(ctx, await getAccessSettings(ctx, read.companyId), read.companyId, pluginKey, read.payload.rev, at);
}

/**
 * `access.request { companyId, pluginKey, rev }`: answered at once from this
 * handler (the host allows an emit for the event's company, F35). A company with
 * no settings gets `off` at `rev` 0, so a plugin with no row stops asking.
 */
export async function onAccessRequest(ctx: PluginContext, pluginKey: string, event: PluginEvent, now: Clock = Date.now): Promise<void> {
  const read = readEvent(pluginKey, event);
  if (!read) return;
  const rev = isAccessRev(read.payload.rev) ? read.payload.rev : 0;
  const settings = await getAccessSettings(ctx, read.companyId);
  if (await compareRev(ctx, settings, read.companyId, pluginKey, rev, new Date(now()).toISOString())) return;
  await publishAccess(ctx, read.companyId);
}

/** `access.refusal`: kept in the company's last 500. */
export async function onAccessRefusal(ctx: PluginContext, pluginKey: string, event: PluginEvent, now: Clock = Date.now): Promise<void> {
  const read = readEvent(pluginKey, event);
  const key = str(read?.payload.key);
  if (!read || !key) return;
  const { payload } = read;
  await recordAccessRefusal(ctx, {
    companyId: read.companyId,
    pluginKey,
    userId: str(payload.userId),
    key,
    permission: str(payload.permission),
    viaAgentId: str(payload.viaAgentId),
    createdAt: new Date(now()).toISOString(),
  });
}

export function registerAccessSync(ctx: PluginContext): void {
  const handlers = [
    [ACCESS_EVENTS.synced, onAccessSynced],
    [ACCESS_EVENTS.request, onAccessRequest],
    [ACCESS_REFUSAL_EVENT, onAccessRefusal],
  ] as const;
  for (const pluginKey of ACCESS_PEERS) {
    for (const [name, handle] of handlers) {
      ctx.events.on(pluginEvent(pluginKey, name), async (event) => {
        try {
          await handle(ctx, pluginKey, event);
        } catch (error) {
          ctx.logger.info("Access event failed", { pluginKey, name, error: errorText(error) });
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Re-sends

export type ResendResult = { sent: number; skipped: number; failed: number };

/**
 * Sends each chosen company's whole state again. A job may emit only for a
 * company whose Setup settings are saved (F34); the others are counted as skipped.
 */
async function resend(ctx: PluginContext, pick: (row: AccessSettings) => Promise<boolean>): Promise<ResendResult> {
  const result: ResendResult = { sent: 0, skipped: 0, failed: 0 };
  for (const row of await listAccessSettings(ctx)) {
    try {
      if (!(await pick(row))) continue;
      if (!(await configSaved(ctx, row.companyId))) {
        result.skipped += 1;
        continue;
      }
      await publishAccess(ctx, row.companyId);
      result.sent += 1;
    } catch (error) {
      result.failed += 1;
      ctx.logger.info("Access re-send failed", { companyId: row.companyId, error: errorText(error) });
    }
  }
  return result;
}

const anyUnconfirmed = async (ctx: PluginContext, row: AccessSettings) => (await unconfirmedPlugins(ctx, row.companyId, row.rev)).length > 0;

/** Every minute: a company changed less than 15 minutes ago that a plugin has not confirmed yet. */
export function resendRecentAccess(ctx: PluginContext, now: Clock = Date.now): Promise<ResendResult> {
  return resend(ctx, async (row) => now() - Date.parse(row.updatedAt) < ACCESS_RESEND_WINDOW_MS && (await anyUnconfirmed(ctx, row)));
}

/** Every hour: every company not on `off`, and a company on `off` until every plugin confirmed it. */
export function resendAccessHourly(ctx: PluginContext): Promise<ResendResult> {
  return resend(ctx, async (row) => row.mode !== "off" || (await anyUnconfirmed(ctx, row)));
}

/** Once at worker start: every company Setup holds settings for. */
export function resendAllAccess(ctx: PluginContext): Promise<ResendResult> {
  return resend(ctx, async () => true);
}

/** The "Send again" action: an owner or admin of the company sends its state now. */
export async function sendAccessAgain(ctx: PluginContext, companyId: string, actor: ActorInput): Promise<{ ok: true; rev: number; parts: number } | { ok: false; error: string }> {
  const access = await resolveAccess(ctx, companyId, actor?.type === "user" ? actor : null);
  if (!access.bypass || !access.userId) return { ok: false, error: "Only a company owner or admin can send access again" };
  try {
    return { ok: true, ...(await publishAccess(ctx, companyId)) };
  } catch (error) {
    ctx.logger.info("Access send again failed", { companyId, error: errorText(error) });
    return { ok: false, error: "Could not send access to the other plugins. Try again in a minute" };
  }
}
