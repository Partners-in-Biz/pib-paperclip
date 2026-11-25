import type { Db } from "@paperclipai/db";
import type { ExternalObjectReadOptions } from "../external-objects.js";
import { recordMemberRestrictionDenial } from "./admin.js";
import { memberRestrictionOrUnavailable, memberRestrictionResolver } from "./resolver.js";
import { restrictionPersonIds } from "./strict-read.js";

/**
 * PAR-12608 4.6a row 5, read side (PAR-14590). External objects are company
 * rows resolved by a background sweep with the company's GitHub credential, so
 * the rule applies when they are read, not when they are resolved:
 *
 * - `enforce`: a person restricted here reads a GitHub object without its
 *   resolved fields (title, state, liveness, details) unless its repository is
 *   known public. He still sees the URL he or his run wrote.
 * - `report`: the would-be withholding is recorded; the answer is today's.
 * - `off`, the kill switch, owners, admins, the local board: today's answer.
 *
 * Applies to the open read routes `GET /issues/:id/external-objects`,
 * `GET /issues/:id/external-object-summary` and
 * `GET /projects/:id/external-object-summary`.
 */
export const GITHUB_EXTERNAL_OBJECTS_RULE_ID = "4.6a row 5";

type ReaderActor = Parameters<typeof restrictionPersonIds>[0];

export interface GitHubExternalObjectReadGate {
  /** Pass to the external-object service read; undefined when nobody is restricted. */
  readOptions: ExternalObjectReadOptions | undefined;
  /** Record the withholding (or would-be withholding) once the read is done. */
  record(): Promise<void>;
}

/**
 * Decide the 4.6a row 5 read rule for this caller in this company. Every
 * person the caller carries is checked (the signed-in user, the person an
 * agent works for, the authorizer); any one restricted under `enforce` makes
 * the read withhold. A failed read throws 503 `MEMBER_RESTRICTION_UNAVAILABLE`.
 */
export async function githubExternalObjectReadGate(
  db: Db,
  actor: ReaderActor & { source?: string },
  companyId: string,
  target: string,
): Promise<GitHubExternalObjectReadGate> {
  const people = actor.type === "board" && actor.source === "local_implicit"
    ? []
    : restrictionPersonIds(actor).filter((id) => id !== "local-board");
  const restricted: Array<{ personId: string; mode: "report" | "enforce" }> = [];
  const resolve = memberRestrictionResolver(db);
  for (const personId of people) {
    const restriction = await memberRestrictionOrUnavailable(resolve, personId, companyId);
    if (!restriction.restricted || restriction.mode === "off") continue;
    restricted.push({ personId, mode: restriction.mode });
  }
  if (restricted.length === 0) return { readOptions: undefined, record: async () => {} };

  const withheld = new Set<string>();
  return {
    readOptions: {
      restrictedReader: {
        withhold: restricted.some((person) => person.mode === "enforce"),
        onWithheld: (objectId) => withheld.add(objectId),
      },
    },
    record: async () => {
      if (withheld.size === 0) return;
      const objectId = [...withheld][0] ?? null;
      for (const person of restricted) {
        await recordMemberRestrictionDenial(db, {
          companyId,
          personId: person.personId,
          ruleId: GITHUB_EXTERNAL_OBJECTS_RULE_ID,
          target,
          objectId,
          mode: person.mode,
        });
      }
    },
  };
}
