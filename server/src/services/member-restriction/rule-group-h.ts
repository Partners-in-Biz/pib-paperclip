import { and, eq } from "drizzle-orm";
import { companyMemberships, heartbeatRuns, instanceUserRoles, type Db } from "@paperclipai/db";
import { isUuidLike, type ActorCompanyMembership, type MemberRestrictionMode } from "@paperclipai/shared";
import { forbidden, unprocessable, type HttpError } from "../../errors.js";
import { recordMemberRestrictionDenial } from "./admin.js";
import { memberRestrictionForMembership } from "./actor-memberships.js";
import { memberRestrictionKillSwitchOn, memberRestrictionResolver, memberRestrictionUnavailable } from "./resolver.js";

/**
 * Rule group H (PAR-12608 4.10): binds every member who is not owner or admin
 * (flagged or not), and the keys and runs that work for him. The local board
 * and instance admins are never bound. The mode is the company's switch, read
 * through the one resolver; mode `off` (or the kill switch) binds nobody.
 */

export const TOOL_ROUTE_OWNER_ONLY_CODE = "TOOL_ROUTE_OWNER_ONLY";
export const AGENT_KEY_RUN_NOT_OWNED_CODE = "agent_key_run_not_owned";

type Binding = { bound: false } | { bound: true; mode: Exclude<MemberRestrictionMode, "off"> };

function unbindingRole(role: string | null | undefined) {
  return role === "owner" || role === "admin";
}

async function readOrUnavailable<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw memberRestrictionUnavailable(error);
  }
}

/**
 * Whether rule group H binds one person in one company, and under which mode.
 * Reads nothing for an owner or admin whose membership is carried, nor (beyond
 * a carried mode) in a company on `off`. A failed read throws 503
 * `MEMBER_RESTRICTION_UNAVAILABLE`.
 */
export async function ruleGroupHBinding(
  db: Db,
  input: {
    personId: string;
    companyId: string;
    membership?: Partial<ActorCompanyMembership> | null;
    isInstanceAdmin?: boolean;
  },
): Promise<Binding> {
  if (memberRestrictionKillSwitchOn() || input.isInstanceAdmin === true) return { bound: false };
  const membership = input.membership?.companyId === input.companyId ? input.membership : null;
  if (unbindingRole(membership?.membershipRole)) return { bound: false };
  const { mode } = await memberRestrictionForMembership(
    memberRestrictionResolver(db), input.personId, input.companyId, membership,
  );
  if (mode === "off") return { bound: false };
  const role = membership?.membershipRole !== undefined
    ? membership.membershipRole
    : await readOrUnavailable(() => db
        .select({ role: companyMemberships.membershipRole })
        .from(companyMemberships)
        .where(and(
          eq(companyMemberships.companyId, input.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, input.personId),
        ))
        .then((rows) => rows[0]?.role ?? null));
  if (unbindingRole(role)) return { bound: false };
  if (input.isInstanceAdmin === undefined) {
    const admin = await readOrUnavailable(() => db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, input.personId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows.length > 0));
    if (admin) return { bound: false };
  }
  return { bound: true, mode };
}

/** Record the refusal (or, in `report`, the "would refuse"); in `enforce` answer the refusal. */
async function refuseOrRecord(
  db: Db,
  binding: Extract<Binding, { bound: true }>,
  denial: { companyId: string; personId: string; ruleId: string; target: string; objectId?: string | null },
  refusal: () => HttpError,
): Promise<HttpError | null> {
  await recordMemberRestrictionDenial(db, { ...denial, mode: binding.mode });
  return binding.mode === "enforce" ? refusal() : null;
}

/**
 * H5: a long-lived agent key may name a run (run id header, a tool call's run
 * context, a gateway session's run) only when that run belongs to the key's
 * agent and works for the key's own person. Otherwise 422 under `enforce`; a
 * "would refuse" is recorded under `report`. Returns the error to answer, or null.
 */
export async function agentKeyRunNamingError(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    personId: string;
    runId: string;
    membership?: Partial<ActorCompanyMembership> | null;
    target: string;
  },
): Promise<HttpError | null> {
  const binding = await ruleGroupHBinding(db, input);
  if (!binding.bound) return null;
  const runPerson = isUuidLike(input.runId)
    ? await readOrUnavailable(() => db
        .select({ responsibleUserId: heartbeatRuns.responsibleUserId })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.id, input.runId),
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.agentId, input.agentId),
        ))
        .then((rows) => (rows[0] ? rows[0].responsibleUserId?.trim() || null : undefined)))
    : undefined;
  if (runPerson === input.personId) return null;
  return refuseOrRecord(db, binding, {
    companyId: input.companyId, personId: input.personId, ruleId: "H5", target: input.target, objectId: input.runId,
  }, () => unprocessable("This agent key may only name a run of its own agent that works for its own person", {
    code: AGENT_KEY_RUN_NOT_OWNED_CODE,
    runId: input.runId,
  }));
}

type ToolRouteActor = {
  type: string;
  source?: string;
  userId?: string;
  isInstanceAdmin?: boolean;
  memberships?: Array<Partial<ActorCompanyMembership> & { companyId: string }>;
};

/**
 * PAR-12608 4.9, decisions 1 and 2: a signed-in person calls
 * `POST /plugins/tools/execute` and `POST /tool-gateway/sessions` only as
 * owner, admin or instance admin. Agents are not judged here (H5 covers keys).
 * Returns the error to answer, or null.
 */
export async function toolRouteCallerError(
  db: Db,
  actor: ToolRouteActor,
  companyId: string,
  target: string,
): Promise<HttpError | null> {
  if (actor.type !== "board" || !actor.userId || actor.source === "local_implicit") return null;
  const binding = await ruleGroupHBinding(db, {
    personId: actor.userId,
    companyId,
    membership: actor.memberships?.find((membership) => membership.companyId === companyId) ?? null,
    isInstanceAdmin: actor.isInstanceAdmin === true,
  });
  if (!binding.bound) return null;
  return refuseOrRecord(db, binding, {
    companyId, personId: actor.userId, ruleId: "H-tool-route", target,
  }, () => forbidden("Only an owner or admin may call this tool route", { code: TOOL_ROUTE_OWNER_ONLY_CODE }));
}
