import { describe, expect, it, vi } from "vitest";
import { agentSummary, TOOLS_GRANT, wireAgent } from "../src/agent.js";
import { SOCIAL_HIRE_ROLE, missingSocialSkills } from "../src/hire.js";
import { socialAgent } from "../src/issues.js";
import { DESIRED_SKILLS } from "../src/skills.js";
import plugin from "../src/worker.js";
import { fakeCtx, TEST_UI_BASE } from "./helpers.js";

type Agent = Record<string, unknown> & { id: string; name: string; status: string };
type Routine = { id: string; assigneeAgentId: string | null; status: string };
type Handler = (...args: any[]) => Promise<any>;

const USER = { type: "user", userId: "u1", agentId: null, runId: null, companyId: "co" };
const AGENT_ACTOR = { type: "agent", userId: null, agentId: "a-x", runId: null, companyId: "co" };

/** An in-memory company: agents, plugin state, grants, the weekly routine, issues. */
function world(input: { agents?: Agent[]; legacyAgentId?: string | null; routine?: Routine | null } = {}) {
  const agents: Agent[] = input.agents ?? [];
  const state = new Map<string, unknown>();
  let routine: Routine | null = input.routine ?? null;
  const grants: Array<{ permissionKey: string; scope: Record<string, unknown> | null }> = [];
  const managedReconcile = vi.fn(async () => {
    throw new Error("the plugin must not create its agent");
  });
  const grantsSet = vi.fn(async (args: { principalId: string; grants: typeof grants }) => {
    grants.splice(0, grants.length, ...args.grants);
  });
  const routineReconcile = vi.fn(async (_key: string, _companyId: string, overrides?: { assigneeAgentId?: string | null }) => {
    if (!routine) routine = { id: "r1", assigneeAgentId: overrides?.assigneeAgentId ?? null, status: "paused" };
    return { status: "created", routineId: routine.id, routine };
  });
  const routineReset = vi.fn(async (_key: string, _companyId: string, overrides?: { assigneeAgentId?: string | null }) => {
    routine = { ...routine!, assigneeAgentId: overrides?.assigneeAgentId ?? null, status: "paused" };
    return { status: "reset", routineId: routine.id, routine };
  });
  const routineUpdate = vi.fn(async (_key: string, _companyId: string, patch: { status?: string }) => {
    routine = { ...routine!, status: patch.status ?? routine!.status };
    return routine;
  });
  const issuesCreate = vi.fn(async (issue: Record<string, unknown>) => ({ id: "issue-1", identifier: "PIB-7", ...issue }));
  const comments: Array<{ issueId: string; body: string }> = [];
  const actions = new Map<string, Handler>();
  const jobs = new Map<string, Handler>();
  const events = new Map<string, Handler[]>();
  const stateId = (k: { scopeId?: string; namespace?: string; stateKey: string }) => `${k.scopeId}:${k.namespace}:${k.stateKey}`;

  const ctx = fakeCtx({
    state: {
      get: async (k: { scopeId?: string; namespace?: string; stateKey: string }) => (k.stateKey === "plugin-ui-base" ? TEST_UI_BASE : state.get(stateId(k)) ?? null),
      set: async (k: { scopeId?: string; namespace?: string; stateKey: string }, value: unknown) => void state.set(stateId(k), value),
      delete: async () => undefined,
    },
    config: { get: vi.fn(async () => ({})) },
    agents: {
      list: vi.fn(async () => agents),
      get: vi.fn(async (id: string) => agents.find((a) => a.id === id) ?? null),
      managed: {
        get: vi.fn(async () => ({ agentId: input.legacyAgentId ?? null, agent: agents.find((a) => a.id === input.legacyAgentId) ?? null, status: "resolved" })),
        reconcile: managedReconcile,
      },
    },
    authorization: { grants: { list: vi.fn(async () => grants), set: grantsSet } },
    projects: { managed: { reconcile: vi.fn(async () => ({ projectId: "proj" })), get: vi.fn(async () => ({ projectId: "proj" })) } },
    routines: {
      managed: {
        get: vi.fn(async () => ({ status: routine ? "resolved" : "missing", routineId: routine?.id ?? null, routine })),
        reconcile: routineReconcile,
        reset: routineReset,
        update: routineUpdate,
      },
    },
    issues: {
      create: issuesCreate,
      requestWakeup: vi.fn(async () => ({})),
      createComment: vi.fn(async (issueId: string, body: string) => void comments.push({ issueId, body })),
    },
    companies: { get: vi.fn(async () => ({ id: "co", issuePrefix: "PIB" })) },
    skills: { managed: { get: vi.fn(async () => { throw new Error("no skills in tests"); }), reconcile: vi.fn(async () => { throw new Error("no skills in tests"); }) } },
    actions: { register: (key: string, fn: Handler) => void actions.set(key, fn) },
    tools: { register: () => undefined },
    jobs: { register: (key: string, fn: Handler) => void jobs.set(key, fn) },
    events: { on: (name: string, fn: Handler) => void events.set(name, [...(events.get(name) ?? []), fn]) },
  }, {
    queryResult: (sql) => (sql.includes("SELECT DISTINCT company_id") ? [{ company_id: "co" }] : []),
  });

  return {
    ctx,
    agents,
    grants,
    comments,
    get routine() {
      return routine;
    },
    managedReconcile,
    grantsSet,
    routineReconcile,
    routineReset,
    routineUpdate,
    issuesCreate,
    async setup() {
      await plugin.definition.setup(ctx);
    },
    act(key: string, params: Record<string, unknown> = {}, actor: Record<string, unknown> = USER) {
      const fn = actions.get(key);
      if (!fn) throw new Error(`no action ${key}`);
      return fn(params, { companyId: "co", actor });
    },
    async emit(name: string) {
      for (const fn of events.get(name) ?? []) await fn({ eventId: "e1", eventType: name, occurredAt: new Date().toISOString(), companyId: "co", payload: {} });
    },
    runJob(key: string) {
      return jobs.get(key)!({});
    },
  };
}

