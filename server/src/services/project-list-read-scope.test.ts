import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { projectListReadCondition, type projectService } from "./projects.js";

/**
 * PAR-12719, AC-L14 (spec PAR-12608 rev 3, 4.3 C28 and 7 X5): a project list
 * call without a read scope does not compile. This file sits next to the
 * service, not under src/__tests__, so the server's `tsc --noEmit` in CI checks
 * it: if any call below compiled, its unused `@ts-expect-error` would fail the
 * build.
 */
function listCallsWithoutReadScopeDoNotCompile(svc: ReturnType<typeof projectService>) {
  // @ts-expect-error the options argument is required
  void svc.list("company");
  // @ts-expect-error readCondition is required in the options
  void svc.list("company", { includeArchived: false });
  // @ts-expect-error the options argument is required
  void svc.listByIds("company", ["project"]);
  // @ts-expect-error readCondition is required in the options
  void svc.listByIds("company", ["project"], {});
  // @ts-expect-error readCondition is required in the options
  void svc.listSummaries("company", { limit: 1, includeArchived: false, candidateIds: null });
  // @ts-expect-error only an SQL condition or the literal "system" is a read scope
  void svc.list("company", { readCondition: "all" });
  void svc.list("company", { readCondition: "system" });
  void svc.listByIds("company", ["project"], { readCondition: sql<boolean>`true` });
}

describe("project list read scope (AC-L14)", () => {
  it("is a read condition or \"system\"; \"system\" adds no condition", () => {
    expect(listCallsWithoutReadScopeDoNotCompile).toBeTypeOf("function");
    expect(projectListReadCondition("system")).toBeUndefined();
    const condition = sql<boolean>`false`;
    expect(projectListReadCondition(condition)).toBe(condition);
  });
});
