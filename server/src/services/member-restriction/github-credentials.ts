import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { recordMemberRestrictionDenial } from "./admin.js";
import {
  memberRestrictionModeFor,
  memberRestrictionOrUnavailable,
  memberRestrictionResolver,
  memberRestrictionUnavailable,
} from "./resolver.js";

/**
 * PAR-12608 4.6a row 5 and 4.9 decision 4: a run whose person is restricted
 * under `enforce` gets no GitHub credential: not a managed one (the runtime
 * credentials route and every caller of `resolveGitHubOperationCredentials`),
 * not a company secret or the server's token (`createGitRemoteAuthProvider`,
 * with or without an identity context), not the host's (`useHostGitHub`), and
 * not a project authorizer's (`project-git-authorization`, non-run scope).
 */
export const GITHUB_CREDENTIALS_RULE_ID = "4.6a row 5";
export const GITHUB_CREDENTIALS_RESTRICTED_REASON =
  "GitHub access is limited for the person this run works for; ask a company admin.";
export const PROJECT_GITHUB_CREDENTIALS_RESTRICTED_REASON =
  "GitHub access is limited for the person who authorized this project; ask a company admin.";
export const GRANT_GITHUB_CREDENTIALS_RESTRICTED_REASON =
  "GitHub access is limited for the person whose GitHub connection this work would use; ask a company admin.";

/**
 * True when any of the given people is restricted under `enforce`: the caller
 * hands out no GitHub credential. Callers pass every person the credential
 * could be resolved for (the run's row and its identity context), so a
 * divergence between the two sources fails closed. Under `report` each
 * restricted person's refusal is recorded and the answer is false. No person,
 * or the local board: no check. A failed read throws 503
 * `MEMBER_RESTRICTION_UNAVAILABLE`; never "not restricted".
 */
export async function githubCredentialsRefused(
  db: Db,
  input: { companyId: string; personIds: readonly (string | null | undefined)[]; target: string; objectId: string },
): Promise<boolean> {
  const people = [...new Set(input.personIds.filter((id): id is string => !!id && id !== "local-board"))];
  let refused = false;
  for (const personId of people) {
    const restriction = await memberRestrictionOrUnavailable(memberRestrictionResolver(db), personId, input.companyId);
    if (!restriction.restricted || restriction.mode === "off") continue;
    await recordMemberRestrictionDenial(db, {
      companyId: input.companyId, personId, ruleId: GITHUB_CREDENTIALS_RULE_ID,
      target: input.target, objectId: input.objectId, mode: restriction.mode,
    });
    if (restriction.mode === "enforce") refused = true;
  }
  return refused;
}

/**
 * A caller named a run that is not in this company, so there is no person to
 * check. Refused only under `enforce` (fail closed); under `report` the
 * would-be refusal is logged and today's answer stands; `off` and the kill
 * switch keep today's answer. A failed read throws 503.
 */
export async function githubCredentialsRefusedForUnknownRun(
  db: Db,
  input: { companyId: string; runId: string; target: string },
): Promise<boolean> {
  let mode: Awaited<ReturnType<typeof memberRestrictionModeFor>>;
  try {
    mode = await memberRestrictionModeFor(db, input.companyId);
  } catch (error) {
    throw memberRestrictionUnavailable(error);
  }
  if (mode === "off") return false;
  logger.warn(
    { memberRestriction: { ...input, ruleId: GITHUB_CREDENTIALS_RULE_ID, mode, reason: "unknown_run" } },
    mode === "report" ? "member restriction would refuse" : "member restriction refused",
  );
  return mode === "enforce";
}