const withSkills = { paperclipSkillSync: { desiredSkills: DESIRED_SKILLS } };
const outbound = (): Agent => ({ id: "oss", name: "Outbound & Social Specialist", title: "Outbound & Social Specialist", role: "general", status: "idle", createdAt: new Date("2026-01-01"), adapterConfig: {} });
const ceo = (): Agent => ({ id: "ceo", name: "CEO", role: "ceo", status: "idle", createdAt: new Date("2026-01-01") });

describe("social hire role", () => {
  it("spells out the agent and both skills", () => {
    expect(SOCIAL_HIRE_ROLE).toMatchObject({ pluginKey: "partnersinbiz.social", roleKey: "social-media-manager", displayName: "Social Media Manager", role: "general", budgetMonthlyCents: 0 });
    expect(SOCIAL_HIRE_ROLE.adapterPreference).toEqual(["hermes_local", "claude_local"]);
    expect(SOCIAL_HIRE_ROLE.skills.map((s) => [s.key, s.slug])).toEqual([
      ["plugin/partnersinbiz-social/social-publish", "pib-social-publish"],
      ["plugin/partnersinbiz-social/social-content", "pib-social-content"],
    ]);
    expect(SOCIAL_HIRE_ROLE.instructions.split("\n").length).toBeLessThan(12);
  });

  it("detects missing social skills by canonical key or slug", () => {
    expect(missingSocialSkills({ adapterConfig: withSkills })).toEqual([]);
    expect(missingSocialSkills({ adapterConfig: { paperclipSkillSync: { desiredSkills: ["company-1/pib-social-publish"] } } })).toEqual(["pib-social-content"]);
    expect(missingSocialSkills({ name: "No config" })).toEqual(["pib-social-publish", "pib-social-content"]);
  });
});

