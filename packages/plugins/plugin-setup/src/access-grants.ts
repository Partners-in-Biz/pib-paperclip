/**
 * Saving and clearing one person's grant in Setup, the one source (PAR-12578 plan, 4.1).
 *
 * The grant itself goes through the kit's unchanged `saveGrant` / `clearGrant`
 * (validation, audit, undo after a failed audit). Around it:
 * - save: the id joins `granted_user_ids` first, the grant is saved, then `rev` + 1;
 * - clear: the grant is removed first, then the id leaves the list with `rev` + 1.
 * An id on the list with no grant is harmless (the payload skips it), so no undo
 * is needed between the writes. `rev` goes up only after the grant write, so a
 * payload with the new `rev` always carries the new grant (access-publish.ts).
 * Then the whole state is sent; a send that fails is repaired by the re-sends.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { clearGrant, resolveAccess, saveGrant, type ActorInput, type AccessGrant, type SaveGrantInput } from "@partnersinbiz/pib-plugin-kit";
import { addGrantedUser, bumpAccessRev, removeGrantedUser } from "./access-store.js";
import { publishAccess } from "./access-publish.js";

type ActionInput = { companyId?: string | null; actor?: ActorInput };
export type AccessChangeResult = { ok: true; grant: AccessGrant | null; rev: number; sent: boolean } | { ok: false; error: string };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const trimmed = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The acting owner or admin, checked before Setup writes its own list. */
async function admin(ctx: PluginContext, companyId: string, actor: ActorInput): Promise<string | null> {
  const access = await resolveAccess(ctx, companyId, actor?.type === "user" ? actor : null);
  return access.bypass && access.userId ? access.userId : null;
}

async function send(ctx: PluginContext, companyId: string): Promise<boolean> {
  try {
    await publishAccess(ctx, companyId);
    return true;
  } catch (error) {
    // The re-send jobs send the same whole state again.
    ctx.logger.info("Access send failed", { companyId, error: errorText(error) });
    return false;
  }
}

export async function saveAccessGrant(ctx: PluginContext, action: ActionInput, input: SaveGrantInput): Promise<AccessChangeResult> {
  const companyId = trimmed(action.companyId);
  const userId = trimmed(input?.userId);
  if (!companyId) return { ok: false, error: "A company is required" };
  if (!userId) return { ok: false, error: "Choose a person" };
  const by = await admin(ctx, companyId, action.actor);
  if (!by) return { ok: false, error: "Only a company owner or admin can manage access" };
  try {
    await addGrantedUser(ctx, companyId, userId, by, new Date().toISOString());
  } catch (error) {
    ctx.logger.info("Could not add the person to the access list", { companyId, error: errorText(error) });
    return { ok: false, error: "Could not save access" };
  }
  const saved = await saveGrant(ctx, { companyId, actor: action.actor }, { ...input, userId });
  if (!saved.ok) return saved;
  let rev: number;
  try {
    rev = await bumpAccessRev(ctx, companyId, by, new Date().toISOString());
  } catch (error) {
    ctx.logger.error("Access saved but its revision was not raised", { companyId, error: errorText(error) });
    return { ok: false, error: "Access was saved but not sent to the other plugins. Save it again" };
  }
  return { ok: true, grant: saved.grant, rev, sent: await send(ctx, companyId) };
}

export async function clearAccessGrant(ctx: PluginContext, action: ActionInput, rawUserId: string): Promise<AccessChangeResult> {
  const companyId = trimmed(action.companyId);
  const userId = trimmed(rawUserId);
  if (!companyId) return { ok: false, error: "A company is required" };
  if (!userId) return { ok: false, error: "Choose a person" };
  const by = await admin(ctx, companyId, action.actor);
  if (!by) return { ok: false, error: "Only a company owner or admin can manage access" };
  const cleared = await clearGrant(ctx, { companyId, actor: action.actor }, userId);
  if (!cleared.ok) return cleared;
  let rev: number;
  try {
    rev = await removeGrantedUser(ctx, companyId, userId, by, new Date().toISOString());
  } catch (error) {
    ctx.logger.error("Access removed but its revision was not raised", { companyId, error: errorText(error) });
    return { ok: false, error: "Access was removed but not sent to the other plugins. Remove it again" };
  }
  return { ok: true, grant: null, rev, sent: await send(ctx, companyId) };
}
