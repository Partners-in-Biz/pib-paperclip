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
 * - Before `enforce`, the owner confirms the people who would have no access at
 *   all, each with the runs that worked for him in the last 30 days (plan, 4.3).
 *   A list that grew since he saw it is shown again; a grant change in between
 *   moves the `rev`, so the write is refused.
 * - The change is written to the activity log in the shape of the kit's grant
 *   `audit` (entity `plugin_access`, `changedBy`, `before`, `after`). The kit's
 *   `audit` and `undoAfterFailedAudit` take a grant, not a mode, and the kit is
 *   closed after A1, so the switch keeps their rules here: when the entry cannot
 *   be written, the mode is put back (one retry) and the change is refused.
 * - After a kept change the whole state is sent; a failed send is repaired by the
 *   re-send jobs.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { LOCAL_BOARD_USER_ID, PRESETS, configSaved, isAccessMode, loadGrant, resolveAccess, type AccessGrant, type AccessMode, type ActorInput } from "@partnersinbiz/pib-plugin-kit";
import { publishAccess } from "./access-publish.js";
import { getAccessSettings, revertAccessMode, setAccessMode, setAccessModeAt } from "./access-store.js";
import { unconfirmedPlugins } from "./access-sync.js";

/** A member who would have no access at all under `enforce`. `runsLast30Days` is null when the runs could not be read. */
export interface NoAccessPerson {
  userId: string;
  role: string;
  runsLast30Days: number | null;
}

export type SetAccessModeResult =
  | { ok: true; mode: AccessMode; rev: number; changed: boolean; sent: boolean }
  | { ok: false; error: string; unconfirmed?: string[]; noAccess?: NoAccessPerson[] };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const SWITCH_REFUSALS = {
  notAdmin: "Only a company owner or admin can change the access switch",
  noSettings: "Save this company's Setup settings first. Access can only leave off for a company with saved Setup settings",
  unconfirmed: "Every guarded plugin must confirm the current access before enforce. Send again and wait a minute",
  confirmNoAccess: "These people would have no access at all under enforce. Check the list and confirm it to switch on",
  noMembers: "Could not read the members and their access, so enforce was not saved. Try again",
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

// ---------------------------------------------------------------------------
// The confirm list before `enforce`

export const NO_ACCESS_RUN_DAYS = 30;

/**
 * Runs that worked for each person: runs of the company with that responsible
 * person that ended `succeeded`, created in the window. Uses the core index on
 * (company_id, responsible_user_id, created_at). Needs the runs table in
 * Setup's `database.coreReadTables` (A3, plan 4.9). It returns counts only, no
 * run context; the kit test `access-heartbeat-runs.spec.ts` pins this exact
 * text as the one query on that table outside the kit (plan 4.3 against 9).
 */
export const RUNS_WORKED_SQL = `SELECT responsible_user_id, COUNT(*)::int AS runs
  FROM public.heartbeat_runs
 WHERE company_id = $1
   AND responsible_user_id IN (SELECT jsonb_array_elements_text($2::jsonb))
   AND status = 'succeeded'
   AND created_at >= $3
 GROUP BY responsible_user_id`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the grant opens nothing: no grant, or every key of its preset and allow list is denied. */
function grantsNothing(grant: AccessGrant | null): boolean {
  if (!grant) return true;
  const deny = new Set(grant.deny);
  return [...(grant.preset ? PRESETS[grant.preset].permissions : []), ...grant.allow].every((key) => deny.has(key));
}

/** Count per person, or null when the runs cannot be read (the list still names everyone). */
async function runsWorked(ctx: PluginContext, companyId: string, userIds: string[], now: number): Promise<Map<string, number> | null> {
  // Core company ids are UUIDs: any other id has no runs, and would make the query fail on the cast.
  if (!userIds.length || !UUID.test(companyId)) return new Map();
  const since = new Date(now - NO_ACCESS_RUN_DAYS * 86_400_000).toISOString();
  try {
    const rows = await ctx.db.query<{ responsible_user_id: string; runs: number }>(RUNS_WORKED_SQL, [companyId, JSON.stringify(userIds), since]);
    return new Map(rows.map((row) => [String(row.responsible_user_id), Number(row.runs)]));
  } catch (error) {
    ctx.logger.info("Could not count the runs for the enforce confirm list", { companyId, error: errorText(error) });
    return null;
  }
}

/**
 * The active human members who would have no access at all under `enforce`:
 * not an owner or admin, and no grant that opens anything. Throws when the
 * members or a grant cannot be read.
 */
export async function noAccessPeople(ctx: PluginContext, companyId: string, now: number = Date.now()): Promise<NoAccessPerson[]> {
  const members = await ctx.access.members.list({ companyId });
  const people = new Map<string, string>();
  for (const m of members) {
    if (m.principalType !== "user" || m.status !== "active" || m.principalId === LOCAL_BOARD_USER_ID) continue;
    const role = m.membershipRole ?? "member";
    if (role === "owner" || role === "admin" || people.has(m.principalId)) continue;
    if (grantsNothing(await loadGrant(ctx, companyId, m.principalId))) people.set(m.principalId, role);
  }
  const ids = [...people.keys()].sort();
  const runs = await runsWorked(ctx, companyId, ids, now);
  return ids.map((userId) => ({ userId, role: people.get(userId)!, runsLast30Days: runs ? (runs.get(userId) ?? 0) : null }));
}

const idList = (value: unknown) => new Set(Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : []);

/** The `setup.access.set-mode` action. `confirmNoAccess` lists the people the owner saw on the confirm list. */
export async function setAccessSwitch(
  ctx: PluginContext,
  action: { companyId?: string | null; actor?: ActorInput },
  rawMode: unknown,
  confirmNoAccess?: unknown,
): Promise<SetAccessModeResult> {
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
        let noAccess: NoAccessPerson[];
        try {
          noAccess = await noAccessPeople(ctx, companyId);
        } catch (error) {
          ctx.logger.info("Could not build the enforce confirm list", { companyId, error: errorText(error) });
          return { ok: false, error: SWITCH_REFUSALS.noMembers };
        }
        const seen = idList(confirmNoAccess);
        if (noAccess.some((person) => !seen.has(person.userId))) return { ok: false, error: SWITCH_REFUSALS.confirmNoAccess, noAccess };
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
