import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sprintTask } from "../src/domain.js";
import { NAMESPACE } from "../src/namespace.js";

describe("seo", () => {
  it("uses the host namespace", () => {
    expect(NAMESPACE).toBe("plugin_seo_8099f8879a");
    const sql = readFileSync(new URL("../migrations/001_seo.sql", import.meta.url), "utf8");
    for (const table of ["sprints", "keywords", "pages", "audits"]) {
      expect(sql).toContain(`CREATE TABLE ${NAMESPACE}.${table}`);
    }
  });

  it("tags a Paperclip issue with the sprint id", () => {
    const task = sprintTask({ id: "sprint-1", name: "Launch" }, "Fix the title tag");
    expect(task.originId).toBe("sprint-1");
    expect(task.description).toContain("sprint-1");
    expect(task.originKind).toBe("plugin:partnersinbiz.seo");
  });
});
