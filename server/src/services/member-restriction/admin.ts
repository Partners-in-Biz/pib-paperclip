import { and, count, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { activityLog, agents, companies, companyMemberships, plugins, type Db } from "@paperclipai/db";
import type { MemberRestrictionMode, UpdateMemberRestriction } from "@paperclipai/shared";
import { unprocessable } from "../../errors.js";
import { logger as defaultLogger } from "../../middleware/logger.js";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";

/**
 * Writes of the member-restriction columns and the denial record (PAR-12608
 * 4.2). Deciding access stays with `memberRestrictionFor`; this module only
 * stores what an owner sets and what a consumer refused.
 */

export const MEMBER_RESTRICTION_CHANGED_ACTION = "company_member.restriction_changed";
export const MEMBER_RESTRICTION_MODE_CHANGED_ACTION = "company.member_restriction_mode_changed";
export const MEMBER_RESTRICTION_DENIED_ACTION = "member_restriction.denied";
export const MEMBER_RESTRICTED_ROLE_CODE = "MEMBER_RESTRICTED_ROLE";

const PROTECTED_ROLES = new Set(["owner", "admin"]);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 4.1: nobody is both flagged and owner or admin. Uses the stored flag in
 * every mode (a flag set under `off` still blocks the role).
 */
export function assertRoleAllowedForRestriction(
  member: { restricted?: boolean | null },
  nextRole: string | null | undefined,
) {
  if (member.restricted === true && nextRole && PROTECTED_ROLES.has(nextRole)) {
    throw unprocessable(
      `This member is restricted (member restriction flag is set). Remove the restriction before making them ${nextRole}.`,
      { code: MEMBER_RESTRICTED_ROLE_CODE },
    );
  }
}

type StoredRestriction = { restricted: boolean; pluginKeys: string[]; agentIds: string[] };

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values)].sort();
}

/** Set the flag and both lists on one person's membership. Returns null when the member does not exist. */
export async function setMemberRestriction(
  db: Db,
  companyId: string,
  memberId: string,
  input: UpdateMemberRestriction,
): Promise<{ principalId: string; before: StoredRestriction; after: StoredRestriction } | null> {
  const next: StoredRestriction = {
    restricted: input.restricted,
    pluginKeys: uniqueSorted(input.pluginKeys),
    agentIds: uniqueSorted(input.agentIds),
  };
  if (next.pluginKeys.length > 0) {
    const found = new Set(await db
      .select({ key: plugins.pluginKey })
      .from(plugins)
      .where(and(inArray(plugins.pluginKey, next.pluginKeys), ne(plugins.status, "uninstalled")))
      .then((rows) => rows.map((row) => row.key)));
    const unknown = next.pluginKeys.filter((key) => !found.has(key));
    if (unknown.length > 0) throw unprocessable(`Unknown or uninstalled plugin: ${unknown.join(", ")}`);
  }
  if (next.agentIds.length > 0) {
    const found = new Set(await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, next.agentIds)))
      .then((rows) => rows.map((row) => row.id)));
    const unknown = next.agentIds.filter((id) => !found.has(id));
    if (unknown.length > 0) throw unprocessable(`Agent not in this company: ${unknown.join(", ")}`);
  }

  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, memberId)))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!existing) return null;
    if (existing.principalType !== "user") throw unprocessable("Only a person's membership can be restricted");
    if (next.restricted && existing.membershipRole && PROTECTED_ROLES.has(existing.membershipRole)) {
      throw unprocessable(`An ${existing.membershipRole} cannot be restricted. Change the role first.`, {
        code: MEMBER_RESTRICTED_ROLE_CODE,
      });
    }
    await tx
      .update(companyMemberships)
      .set({
        restricted: next.restricted,
        restrictedPluginKeys: next.pluginKeys,
        restrictedAgentIds: next.agentIds,
        updatedAt: new Date(),
      })
      .where(eq(companyMemberships.id, existing.id));
    return {
      principalId: existing.principalId,
      before: {
        restricted: existing.restricted,
        // Sorted like `after`, so a no-op save of an unsorted stored list writes no entry.
        pluginKeys: uniqueSorted(existing.restrictedPluginKeys),
        agentIds: uniqueSorted(existing.restrictedAgentIds),
      },
      after: next,
    };
  });
}

