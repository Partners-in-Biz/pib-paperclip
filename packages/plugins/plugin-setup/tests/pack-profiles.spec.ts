import { describe, expect, it } from "vitest";
import { PACK_MANIFEST_JSON } from "../src/pack/data.generated.js";
import { isDefaultOn, loadPack, packSources, parsePack, projectsHaveRepository, templateByKey } from "../src/templates.js";

function packWith(key: string, defaultOn: unknown) {
  const raw = structuredClone(PACK_MANIFEST_JSON) as { templates: Array<Record<string, unknown>> };
  raw.templates.find((template) => template.key === key)!.defaultOn = defaultOn;
  const { files, blocks } = packSources();
  return parsePack(raw, files, blocks);
}

describe("the pack's hosting profiles", () => {
  it("keeps the CEO on for both profiles and puts the dev chain behind a repository for clients", () => {
    const pack = loadPack();
    const ceo = pack.templates.find((template) => template.key === "ceo")!;
    expect(isDefaultOn(ceo, "pib", false)).toBe(true);
    expect(isDefaultOn(ceo, "client", false)).toBe(true);
    for (const key of ["delivery-lead", "planner", "plan-critic", "senior-developer", "developer", "code-reviewer"]) {
      const template = templateByKey(key)!;
      expect(isDefaultOn(template, "pib", false), `${key} pib`).toBe(true);
      expect(isDefaultOn(template, "client", false), `${key} client without a repository`).toBe(false);
      expect(isDefaultOn(template, "client", true), `${key} client with a repository`).toBe(true);
    }
  });

  it("leaves every marketing, support and optional template off for both profiles", () => {
    for (const template of loadPack().templates.filter((entry) => !["ceo", "delivery-lead", "planner", "plan-critic", "senior-developer", "developer", "code-reviewer"].includes(entry.key))) {
      expect(isDefaultOn(template, "pib", true), template.key).toBe(false);
      expect(isDefaultOn(template, "client", true), template.key).toBe(false);
    }
  });

  it("reads defaultOn as a boolean for both profiles, or as { pib, client }", () => {
    const same = packWith("developer", true).pack!.templates.find((template) => template.key === "developer")!;
    expect(same.defaultOnClient).toBeUndefined();
    expect(isDefaultOn(same, "client", false)).toBe(true);
    const split = packWith("developer", { pib: false, client: true }).pack!.templates.find((template) => template.key === "developer")!;
    expect(isDefaultOn(split, "pib", true)).toBe(false);
    expect(isDefaultOn(split, "client", false)).toBe(true);
  });

  it("rejects a defaultOn it cannot read", () => {
    expect(packWith("developer", { pib: true, client: "sometimes" }).problems.join(" ")).toContain('developer: defaultOn.client must be true, false or "repo"');
    expect(packWith("developer", { client: true }).problems.join(" ")).toContain("developer: defaultOn.pib must be true or false");
    expect(packWith("developer", "yes").problems.join(" ")).toContain("developer: defaultOn must be true, false or { pib, client }");
  });
});

describe("projectsHaveRepository", () => {
  it("is true when a live project has a repository on its codebase, primary workspace or any workspace", () => {
    expect(projectsHaveRepository([{ codebase: { repoUrl: "https://github.com/acme/site" } }])).toBe(true);
    expect(projectsHaveRepository([{ primaryWorkspace: { repoUrl: "https://github.com/acme/site" } }])).toBe(true);
    expect(projectsHaveRepository([{ workspaces: [{ repoUrl: null }, { repoUrl: "https://github.com/acme/site" }] }])).toBe(true);
  });

  it("is false for no projects, no repository, a blank url, an archived project or an unreadable list", () => {
    expect(projectsHaveRepository([])).toBe(false);
    expect(projectsHaveRepository([{ codebase: { repoUrl: null }, primaryWorkspace: null, workspaces: [] }])).toBe(false);
    expect(projectsHaveRepository([{ codebase: { repoUrl: "  " } }])).toBe(false);
    expect(projectsHaveRepository([{ archivedAt: "2026-10-01T00:00:00Z", codebase: { repoUrl: "https://github.com/acme/site" } }])).toBe(false);
    expect(projectsHaveRepository(null)).toBe(false);
    expect(projectsHaveRepository({ error: "nope" })).toBe(false);
  });
});
