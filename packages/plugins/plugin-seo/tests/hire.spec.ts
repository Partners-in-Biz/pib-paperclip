import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { linkAgent } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { NAMESPACE } from "../src/namespace.js";
import { createEnv } from "../src/service/common.js";
import { defaultHireAssignee, resolveAgent, seoOnLinked, wireAgent } from "../src/service/agent.js";
import { SEO_ROLE } from "../src/service/hire.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

type Row = Record<string, unknown>;

const SPRINT: Row = {
  id: "sp-1", company_id: "co-1", name: "Acme", site_url: "https://acme.co.za", site_name: "Acme", client_ref: null, client_name: null,
  status: "active", start_date: "2026-09-01", template_id: "outrank-90", template_version: 2, autopilot_mode: "safe", owner_user_id: "user-1",
  project_id: null, root_issue_id: "root-1", root_issue_identifier: "PIB-1", agent_id: null, notes: null, paused_reason: null,
  health: {}, scoreboard: {}, today: {}, current_day: 25, current_week: 4, current_phase: 1, last_daily_on: null, last_weekly_on: null,
  audit_days_done: [0], seeded_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
};

const WAITING_TASK: Row = {
  id: "t-1", company_id: "co-1", sprint_id: "sp-1", template_key: "w1-audit", week: 1, phase: 1, due_day: 1, focus: "Foundation",
  title: "Technical audit", description: null, task_type: "custom", owner: "agent", autopilot_eligible: true, playbook_key: null,
  status: "not_started", source: "template", parent_optimization_id: null, context: null, issue_id: "iss-1", issue_identifier: "PIB-2",
  issue_status: "todo", assignee_kind: "unassigned", blocker_reason: null, human_ask: null, evidence: null, started_at: null,
  completed_at: null, completed_by: null, created_at: null, updated_at: null,
};

const ns = NAMESPACE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** SEO tables with one active sprint and one agent task waiting for an agent. */
function fakeDb() {
  const executes: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    namespace: NAMESPACE,
    async query(sql: string, params: unknown[] = []) {
      validateRuntimeQuery(sql, NAMESPACE, ["heartbeat_runs"]);
      validateParams(sql, params);
      if (new RegExp(`FROM ${ns}\\.sprints WHERE company_id = \\$1`).test(sql)) return [SPRINT];
      if (new RegExp(`FROM ${ns}\\.sprint_tasks WHERE company_id = \\$1 AND sprint_id = \\$2`).test(sql)) return [WAITING_TASK];
      if (/SELECT DISTINCT company_id/.test(sql)) return [{ company_id: "co-1" }];
      return [];
    },
    async execute(sql: string, params: unknown[] = []) {
      validateRuntimeExecute(sql, NAMESPACE);
      validateParams(sql, params);
      executes.push({ sql, params });
      return { rowCount: 1 };
    },
  };
  return { db, executes };
}

function agentRow(extra: Row): never {
  return {
    companyId: "co-1", urlKey: String(extra.id), role: "general", title: null, icon: null, status: "idle", reportsTo: null, capabilities: null,
    adapterType: "hermes_local", adapterConfig: {}, runtimeConfig: {}, budgetMonthlyCents: 0, spentMonthlyCents: 0, pauseReason: null,
    pausedAt: null, permissions: {}, lastHeartbeatAt: null, metadata: {}, createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date(),
    ...extra,
  } as never;
}

const USER = { companyId: "co-1", actor: { type: "user" as const, userId: "user-1" } };

async function boot(options: { agents?: Row[] } = {}) {
  const harness = createTestHarness({ manifest, config: { timezone: "Africa/Johannesburg", publicBaseUrl: "https://paperclip.partnersinbiz.online" } });
  harness.seed({
    companies: [{ id: "co-1", issuePrefix: "PIB", name: "PiB" } as never],
    agents: (options.agents ?? [{ id: "ceo", name: "CEO", role: "ceo" }]).map(agentRow),
    issues: [{ id: "iss-1", companyId: "co-1", title: "Technical audit", status: "todo", assigneeAgentId: null, assigneeUserId: null, identifier: "PIB-2" } as never],
  });
  const { db, executes } = fakeDb();
  const reconcileAgent = vi.spyOn(harness.ctx.agents.managed, "reconcile");
  const comments = vi.spyOn(harness.ctx.issues, "createComment");
  const ctx = { ...harness.ctx, db } as PluginContext;
  await plugin.definition.setup(ctx);
  const env = createEnv(ctx, { now: () => new Date(), fetch: vi.fn() as never, site: vi.fn() as never });
  return { harness, ctx, env, executes, reconcileAgent, comments };
}

