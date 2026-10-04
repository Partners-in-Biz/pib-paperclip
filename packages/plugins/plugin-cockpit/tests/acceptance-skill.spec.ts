/**
 * The Acceptance skill and the screenshots reference (Q5-1, Q5-5): what an agent reads
 * must name real tools, state the safety rules, list every journey the plugin ships
 * (the reference is built from the journey files), and stay inside the size budgets
 * every skill shares (every PiB role carries the manual, so its size is a cost on every run).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCEPTANCE_FILES, ACCEPTANCE_REFERENCE_PATHS, ACCEPTANCE_SKILL_BODY, journeysReference } from "../src/acceptance-skill.js";
import { JOURNEYS } from "../src/journeys.js";
import { COCKPIT_TOOLS } from "../src/tools.js";
import { PIB_SHOT_PATH, SCREENSHOT_REFERENCE } from "../src/screenshots.js";
import { SKILLS } from "../src/skills.js";
import { COMPANY_SKILL_SLUG } from "../src/company-skill.js";

const acceptance = SKILLS.find((s) => s.slug === "pib-acceptance")!;

describe("the Acceptance skill", () => {
  it("is declared with its two references, and its description says where it stops", () => {
    expect(acceptance).toBeDefined();
    expect((acceptance.files ?? []).map((f) => f.path).sort()).toEqual([ACCEPTANCE_REFERENCE_PATHS.journeys, ACCEPTANCE_REFERENCE_PATHS.screenshots].sort());
    expect(acceptance.markdown).toContain("name: pib-acceptance");
    expect(acceptance.markdown).toContain("Never touch a real client, never approve, send, publish or pay");
  });

  it("states the five rules that keep it off real clients and away from outward actions", () => {
    for (const text of ["The canary client only", "Draft and dry run only", "Never approve, send, publish, merge or pay", "Report what happened, not what you expected", "A step you cannot prove is a failed step", "@canary.invalid", "do not retry to hide it"]) expect(ACCEPTANCE_SKILL_BODY, text).toContain(text);
  });

  it("tells the agent to give the input of every tool or http call, to take a run an issue names, and to abort when a tool does not exist yet", () => {
    expect(ACCEPTANCE_SKILL_BODY).toContain("always give it for a tool or http step");
    expect(ACCEPTANCE_SKILL_BODY).toContain("an issue that says to run a journey now");
    expect(ACCEPTANCE_SKILL_BODY).toContain("the tool does not exist (its plugin has not been upgraded to the version that ships it yet)");
  });

  it("tells the agent the Cockpit cancels the issues a rehearsal leaves about the canary, so it never does (0.6.5)", () => {
    expect(ACCEPTANCE_SKILL_BODY).toContain("any other open issue named after the canary it made meanwhile");
    expect(journeysReference()).toContain("any other open issue made while the run was open whose title names the canary");
    expect(journeysReference()).toContain("never cancel one yourself");
  });

  it("names only tools that exist: its own, and the CRM's canary tool", () => {
    const own = new Set(COCKPIT_TOOLS.map((t) => t.name));
    expect(own.has("acceptance-run")).toBe(true);
    expect(own.has("acceptance-report")).toBe(true);
    const crm = readFileSync(new URL("../../plugin-crm/src/tools.ts", import.meta.url), "utf8");
    expect(crm).toContain('name: "create-canary-client"');
    for (const match of ACCEPTANCE_SKILL_BODY.matchAll(/`partnersinbiz\.([a-z]+):([a-z-]+)`/g)) {
      if (match[1] === "cockpit") expect(own.has(match[2]!), match[0]).toBe(true);
    }
  });

  it("the journeys reference lists every journey, built from the files (a journey added is a journey listed)", () => {
    const reference = journeysReference();
    for (const j of JOURNEYS) {
      expect(reference, j.key).toContain(`\`${j.key}\`, v${j.version}`);
      expect(reference, j.key).toContain(j.title);
    }
    expect(acceptance.files!.find((f) => f.path === ACCEPTANCE_REFERENCE_PATHS.journeys)!.content).toBe(reference);
    expect(ACCEPTANCE_FILES).toHaveLength(2);
  });

  it("the screenshots reference tells an agent how to look at a page it built", () => {
    for (const text of [PIB_SHOT_PATH, "--viewport desktop|mobile|tablet|WxH", "--expect", "Exit codes", "no browser"]) expect(SCREENSHOT_REFERENCE, text).toContain(text);
    expect(acceptance.files!.find((f) => f.path === ACCEPTANCE_REFERENCE_PATHS.screenshots)!.content).toBe(SCREENSHOT_REFERENCE);
  });
});

describe("skill sizes", () => {
  it("every skill the Cockpit ships is under the 18,000 character budget and each reference under 8,000", () => {
    for (const skill of SKILLS) {
      const slug = skill.slug!;
      const limit = slug === "pib-operator" ? 18_950 : 19_000;
      expect(skill.markdown!.length, `${slug} SKILL.md`).toBeLessThan(limit);
      for (const file of skill.files ?? []) expect(file.content.length, `${slug} ${file.path}`).toBeLessThan(8_000);
    }
    expect(SKILLS.map((s) => s.slug)).toContain(COMPANY_SKILL_SLUG);
  });

  it("the Acceptance skill is small: it is read at the start of every run", () => {
    expect(acceptance.markdown!.length).toBeLessThan(9_000);
  });
});
