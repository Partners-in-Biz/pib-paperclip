import { describe, expect, it } from "vitest";
import { CLIENT_PROJECT_KINDS, groupProjectsByKind, missingKindHints } from "../src/project-groups.js";

describe("groupProjectsByKind", () => {
  it("groups projects by kind in the specified order", () => {
    const projects = [
      { projectId: "1", name: "Social media", kind: "social" },
      { projectId: "2", name: "Website", kind: "website" },
      { projectId: "3", name: "SEO audit", kind: "seo" },
      { projectId: "4", name: "App platform", kind: "app" },
    ];

    const groups = groupProjectsByKind(projects);

    expect(groups).toHaveLength(4);
    expect(groups[0].kind).toBe("website");
    expect(groups[0].label).toBe("Website");
    expect(groups[1].kind).toBe("seo");
    expect(groups[1].label).toBe("SEO");
    expect(groups[2].kind).toBe("social");
    expect(groups[2].label).toBe("Social");
    expect(groups[3].kind).toBe("app");
    expect(groups[3].label).toBe("App");
  });

  it("groups null kind as 'Not typed yet' at the end", () => {
    const projects = [
      { projectId: "1", name: "Project A", kind: "website" },
      { projectId: "2", name: "Project B", kind: null },
      { projectId: "3", name: "Project C", kind: null },
    ];

    const groups = groupProjectsByKind(projects);

    expect(groups).toHaveLength(2);
    expect(groups[0].kind).toBe("website");
    expect(groups[1].kind).toBeNull();
    expect(groups[1].label).toBe("Not typed yet");
    expect(groups[1].projects).toHaveLength(2);
  });

  it("omits empty groups", () => {
    const projects = [
      { projectId: "1", name: "Website", kind: "website" },
    ];

    const groups = groupProjectsByKind(projects);

    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("website");
  });

  it("groups other kinds in CLIENT_PROJECT_KINDS order", () => {
    const projects = [
      { projectId: "1", name: "Campaigns", kind: "campaigns" },
      { projectId: "2", name: "Ads", kind: "ads" },
      { projectId: "3", name: "Platform", kind: "platform" },
      { projectId: "4", name: "Book", kind: "book" },
    ];

    const groups = groupProjectsByKind(projects);

    expect(groups.map((g) => g.kind)).toEqual(["ads", "campaigns", "book", "platform"]);
  });

  it("handles unknown kinds in their own group before 'Not typed yet'", () => {
    const projects = [
      { projectId: "1", name: "Unknown type", kind: "unknown-type" },
      { projectId: "2", name: "Not typed", kind: null },
      { projectId: "3", name: "Website", kind: "website" },
    ];

    const groups = groupProjectsByKind(projects);

    expect(groups).toHaveLength(3);
    expect(groups[0].kind).toBe("website");
    expect(groups[1].kind).toBe("unknown-type");
    expect(groups[1].label).toBe("Unknown-type");
    expect(groups[2].kind).toBeNull();
    expect(groups[2].label).toBe("Not typed yet");
  });

  it("maintains stable input order within each group", () => {
    const projects = [
      { projectId: "3", name: "Website C", kind: "website" },
      { projectId: "1", name: "Website A", kind: "website" },
      { projectId: "2", name: "Website B", kind: "website" },
    ];

    const groups = groupProjectsByKind(projects);

    expect(groups[0].projects.map((p) => p.projectId)).toEqual(["3", "1", "2"]);
  });

  it("sum of all group sizes equals input length", () => {
    const projects = [
      { projectId: "1", name: "Website", kind: "website" },
      { projectId: "2", name: "SEO", kind: "seo" },
      { projectId: "3", name: "Social", kind: "social" },
      { projectId: "4", name: "Not typed", kind: null },
      { projectId: "5", name: "Unknown", kind: "custom-type" },
    ];

    const groups = groupProjectsByKind(projects);
    const totalProjects = groups.reduce((sum, g) => sum + g.projects.length, 0);

    expect(totalProjects).toBe(projects.length);
  });
});

describe("missingKindHints", () => {
  it("returns no hints when all primary kinds are present", () => {
    const projects = [
      { projectId: "1", name: "Website", kind: "website" },
      { projectId: "2", name: "SEO", kind: "seo" },
      { projectId: "3", name: "Social", kind: "social" },
    ];

    const hints = missingKindHints(projects);

    expect(hints).toEqual([]);
  });

  it("returns hints for missing primary kinds", () => {
    const projects = [
      { projectId: "1", name: "Website", kind: "website" },
    ];

    const hints = missingKindHints(projects);

    expect(hints).toEqual(["No SEO or Social projects linked yet."]);
  });

  it("returns hints for all missing primary kinds", () => {
    const projects = [
      { projectId: "1", name: "App", kind: "app" },
    ];

    const hints = missingKindHints(projects);

    expect(hints).toEqual(["No Website, SEO or Social projects linked yet."]);
  });

  it("returns no hints when there are no projects", () => {
    const projects: Array<{ kind?: string | null; [key: string]: unknown }> = [];

    const hints = missingKindHints(projects);

    expect(hints).toEqual([]);
  });

  it("ignores non-primary kinds when checking for hints", () => {
    const projects = [
      { projectId: "1", name: "App", kind: "app" },
      { projectId: "2", name: "Ads", kind: "ads" },
    ];

    const hints = missingKindHints(projects);

    expect(hints).toEqual(["No Website, SEO or Social projects linked yet."]);
  });

  it("handles single missing kind with singular noun", () => {
    const projects = [
      { projectId: "1", name: "SEO", kind: "seo" },
      { projectId: "2", name: "Social", kind: "social" },
    ];

    const hints = missingKindHints(projects);

    expect(hints).toEqual(["No Website project linked yet."]);
  });
});
