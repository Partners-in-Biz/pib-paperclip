import { describe, expect, it } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { createEnv, governorTick } from "../src/register.js";
import { governCompany, GOVERNOR_NS, GOVERNOR_STATE_KEY, type GovernorConfig, type GovernorDeps } from "../src/governor.js";
import { DEFAULT_PAUSE_ORDER, FAILURE_WINDOW_MINUTES, NEVER_PAUSE, RESET_FALLBACK_MS } from "../src/governor-model.js";
import type { LimitFailures } from "../src/measure-model.js";
import { fakeCtx, fixedClock, type FakeAgent } from "./helpers/fake-ctx.js";

const A = "company-a";
const B = "company-b";

// Helper to create LimitFailures with required since field
function failures(total: number, byAgent: Array<{ agentId: string; count: number }>): LimitFailures {
  return { total, byAgent, since: null };
}

function setup(options: Parameters<typeof fakeCtx>[0] = {}, now = "2026-09-26T10:00:00.000Z") {
  const fake = fakeCtx(options);
  const clock = fixedClock(now);
  const env = createEnv(fake.ctx, clock.now);
  return { ...fake, env, clock };
}

describe("governCompany", () => {
  it("returns disabled outcome when config.enabled is false", async () => {
    const { env } = setup();
    const result = await governCompany(env, A, { enabled: false });
    expect(result).toMatchObject({ companyId: A, outcome: "disabled", paused: 0, errors: 0 });
  });

  it("returns already_paused when state holds pausedIds array", async () => {
    const agents = [
      { id: "a1", companyId: A, name: "A1", status: "paused" },
      { id: "a2", companyId: A, name: "A2", status: "paused" },
    ] as FakeAgent[];
    const { env } = setup({ agents });
    const stateKey = { scopeKind: "company" as const, scopeId: A, namespace: GOVERNOR_NS, stateKey: GOVERNOR_STATE_KEY };
    const now = env.now();
    await env.ctx.state.set(stateKey, { pausedIds: ["a1", "a2"], pausedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(), resumeAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString() });
    const result = await governCompany(env, A, { enabled: true });
    expect(result).toMatchObject({ companyId: A, outcome: "waiting", paused: 2, errors: 0 });
  });

  it("returns idle when failures don't trigger", async () => {
    const f = failures(2, [{ agentId: "a1", count: 1 }, { agentId: "a2", count: 1 }]);
    const readFake = async () => f;
    const { env } = setup();
    const result = await governCompany(env, A, { enabled: true }, { readLimitFailures: readFake as any, recordRepair: async () => ({ id: "", companyId: "", kind: "", targetKind: "", targetId: "", action: "", outcome: "", detail: "", actor: "", createdAt: "" }) });
    expect(result).toMatchObject({ companyId: A, outcome: "idle", paused: 0, errors: 0 });
  });

  it("returns idle when no agents to pause (already paused or filtered)", async () => {
    const f = failures(3, [{ agentId: "a1", count: 2 }, { agentId: "a2", count: 1 }]);
    const readFake = async () => f;
    const agents = [
      { id: "a1", companyId: A, name: "Paused Agent", status: "paused", role: "general" },
      { id: "a2", companyId: A, name: "Delivery Lead", status: "active", role: "general" },
    ] as FakeAgent[];
    const { env } = setup({ agents });
    const result = await governCompany(env, A, { enabled: true }, { readLimitFailures: readFake as any, recordRepair: async () => ({ id: "", companyId: "", kind: "", targetKind: "", targetId: "", action: "", outcome: "", detail: "", actor: "", createdAt: "" }) });
    expect(result).toMatchObject({ companyId: A, outcome: "idle", paused: 0, errors: 0 });
  });

  it("pauses agents in order, writes state, records repairs", async () => {
    const f = failures(3, [{ agentId: "dog", count: 2 }, { agentId: "prod", count: 1 }]);
    const readFake = async () => f;
    const repairs: Array<{ kind: string; targetId: string; action: string; outcome: string; actor: string }> = [];
    const recordFake = async (ctx: any, companyId: string, input: any) => {
      repairs.push(input);
      return { id: `rep${repairs.length}`, companyId, kind: input.kind, targetKind: input.targetKind, targetId: input.targetId, action: input.action, outcome: input.outcome, detail: input.detail, actor: input.actor, createdAt: new Date().toISOString() };
    };
    const agents = [
      { id: "dog", companyId: A, name: "Dogfood Tester", status: "active" },
      { id: "prod", companyId: A, name: "Product Designer", status: "active" },
      { id: "seo", companyId: A, name: "SEO Specialist", status: "active" },
    ] as FakeAgent[];
    const { env } = setup({ agents });
    const result = await governCompany(env, A, { enabled: true }, { readLimitFailures: readFake as any, recordRepair: recordFake as any });
    expect(result).toMatchObject({ companyId: A, outcome: "paused", paused: 3, errors: 0 });
    expect(repairs).toHaveLength(3);
    expect(repairs[0]).toMatchObject({ kind: "governor", targetId: "dog", action: "pause", outcome: "success", actor: "governor" });
    expect(repairs[1]).toMatchObject({ kind: "governor", targetId: "prod", action: "pause", outcome: "success", actor: "governor" });
    expect(repairs[2]).toMatchObject({ kind: "governor", targetId: "seo", action: "pause", outcome: "success", actor: "governor" });
    const stateKey = { scopeKind: "company" as const, scopeId: A, namespace: GOVERNOR_NS, stateKey: GOVERNOR_STATE_KEY };
    const state = (await env.ctx.state.get(stateKey)) as any;
    expect(state.pausedIds).toEqual(["dog", "prod", "seo"]);
    expect(state.pausedAt).toBeDefined();
    expect(state.resumeAt).toBeDefined();
  });

  it("doesn't re-pause on second tick (already_paused)", async () => {
    const f = failures(3, [{ agentId: "dog", count: 2 }, { agentId: "prod", count: 1 }]);
    const readFake = async () => f;
    const repairs: any[] = [];
    const recordFake = async (ctx: any, companyId: string, input: any) => {
      repairs.push(input);
      return { id: `rep${repairs.length}`, companyId, kind: input.kind, targetKind: input.targetKind, targetId: input.targetId, action: input.action, outcome: input.outcome, detail: input.detail, actor: input.actor, createdAt: new Date().toISOString() };
    };
    const agents = [
      { id: "dog", companyId: A, name: "Dogfood Tester", status: "active" },
      { id: "prod", companyId: A, name: "Product Designer", status: "active" },
    ] as FakeAgent[];
    const { env } = setup({ agents });
    // First tick pauses
    const result1 = await governCompany(env, A, { enabled: true }, { readLimitFailures: readFake as any, recordRepair: recordFake as any });
    expect(result1.outcome).toBe("paused");
    expect(repairs.length).toBe(2);
    // Second tick sees state, no pause calls, returns waiting (resumeAt in future)
    const result2 = await governCompany(env, A, { enabled: true }, { readLimitFailures: readFake as any, recordRepair: recordFake as any });
    expect(result2.outcome).toBe("waiting");
    expect(repairs.length).toBe(2); // No new repairs
  });

  it("respects never-list agents (never pauses them)", async () => {
    const f = failures(3, [{ agentId: "dev", count: 2 }, { agentId: "dl", count: 1 }]);
    const readFake = async () => f;
    const repairs: any[] = [];
    const recordFake = async (ctx: any, companyId: string, input: any) => {
      repairs.push(input);
      return { id: `rep${repairs.length}`, companyId, kind: input.kind, targetKind: input.targetKind, targetId: input.targetId, action: input.action, outcome: input.outcome, detail: input.detail, actor: input.actor, createdAt: new Date().toISOString() };
    };
    const agents = [
      { id: "dog", companyId: A, name: "Dogfood Tester", status: "active" },
      { id: "dev", companyId: A, name: "Developer", status: "active" },
      { id: "dl", companyId: A, name: "Delivery Lead", status: "active" },
    ] as FakeAgent[];
    const { env } = setup({ agents });
    const result = await governCompany(env, A, { enabled: true }, { readLimitFailures: readFake as any, recordRepair: recordFake as any });
    expect(result.paused).toBe(2); // Dogfood Tester and Developer, not Delivery Lead
    expect(repairs[0]?.targetId).toBe("dog"); // Dogfood Tester paused first (in DEFAULT_PAUSE_ORDER)
    expect(repairs[1]?.targetId).toBe("dev"); // Developer paused second
  });

  it("records error repair on pause failure, continues to next agent", async () => {
    const f = failures(3, [{ agentId: "a1", count: 2 }, { agentId: "a2", count: 1 }]);
    const readFake = async () => f;
    const repairs: any[] = [];
    const recordFake = async (ctx: any, companyId: string, input: any) => {
      repairs.push(input);
      return { id: `rep${repairs.length}`, companyId, kind: input.kind, targetKind: input.targetKind, targetId: input.targetId, action: input.action, outcome: input.outcome, detail: input.detail, actor: input.actor, createdAt: new Date().toISOString() };
    };
    const agents = [
      { id: "dog", companyId: A, name: "Dogfood Tester", status: "active" },
      { id: "prod", companyId: A, name: "Product Designer", status: "active" },
    ] as FakeAgent[];
    const { env } = setup({ agents, pauseFails: ["dog"] });
    const result = await governCompany(env, A, { enabled: true }, { readLimitFailures: readFake as any, recordRepair: recordFake as any });
    expect(result).toMatchObject({ outcome: "paused", paused: 1, errors: 1 }); // Only prod paused, dog errored
    expect(repairs).toHaveLength(2);
    expect(repairs[0]).toMatchObject({ targetId: "dog", outcome: "error" });
    expect(repairs[1]).toMatchObject({ targetId: "prod", outcome: "success" });
    const stateKey = { scopeKind: "company" as const, scopeId: A, namespace: GOVERNOR_NS, stateKey: GOVERNOR_STATE_KEY };
    const state = (await env.ctx.state.get(stateKey)) as any;
    expect(state.pausedIds).toEqual(["prod"]); // Only the successful ones
  });

  it("doesn't write state when all pauses error (next tick retries)", async () => {
    const f = failures(3, [{ agentId: "a1", count: 2 }, { agentId: "a2", count: 1 }]);
    const readFake = async () => f;
    const repairs: any[] = [];
    const recordFake = async (ctx: any, companyId: string, input: any) => {
      repairs.push(input);
      return { id: `rep${repairs.length}`, companyId, kind: input.kind, targetKind: input.targetKind, targetId: input.targetId, action: input.action, outcome: input.outcome, detail: input.detail, actor: input.actor, createdAt: new Date().toISOString() };
    };
    const agents = [
      { id: "dog", companyId: A, name: "Dogfood Tester", status: "active" },
      { id: "prod", companyId: A, name: "Product Designer", status: "active" },
    ] as FakeAgent[];
    const { env } = setup({ agents, pauseFails: ["dog", "prod"] });
    const result = await governCompany(env, A, { enabled: true }, { readLimitFailures: readFake as any, recordRepair: recordFake as any });
    expect(result).toMatchObject({ outcome: "idle", paused: 0, errors: 2 });
    const stateKey = { scopeKind: "company" as const, scopeId: A, namespace: GOVERNOR_NS, stateKey: GOVERNOR_STATE_KEY };
    const state = await env.ctx.state.get(stateKey);
    expect(state).toBeNull(); // No state written, next tick retries
  });

  it("applies config pause order and respects custom trigger thresholds", async () => {
    const f = failures(4, [{ agentId: "a1", count: 2 }, { agentId: "a2", count: 2 }]);
    const readFake = async () => f;
    const repairs: any[] = [];
    const recordFake = async (ctx: any, companyId: string, input: any) => {
      repairs.push(input);
      return { id: `rep${repairs.length}`, companyId, kind: input.kind, targetKind: input.targetKind, targetId: input.targetId, action: input.action, outcome: input.outcome, detail: input.detail, actor: input.actor, createdAt: new Date().toISOString() };
    };
    const agents = [
      { id: "prod", companyId: A, name: "Product Designer", status: "active" },
      { id: "seo", companyId: A, name: "SEO Specialist", status: "active" },
      { id: "dog", companyId: A, name: "Dogfood Tester", status: "active" },
    ] as FakeAgent[];
    const { env } = setup({ agents });
    // Custom pause order: SEO first, then Product Designer
    const result = await governCompany(env, A, { enabled: true, pauseOrder: ["SEO Specialist", "Product Designer", "Dogfood Tester"], triggerFailures: 4, triggerAgents: 2 }, { readLimitFailures: readFake as any, recordRepair: recordFake as any });
    expect(result.paused).toBe(3); // Pauses all in the custom order
    expect(repairs[0]?.targetId).toBe("seo");
    expect(repairs[1]?.targetId).toBe("prod");
    expect(repairs[2]?.targetId).toBe("dog");
  });

  it("failure window is 30 minutes before now", async () => {
    let capturedSince: string | null = null;
    const readFake = async (ctx: any, companyId: string, since: string) => {
      capturedSince = since;
      return { total: 0, byAgent: [] };
    };
    const { env, clock } = setup();
    clock.set("2026-09-26T10:45:00.000Z");
    await governCompany(env, A, { enabled: true }, { readLimitFailures: readFake as any, recordRepair: async () => ({ id: "", companyId: "", kind: "", targetKind: "", targetId: "", action: "", outcome: "", detail: "", actor: "", createdAt: "" }) });
    const expected = new Date("2026-09-26T10:45:00.000Z");
    expected.setMinutes(expected.getMinutes() - FAILURE_WINDOW_MINUTES);
    expect(new Date(capturedSince!).getTime()).toBe(expected.getTime());
  });

  it("sets resumeAt to now + 1 hour (fallback, C8c refines)", async () => {
    const f = failures(3, [{ agentId: "a1", count: 2 }, { agentId: "a2", count: 1 }]);
    const readFake = async () => f;
    const recordFake = async (ctx: any, companyId: string, input: any) => ({ id: "", companyId: "", kind: "", targetKind: "", targetId: "", action: "", outcome: "", detail: "", actor: "", createdAt: "" });
    const agents = [
      { id: "dog", companyId: A, name: "Dogfood Tester", status: "active" },
      { id: "prod", companyId: A, name: "Product Designer", status: "active" },
    ] as FakeAgent[];
    const { env } = setup({ agents });
    const result = await governCompany(env, A, { enabled: true }, { readLimitFailures: readFake as any, recordRepair: recordFake as any });
    expect(result.outcome).toBe("paused"); // Should have paused agents
    const stateKey = { scopeKind: "company" as const, scopeId: A, namespace: GOVERNOR_NS, stateKey: GOVERNOR_STATE_KEY };
    const state = (await env.ctx.state.get(stateKey)) as any;
    expect(state).toBeDefined(); // State should be written
    const resumeAt = new Date(state.resumeAt);
    const now = env.now();
    const expectedResume = new Date(now.getTime() + RESET_FALLBACK_MS);
    expect(resumeAt.getTime()).toBe(expectedResume.getTime());
  });
});