describe("SEO agent hire", () => {
  it("offers the hire draft with the CEO as the default assignee", async () => {
    const { harness } = await boot({ agents: [{ id: "ops", name: "Ops", role: "general" }, { id: "ceo", name: "CEO", role: "ceo" }] });
    const options = await harness.performAction<{ draft: { title: string; description: string }; agents: Array<{ id: string }>; defaultAssigneeAgentId: string | null }>("seo.hire-options", {}, USER);
    expect(options.defaultAssigneeAgentId).toBe("ceo");
    expect(options.agents.map((a) => a.id).sort()).toEqual(["ceo", "ops"]);
    expect(options.draft.title).toBe("Hire: SEO Specialist (SEO agent)");
    expect(options.draft.description).toContain("`pib-seo-sprint`");
    expect(options.draft.description).toContain("plugin/partnersinbiz-seo/seo-sprint");
    expect(options.draft.description).toContain("the marketing / growth lead (or the CEO)");
    expect(defaultHireAssignee([{ id: "x", name: "X", title: null, role: "general", status: "idle", icon: null, createdAt: null }])).toBeNull();
    await expect(harness.performAction("seo.hire-options", {}, { companyId: "co-1", actor: { type: "system" } })).rejects.toThrow(/board users/);
  });

  it("opens the hire task as a normal issue and never creates the agent itself", async () => {
    const { harness, reconcileAgent } = await boot();
    const { hire } = await harness.performAction<{ hire: { issueId: string; assigneeAgentId: string | null } }>(
      "seo.start-hire",
      { title: "Hire our SEO Specialist", assigneeAgentId: "ceo" },
      USER,
    );
    const issue = await harness.ctx.issues.get(hire.issueId, "co-1");
    expect(issue).toMatchObject({
      title: "Hire our SEO Specialist",
      status: "todo",
      assigneeAgentId: "ceo",
      originKind: "plugin:partnersinbiz.seo",
      originId: "hire:seo-specialist",
    });
    expect(issue?.description).toContain("## Skills to attach");
    expect(reconcileAgent).not.toHaveBeenCalled();

    const load = await harness.performAction<{ hire: { agent: unknown; hire: { issueId: string; issueStatus: string; assigneeName: string } } }>("seo.load", {}, USER);
    expect(load.hire.agent).toBeNull();
    expect(load.hire.hire).toMatchObject({ issueId: hire.issueId, issueStatus: "todo", assigneeName: "CEO" });

    await expect(harness.performAction("seo.start-hire", { assigneeAgentId: "nobody" }, USER)).rejects.toThrow(/not an agent/);
  });

  it("links the hired agent when it appears and wires routines, tool access and waiting tasks", async () => {
    const { harness, executes, reconcileAgent, comments } = await boot();
    const { hire } = await harness.performAction<{ hire: { issueId: string } }>("seo.start-hire", { assigneeAgentId: "ceo" }, USER);

    harness.seed({
      agents: [agentRow({ id: "seo-1", name: "Sam", status: "idle", createdAt: new Date(), adapterConfig: { paperclipSkillSync: { desiredSkills: ["plugin/partnersinbiz-seo/seo-sprint"] } } })],
    });
    await harness.emit("agent.created", {}, { companyId: "co-1", entityId: "seo-1" });

    expect(reconcileAgent).not.toHaveBeenCalled();
    const grants = await harness.ctx.authorization.grants.list({ companyId: "co-1", principalType: "agent", principalId: "seo-1" });
    expect(grants.map((g) => g.permissionKey)).toContain("tools:use");
    for (const key of ["seo-run-today", "seo-weekly-review"]) {
      const routine = await harness.ctx.routines.managed.get(key, "co-1");
      expect(routine.routine?.assigneeAgentId, key).toBe("seo-1");
    }
    // The waiting agent task is handed to the new agent.
    expect((await harness.ctx.issues.get("iss-1", "co-1"))?.assigneeAgentId).toBe("seo-1");
    expect(executes.some((e) => /UPDATE .*\.sprints SET agent_id = \$1/.test(e.sql) && e.params[0] === "seo-1")).toBe(true);
    expect(executes.some((e) => e.sql.includes("sprint_tasks") && e.params.includes("agent"))).toBe(true);
    // The hire task hears about it.
    const hireComment = comments.mock.calls.find(([issueId]) => issueId === hire.issueId);
    expect(hireComment?.[1]).toContain("found **Sam**");
    expect(hireComment?.[1]).toContain("Granted plugin tool access");
    expect(hireComment?.[1]).toContain("handed it 1 waiting SEO task");

    const load = await harness.performAction<{ agent: { id: string }; hire: { agent: { id: string }; linkedBy: string } }>("seo.load", {}, USER);
    expect(load.agent.id).toBe("seo-1");
    expect(load.hire).toMatchObject({ agent: { id: "seo-1" }, linkedBy: "auto" });

    // A second event does not wire it again.
    await harness.emit("agent.updated", {}, { companyId: "co-1", entityId: "seo-1" });
    expect(comments.mock.calls.filter(([issueId]) => issueId === hire.issueId)).toHaveLength(1);
  });

  it("links by hand, re-syncs the linked agent and refuses re-sync with no agent", async () => {
    const { harness, reconcileAgent } = await boot({ agents: [{ id: "ceo", name: "CEO", role: "ceo" }, { id: "sam", name: "Sam" }] });
    await expect(harness.performAction("seo.activate-agent", {}, USER)).rejects.toThrow(/No SEO agent is linked yet/);

    const linked = await harness.performAction<{ agent: { id: string }; steps: string[]; instructions: string[] }>("seo.link-agent", { agentId: "sam" }, USER);
    expect(linked.agent.id).toBe("sam");
    expect(linked.steps.join("\n")).toContain("Granted plugin tool access");
    // Sam has no skills: the plugin says so, since it cannot attach them.
    expect(linked.instructions.join("\n")).toContain("Attach the `pib-seo-sprint` skill to Sam");

    const again = await harness.performAction<{ agent: { id: string }; grant: string }>("seo.activate-agent", {}, USER);
    expect(again).toMatchObject({ agent: { id: "sam" }, grant: "already_present" });
    expect(reconcileAgent).not.toHaveBeenCalled();

    await expect(harness.performAction("seo.link-agent", { agentId: "missing" }, USER)).rejects.toThrow(/not found/);
    await harness.performAction("seo.unlink-agent", {}, USER);
    await expect(harness.performAction("seo.activate-agent", {}, USER)).rejects.toThrow(/No SEO agent is linked yet/);
  });

  it("the daily job links a hire whose agent event was missed", async () => {
    const { harness, comments } = await boot();
    const { hire } = await harness.performAction<{ hire: { issueId: string } }>("seo.start-hire", {}, USER);
    expect((await harness.ctx.issues.get(hire.issueId, "co-1"))?.status).toBe("backlog");
    harness.seed({ agents: [agentRow({ id: "seo-2", name: "SEO Specialist", status: "paused", createdAt: new Date() })] });
    await harness.runJob("seo-daily");
    expect(comments.mock.calls.some(([issueId, body]) => issueId === hire.issueId && String(body).includes("SEO Specialist"))).toBe(true);
    expect(harness.logs.filter((l) => l.level === "error")).toEqual([]);
  });
});

