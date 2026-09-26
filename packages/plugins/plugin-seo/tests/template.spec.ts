import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIRECTORIES,
  dueDayFor,
  OUTRANK_90,
  phaseForWeek,
  TEMPLATE_ID,
  TEMPLATE_VERSION,
} from "../src/templates/outrank-90.js";
import { PLAYBOOKS, playbookFor } from "../src/templates/playbooks.js";
import { SEO_TOOL_DECLARATIONS } from "../src/tools.js";

describe("Outrank-90 template", () => {
  it("has the 42 tasks with unique stable keys", () => {
    expect(TEMPLATE_ID).toBe("outrank-90");
    expect(TEMPLATE_VERSION).toBe(3);
    expect(OUTRANK_90.tasks).toHaveLength(42);
    const keys = OUTRANK_90.tasks.map((t) => t.templateKey);
    expect(new Set(keys).size).toBe(42);
    for (const key of keys) expect(key).toMatch(/^w\d{1,2}-[a-z0-9-]+$/);
  });

  it("keeps weeks 0–13 and derives phases from weeks", () => {
    for (const task of OUTRANK_90.tasks) {
      expect(task.week).toBeGreaterThanOrEqual(0);
      expect(task.week).toBeLessThanOrEqual(13);
      expect(task.phase).toBe(phaseForWeek(task.week));
      expect(task.templateKey.startsWith(`w${task.week}-`)).toBe(true);
    }
    expect(new Set(OUTRANK_90.tasks.map((t) => t.week)).size).toBe(14);
    const perWeek = (w: number) => OUTRANK_90.tasks.filter((t) => t.week === w).length;
    expect([0, 1, 2, 3, 4, 13].map(perWeek)).toEqual([7, 7, 4, 3, 2, 3]);
  });

  it("ports the old autopilot flags and task types", () => {
    const byKey = Object.fromEntries(OUTRANK_90.tasks.map((t) => [t.templateKey, t]));
    expect(byKey["w0-meta-tags"]).toMatchObject({ taskType: "meta-tag-audit", autopilotEligible: true, internalToolPath: "/admin/seo/tools#metadata-check" });
    // v3: verification runs through the service account and the site repo (SEO scope).
    expect(byKey["w0-gsc-verify"]).toMatchObject({ taskType: "gsc-verify", owner: "agent", autopilotEligible: true });
    expect(byKey["w9-directories"]).toMatchObject({ taskType: "directory-submission", autopilotEligible: true });
    expect(byKey["w5-post-1"]).toMatchObject({ taskType: "post-publish", autopilotEligible: false });
    expect(OUTRANK_90.tasks.filter((t) => t.autopilotEligible)).toHaveLength(30);
  });

  it("has no person tasks in v3 (grants and personal messages go to the Needs you digest)", () => {
    expect(OUTRANK_90.tasks.filter((t) => t.owner === "human")).toEqual([]);
    const signoff = OUTRANK_90.tasks.filter((t) => !t.autopilotEligible).map((t) => t.taskType).sort();
    expect(signoff).toContain("link-trade-dm");
    expect(signoff).toContain("community-post");
    expect(signoff).not.toContain("alt-text-audit");
  });

  it("makes the Day 90 audit due on day 90 and pre-launch immediately", () => {
    expect(dueDayFor(0)).toBeNull();
    expect(dueDayFor(1)).toBe(1);
    expect(dueDayFor(2)).toBe(8);
    expect(dueDayFor(13)).toBe(85);
    for (const task of OUTRANK_90.tasks.filter((t) => t.week === 13)) expect(dueDayFor(task.week, task.dueDay)).toBe(90);
  });

  it("seeds the 15 directories with DR", () => {
    expect(DEFAULT_DIRECTORIES).toHaveLength(15);
    expect(new Set(DEFAULT_DIRECTORIES.map((d) => d.domain)).size).toBe(15);
    for (const dir of DEFAULT_DIRECTORIES) expect(dir.dr).toBeGreaterThan(0);
    expect(DEFAULT_DIRECTORIES.find((d) => d.domain === "g2.com")?.dr).toBe(90);
  });

  it("has a playbook for every task and only real tools in playbooks", () => {
    const tools = new Set(SEO_TOOL_DECLARATIONS.map((t) => t.name));
    for (const task of OUTRANK_90.tasks) {
      expect(PLAYBOOKS[task.playbook], task.templateKey).toBeDefined();
    }
    for (const [key, playbook] of Object.entries(PLAYBOOKS)) {
      expect(playbook.steps.length, key).toBeGreaterThan(0);
      for (const tool of playbook.tools) {
        if (!tool.includes(":")) expect(tools.has(tool), `${key} → ${tool}`).toBe(true);
      }
    }
    expect(playbookFor("missing").goal).toBe(PLAYBOOKS.custom!.goal);
  });
});
