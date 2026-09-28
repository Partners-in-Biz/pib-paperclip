import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { operatorAgentId, reviewerAgentId, roleAgentUsable, routeRole, routeWork, suppressionEmail, suppressionScope, teamAgentId, type RolesPayload } from "../src/cockpit.js";
import { COMPANY_OS_HIRE_SKILL, hireSkills, hireTaskDraft, matchesRole, type HireRole } from "../src/agent-hire.js";
import { COMPANY_OS_SKILL } from "../src/asking.js";
import { COMPANY_OS_SKILL_KEY } from "../src/team.js";
import { reopenApprovalForPerson } from "../src/issues.js";

function fakeCtx(roles: Partial<RolesPayload> | null) {
  const updates: unknown[] = [];
  const comments: string[] = [];
  const ctx = {
    state: { get: vi.fn(async () => (roles ? { companyId: "c1", operatorAgentId: null, reviewerAgentId: null, ownerUserId: null, reviewOutward: false, updatedAt: "2026-09-27T00:00:00Z", ...roles } : null)) },
    issues: {
      update: vi.fn(async (_id: string, patch: unknown) => {
        updates.push(patch);
      }),
      createComment: vi.fn(async (_id: string, body: string) => {
        comments.push(body);
      }),
    },
    logger: { info: vi.fn() },
  } as unknown as PluginContext;
  return { ctx, updates, comments };
}

