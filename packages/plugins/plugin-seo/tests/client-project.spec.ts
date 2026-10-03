import { describe, expect, it } from "vitest";
import type * as db from "../src/db.js";
import { taskProjectId } from "../src/service/tasks.js";

const sprint = (extra: Partial<db.Sprint>) => ({ projectId: "seo", siteProjectId: null, clientProjectId: null, siteAccess: "wordpress", ...extra }) as db.Sprint;

describe("taskProjectId", () => {
  it("falls back to the company SEO project without a client project", () => {
    expect(taskProjectId(sprint({}), false, "seo")).toBe("seo");
  });
  it("opens every task of a client sprint in the client project", () => {
    const s = sprint({ clientProjectId: "agri" });
    expect(taskProjectId(s, false, "seo")).toBe("agri");
    expect(taskProjectId(s, true, "seo")).toBe("agri");
  });
  it("sends repo code tasks to the repo project, the rest to the client project", () => {
    const s = sprint({ clientProjectId: "agri", siteAccess: "repo", siteProjectId: "repo" });
    expect(taskProjectId(s, true, "seo")).toBe("repo");
    expect(taskProjectId(s, false, "seo")).toBe("agri");
  });
});

import { evaluateWordPressChange } from "../src/engine/site-change.js";

describe("theme_markup on WordPress", () => {
  const change = [{ path: "wp:theme:themes/astra/template-parts/share.php", category: "theme_markup" }];
  it("applies with an SFTP login", () => {
    expect(evaluateWordPressChange("merge_seo_scope", change, { sftp: true }).decision).toBe("apply");
  });
  it("goes to a person without one, naming wp_sftp", () => {
    const v = evaluateWordPressChange("merge_seo_scope", change, { sftp: false });
    expect(v.decision).toBe("pr_only");
    expect(v.outOfScope[0]?.reason).toContain("wp_sftp");
  });
  it("still sends other theme paths and pr_only sprints to a person", () => {
    expect(evaluateWordPressChange("merge_seo_scope", [{ path: "wp:theme:functions.php", category: "other" }], { sftp: true }).decision).toBe("pr_only");
    expect(evaluateWordPressChange("pr_only", change, { sftp: true }).decision).toBe("pr_only");
  });
});
