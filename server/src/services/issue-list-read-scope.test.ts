import { describe, expect, it } from "vitest";
import { issueListReadCondition, type issueService } from "./issues.js";

/**
 * PAR-12718, AC-L14 (spec PAR-12608 rev 3, 4.3 C28 and 7 X5): a task list call
 * without a read scope does not compile. This file sits next to the service, not
 * under src/__tests__, so the server's `tsc --noEmit` in CI checks it: if any
 * call below compiled, its unused `@ts-expect-error` would fail the build.
 */
function listCallsWithoutReadScopeDoNotCompile(svc: ReturnType<typeof issueService>) {
  // @ts-expect-error the filters argument is required
  void svc.list("company");
  // @ts-expect-error the filters argument is required
  void svc.count("company");
  // @ts-expect-error readCondition is required in the filters
  void svc.list("company", { status: "todo" });
  // @ts-expect-error readCondition is required in the filters
  void svc.count("company", { status: "todo" });
  // @ts-expect-error only an SQL condition or the literal "system" is a read scope
  void svc.list("company", { readCondition: "all" });
  void svc.list("company", { readCondition: "system" });
}

describe("task list read scope (AC-L14)", () => {
  it("is a read condition or \"system\"; \"system\" adds no condition", () => {
    expect(listCallsWithoutReadScopeDoNotCompile).toBeTypeOf("function");
    expect(issueListReadCondition("system")).toBeUndefined();
  });
});
