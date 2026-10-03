import { describe, expect, it } from "vitest";
import { canHire, defaultHireAssignee, hiringLine, NO_HIRING_FIX, pickHiringAgent, teamAgentCandidate, toHiringCandidate, toHiringCandidates } from "../src/hiring.js";

/** The agents of both live companies on 2026-10-03, trimmed to what hiring looks at (permissions as the host stores them). */
const perms = { canCreateAgents: true, canCreateSkills: true };
const par = [
  { id: "pib", name: "PiB", role: "general", title: "CEO", status: "idle", reportsTo: null, permissions: perms },
  { id: "op", name: "Operator", role: "general", title: "Chief of staff", status: "idle", reportsTo: "pib", permissions: perms },
  { id: "dl", name: "Delivery Lead", role: "general", title: "Delivery Lead", status: "idle", reportsTo: "pib", permissions: perms },
  { id: "dev", name: "Developer", role: "engineer", title: "Software Engineer", status: "idle", reportsTo: "dl", permissions: perms },
  { id: "sum", name: "Summarizer", role: "general", title: "Summarizer", status: "idle", reportsTo: "pib", permissions: { canCreateAgents: false, canCreateSkills: false } },
];
const para = [
  { id: "steve", name: "Steve", role: "general", title: "", status: "idle", reportsTo: null, permissions: perms },
  { id: "arjun", name: "Arjun", role: "engineer", title: "Engineering Lead", status: "idle", reportsTo: "steve", permissions: perms },
  { id: "kai", name: "Kai", role: "engineer", title: "App Engineer", status: "idle", reportsTo: "arjun", permissions: perms },
];

describe("who does the hiring", () => {
  it("is the agent whose title says CEO when no agent has role ceo (live Partners in Biz: PiB)", () => {
    const pick = pickHiringAgent(toHiringCandidates(par));
    expect(pick.agent?.id).toBe("pib");
    expect(pick.source).toBe("title");
    expect(pick.problem).toBeNull();
    expect(hiringLine(pick)).toBe("PiB does the hiring (its title is CEO).");
  });

  it("is the head of the org chart when it is the only one (live Partners in Apps: Steve has no title)", () => {
    const pick = pickHiringAgent(toHiringCandidates(para));
    expect(pick.agent?.id).toBe("steve");
    expect(pick.source).toBe("head");
    expect(hiringLine(pick)).toBe("Steve does the hiring (it is the head of the org chart).");
  });

  it("prefers role ceo over a title, and a title over the head", () => {
    const agents = toHiringCandidates([
      ...par,
      { id: "real", name: "Real CEO", role: "ceo", title: "", status: "idle", reportsTo: null, permissions: perms },
    ]);
    expect(pickHiringAgent(agents)).toMatchObject({ agent: { id: "real" }, source: "role" });
    expect(pickHiringAgent(agents).alternatives.map((agent) => agent.id)).toContain("pib");
    expect(pickHiringAgent(toHiringCandidates([{ id: "x", name: "X", role: "general", title: "Chief Executive Officer", status: "idle", reportsTo: null, permissions: perms }])).source).toBe("title");
  });

  it("skips a CEO that cannot take work now (paused, in error, awaiting approval) or may not create agents", () => {
    for (const status of ["paused", "error", "pending_approval", "terminated"]) {
      const agents = toHiringCandidates(par.map((agent) => (agent.id === "pib" ? { ...agent, status } : agent)));
      expect(pickHiringAgent(agents).agent?.id, status).not.toBe("pib");
    }
    const off = toHiringCandidates(par.map((agent) => (agent.id === "pib" ? { ...agent, permissions: { canCreateAgents: false } } : agent)));
    expect(canHire(off.find((agent) => agent.id === "pib")!)).toBe(false);
    expect(pickHiringAgent(off).agent).toBeNull();
  });

  it("treats a head whose boss was terminated as a head", () => {
    const agents = toHiringCandidates([
      { id: "gone", name: "Gone", role: "general", title: "CEO", status: "terminated", reportsTo: null, permissions: perms },
      { id: "a", name: "A", role: "general", title: "", status: "idle", reportsTo: "gone", permissions: perms },
      { id: "b", name: "B", role: "general", title: "", status: "idle", reportsTo: "a", permissions: perms },
    ]);
    expect(pickHiringAgent(agents)).toMatchObject({ agent: { id: "a" }, source: "head" });
  });

  it("shows the problem and the fix when nobody can hire", () => {
    const empty = pickHiringAgent([]);
    expect(empty.agent).toBeNull();
    expect(empty.problem).toMatch(/no agent yet/);
    expect(empty.fix).toBe(NO_HIRING_FIX);
    expect(NO_HIRING_FIX).toMatch(/Agents -> New agent, role CEO/);
    expect(NO_HIRING_FIX).toMatch(/new-company\.py --create-ceo/);

    const twoHeads = pickHiringAgent(toHiringCandidates([
      { id: "a", name: "Ann", role: "general", title: "", status: "idle", reportsTo: null, permissions: perms },
      { id: "b", name: "Bo", role: "general", title: "", status: "idle", reportsTo: null, permissions: perms },
    ]));
    expect(twoHeads.agent).toBeNull();
    expect(twoHeads.problem).toMatch(/2 agents sit at the top of the org chart \(Ann, Bo\)/);

    const allPaused = pickHiringAgent(toHiringCandidates(par.map((agent) => ({ ...agent, status: "paused" }))));
    expect(allPaused.problem).toMatch(/every agent is paused, in error, awaiting approval, terminated/);
    expect(hiringLine(allPaused)).toBe(allPaused.problem);
  });

  it("reads host agent records and Team page agents the same way", () => {
    expect(toHiringCandidate({ id: "1", name: "A", permissions: { canCreateAgents: false } })).toMatchObject({ canCreateAgents: false, reportsTo: null, title: null });
    expect(toHiringCandidate({ id: "1", name: "A" })).toMatchObject({ canCreateAgents: null });
    expect(toHiringCandidate({ name: "no id" })).toBeNull();
    expect(toHiringCandidates("nope")).toEqual([]);
    expect(teamAgentCandidate({ id: "1", name: "A", status: "idle", role: "ceo", canCreateAgents: undefined })).toMatchObject({ role: "ceo", canCreateAgents: null });
    // An agent record that does not say stays allowed: the host default is on.
    expect(canHire(toHiringCandidate({ id: "1", name: "A", status: "idle" })!)).toBe(true);
  });

  it("makes Setup's hiring agent the default assignee, ahead of the plugin's own default", () => {
    const pick = pickHiringAgent(toHiringCandidates(par));
    expect(defaultHireAssignee(pick, "other-agent")).toBe("pib");
    expect(defaultHireAssignee(null, "other-agent")).toBe("other-agent");
    expect(defaultHireAssignee(pickHiringAgent([]), undefined)).toBeNull();
  });
});
