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
import {
  claimAccessLostNote,
  claimAccessRedNote,
  getAccessSettings,
  listAccessSettings,
  listAccessSync,
  raiseAccessRev,
  recordAccessLost,
  recordAccessRefusal,
  recordAccessSync,
  releaseAccessLostNote,
  releaseAccessRedNote,
  type AccessSettings,
} from "./access-store.js";
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
 * above it and sends. A `rev` above 0 for a company with no settings row: the
 * switch is lost (one activity entry), and Setup does not invent a mode.
 * Returns true when it already sent.
 */
async function compareRev(ctx: PluginContext, settings: AccessSettings | null, companyId: string, pluginKey: string, rev: number, now: string): Promise<boolean> {
  if (!settings) {
    if (rev > 0) await noteSwitchLost(ctx, companyId, pluginKey, rev, now);
    return false;
  }
  if (rev <= settings.rev) return false;
  const raised = await raiseAccessRev(ctx, companyId, rev, now);
  ctx.logger.info("A plugin held a higher access rev; Setup raised its own", { companyId, pluginKey, reported: rev, rev: raised });
  await publishAccess(ctx, companyId);
  return true;
}

async function noteSwitchLost(ctx: PluginContext, companyId: string, pluginKey: string, rev: number, now: string): Promise<void> {
  await recordAccessLost(ctx, companyId, pluginKey, rev, now);
  if (!(await claimAccessLostNote(ctx, companyId, now))) return;
  try {
    await ctx.activity.log({
      companyId,
      message: "Access switch lost: Setup has no access settings for this company but a plugin still holds some. Choose the switch again in Setup under People",
      entityType: "plugin_access",
      entityId: companyId,
      metadata: { pluginKey, rev },
    });
  } catch (error) {
    await releaseAccessLostNote(ctx, companyId);
    ctx.logger.info("Could not write the switch-lost activity entry", { companyId, error: errorText(error) });
  }
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

// ---------------------------------------------------------------------------
// While on `enforce`: a plugin behind for more than 15 minutes is red (plan, 4.3)

/** On `enforce`, a plugin that has not confirmed the current `rev` for longer than this is red. */
export const ACCESS_RED_AFTER_MS = 15 * 60_000;

export interface AccessPluginStatus {
  pluginKey: string;
  /** The highest `rev` it confirmed, or null when it never reported. */
  rev: number | null;
  syncedAt: string | null;
  confirmed: boolean;
  red: boolean;
}

/**
 * All 15 guarded plugins against the company's current `rev`. The time behind is
 * counted from the settings row's `updated_at`, which is at or after the change
 * that made the current `rev`, so a plugin turns red late, never early.
 */
export async function accessPluginStatus(ctx: PluginContext, settings: AccessSettings | null, companyId: string, now: Clock = Date.now): Promise<AccessPluginStatus[]> {
  const rev = settings?.rev ?? 0;
  const rows = new Map((await listAccessSync(ctx, companyId)).map((row) => [row.pluginKey, row]));
  const late = settings?.mode === "enforce" && now() - Date.parse(settings.updatedAt) > ACCESS_RED_AFTER_MS;
  return GUARDED_PLUGINS.map((pluginKey) => {
    // Setup reads its own tables, so it is always current.
    if (pluginKey === PLUGIN_ID) return { pluginKey, rev, syncedAt: settings?.updatedAt ?? null, confirmed: true, red: false };
    const row = rows.get(pluginKey);
    const confirmed = row !== undefined && row.rev >= rev;
    return { pluginKey, rev: row?.rev ?? null, syncedAt: row?.syncedAt ?? null, confirmed, red: late && !confirmed };
  });
}

/** The People screen's switch state: mode, `rev` and the 15 plugins with their red flag. Owner or admin only. */
export async function accessStatus(ctx: PluginContext, companyId: string, actor: ActorInput, now: Clock = Date.now) {
  const access = await resolveAccess(ctx, companyId, actor?.type === "user" ? actor : null);
  if (!access.bypass || !access.userId) return { ok: false as const, error: "Only a company owner or admin can see the access switch" };
  const settings = await getAccessSettings(ctx, companyId);
  return { ok: true as const, mode: settings?.mode ?? "off", rev: settings?.rev ?? 0, plugins: await accessPluginStatus(ctx, settings, companyId, now) };
}

export type RedNoteResult = { noted: number; failed: number };

/**
 * Hourly: for every company on `enforce`, one activity entry per day (UTC) for
 * each red plugin. That is the only notice of a plugin that lost its row and
 * cannot get it back. Two runs at once write one entry: the day is claimed first.
 */
export async function noteRedPlugins(ctx: PluginContext, now: Clock = Date.now): Promise<RedNoteResult> {
  const result: RedNoteResult = { noted: 0, failed: 0 };
  const day = new Date(now()).toISOString().slice(0, 10);
  for (const row of await listAccessSettings(ctx)) {
    if (row.mode !== "enforce") continue;
    let red: AccessPluginStatus[];
    try {
      red = (await accessPluginStatus(ctx, row, row.companyId, now)).filter((plugin) => plugin.red);
    } catch (error) {
      result.failed += 1;
      ctx.logger.info("Could not check the access confirmations", { companyId: row.companyId, error: errorText(error) });
      continue;
    }
    for (const plugin of red) {
      try {
        if (!(await claimAccessRedNote(ctx, row.companyId, plugin.pluginKey, day))) continue;
      } catch (error) {
        result.failed += 1;
        ctx.logger.info("Could not claim the red-plugin note", { companyId: row.companyId, pluginKey: plugin.pluginKey, error: errorText(error) });
        continue;
      }
      try {
        await ctx.activity.log({
          companyId: row.companyId,
          message: `Access: ${plugin.pluginKey} has not confirmed the current access (rev ${row.rev}) for more than 15 minutes while this company is on enforce. It may be working on old access. Use Send again in Setup under People; if it stays red, follow the access way-out runbook in packages/plugins/DEPLOY.md`,
          entityType: "plugin_access",
          entityId: row.companyId,
          metadata: { pluginKey: plugin.pluginKey, rev: row.rev, confirmedRev: plugin.rev, since: row.updatedAt },
        });
        result.noted += 1;
      } catch (error) {
        result.failed += 1;
        ctx.logger.info("Could not write the red-plugin activity entry", { companyId: row.companyId, pluginKey: plugin.pluginKey, error: errorText(error) });
        await releaseAccessRedNote(ctx, row.companyId, plugin.pluginKey, day).catch(() => undefined);
      }
    }
  }
  return result;
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
