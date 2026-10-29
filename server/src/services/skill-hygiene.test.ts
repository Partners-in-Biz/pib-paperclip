import { describe, expect, it } from "vitest";
import {
  hygieneSkillFromApi,
  isProtectedSkill,
  planSkillHygiene,
  type HygieneSkill,
} from "./skill-hygiene.js";

function skill(overrides: Partial<HygieneSkill> & Pick<HygieneSkill, "key" | "name">): HygieneSkill {
  return {
    description: null,
    managedBy: "agent",
    sourceType: "local_path",
    sourceBadge: "paperclip",
    useCount: 1,
    viewCount: 1,
    ageDays: 30,
    ...overrides,
  };
}

const sameScenario = "retry local firestore writes before you read them back";

describe("skill hygiene protection", () => {
  it("protects a skill with no agent marker", () => {
    const human = skill({ key: "company/brand-rules", name: "brand-rules", managedBy: null, description: sameScenario });
    expect(isProtectedSkill(human)).toBe(true);
    const plan = planSkillHygiene([
      human,
      skill({ key: "agent/firestore-offline", name: "firestore-offline", description: sameScenario }),
    ]);
    expect(plan.mergeProposals).toEqual([]);
    expect(plan.archiveProposals).toEqual([]);
    expect(plan.protectedCount).toBe(1);
    expect(plan.sessionIndex).not.toContain("brand-rules");
  });

  it("protects installed skills even when mis-marked as agent-owned", () => {
    for (const installed of [
      skill({ key: "plugin/paperclip/reflection-coach", name: "reflection-coach", sourceBadge: "catalog", sourceType: "catalog" }),
      skill({ key: "paperclipai/paperclip/first-task", name: "first-task", sourceBadge: "paperclip" }),
      skill({ key: "local/github-skill", name: "github-skill", sourceBadge: "github" }),
    ]) {
      expect(isProtectedSkill(installed)).toBe(true);
    }
  });
});

describe("skill hygiene merge and archive", () => {
  it("merges near-duplicates and keeps the higher-use skill", () => {
    const plan = planSkillHygiene([
      skill({
        key: "agent/firestore-offline-retry",
        name: "firestore-offline-retry",
        description: `${sameScenario} from cache`,
        useCount: 1,
        viewCount: 2,
      }),
      skill({
        key: "agent/firestore-offline-write",
        name: "firestore-offline-write",
        description: sameScenario,
        useCount: 4,
        viewCount: 1,
      }),
      skill({ key: "company/human", name: "human-skill", managedBy: null, description: sameScenario, useCount: 0, viewCount: 0 }),
    ]);
    expect(plan.mergeProposals).toEqual([
      expect.objectContaining({
        keepKey: "agent/firestore-offline-write",
        absorbKey: "agent/firestore-offline-retry",
      }),
    ]);
    expect(plan.mergeProposals[0].sharedTokens).toBeGreaterThanOrEqual(3);
    expect(plan.mergeProposals[0].overlap).toBeGreaterThanOrEqual(0.5);
    expect(plan.archiveProposals).toEqual([]);
    expect(plan.skillCountBefore).toBe(3);
    expect(plan.skillCountAfterIfApplied).toBe(2);
  });

  it("does not merge on a short overlap", () => {
    const plan = planSkillHygiene([
      skill({ key: "agent/a", name: "login-fix", description: "reset the session cookie" }),
      skill({ key: "agent/b", name: "login-fix", description: "rotate the signing key" }),
    ]);
    expect(plan.mergeProposals).toEqual([]);
  });

  it("archives an unused agent skill and leaves unknown usage alone", () => {
    const plan = planSkillHygiene([
      skill({
        key: "agent/old-unused",
        name: "old-unused",
        description: "a lesson nobody loaded",
        useCount: 0,
        viewCount: 0,
        ageDays: 14,
      }),
      skill({
        key: "agent/young-unused",
        name: "young-unused",
        description: "too new to archive",
        useCount: 0,
        viewCount: 0,
        ageDays: 13,
      }),
      skill({
        key: "agent/unknown-usage",
        name: "unknown-usage",
        description: "no counter yet",
        useCount: null,
        viewCount: null,
        ageDays: 40,
      }),
    ]);
    expect(plan.archiveProposals.map((item) => item.key)).toEqual(["agent/old-unused"]);
    expect(plan.skillCountAfterIfApplied).toBe(2);
  });

  it("does not archive the skill a merge keeps", () => {
    const plan = planSkillHygiene([
      skill({
        key: "agent/keep",
        name: "firestore-offline-write",
        description: sameScenario,
        useCount: 0,
        viewCount: 0,
        ageDays: 20,
      }),
      skill({
        key: "agent/absorb",
        name: "firestore-offline-retry",
        description: `${sameScenario} from cache`,
        useCount: 0,
        viewCount: 0,
        ageDays: 20,
      }),
    ]);
    expect(plan.mergeProposals).toHaveLength(1);
    expect(plan.archiveProposals).toEqual([]);
    expect(plan.skillCountAfterIfApplied).toBe(1);
  });

  it("builds an index of agent-owned skills only, with a 60 character description", () => {
    const long = "x".repeat(80);
    const plan = planSkillHygiene([
      skill({ key: "agent/firestore-offline", name: "firestore-offline", description: long }),
      skill({ key: "company/secret", name: "secret-human", managedBy: "human", description: "do not list" }),
    ]);
    expect(plan.sessionIndex).toContain("## firestore");
    expect(plan.sessionIndex).toContain(`- firestore-offline: ${"x".repeat(60)}`);
    expect(plan.sessionIndex).not.toContain("secret-human");
    expect(plan.agentOwnedCount).toBe(1);
  });

  it("maps an API row as protected when the owner marker is missing", () => {
    const mapped = hygieneSkillFromApi({
      key: "company/brand-rules",
      name: "brand-rules",
      sourceType: "local_path",
      sourceBadge: "paperclip",
    });
    expect(isProtectedSkill(mapped)).toBe(true);
    expect(mapped.useCount).toBeNull();
  });
});