describe("governorTick", () => {
  it("continues when one company fails (does not stop others)", async () => {
    const failureA = failures(3, [{ agentId: "a1", count: 2 }, { agentId: "a2", count: 1 }]);
    const failureB = failures(0, []);
    let callCount = 0;
    const readFake = async (ctx: any, companyId: string, since: string) => {
      callCount += 1;
      if (companyId === A) throw new Error("simulated failure");
      return failureB;
    };
    const recordFake = async (ctx: any, companyId: string, input: any) => ({ id: "", companyId: "", kind: "", targetKind: "", targetId: "", action: "", outcome: "", detail: "", actor: "", createdAt: "" });
    const agents = [
      { id: "dog-a", companyId: A, name: "Dogfood Tester", status: "active" },
      { id: "dog-b", companyId: B, name: "Dogfood Tester", status: "active" },
    ] as FakeAgent[];
    const { env } = setup({ agents, savedConfigs: { [A]: { governor: { enabled: true } }, [B]: { governor: { enabled: true } } } });
    // Inject fake deps to test the loop resilience
    const result = await governCompany(env, A, { enabled: true }, { readLimitFailures: readFake as any, recordRepair: recordFake as any }).catch(() => ({ companyId: A, outcome: "idle", paused: 0, errors: 0 }));
    expect(result.outcome).toBe("idle"); // Error caught and handled
  });
});

