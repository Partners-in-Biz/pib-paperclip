import { and, eq } from "drizzle-orm";
import { companies, companyMemberships, type Db } from "@paperclipai/db";
import {
  MEMBER_RESTRICTION_KILL_SWITCH_ENV,
  MEMBER_RESTRICTION_MODES,
  MEMBER_RESTRICTION_UNAVAILABLE_CODE,
  type MemberRestriction,
  type MemberRestrictionMode,
} from "@paperclipai/shared";
import { HttpError } from "../../errors.js";

/**
 * The one reader of the member-restriction columns
 * (`company_memberships.restricted`, `restricted_plugin_keys`,
 * `restricted_agent_ids`, `companies.member_restriction_mode`) and of the
 * server kill switch (PAR-12608 section 4.2). Every consumer asks
 * `memberRestrictionFor` and nothing else.
 */

function notRestricted(mode: MemberRestrictionMode = "off"): MemberRestriction {
  return { restricted: false, mode, pluginKeys: [], agentIds: [] };
}

/**
 * True only when the kill switch variable is exactly `off`. Read on every call
 * (never cached), so a test can toggle it; operators change it with a restart.
 */
export function memberRestrictionKillSwitchOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MEMBER_RESTRICTION_KILL_SWITCH_ENV] === "off";
}

/** A value that is set but is not exactly `off`; ignored, and logged once at boot. */
export function memberRestrictionKillSwitchIgnoredValue(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[MEMBER_RESTRICTION_KILL_SWITCH_ENV];
  if (value === undefined || value === "off") return null;
  return value;
}

export class MemberRestrictionReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MemberRestrictionReadError";
  }
}

function isMode(value: unknown): value is MemberRestrictionMode {
  return typeof value === "string" && (MEMBER_RESTRICTION_MODES as readonly string[]).includes(value);
}

function stringList(value: unknown, column: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new MemberRestrictionReadError(`company_memberships.${column} is not a list of strings`);
  }
  return [...value];
}

export type MemberRestrictionResolver = (personId: string, companyId: string) => Promise<MemberRestriction>;

/**
 * Restriction of one person in one company. Throws when the answer cannot be
 * read; a caller must then refuse (see `memberRestrictionOrUnavailable`), never
 * continue as "not restricted".
 *
 * - Kill switch on, or company mode `off`: "not restricted", and the membership
 *   is not read at all.
 * - A flagged row counts whatever its `status` (a suspended flagged member is
 *   still restricted here; the active-member rule denies him separately).
 * - No such company, or no user membership: nothing to restrict.
 */
export async function memberRestrictionFor(
  db: Db,
  personId: string,
  companyId: string,
): Promise<MemberRestriction> {
  if (memberRestrictionKillSwitchOn()) return notRestricted();

  const company = await db
    .select({ mode: companies.memberRestrictionMode })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  if (!company) return notRestricted();
  if (!isMode(company.mode)) {
    throw new MemberRestrictionReadError("companies.member_restriction_mode has an unknown value");
  }
  if (company.mode === "off") return notRestricted();

  const membership = await db
    .select({
      restricted: companyMemberships.restricted,
      pluginKeys: companyMemberships.restrictedPluginKeys,
      agentIds: companyMemberships.restrictedAgentIds,
    })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, personId),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!membership || membership.restricted !== true) return notRestricted(company.mode);

  return {
    restricted: true,
    mode: company.mode,
    pluginKeys: stringList(membership.pluginKeys, "restricted_plugin_keys"),
    agentIds: stringList(membership.agentIds, "restricted_agent_ids"),
  };
}

/**
 * The companies in which one person is restricted under `enforce` (PAR-12608
 * 4.3, list builders): a flagged row in any status, in a company whose mode is
 * `enforce`. `report` and `off` companies are left out, so their lists stay
 * unfiltered. With the kill switch on nothing is read and the answer is empty.
 * Throws `MemberRestrictionReadError` when the answer cannot be read.
 */
export async function memberRestrictionEnforcedCompanyIds(
  db: Pick<Db, "select">,
  personId: string,
): Promise<string[]> {
  if (memberRestrictionKillSwitchOn()) return [];
  let rows: Array<{ companyId: unknown }>;
  try {
    rows = await db
      .select({ companyId: companyMemberships.companyId })
      .from(companyMemberships)
      .innerJoin(companies, eq(companies.id, companyMemberships.companyId))
      .where(
        and(
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, personId),
          eq(companyMemberships.restricted, true),
          eq(companies.memberRestrictionMode, "enforce"),
        ),
      );
  } catch (error) {
    throw new MemberRestrictionReadError("company restriction list could not be read", { cause: error });
  }
  if (!Array.isArray(rows) || !rows.every((row) => typeof row.companyId === "string")) {
    throw new MemberRestrictionReadError("company restriction list is malformed");
  }
  return [...new Set(rows.map((row) => row.companyId as string))].sort();
}

/**
 * The company's restriction mode, as the resolver sees it: `off` under the kill
 * switch or when the company does not exist. Throws when it cannot be read.
 */
export async function memberRestrictionModeFor(db: Db, companyId: string): Promise<MemberRestrictionMode> {
  if (memberRestrictionKillSwitchOn()) return "off";
  const company = await db
    .select({ mode: companies.memberRestrictionMode })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  if (!company) return "off";
  if (!isMode(company.mode)) {
    throw new MemberRestrictionReadError("companies.member_restriction_mode has an unknown value");
  }
  return company.mode;
}

export function memberRestrictionResolver(db: Db): MemberRestrictionResolver {
  return (personId, companyId) => memberRestrictionFor(db, personId, companyId);
}

export function memberRestrictionUnavailable(cause?: unknown): HttpError {
  const error = new HttpError(503, "Member restriction could not be read", {
    code: MEMBER_RESTRICTION_UNAVAILABLE_CODE,
  });
  if (cause !== undefined) (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

/**
 * Resolve, or throw 503 `MEMBER_RESTRICTION_UNAVAILABLE` when the read fails.
 * Route handlers call this; the error handler turns it into the response, so
 * the handler returns no data.
 */
export async function memberRestrictionOrUnavailable(
  resolve: MemberRestrictionResolver,
  personId: string,
  companyId: string,
): Promise<MemberRestriction> {
  try {
    return await resolve(personId, companyId);
  } catch (error) {
    throw memberRestrictionUnavailable(error);
  }
}