describe("resolveAgent", () => {
  it("prefers the linked agent and falls back to the legacy managed agent", async () => {
    const legacyMeta = { paperclipManagedResource: { pluginKey: "partnersinbiz.seo", resourceKind: "agent", resourceKey: "seo-specialist" } };
    const { env, ctx } = await boot({ agents: [{ id: "legacy", name: "SEO Specialist", status: "paused", metadata: legacyMeta }, { id: "sam", name: "Sam" }] });
    expect(await resolveAgent(env, "co-1")).toEqual({ id: "legacy", status: "paused" });

    await linkAgent(ctx, "co-1", SEO_ROLE, "sam", { by: "manual", userId: null, onLinked: seoOnLinked(env) });
    expect(await resolveAgent(env, "co-1")).toEqual({ id: "sam", status: "idle" });
  });

  it("returns null when there is neither", async () => {
    const { env } = await boot();
    expect(await resolveAgent(env, "co-1")).toBeNull();
  });
});

describe("wireAgent", () => {
  it("reassigns routines that belong to another agent and keeps their status", async () => {
    const { ctx } = await boot({ agents: [{ id: "new", name: "New" }] });
    const routine = (assigneeAgentId: string, status: string) => ({ id: "r-1", assigneeAgentId, status });
    const managed = {
      get: vi.fn(),
      reconcile: vi.fn(async () => ({ routineId: "r-1", routine: routine("old", "active"), status: "resolved" })),
      reset: vi.fn(async () => ({ routineId: "r-1", routine: routine("new", "paused"), status: "reset" })),
      update: vi.fn(async () => routine("new", "active")),
      run: vi.fn(),
    };
    const env = createEnv({ ...ctx, routines: { managed } } as unknown as PluginContext, { now: () => new Date(), fetch: vi.fn() as never, site: vi.fn() as never });
    const reconcileAgent = vi.spyOn(ctx.agents.managed, "reconcile");
    const result = await wireAgent(env, "co-1", "new", null);
    expect(reconcileAgent).not.toHaveBeenCalled();
    expect(managed.reset).toHaveBeenCalledWith("seo-run-today", "co-1", expect.objectContaining({ assigneeAgentId: "new" }));
    expect(managed.update).toHaveBeenCalledWith("seo-run-today", "co-1", { status: "active" });
    expect(result.routines.every((r) => r.reassigned && r.routineStatus === "active")).toBe(true);
    expect(result.steps.join("\n")).toContain("moved over from the previous agent");
    // Both routines are active, so no "turn them on" instruction.
    expect(result.instructions.join("\n")).not.toContain("Open Routines");
    expect(result.grant).toBe("added");
  });

  it("tells a person to re-enable a moved routine when the host refuses the status restore", async () => {
    const { ctx } = await boot({ agents: [{ id: "new", name: "New" }] });
    const routine = (assigneeAgentId: string, status: string) => ({ id: "r-1", assigneeAgentId, status });
    const managed = {
      get: vi.fn(),
      reconcile: vi.fn(async (key: string) => ({ routineId: key, routine: routine(key === "seo-run-today" ? "old" : "new", "active"), status: "resolved" })),
      reset: vi.fn(async (key: string) => ({ routineId: key, routine: routine("new", "paused"), status: "reset" })),
      update: vi.fn(async () => {
        throw new Error("Plugin does not have access to routines.managed.update");
      }),
      run: vi.fn(),
    };
    const env = createEnv({ ...ctx, routines: { managed } } as unknown as PluginContext, { now: () => new Date(), fetch: vi.fn() as never, site: vi.fn() as never });
    const result = await wireAgent(env, "co-1", "new", null);
    // Only the routine held by the old agent is moved.
    expect(managed.reset).toHaveBeenCalledTimes(1);
    expect(managed.reset).toHaveBeenCalledWith("seo-run-today", "co-1", expect.objectContaining({ assigneeAgentId: "new" }));
    expect(result.routines.find((r) => r.key === "seo-run-today")).toMatchObject({ reassigned: true, routineStatus: "paused", lostStatus: "active" });
    expect(result.routines.find((r) => r.key === "seo-weekly-review")).toMatchObject({ reassigned: false, lostStatus: null });
    const ask = `Moving "Run today's SEO" to New set it to paused (it was active). Open Routines → "Run today's SEO" and set it active again.`;
    expect(result.steps).toContain(ask);
    expect(result.instructions).toContain(ask);
    expect(result.instructions.join("\n")).not.toContain("they are created paused");
  });
});
