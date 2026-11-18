import type { Db } from "@paperclipai/db";
import { MEMBER_RESTRICTED_CODE, type ActorCompanyMembership } from "@paperclipai/shared";
import { forbidden, HttpError } from "../../errors.js";
import { recordMemberRestrictionDenial } from "./admin.js";
import { actorPersonMembership, loadActorMemberships, memberRestrictionForMembership } from "./actor-memberships.js";
import { memberRestrictionKillSwitchOn, type MemberRestrictionResolver } from "./resolver.js";

/**
 * The core plugin gate (PAR-12608 4.8): a call made by, or for, a restricted
 * person reaches a plugin only when its key is on his `restricted_plugin_keys`.
 * No list, or a plugin not on it (one installed later included), is closed.
 * The plugin's own guard still runs after this; core only decides "this plugin
 * at all". `report` records a "would refuse" and lets the call through.
 */

export const PLUGIN_GATE_RULE_ID = "R-plugin";

export interface PluginGateDeps {
  db: Db;
  resolve: MemberRestrictionResolver;
}

/** Refuses (403 `MEMBER_RESTRICTED`) unless the plugin is open to the person; a failed read is 503. */
export async function assertPluginOpenForPerson(
  deps: PluginGateDeps,
  input: { companyId: string; personId: string; pluginKey: string; target: string },
  membership: Partial<ActorCompanyMembership> | null = null,
): Promise<void> {
  const { companyId, personId, pluginKey } = input;
  const restriction = await memberRestrictionForMembership(deps.resolve, personId, companyId, membership);
  if (!restriction.restricted || restriction.mode === "off" || restriction.pluginKeys.includes(pluginKey)) return;
  await recordMemberRestrictionDenial(deps.db, {
    companyId, personId, ruleId: PLUGIN_GATE_RULE_ID, target: `plugin:${pluginKey}:${input.target}`, mode: restriction.mode,
  });
  if (restriction.mode === "enforce") {
    throw forbidden("Not available for your access level", { code: MEMBER_RESTRICTED_CODE });
  }
}

/**
 * The gate for a request actor: the signed-in user, or the person an agent
 * works for. No person (local board, an agent working for nobody) passes as
 * today, and so does an instance admin, as in the route middleware (4.6). A
 * bridge call with no company is admitted for an instance admin only
 * (`assertPluginBridgeScope`), so it passes here too.
 */
export async function assertPluginOpenForActor(
  deps: PluginGateDeps,
  actor: Parameters<typeof actorPersonMembership>[0] & { source?: string; isInstanceAdmin?: boolean },
  companyId: string | null | undefined,
  pluginKey: string,
  target: string,
): Promise<void> {
  if (!companyId || actor.source === "local_implicit" || actor.isInstanceAdmin) return;
  const carried = actorPersonMembership(actor, companyId);
  if (!carried) return;
  await assertPluginOpenForPerson(deps, { companyId, personId: carried.personId, pluginKey, target }, carried.membership);
}

/**
 * The Apps menu (4.8, AC-K4): `GET /plugins/ui-contributions` names no
 * company, so for a signed-in user restricted under `enforce` in any company
 * it keeps only the plugins open to him in every such company. A person who is
 * owner in X and restricted in Y therefore sees Y's list in X too, the rule of
 * 4.6 for pages with no company in their path (S14). `report` and `off` filter
 * nothing, like every list (4.2). Nobody else is filtered: no signed-in user,
 * the local board, an instance admin. A failed read throws 503.
 */
export async function filterPluginsOpenForPerson<T extends { pluginKey: string }>(
  deps: PluginGateDeps,
  actor: { type: string; userId?: string | null; source?: string; isInstanceAdmin?: boolean;
    memberships?: Array<Partial<ActorCompanyMembership> & { companyId: string }> },
  rows: T[],
): Promise<T[]> {
  const personId = actor.type === "board" ? actor.userId : null;
  if (!personId || actor.source === "local_implicit" || actor.isInstanceAdmin || memberRestrictionKillSwitchOn()) return rows;
  const memberships = actor.memberships ?? await loadActorMemberships(deps.db, { userId: personId, activeOnly: false });
  const openLists: ReadonlyArray<string>[] = [];
  for (const membership of memberships) {
    const restriction = await memberRestrictionForMembership(deps.resolve, personId, membership.companyId, membership);
    if (!restriction.restricted || restriction.mode !== "enforce") continue;
    openLists.push(restriction.pluginKeys);
  }
  if (openLists.length === 0) return rows;
  const keep = new Set(openLists[0]!.filter((key) => openLists.every((list) => list.includes(key))));
  return rows.filter((row) => keep.has(row.pluginKey));
}

export function isMemberRestricted(error: unknown): error is HttpError {
  return error instanceof HttpError && error.status === 403
    && (error.details as { code?: unknown } | null | undefined)?.code === MEMBER_RESTRICTED_CODE;
}
