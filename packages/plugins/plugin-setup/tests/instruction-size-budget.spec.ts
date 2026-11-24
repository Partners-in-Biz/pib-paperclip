import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PACK_AGENT_FILES, PACK_SHARED_BLOCKS } from "../src/pack/data.generated.js";
import { expandBlocks } from "../src/templates.js";

/** Core AGENTS.md limit (PAR-13541): agents re-read it every run, so keep it lean. */
const AGENTS_MD_CHAR_LIMIT = 14_000;

describe("agent template AGENTS.md size budget", () => {
  for (const [key, body] of Object.entries(PACK_AGENT_FILES)) {
    it(`${key} stays within ${AGENTS_MD_CHAR_LIMIT} chars (raw and block-expanded)`, () => {
      expect(body.length, `${key} raw`).toBeLessThanOrEqual(AGENTS_MD_CHAR_LIMIT);
      expect(expandBlocks(body, PACK_SHARED_BLOCKS).length, `${key} expanded`).toBeLessThanOrEqual(AGENTS_MD_CHAR_LIMIT);
    });
  }
});

describe("paperclip skill core size budget", () => {
  const skillDir = new URL("../../../../skills/paperclip/", import.meta.url);
  const skill = readFileSync(new URL("SKILL.md", skillDir), "utf8");

  it("SKILL.md is at most 10,000 chars", () => {
    expect(skill.length).toBeLessThanOrEqual(10_000);
  });

  it("every references/*.md file linked from SKILL.md exists", () => {
    const links = [...skill.matchAll(/\]\((references\/[^)#\s]+)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const rel of links) {
      expect(() => readFileSync(fileURLToPath(new URL(rel, skillDir)), "utf8"), rel).not.toThrow();
    }
  });
});
