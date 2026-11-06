/** PAR-7946: the company `higgsfield` skill sends agents to the Studio tools only, never the provider API or a key. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STUDIO_TOOLS } from "../src/tools.js";

const md = readFileSync(new URL("../skills/higgsfield/SKILL.md", import.meta.url), "utf8");

describe("higgsfield skill", () => {
  it("keeps the company skill's name, so the cut-over replaces it in place", () => {
    expect(md.startsWith("---\nname: higgsfield\n")).toBe(true);
    expect(md).toMatch(/^description: .*Studio/m);
  });

  it("names every Studio tool, and only tools Studio registers", () => {
    const registered = new Set(STUDIO_TOOLS.map((t) => t.name));
    for (const name of registered) expect(md, name).toContain(`\`${name}\``);
    const named = [...md.matchAll(/`(studio-[a-z-]+)`/g)].map((m) => m[1]!);
    expect(named.filter((n) => !registered.has(n))).toEqual([]);
  });

  it("has no provider key, script, REST URL or MCP instructions left", () => {
    for (const old of ["HF_KEY", "HIGGSFIELD_API_KEY", "HIGGSFIELD_SECRET", "hf.py", "python3", "platform.higgsfield.ai", "preflight_check", "generate_image", "get_balance"]) {
      expect(md, old).not.toContain(old);
    }
    expect(md).toContain("Do not call the Higgsfield REST API");
  });

  it("estimates before generating and waits for the wake instead of polling", () => {
    expect(md.indexOf("`studio-estimate`")).toBeLessThan(md.indexOf("`studio-generate`"));
    expect(md).toContain("Do not poll");
    expect(md).toContain("monitor");
  });

  it("keeps the review gate and the Drive rules", () => {
    expect(md).toContain("generating an asset is not approval to post it");
    expect(md).toContain("Never save to the Drive root");
  });
});
