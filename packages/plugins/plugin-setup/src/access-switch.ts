/**
 * The access switch in Setup, the one source (PAR-12578 plan, 4.1 and 4.3).
 *
 * - Owner or admin only (the `ADMIN_ONLY` entry of Setup's guard table). Agents
 *   and the system never change it.
 * - `off` is always allowed.
 * - `report` and `enforce` need saved Setup settings for the company: the re-send
 *   jobs may only emit for such a company (F34).
 * - `enforce` needs every one of the 15 `GUARDED_PLUGINS` to have confirmed the
 *   current `rev`. Setup is the 15th and reads its own tables, so the other 14 are
 *   checked against `access_sync`; one that never reported counts as unconfirmed.
 *   The write is made only while the `rev` is still the one checked.
 * - The change is written to the activity log in the shape of the kit's grant
 *   `audit` (entity `plugin_access`, `changedBy`, `before`, `after`). The kit's
 *   `audit` and `undoAfterFailedAudit` take a grant, not a mode, and the kit is
 *   closed after A1, so the switch keeps their rules here: when the entry cannot
 *   be written, the mode is put back (one retry) and the change is refused.
 * - After a kept change the whole state is sent; a failed send is repaired by the
 *   re-send jobs.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { configSaved, isAccessMode, resolveAccess, type AccessMode, type ActorInput } from "@partnersinbiz/pib-plugin-kit";
import { publishAccess } from "./access-publish.js";
import { getAccessSettings, revertAccessMode, setAccessMode, setAccessModeAt } from "./access-store.js";
import { unconfirmedPlugins } from "./access-sync.js";

export type SetAccessModeResult =
  | { ok: true; mode: AccessMode; rev: number; changed: boolean; sent: boolean }
  | { ok: false; error: string; unconfirmed?: string[] };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const SWITCH_REFUSALS = {
  notAdmin: "Only a company owner or admin can change the access switch",
  noSettings: "Save this company's Setup settings first. Access can only leave off for a company with saved Setup settings",
  unconfirmed: "Every guarded plugin must confirm the current access before enforce. Send again and wait a minute",
  moved: "Access changed while you were saving. Check it and try again",
  notSaved: "Could not record the change in the audit log, so it was not saved",
  notUndone: "The switch was changed but could not be recorded in the audit log, and it could not be undone. Check the switch and try again",
} as const;

async function auditSwitch(ctx: PluginContext, companyId: string, by: string, before: AccessMode, after: AccessMode, rev: number): Promise<boolean> {
  try {
    await ctx.activity.log({
      companyId,
      message: `Access switch changed from ${before} to ${after}`,
      entityType: "plugin_access",
      entityId: companyId,
      metadata: { changedBy: by, before: { mode: before }, after: { mode: after }, rev },
    });
    return true;
  } catch (error) {
    ctx.logger.info("Could not write the access switch audit entry", { companyId, error: errorText(error) });
    return false;
  }
}

/** Puts the mode back after a failed audit write, retrying once. Returns the refusal text. */
async function undoSwitch(ctx: PluginContext, companyId: string, by: string, from: AccessMode, to: AccessMode): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Not written when the mode is no longer `from`: a later change replaced this one.
      await revertAccessMode(ctx, companyId, from, to, by, new Date().toISOString());
      // A plugin may have been sent the unaudited mode by an answer to its ask in between.
      await send(ctx, companyId);
      return SWITCH_REFUSALS.notSaved;
    } catch (error) {
      ctx.logger.error("Could not restore the access switch after a failed audit write", { companyId, error: errorText(error), attempt });
    }
  }
  return SWITCH_REFUSALS.notUndone;
}

async function send(ctx: PluginContext, companyId: string): Promise<boolean> {
  try {
    await publishAccess(ctx, companyId);
    return true;
  } catch (error) {
    ctx.logger.info("Access send failed", { companyId, error: errorText(error) });
    return false;
  }
}

/** The `setup.access.set-mode` action. */
export async function setAccessSwitch(ctx: PluginContext, action: { companyId?: string | null; actor?: ActorInput }, rawMode: unknown): Promise<SetAccessModeResult> {
  const companyId = typeof action.companyId === "string" ? action.companyId.trim() : "";
  if (!companyId) return { ok: false, error: "A company is required" };
  if (!isAccessMode(rawMode)) return { ok: false, error: "The switch is off, report or enforce" };
  const mode = rawMode;
  const access = await resolveAccess(ctx, companyId, action.actor?.type === "user" ? action.actor : null);
  if (!access.bypass || !access.userId) return { ok: false, error: SWITCH_REFUSALS.notAdmin };
  const by = access.userId;

  let current: { mode: AccessMode; rev: number };
  try {
    const row = await getAccessSettings(ctx, companyId);
    current = { mode: row?.mode ?? "off", rev: row?.rev ?? 0 };
  } catch (error) {
    ctx.logger.info("Could not read the access switch", { companyId, error: errorText(error) });
    return { ok: false, error: "Could not read the access switch. Try again" };
  }
  if (current.mode === mode) return { ok: true, mode, rev: current.rev, changed: false, sent: false };

  let rev: number | null;
  try {
    if (mode === "off") {
      rev = await setAccessMode(ctx, companyId, mode, by, new Date().toISOString());
    } else {
      if (!(await configSaved(ctx, companyId))) return { ok: false, error: SWITCH_REFUSALS.noSettings };
      if (mode === "enforce") {
        const unconfirmed = await unconfirmedPlugins(ctx, companyId, current.rev);
        if (unconfirmed.length) return { ok: false, error: `${SWITCH_REFUSALS.unconfirmed}. Not confirmed: ${unconfirmed.join(", ")}`, unconfirmed };
      }
      rev = await setAccessModeAt(ctx, companyId, mode, current.rev, by, new Date().toISOString());
      if (rev === null) return { ok: false, error: SWITCH_REFUSALS.moved };
    }
  } catch (error) {
    ctx.logger.info("Could not change the access switch", { companyId, mode, error: errorText(error) });
    return { ok: false, error: "Could not change the access switch. Try again" };
  }

  if (!(await auditSwitch(ctx, companyId, by, current.mode, mode, rev))) {
    return { ok: false, error: await undoSwitch(ctx, companyId, by, mode, current.mode) };
  }
  return { ok: true, mode, rev, changed: true, sent: await send(ctx, companyId) };
}
