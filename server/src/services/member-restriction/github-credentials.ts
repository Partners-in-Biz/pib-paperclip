import type { Db } from "@paperclipai/db";
import { recordMemberRestrictionDenial } from "./admin.js";
import { memberRestrictionOrUnavailable, memberRestrictionResolver } from "./resolver.js";

/**
 * PAR-12608 4.6a row 5 and 4.9 decision 4: a run whose person is restricted
 * under `enforce` gets no GitHub credential, neither a managed one (the
 * runtime credentials route and every caller of
 * `resolveGitHubOperationCredentials`) nor the host's (`useHostGitHub`).
 */
export const GITHUB_CREDENTIALS_RULE_ID = "4.6a row 5";
export const GITHUB_CREDENTIALS_RESTRICTED_REASON =
  "GitHub access is limited for the person this run works for; ask a company admin.";

/**
 * True when the run's person is restricted under `enforce`: the caller hands
 * out no GitHub credential. Under `report` the refusal is recorded and the
 * answer is false. No person, or the local board: no check. A failed read
 * throws 503 `MEMBER_RESTRICTION_UNAVAILABLE`; never "not restricted".
 */
export async function githubCredentialsRefused(
  db: Db,
  input: { companyId: string; personId: string | null | undefined; target: string; runId: string },
): Promise<boolean> {
  const { personId } = input;
  if (!personId || personId === "local-board") return false;
  const restriction = await memberRestrictionOrUnavailable(memberRestrictionResolver(db), personId, input.companyId);
  if (!restriction.restricted || restriction.mode === "off") return false;
  await recordMemberRestrictionDenial(db, {
    companyId: input.companyId, personId, ruleId: GITHUB_CREDENTIALS_RULE_ID,
    target: input.target, objectId: input.runId, mode: restriction.mode,
  });
  return restriction.mode === "enforce";
}
