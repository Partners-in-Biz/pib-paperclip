import type { Db } from "@paperclipai/db";
import { MEMBER_RESTRICTED_CODE, type ActorCompanyMembership } from "@paperclipai/shared";
import { forbidden, HttpError } from "../../errors.js";
import { recordMemberRestrictionDenial } from "./admin.js";
import { actorPersonMembership, memberRestrictionForMembership } from "./actor-memberships.js";
import type { MemberRestrictionResolver } from "./resolver.js";

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

/**
 * `fresh` ignores the membership carried by the request and reads the database
 * (a stream re-checked per message, 4.6a); `record: false` skips the denial
 * record, so a re-check does not log one denial per message.
 */
export interface PluginGateOptions {
  fresh?: boolean;
  record?: boolean;
}

/** Refuses (403 `MEMBER_RESTRICTED`) unless the plugin is open to the person; a failed read is 503. */
export async function assertPluginOpenForPerson(
  deps: PluginGateDeps,
  input: { companyId: string; personId: string; pluginKey: string; target: string },
  membership: Partial<ActorCompanyMembership> | null = null,
  options: PluginGateOptions = {},
): Promise<void> {
  const { companyId, personId, pluginKey } = input;
  const restriction = await memberRestrictionForMembership(
    deps.resolve, personId, companyId, options.fresh ? null : membership,
  );
  if (!restriction.restricted || restriction.mode === "off" || restriction.pluginKeys.includes(pluginKey)) return;
  if (options.record !== false) {
    await recordMemberRestrictionDenial(deps.db, {
      companyId, personId, ruleId: PLUGIN_GATE_RULE_ID, target: `plugin:${pluginKey}:${input.target}`, mode: restriction.mode,
    });
  }
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
  options: PluginGateOptions = {},
): Promise<void> {
  if (!companyId || actor.source === "local_implicit" || actor.isInstanceAdmin) return;
  const carried = actorPersonMembership(actor, companyId);
  if (!carried) return;
  await assertPluginOpenForPerson(
    deps, { companyId, personId: carried.personId, pluginKey, target }, carried.membership, options,
  );
}

export function isMemberRestricted(error: unknown): error is HttpError {
  return error instanceof HttpError && error.status === 403
    && (error.details as { code?: unknown } | null | undefined)?.code === MEMBER_RESTRICTED_CODE;
}