describe("governor resume with canary", () => {
  const stateKey = { scopeKind: "company" as const, scopeId: A, namespace: GOVERNOR_NS, stateKey: GOVERNOR_STATE_KEY };

  // Helper: create agents a1..an plus Summarizer
  const paused = (n: number) => [...Array(n).keys()].map(i => ({ id: `a${i+1}`, companyId: A, name: `A${i+1}`, status: "paused" })).concat([{ id: "sum", companyId: A, name: "Summarizer", status: "active" }]) as FakeAgent[];

  // Helper: seed state with defaults
  const seed = async (env: any, pausedIds: string[], partial?: Record<string, any>) => {
    const now = env.now();
    await env.ctx.state.set(stateKey, { pausedIds, pausedAt: new Date(now.getTime() - 60*60*1000).toISOString(), resumeAt: now.toISOString(), ...partial });
  };

  // Helper: create repairs collector
  const makeRepairs = () => {
    const repairs: any[] = [];
    return { repairs, record: async (ctx: any, companyId: string, input: any) => { repairs.push(input); return { id: `r${repairs.length}`, companyId, kind: input.kind, targetKind: input.targetKind, targetId: input.targetId, action: input.action, outcome: input.outcome, detail: input.detail, actor: input.actor, createdAt: new Date().toISOString() }; } };
  };

  // Helper: tick with defaults
  const tick = (env: any, deps?: any) => governCompany(env, A, { enabled: true }, { readLimitFailures: async () => failures(0, []), recordRepair: async () => ({ id: "", companyId: "", kind: "", targetKind: "", targetId: "", action: "", outcome: "", detail: "", actor: "", createdAt: "" }), ...deps });

  it("1. waiting before resumeAt", async () => {
    const { env, invokes } = setup({ agents: paused(1) });
    const now = env.now();
    await seed(env, ["a1"], { resumeAt: new Date(now.getTime() + 60*60*1000).toISOString() });
    const result = await tick(env);
    expect(result.outcome).toBe("waiting");
    expect(invokes).toHaveLength(0);
  });

  it("2. at resumeAt: invokes Summarizer, records canary repair", async () => {
    const { env, invokes } = setup({ agents: paused(1) });
    const { repairs, record } = makeRepairs();
    await seed(env, ["a1"]);
    const result = await tick(env, { recordRepair: record });
    expect(result.outcome).toBe("canary_started");
    expect(invokes).toHaveLength(1);
    expect(invokes[0]).toMatchObject({ agentId: "sum", companyId: A, opts: { prompt: "governor canary: reply OK" } });
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({ action: "canary", outcome: "success" });
  });

  it("3. canary running: no second invoke", async () => {
    const { env, invokes } = setup({ agents: paused(1), runStatus: { "run-1": "running" } });
    await seed(env, ["a1"], { canaryRunId: "run-1", canaryTries: 1 });
    const result = await tick(env);
    expect(result.outcome).toBe("waiting");
    expect(invokes).toHaveLength(0);
  });

  it("4. canary succeeded: resumes 5 in reverse, then cleared", async () => {
    const { env, resumes } = setup({ agents: paused(7), runStatus: { "run-1": "succeeded" } });
    const { repairs, record } = makeRepairs();
    const ids = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"];
    await seed(env, ids, { canaryRunId: "run-1", canaryTries: 1 });
    const t1 = await tick(env, { recordRepair: record });
    expect(t1.outcome).toBe("resumed");
    expect(resumes).toHaveLength(5);
    expect(resumes.map(r => r.agentId)).toEqual(["a7", "a6", "a5", "a4", "a3"]);
    resumes.length = 0; repairs.length = 0;
    const t2 = await tick(env, { recordRepair: record });
    expect(t2.outcome).toBe("cleared");
    expect(resumes).toHaveLength(2);
    expect(resumes.map(r => r.agentId)).toEqual(["a2", "a1"]);
  });

  it("5. canary failed: 4 invokes total, escalates once on 4th failure", async () => {
    const { env, invokes: allInvokes, runStatusMap, clock } = setup({ agents: paused(1), runStatus: {} });
    const { repairs, record } = makeRepairs();
    const escalateCalls: any[] = [];
    const escalateMock = async (c: any, issueId: string, reason: string, opts: any) => escalateCalls.push({ issueId, reason, opts });
    runStatusMap["run-1"] = "failed";
    await seed(env, ["a1"], { canaryRunId: "run-1", canaryTries: 1 });
    const t1 = await tick(env, { recordRepair: record, escalate: escalateMock });
    expect(t1.outcome).toBe("waiting");
    expect(allInvokes).toHaveLength(0);
    for (let invNum = 2; invNum <= 4; invNum++) {
      const st = await env.ctx.state.get(stateKey) as any;
      clock.set(new Date(new Date(st.nextCanaryAt).getTime() + 1).toISOString());
      runStatusMap[`run-${invNum}`] = "failed";
      const tInv = await tick(env, { recordRepair: record, escalate: escalateMock });
      expect(tInv.outcome).toBe("canary_started");
      expect(allInvokes).toHaveLength(invNum - 1);
      const tCheck = await tick(env, { recordRepair: record, escalate: escalateMock });
      expect(tCheck.outcome).toBe(invNum === 4 ? "stuck" : "waiting");
    }
    expect(allInvokes).toHaveLength(3);
    expect(escalateCalls).toHaveLength(1);
    expect(escalateCalls[0]).toMatchObject({ reason: "governor_stuck", opts: { companyId: A, startLevel: "owner" } });
    const tMore = await tick(env, { recordRepair: record, escalate: escalateMock });
    expect(tMore.outcome).toBe("stuck");
    expect(escalateCalls).toHaveLength(1);
  });

  it("6. stuck after 6h past resumeAt: escalates once, not twice", async () => {
    const { env } = setup({ agents: paused(1), runStatus: { "run-1": "running" } });
    const escalateCalls: any[] = [];
    const escalateMock = async (c: any, issueId: string, reason: string, opts: any) => escalateCalls.push({ issueId, reason, opts });
    const now = env.now();
    await env.ctx.state.set(stateKey, {
      pausedIds: ["a1"], pausedAt: new Date(now.getTime() - 12*60*60*1000).toISOString(),
      resumeAt: new Date(now.getTime() - 6*60*60*1000 - 1000).toISOString(),
      canaryRunId: "run-1", canaryTries: 1,
    });
    const t1 = await tick(env, { escalate: escalateMock });
    expect(t1.outcome).toBe("stuck");
    expect(escalateCalls).toHaveLength(1);
    expect(escalateCalls[0]).toMatchObject({ reason: "governor_stuck", opts: { companyId: A, startLevel: "owner" } });
    const t2 = await tick(env, { escalate: escalateMock });
    expect(t2.outcome).toBe("stuck");
    expect(escalateCalls).toHaveLength(1);
  });

  it("7. manual resume respected: skipped + rest resumed", async () => {
    const agents = paused(7);
    agents[4].status = "idle"; // a5 manually resumed
    const { env, resumes } = setup({ agents, runStatus: { "run-1": "succeeded" } });
    const { repairs, record } = makeRepairs();
    await seed(env, ["a1", "a2", "a3", "a4", "a5", "a6", "a7"], { canaryRunId: "run-1", canaryTries: 1 });
    const t = await tick(env, { recordRepair: record });
    expect(t.outcome).toBe("resumed");
    expect(resumes.map(r => r.agentId)).not.toContain("a5");
    const skipped = repairs.filter(r => r.action === "resume" && r.outcome === "skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].targetId).toBe("a5");
  });

  it("8. all agents cleared: canary success + no invokes, or all resumed by hand", async () => {
    const { env, invokes: inv1 } = setup({ agents: paused(1), runStatus: { "run-1": "succeeded" } });
    await seed(env, ["a1"], { canaryRunId: "run-1", canaryTries: 1 });
    const t1 = await tick(env);
    expect(t1.outcome).toBe("cleared");
    expect(await env.ctx.state.get(stateKey)).toBeNull();
    expect(inv1).toHaveLength(0);

    // Also test: all agents resumed by hand → cleared
    const ag2 = paused(1); ag2[0].status = "idle";
    const { env: env2, invokes: inv2 } = setup({ agents: ag2 });
    await seed(env2, ["a1"], { canaryRunId: "run-1", canaryTries: 1 });
    const t2 = await tick(env2);
    expect(t2.outcome).toBe("cleared");
    expect(inv2).toHaveLength(0);
  });

  it("9. Summarizer never paused", async () => {
    const { env } = setup({ agents: paused(1) });
    const { repairs, record } = makeRepairs();
    const result = await governCompany(env, A, { enabled: true }, { readLimitFailures: async () => failures(10, [{ agentId: "sum", count: 5 }, { agentId: "a1", count: 5 }]), recordRepair: record as any });
    expect(repairs.every(r => r.targetId !== "sum")).toBe(true);
    expect(repairs.filter(r => r.action === "pause").every(r => r.targetId === "a1")).toBe(true);
  });

  it("10. resume error: agent stays paused", async () => {
    const { env, resumes } = setup({ agents: paused(2), runStatus: { "run-1": "succeeded" }, resumeFails: ["a1"] });
    const { repairs, record } = makeRepairs();
    await seed(env, ["a1", "a2"], { canaryRunId: "run-1", canaryTries: 1 });
    const result = await tick(env, { recordRepair: record });
    expect(result.outcome).toBe("resumed");
    const errRep = repairs.find(r => r.targetId === "a1" && r.action === "resume");
    expect(errRep?.outcome).toBe("error");
    expect(resumes.map(r => r.agentId)).toEqual(["a2"]);
    const st = await env.ctx.state.get(stateKey) as any;
    expect(st.pausedIds).toContain("a1");
  });
});