describe("hand-off helpers", () => {
  it("suppresses marketing on unsubscribe and everything on a hard bounce", () => {
    expect(suppressionScope("unsubscribed")).toBe("marketing");
    expect(suppressionScope("complained")).toBe("marketing");
    expect(suppressionScope("bounced")).toBe("all");
    expect(suppressionEmail("  Jane@Example.COM ")).toBe("jane@example.com");
  });

  it("skips a Reviewer or Operator that is not running", async () => {
    expect(roleAgentUsable(undefined)).toBe(true);
    expect(roleAgentUsable("idle")).toBe(true);
    expect(roleAgentUsable("paused")).toBe(false);
    expect(roleAgentUsable("terminated")).toBe(false);
    expect(await reviewerAgentId(fakeCtx({ reviewOutward: true, reviewerAgentId: "r1" }).ctx, "c1")).toBe("r1");
    expect(await reviewerAgentId(fakeCtx({ reviewOutward: true, reviewerAgentId: "r1", reviewerStatus: "paused" }).ctx, "c1")).toBeNull();
    expect(await reviewerAgentId(fakeCtx({ reviewOutward: false, reviewerAgentId: "r1" }).ctx, "c1")).toBeNull();
    expect(await operatorAgentId(fakeCtx({ operatorAgentId: "o1", operatorStatus: "active" }).ctx, "c1")).toBe("o1");
    expect(await operatorAgentId(fakeCtx({ operatorAgentId: "o1", operatorStatus: "error" }).ctx, "c1")).toBeNull();
  });

  it("hands an agent-closed approval back to the approver, else the owner", async () => {
    const own = fakeCtx({ ownerUserId: "owner" });
    expect(await reopenApprovalForPerson(own.ctx, { issueId: "i1", companyId: "c1", what: "invoice INV-0001" })).toBe(true);
    expect(own.updates[0]).toEqual({ status: "todo", assigneeAgentId: null, assigneeUserId: "owner" });
    expect(own.comments[0]).toContain("invoice INV-0001");
    const approver = fakeCtx({ ownerUserId: "owner" });
    await reopenApprovalForPerson(approver.ctx, { issueId: "i1", companyId: "c1", userId: "approver" });
    expect(approver.updates[0]).toEqual({ status: "todo", assigneeAgentId: null, assigneeUserId: "approver" });
  });

  it("routes work to the first running role, then the Operator, then the owner", async () => {
    const team = { "account-manager": { agentId: "am", status: "idle" }, bookkeeper: { agentId: "bk", status: "paused" } };
    const ctx = fakeCtx({ operatorAgentId: "op", ownerUserId: "owner", team }).ctx;
    expect(await teamAgentId(ctx, "c1", "account-manager")).toBe("am");
    expect(await teamAgentId(ctx, "c1", "bookkeeper")).toBeNull();
    expect(await routeWork(ctx, "c1", ["account-manager"])).toEqual({ assigneeAgentId: "am", assigneeUserId: null, via: "account-manager" });
    expect(await routeWork(ctx, "c1", ["bookkeeper"])).toEqual({ assigneeAgentId: "op", assigneeUserId: null, via: "operator" });
    const noAgents = fakeCtx({ ownerUserId: "owner" }).ctx;
    expect(await routeWork(noAgents, "c1", ["bookkeeper"])).toEqual({ assigneeAgentId: null, assigneeUserId: "owner", via: "owner" });
    expect(await routeWork(fakeCtx(null).ctx, "c1", ["bookkeeper"])).toEqual({ assigneeAgentId: null, assigneeUserId: null, via: "none" });
  });

  it("routes a role's work down its cover chain", async () => {
    const team = { "account-manager": { agentId: "am", status: "idle" }, "deal-desk": { agentId: "dd", status: "error" } };
    const ctx = fakeCtx({ operatorAgentId: "op", ownerUserId: "owner", team }).ctx;
    expect(await routeRole(ctx, "c1", "deal-desk")).toEqual({ assigneeAgentId: "am", assigneeUserId: null, via: "account-manager" });
    const staffed = fakeCtx({ team: { ...team, "sales-lead": { agentId: "sl", status: "idle" } } }).ctx;
    expect(await routeRole(staffed, "c1", "sales-lead")).toEqual({ assigneeAgentId: "sl", assigneeUserId: null, via: "sales-lead" });
    expect(await routeRole(fakeCtx({ operatorAgentId: "op" }).ctx, "c1", "inbound-qualifier")).toEqual({ assigneeAgentId: "op", assigneeUserId: null, via: "operator" });
  });

  it("every hire gets the company operating manual", () => {
    expect(COMPANY_OS_SKILL.key).toBe(COMPANY_OS_SKILL_KEY);
    const role = { pluginKey: "p", pluginName: "P", roleKey: "r", displayName: "R", title: "Doer", role: "general", capabilities: "Does.", adapterPreference: [], skills: [{ key: "plugin/p/x", slug: "pib-x", purpose: "X" }], budgetMonthlyCents: 0, instructions: "Do.", pluginSetup: [], toolPlugins: [] } as HireRole;
    expect(hireSkills(role).map((s) => s.key)).toEqual(["plugin/p/x", COMPANY_OS_SKILL_KEY]);
    expect(hireSkills({ ...role, skills: [...role.skills, COMPANY_OS_HIRE_SKILL] })).toHaveLength(2);
    const draft = hireTaskDraft(role).description;
    expect(draft).toContain("pib-company-os");
    expect(draft).toContain("Setup → Team");
    expect(draft).not.toContain("Link agent");
  });

  it("an agent that only carries the operating manual does not match a hire", () => {
    const role = { pluginKey: "p", pluginName: "P", roleKey: "r", displayName: "Rae", title: "Doer", role: "general", capabilities: "Does.", adapterPreference: [], skills: [{ key: "plugin/p/x", slug: "pib-x", purpose: "X" }, COMPANY_OS_HIRE_SKILL], budgetMonthlyCents: 0, instructions: "Do.", pluginSetup: [], toolPlugins: [] } as HireRole;
    const withOs = { name: "Sam", adapterConfig: { paperclipSkillSync: { desiredSkills: [COMPANY_OS_SKILL_KEY] } } };
    const withRole = { name: "Sam", adapterConfig: { paperclipSkillSync: { desiredSkills: [COMPANY_OS_SKILL_KEY, "plugin/p/x"] } } };
    expect(matchesRole(withOs, role)).toBe(false);
    expect(matchesRole(withRole, role)).toBe(true);
    expect(matchesRole({ name: "Rae" }, role)).toBe(true);
  });
});