describe("wireAgent", () => {
  it("grants tools and assigns the routine without creating an agent", async () => {
    const w = world({ agents: [outbound()] });
    const result = await wireAgent(w.ctx, "co", "oss", "u1");
    expect(w.managedReconcile).not.toHaveBeenCalled();
    expect(w.grantsSet).toHaveBeenCalledWith(expect.objectContaining({ principalType: "agent", principalId: "oss", grantedByUserId: "u1" }));
    expect(w.grants).toContainEqual(TOOLS_GRANT);
    expect(w.routineReconcile).toHaveBeenCalledWith("plan-next-week", "co", { assigneeAgentId: "oss" });
    expect(result.toolsGrantAdded).toBe(true);
    expect(result.missingSkills).toEqual(["pib-social-publish", "pib-social-content"]);
    expect(result.steps.join("\n")).toContain("does not have `pib-social-publish` and `pib-social-content`");

    // again: nothing new to grant
    const again = await wireAgent(w.ctx, "co", "oss", "u1");
    expect(again.toolsGrantAdded).toBe(false);
    expect(w.grantsSet).toHaveBeenCalledTimes(1);
  });

  it("reassigns a routine that belongs to another agent and keeps it running", async () => {
    const w = world({ agents: [outbound()], routine: { id: "r1", assigneeAgentId: "old-agent", status: "active" } });
    const result = await wireAgent(w.ctx, "co", "oss", "u1");
    expect(w.routineReset).toHaveBeenCalledWith("plan-next-week", "co", { assigneeAgentId: "oss" });
    expect(w.routineUpdate).toHaveBeenCalledWith("plan-next-week", "co", { status: "active" });
    expect(w.routine).toMatchObject({ assigneeAgentId: "oss", status: "active" });
    expect(result.steps.join("\n")).toContain("Reassigned the weekly");
    expect(w.managedReconcile).not.toHaveBeenCalled();
  });
});