/** Number of `member_restriction.denied` entries of the last `days` days. */
export async function countMemberRestrictionDenials(db: Db, companyId: string, days = 7, now = new Date()) {
  const [row] = await db
    .select({ value: count() })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.action, MEMBER_RESTRICTION_DENIED_ACTION),
      gte(activityLog.createdAt, new Date(now.getTime() - days * DAY_MS)),
    ));
  return Number(row?.value ?? 0);
}

/** Change the company switch. Returns null when the company does not exist. */
export async function setMemberRestrictionMode(db: Db, companyId: string, mode: MemberRestrictionMode) {
  return db.transaction(async (tx) => {
    const company = await tx
      .select({ mode: companies.memberRestrictionMode })
      .from(companies)
      .where(eq(companies.id, companyId))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!company) return null;
    if (company.mode !== mode) {
      await tx
        .update(companies)
        .set({ memberRestrictionMode: mode, updatedAt: new Date() })
        .where(eq(companies.id, companyId));
    }
    return {
      oldMode: company.mode,
      newMode: mode,
      changed: company.mode !== mode,
      deniedLast7Days: await countMemberRestrictionDenials(tx as unknown as Db, companyId),
    };
  });
}

export interface MemberRestrictionDenial {
  companyId: string;
  personId: string;
  ruleId: string;
  /** The route or action that was refused (or would be, in `report`). */
  target: string;
  objectId?: string | null;
  mode: Exclude<MemberRestrictionMode, "off">;
}

type DenialLogger = Pick<typeof defaultLogger, "warn" | "error">;

/**
 * Record a refusal (`enforce`) or a "would refuse" (`report`): a log line each
 * time, and one `member_restriction.denied` activity entry at most once per
 * person, rule and UTC day. The once-a-day check is a query on `activity_log`
 * under an advisory lock, so two concurrent denials still leave one entry. A
 * failure to record is logged and never changes the caller's answer.
 */
export async function recordMemberRestrictionDenial(
  db: Db,
  denial: MemberRestrictionDenial,
  options: { log?: DenialLogger; now?: Date } = {},
): Promise<{ recorded: boolean }> {
  const log = options.log ?? defaultLogger;
  const now = options.now ?? new Date();
  log.warn(
    { memberRestriction: denial },
    denial.mode === "report" ? "member restriction would refuse" : "member restriction refused",
  );
  const day = now.toISOString().slice(0, 10);
  const dayStart = new Date(`${day}T00:00:00.000Z`);
  const publications: ActivityPublication[] = [];
  try {
    const recorded = await db.transaction(async (tx) => {
      const lockKey = `${MEMBER_RESTRICTION_DENIED_ACTION}:${denial.companyId}:${denial.personId}:${denial.ruleId}:${day}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      const existing = await tx
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(and(
          eq(activityLog.companyId, denial.companyId),
          eq(activityLog.responsibleUserId, denial.personId),
          eq(activityLog.action, MEMBER_RESTRICTION_DENIED_ACTION),
          gte(activityLog.createdAt, dayStart),
          sql`${activityLog.details} ->> 'ruleId' = ${denial.ruleId}`,
        ))
        .limit(1);
      if (existing.length > 0) return false;
      await logActivity(tx as unknown as Db, {
        companyId: denial.companyId,
        actorType: "system",
        actorId: "member-restriction",
        action: MEMBER_RESTRICTION_DENIED_ACTION,
        entityType: "company",
        entityId: denial.companyId,
        responsibleUserIdOverride: denial.personId,
        details: {
          personId: denial.personId,
          ruleId: denial.ruleId,
          target: denial.target,
          objectId: denial.objectId ?? null,
          mode: denial.mode,
        },
      }, publications);
      return true;
    });
    for (const publication of publications) publishActivity(publication);
    return { recorded };
  } catch (error) {
    log.error({ err: error, memberRestriction: denial }, "member restriction denial could not be recorded");
    return { recorded: false };
  }
}
