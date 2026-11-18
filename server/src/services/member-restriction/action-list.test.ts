import { describe, expect, it } from "vitest";
import type { AuthorizationAction } from "../authorization.js";
import {
  MEMBER_RESTRICTION_ACTION_LIST,
  memberRestrictionAllowsAction,
  type MemberRestrictionActionList,
} from "./action-list.js";

/**
 * PAR-12923, AC-G8 (spec PAR-12608 rev 3, 4.6 "The action list"): the list is
 * a typed map over the full action union. This file sits next to the module,
 * not under src/__tests__, so the server's `tsc --noEmit` in CI checks it: if
 * a map with a missing or unknown action compiled, its unused
 * `@ts-expect-error` would fail the build.
 */
function incompleteActionListsDoNotCompile() {
  const missingOne: Omit<MemberRestrictionActionList, "company_scope:read"> = MEMBER_RESTRICTION_ACTION_LIST;
  // @ts-expect-error every AuthorizationAction must be decided
  const missing: MemberRestrictionActionList = missingOne;
  const unknown = {
    ...MEMBER_RESTRICTION_ACTION_LIST,
    // @ts-expect-error an action outside the union is not a key of the list
    "issue:delete_everything": "allowed",
  } satisfies MemberRestrictionActionList;
  return [missing, unknown];
}

const ALLOWED: AuthorizationAction[] = [
  "issue:read", "issue:comment", "issue:mutate", "project:read", "project:write_workspace",
  "tasks:assign", "agent:read", "agent:wake", "tools:use",
];

describe("member restriction action list (AC-G8)", () => {
  it("allows exactly the nine actions of 4.6 and denies every other one", () => {
    expect(incompleteActionListsDoNotCompile).toBeTypeOf("function");
    const allowed = Object.entries(MEMBER_RESTRICTION_ACTION_LIST)
      .filter(([, rule]) => rule === "allowed").map(([action]) => action);
    expect(allowed.sort()).toEqual([...ALLOWED].sort());
    for (const action of Object.keys(MEMBER_RESTRICTION_ACTION_LIST) as AuthorizationAction[]) {
      expect(memberRestrictionAllowsAction(action), action).toBe(ALLOWED.includes(action));
    }
    expect(memberRestrictionAllowsAction("company_scope:read")).toBe(false);
  });

  it("denies an action that reaches it at run time without being in the map", () => {
    expect(memberRestrictionAllowsAction("issue:delete_everything" as AuthorizationAction)).toBe(false);
  });
});