describe("hire actions", () => {
  it("start-hire opens a normal task for the chosen assignee and refuses agents", async () => {
    const w = world({ agents: [ceo(), outbound()] });
    await w.setup();
    const options = await w.act("social.hire-options");
    expect(options.defaultAssigneeAgentId).toBe("ceo");
    expect(options.draft.title).toBe("Hire: Social Media Manager (Social agent)");
    expect(options.agents.find((a: { id: string }) => a.id === "oss").missingSkills).toEqual(["pib-social-publish", "pib-social-content"]);

    const hire = await w.act("social.start-hire", { title: options.draft.title, description: options.draft.description, assigneeAgentId: "ceo" });
    expect(hire).toMatchObject({ issueId: "issue-1", identifier: "PIB-7", status: "open", assigneeAgentId: "ceo" });
    expect(w.issuesCreate).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co",
      status: "todo",
      assigneeAgentId: "ceo",
      originKind: "plugin:partnersinbiz.social",
      originId: "hire:social-media-manager",
    }));
    const description = String((w.issuesCreate.mock.calls[0]![0] as { description: string }).description);
    expect(description).toContain("`pib-social-publish`");
    expect(description).toContain("`pib-social-content`");
    await expect(w.act("social.start-hire", {}, AGENT_ACTOR)).rejects.toThrow(/A person must/);
    expect(w.managedReconcile).not.toHaveBeenCalled();
  });

  it("auto-links the new agent on agent.created and wires grant + routine", async () => {
    const w = world({ agents: [ceo(), outbound()] });
    await w.setup();
    await w.act("social.start-hire", { assigneeAgentId: "ceo" });
    await w.emit("agent.created");
    expect(w.grantsSet).not.toHaveBeenCalled();

    w.agents.push({ id: "smm", name: "Social Media Manager", role: "general", status: "paused", createdAt: new Date(), adapterConfig: withSkills });
    await w.emit("agent.created");
    expect(w.grantsSet).toHaveBeenCalledWith(expect.objectContaining({ principalId: "smm" }));
    expect(w.routineReconcile).toHaveBeenCalledWith("plan-next-week", "co", { assigneeAgentId: "smm" });
    expect(w.comments[0]!.issueId).toBe("issue-1");
    expect(w.comments[0]!.body).toContain("found **Social Media Manager**");
    expect(w.comments[0]!.body).toContain("has the `pib-social-publish` and `pib-social-content` skills");
    expect(await socialAgent(w.ctx, "co")).toEqual({ agentId: "smm", active: false, status: "paused" });
    expect(w.managedReconcile).not.toHaveBeenCalled();
  });

  it("the hourly job links a hire whose event was missed", async () => {
    const w = world({ agents: [ceo()] });
    await w.setup();
    await w.act("social.start-hire", { assigneeUserId: "u1" });
    w.agents.push({ id: "smm", name: "Sam", status: "idle", createdAt: new Date(), adapterConfig: withSkills });
    await w.runJob("refresh-tokens");
    expect((await socialAgent(w.ctx, "co")).agentId).toBe("smm");
    expect(w.routineReconcile).toHaveBeenCalledWith("plan-next-week", "co", { assigneeAgentId: "smm" });
  });

  it("manual link of an existing agent without the skills says to attach them", async () => {
    const w = world({ agents: [ceo(), outbound()] });
    await w.setup();
    const res = await w.act("social.link-agent", { agentId: "oss" });
    expect(res.agent.id).toBe("oss");
    expect(res.steps.join("\n")).toContain("Outbound & Social Specialist does not have `pib-social-publish` and `pib-social-content` yet");
    expect(w.grantsSet).toHaveBeenCalledWith(expect.objectContaining({ principalId: "oss" }));
    expect(w.routineReconcile).toHaveBeenCalledWith("plan-next-week", "co", { assigneeAgentId: "oss" });

    const snapshot = await w.act("social.load", {});
    expect(snapshot.agent).toMatchObject({ agentId: "oss", name: "Outbound & Social Specialist", linkedBy: "manual", active: true, missingSkills: ["pib-social-publish", "pib-social-content"] });
    await expect(w.act("social.link-agent", { agentId: "missing" })).rejects.toThrow(/not found/);
    expect(w.managedReconcile).not.toHaveBeenCalled();
  });

  it("re-sync needs a linked agent and never creates one", async () => {
    const w = world({ agents: [ceo()] });
    await w.setup();
    await expect(w.act("social.activate-agent")).rejects.toThrow(/No Social agent is linked yet/);
    expect(w.managedReconcile).not.toHaveBeenCalled();
  });
});

describe("socialAgent", () => {
  it("prefers the linked agent and falls back to the legacy managed agent", async () => {
    const legacy: Agent = { id: "legacy", name: "Social Media Manager", status: "idle", createdAt: new Date("2026-01-01"), adapterConfig: withSkills };
    const w = world({ agents: [legacy, outbound()], legacyAgentId: "legacy" });
    await w.setup();
    expect(await socialAgent(w.ctx, "co")).toEqual({ agentId: "legacy", active: true, status: "idle" });
    expect((await agentSummary(w.ctx, "co")).linkedBy).toBe("managed");

    const resync = await w.act("social.activate-agent");
    expect(resync).toMatchObject({ ok: true, agentId: "legacy", missingSkills: [] });

    await w.act("social.link-agent", { agentId: "oss" });
    expect(await socialAgent(w.ctx, "co")).toEqual({ agentId: "oss", active: true, status: "idle" });

    await w.act("social.unlink-agent");
    expect((await socialAgent(w.ctx, "co")).agentId).toBe("legacy");
    expect(w.managedReconcile).not.toHaveBeenCalled();
  });

  it("returns no agent when nothing is linked", async () => {
    const w = world({ agents: [ceo()] });
    expect(await socialAgent(w.ctx, "co")).toEqual({ agentId: null, active: false, status: null });
    const summary = await agentSummary(w.ctx, "co", { hire: false });
    expect(summary).toMatchObject({ agentId: null, hire: null, candidates: [] });
  });
});
