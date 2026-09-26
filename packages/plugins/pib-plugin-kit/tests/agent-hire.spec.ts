import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  hireStatus,
  hireTaskDraft,
  linkAgent,
  linkedAgentId,
  matchesRole,
  startHire,
  tryLinkPendingHire,
  type HireRole,
} from "../src/agent-hire.js";

const role: HireRole = {
  pluginKey: "partnersinbiz.seo",
  pluginName: "SEO",
  roleKey: "seo-specialist",
  displayName: "SEO Specialist",
  title: "SEO Specialist",
  role: "general",
  capabilities: "Runs 90-day SEO sprints.",
  adapterPreference: ["hermes_local", "claude_local"],
  skills: [{ key: "plugin/partnersinbiz-seo/seo-sprint", slug: "pib-seo-sprint", purpose: "The sprint procedure" }],
  budgetMonthlyCents: 0,
  suggestedManager: "the marketing lead",
  instructions: "You are the SEO Specialist. Follow the pib-seo-sprint skill.",
  pluginSetup: ["Grants the SEO plugin tools"],
  toolPlugins: ["partnersinbiz.crm"],
};

function fakeCtx(agents: Array<Record<string, unknown>>) {
  const state = new Map<string, unknown>();
  const comments: Array<{ issueId: string; body: string }> = [];
  const created: Array<Record<string, unknown>> = [];
  const wakeups: string[] = [];
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    state: {
      get: async (k: { scopeId?: string; stateKey: string }) => state.get(`${k.scopeId}:${k.stateKey}`) ?? null,
      set: async (k: { scopeId?: string; stateKey: string }, v: unknown) => void state.set(`${k.scopeId}:${k.stateKey}`, v),
    },
    agents: {
      list: async () => agents,
      get: async (id: string) => agents.find((a) => a.id === id) ?? null,
    },
    issues: {
      create: async (input: Record<string, unknown>) => {
        created.push(input);
        return { id: "issue-1", identifier: "PAR-9", ...input };
      },
      requestWakeup: async (id: string) => void wakeups.push(id),
      createComment: async (issueId: string, body: string) => void comments.push({ issueId, body }),
    },
  } as unknown as PluginContext;
  return { ctx, state, comments, created, wakeups };
}

describe("agent hire", () => {
  it("drafts a task that spells out the agent", () => {
    const draft = hireTaskDraft(role);
    expect(draft.title).toBe("Hire: SEO Specialist (SEO agent)");
    expect(draft.description).toContain("`pib-seo-sprint`");
    expect(draft.description).toContain("the marketing lead");
    expect(draft.description).toContain("`hermes_local`, then `claude_local`");
    expect(draft.description).toContain("Follow the pib-seo-sprint skill.");
  });

  it("matches agents by skill or by name", () => {
    expect(matchesRole({ name: "Sam", adapterConfig: { paperclipSkillSync: { desiredSkills: ["plugin/partnersinbiz-seo/seo-sprint"] } } }, role)).toBe(true);
    expect(matchesRole({ name: "Sam", adapterConfig: { paperclipSkillSync: { desiredSkills: ["pib-seo-sprint"] } } }, role)).toBe(true);
    expect(matchesRole({ name: "SEO Specialist" }, role)).toBe(true);
    expect(matchesRole({ name: "Sam", title: "Senior SEO specialist" }, role)).toBe(true);
    expect(matchesRole({ name: "Growth Lead" }, role)).toBe(false);
  });

  it("opens the hire task, wakes an agent assignee and links the new agent once", async () => {
    const agents: Array<Record<string, unknown>> = [
      { id: "ceo", name: "CEO", status: "idle", createdAt: new Date("2026-01-01") },
    ];
    const { ctx, created, wakeups, comments } = fakeCtx(agents);
    const hire = await startHire(ctx, "co", role, { assigneeAgentId: "ceo", actorUserId: "u1" });
    expect(hire.identifier).toBe("PAR-9");
    expect(created[0]).toMatchObject({ companyId: "co", status: "todo", assigneeAgentId: "ceo", originKind: "plugin:partnersinbiz.seo", originId: "hire:seo-specialist" });
    expect(wakeups).toEqual(["issue-1"]);

    const onLinked = vi.fn(async () => ["Granted plugin tools"]);
    expect(await tryLinkPendingHire(ctx, "co", role, onLinked)).toBeNull();

    agents.push({ id: "seo", name: "Sam", status: "paused", createdAt: new Date(), adapterConfig: { paperclipSkillSync: { desiredSkills: ["pib-seo-sprint"] } } });
    const linked = await tryLinkPendingHire(ctx, "co", role, onLinked);
    expect(linked?.id).toBe("seo");
    expect(onLinked).toHaveBeenCalledWith("co", "seo", { userId: null });
    expect(comments[0]!.issueId).toBe("issue-1");
    expect(comments[0]!.body).toContain("found **Sam**");
    expect(await linkedAgentId(ctx, "co", role)).toBe("seo");

    // already linked: no second wiring
    expect(await tryLinkPendingHire(ctx, "co", role, onLinked)).toBeNull();
    expect(onLinked).toHaveBeenCalledTimes(1);
  });

  it("leaves ambiguous matches for a person and supports manual links and legacy agents", async () => {
    const now = new Date();
    const agents: Array<Record<string, unknown>> = [
      { id: "a", name: "SEO Specialist", status: "idle", createdAt: now },
      { id: "b", name: "SEO Specialist 2", status: "idle", createdAt: now },
      { id: "old", name: "Legacy", status: "paused", createdAt: new Date("2026-01-01") },
    ];
    const { ctx } = fakeCtx(agents);
    await startHire(ctx, "co", role, { assigneeUserId: "u1", actorUserId: "u1" });
    const onLinked = vi.fn(async () => []);
    expect(await tryLinkPendingHire(ctx, "co", role, onLinked)).toBeNull();
    const status = await hireStatus(ctx, "co", role);
    expect(status.agent).toBeNull();
    expect(status.candidates.map((c) => c.id).sort()).toEqual(["a", "b"]);

    await linkAgent(ctx, "co", role, "b", { by: "manual", userId: "u1", onLinked });
    expect((await hireStatus(ctx, "co", role)).agent?.id).toBe("b");

    const fresh = fakeCtx(agents).ctx;
    expect(await linkedAgentId(fresh, "co", role, async () => "old")).toBe("old");
    expect((await hireStatus(fresh, "co", role, async () => "old")).linkedBy).toBe("managed");
    await expect(linkAgent(fresh, "co", role, "missing", { by: "manual", userId: null, onLinked })).rejects.toThrow("not found");
  });

  it("links once when agent events arrive together", async () => {
    const agents: Array<Record<string, unknown>> = [];
    const { ctx, comments } = fakeCtx(agents);
    await startHire(ctx, "co", role, { assigneeUserId: "u1", actorUserId: "u1" });
    agents.push({ id: "seo", name: "SEO Specialist", status: "paused", createdAt: new Date() });
    const onLinked = vi.fn(async () => ["ok"]);
    const results = await Promise.all([
      tryLinkPendingHire(ctx, "co", role, onLinked),
      tryLinkPendingHire(ctx, "co", role, onLinked),
    ]);
    expect(results.map((r) => r?.id)).toEqual(["seo", "seo"]);
    expect(onLinked).toHaveBeenCalledTimes(1);
    expect(comments).toHaveLength(1);
  });
});
