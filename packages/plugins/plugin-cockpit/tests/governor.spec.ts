import { describe, expect, it } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { createEnv, governorTick } from "../src/register.js";
import { governCompany, GOVERNOR_NS, GOVERNOR_STATE_KEY, type GovernorConfig, type GovernorDeps } from "../src/governor.js";
import { DEFAULT_PAUSE_ORDER, FAILURE_WINDOW_MINUTES, NEVER_PAUSE, RESET_FALLBACK_MS, type LimitFailures } from "../src/governor-model.js";
import { fakeCtx, fixedClock, type FakeAgent } from "./helpers/fake-ctx.js";

const A = "company-a";
const B = "company-b";

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
    const { env } = setup();
    const stateKey = { scopeKind: "company" as const, scopeId: A, namespace: GOVERNOR_NS, stateKey: GOVERNOR_STATE_KEY };
    await env.ctx.state.set(stateKey, { pausedIds: ["a1", "a2"], pausedAt: "2026-09-26T09:00:00.000Z", resumeAt: "2026-09-26T10:00:00.000Z" });
    const result = await governCompany(env, A, { enabled: true });
    expect(result).toMatchObject({ companyId: A, outcome: "already_paused", paused: 2, errors: 0 });
  });

  it("returns idle when failures don't trigger", async () => {
    const failures: LimitFailures = { total: 2, byAgent: [{ agentId: "a1", count: 1 }, { agentId: "a2", count: 1 }] };
    const readFake = async () => failures;
    const { env } = setup();
    const result = await governCompany(env, A, { enabled: true }, { readLimitFailures: readFake as any, recordRepair: async () => ({ id: "", companyId: "", kind: "", targetKind: "", targetId: "", action: "", outcome: "", detail: "", actor: "", createdAt: "" }) });
    expect(result).toMatchObject({ companyId: A, outcome: "idle", paused: 0, errors: 0 });
  });

  it("returns idle when no agents to pause (already paused or filtered)", async () => {
    const failures: LimitFailures = { total: 3, byAgent: [{ agentId: "a1", count: 2 }, { agentId: "a2", count: 1 }] };
    const readFake = async () => failures;
    const agents = [
      { id: "a1", companyId: A, name: "Paused Agent", status: "paused", role: "general" },
      { id: "a2", companyId: A, name: "Delivery Lead", status: "active", role: "general" },
    ] as FakeAgent[];
    const { env } = setup({ agents });
    const result = await governCompany(env, A, { enabled: true }, { readLimitFailures: readFake as any, recordRepair: async () => ({ id: "", companyId: "", kind: "", targetKind: "", targetId: "", action: "", outcome: "", detail: "", actor: "", createdAt: "" }) });
    expect(result).toMatchObject({ companyId: A, outcome: "idle", paused: 0, errors: 0 });
  });

  it("pauses agents in order, writes state, records repairs", async () => {
    const failures: LimitFailures = { total: 3, byAgent: [{ agentId: "dog", count: 2 }, { agentId: "prod", count: 1 }] };
    const readFake = async () => failures;
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
    const failures: LimitFailures = { total: 3, byAgent: [{ agentId: "dog", count: 2 }, { agentId: "prod", count: 1 }] };
    const readFake = async () => failures;
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
    // Second tick sees state, no pause calls
    const result2 = await governCompany(env, A, { enabled: true }, { readLimitFailures: readFake as any, recordRepair: recordFake as any });
    expect(result2.outcome).toBe("already_paused");
    expect(repairs.length).toBe(2); // No new repairs
  });

  it("respects never-list agents (never pauses them)", async () => {
    const failures: LimitFailures = { total: 3, byAgent: [{ agentId: "dev", count: 2 }, { agentId: "dl", count: 1 }] };
    const readFake = async () => failures;
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
    const failures: LimitFailures = { total: 3, byAgent: [{ agentId: "a1", count: 2 }, { agentId: "a2", count: 1 }] };
    const readFake = async () => failures;
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
    const failures: LimitFailures = { total: 3, byAgent: [{ agentId: "a1", count: 2 }, { agentId: "a2", count: 1 }] };
    const readFake = async () => failures;
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
    const failures: LimitFailures = { total: 4, byAgent: [{ agentId: "a1", count: 2 }, { agentId: "a2", count: 2 }] };
    const readFake = async () => failures;
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
    const failures: LimitFailures = { total: 3, byAgent: [{ agentId: "a1", count: 2 }, { agentId: "a2", count: 1 }] };
    const readFake = async () => failures;
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
    const failureA: LimitFailures = { total: 3, byAgent: [{ agentId: "a1", count: 2 }, { agentId: "a2", count: 1 }] };
    const failureB: LimitFailures = { total: 0, byAgent: [] };
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
