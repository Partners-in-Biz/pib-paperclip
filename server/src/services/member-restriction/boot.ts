import { ne } from "drizzle-orm";
import { companies, type Db } from "@paperclipai/db";
import { MEMBER_RESTRICTION_KILL_SWITCH_ENV } from "@paperclipai/shared";
import { logger as defaultLogger } from "../../middleware/logger.js";
import { logActivity } from "../activity-log.js";
import { memberRestrictionKillSwitchIgnoredValue, memberRestrictionKillSwitchOn } from "./resolver.js";

export const MEMBER_RESTRICTION_FORCED_OFF_ACTION = "member_restriction.forced_off";

type BootLogger = Pick<typeof defaultLogger, "warn">;

/**
 * Boot report for the kill switch (PAR-12608 4.2): a value that is not exactly
 * `off` is logged once as ignored; `off` is logged and leaves one activity entry
 * on every company whose mode is not `off`, so the forced state is visible there.
 */
export async function reportMemberRestrictionKillSwitchAtBoot(
  db: Db,
  options: { env?: NodeJS.ProcessEnv; logger?: BootLogger } = {},
): Promise<{ forcedOff: boolean; companyIds: string[] }> {
  const env = options.env ?? process.env;
  const log = options.logger ?? defaultLogger;

  const ignored = memberRestrictionKillSwitchIgnoredValue(env);
  if (ignored !== null) {
    log.warn(
      { variable: MEMBER_RESTRICTION_KILL_SWITCH_ENV, value: ignored },
      `${MEMBER_RESTRICTION_KILL_SWITCH_ENV} value not understood, ignored (only the exact value "off" switches member restriction off)`,
    );
  }
  if (!memberRestrictionKillSwitchOn(env)) return { forcedOff: false, companyIds: [] };

  log.warn(
    { variable: MEMBER_RESTRICTION_KILL_SWITCH_ENV },
    `member restriction is switched off for the whole server (${MEMBER_RESTRICTION_KILL_SWITCH_ENV}=off)`,
  );
  const affected = await db
    .select({ id: companies.id, mode: companies.memberRestrictionMode })
    .from(companies)
    .where(ne(companies.memberRestrictionMode, "off"));
  for (const company of affected) {
    await logActivity(db, {
      companyId: company.id,
      actorType: "system",
      actorId: "system",
      action: MEMBER_RESTRICTION_FORCED_OFF_ACTION,
      entityType: "company",
      entityId: company.id,
      details: { mode: company.mode, variable: MEMBER_RESTRICTION_KILL_SWITCH_ENV },
    });
  }
  return { forcedOff: true, companyIds: affected.map((company) => company.id) };
}
