import { describe, expect, it } from "vitest";
import {
  COMPANY_MEMORY_HEADING,
  COMPANY_MEMORY_INSTRUCTION,
  COMPANY_MEMORY_SECTION,
  isMemoryArea,
  isMemoryKind,
  MEMORY_LIMITS,
  memoryAreaForOrigin,
  memoryAreaForPlugin,
  memoryTool,
  withCompanyMemory,
} from "../src/memory.js";
import { withFrontmatter } from "../src/skills.js";
import { hireTaskDraft, withMemoryInstruction, type HireRole } from "../src/agent-hire.js";

describe("company memory contract", () => {
  it("names the Cockpit tools", () => {
    expect(memoryTool("memory-recall")).toBe("partnersinbiz.cockpit:memory-recall");
    expect(COMPANY_MEMORY_SECTION).toContain("partnersinbiz.cockpit:memory-recall");
    expect(COMPANY_MEMORY_SECTION).toContain("partnersinbiz.cockpit:memory-add");
    expect(COMPANY_MEMORY_SECTION).toContain(`at most ${MEMORY_LIMITS.briefMaxFacts} facts`);
  });

  it("keeps the skill section short", () => {
    // Appended to every PiB skill: it must stay small so skills do not bloat context.
    expect(COMPANY_MEMORY_SECTION.length).toBeLessThan(1800);
  });

  it("maps plugins and issue origins to areas", () => {
    expect(memoryAreaForPlugin("partnersinbiz.seo")).toBe("seo");
    expect(memoryAreaForPlugin("partnersinbiz.cockpit")).toBe("operations");
    expect(memoryAreaForPlugin("acme.other")).toBeNull();
    expect(memoryAreaForOrigin("plugin:partnersinbiz.social")).toBe("social");
    expect(memoryAreaForOrigin("plugin:partnersinbiz.cockpit:health")).toBe("operations");
    expect(memoryAreaForOrigin("manual")).toBeNull();
    expect(memoryAreaForOrigin(null)).toBeNull();
    expect(isMemoryArea("seo")).toBe(true);
    expect(isMemoryArea("marketing")).toBe(false);
    expect(isMemoryKind("lesson")).toBe(true);
    expect(isMemoryKind("note")).toBe(false);
  });

  it("appends the section once", () => {
    const once = withCompanyMemory("# Skill\n\nBody\n");
    expect(once).toContain(COMPANY_MEMORY_HEADING);
    expect(withCompanyMemory(once)).toBe(once);
    expect(once.split(COMPANY_MEMORY_HEADING)).toHaveLength(2);
  });

  it("withFrontmatter adds memory by default and can opt out", () => {
    const on = withFrontmatter({ name: "pib-x", description: "X" }, "# X\n");
    expect(on.startsWith("---\nname: pib-x\n")).toBe(true);
    expect(on).toContain(COMPANY_MEMORY_HEADING);
    const off = withFrontmatter({ name: "pib-x", description: "X", memory: false }, "# X\n");
    expect(off).not.toContain(COMPANY_MEMORY_HEADING);
  });

  it("hire drafts carry the memory line in AGENTS.md", () => {
    const role: HireRole = {
      pluginKey: "partnersinbiz.test",
      pluginName: "Test",
      roleKey: "tester",
      displayName: "Tess",
      title: "Tester",
      role: "general",
      capabilities: "Tests things.",
      adapterPreference: ["claude_local"],
      skills: [],
      budgetMonthlyCents: 0,
      instructions: "You test things.",
      pluginSetup: [],
      toolPlugins: [],
    };
    expect(hireTaskDraft(role).description).toContain(COMPANY_MEMORY_INSTRUCTION);
    expect(withMemoryInstruction(withMemoryInstruction("A"))).toBe(`A\n\n${COMPANY_MEMORY_INSTRUCTION}`);
  });
});
