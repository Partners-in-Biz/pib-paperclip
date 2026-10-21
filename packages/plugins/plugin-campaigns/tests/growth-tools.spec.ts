import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GROWTH_TOOL_NAMES } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import { GROWTH_LAB_REFERENCE } from "../src/skill-references.js";
import { SKILLS } from "../src/skills.js";

const names = (manifest.tools ?? []).map((t) => t.name);

describe("growth lab wiring", () => {
  it("the manifest declares the eight growth tools once each", () => {
    for (const name of GROWTH_TOOL_NAMES) expect(names.filter((n) => n === name), name).toHaveLength(1);
  });

  it("scope takes own and client only (015 limits client_kind to company and contact)", () => {
    const review = manifest.tools!.find((t) => t.name === "performance-review")!;
    const scope = (review.parametersSchema as { properties: Record<string, { description: string }> }).properties.scope!;
    expect(scope.description).toContain("Supported here: own, client");
    expect(scope.description).not.toMatch(/Supported here:.*product/);
  });

  it("the worker registers the growth tools through the factory, not the campaign dispatcher", () => {
    const worker = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
    expect(worker).toContain("registerGrowthTools(ctx, campaignsGrowthToolsHost(ctx))");
    expect(worker).toContain("GROWTH_TOOL_NAMES");
  });

  it("the skill ships growth-lab.md, which names all eight tools and no unknown tool", () => {
    const skill = SKILLS.find((s) => s.skillKey === "campaigns")!;
    expect(skill.files?.map((f) => f.path)).toContain("references/growth-lab.md");
    for (const name of GROWTH_TOOL_NAMES) expect(GROWTH_LAB_REFERENCE, name).toContain(`\`${name}\``);
    const known = new Set<string>([...GROWTH_TOOL_NAMES, "measure-experiments", ...names]);
    const named = [...GROWTH_LAB_REFERENCE.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)].map((m) => m[1]!);
    expect(named.filter((n) => !known.has(n))).toEqual([]);
  });
});
