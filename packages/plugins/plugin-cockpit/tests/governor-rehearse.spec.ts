import { describe, expect, it } from "vitest";
import type { RehearseInput, RehearseResult } from "../src/governor-rehearse.js";
import { rehearseGovernor } from "../src/governor-rehearse.js";
import { GOVERNOR_NS, GOVERNOR_STATE_KEY } from "../src/governor.js";
import { NEVER_PAUSE } from "../src/governor-model.js";
import { fakeCtx, fixedClock, type FakeAgent } from "./helpers/fake-ctx.js";
import { createEnv } from "../src/register.js";

const A = "company-a";

function setup(options: Parameters<typeof fakeCtx>[0] = {}, now = "2026-09-26T10:00:00.000Z") {
  const fake = fakeCtx(options);
  const clock = fixedClock(now);
  const env = createEnv(fake.ctx, clock.now);

  // Extend fake ctx with agents.resume since it's not in the base fake yet
  const originalAgents = fake.ctx.agents;
  fake.ctx.agents = {
    ...originalAgents,
    resume: async (agentId: string, companyId: string) => {
      if ((options.resumeFails ?? []).includes(agentId)) throw new Error("resume refused");
      const agent = (await originalAgents.list({ companyId })).find((a) => a.id === agentId);
      if (!agent) throw new Error("agent not found");
      fake.agents.find((a) => a.id === agentId && a.companyId === companyId)!.status = "active";
      return agent;
    },
  } as any;

  // Extend state with delete method
  const originalState = fake.ctx.state;
  fake.ctx.state = {
    ...originalState,
    delete: async (key: Parameters<typeof originalState.get>[0]) => {
      const keyStr = `${key.scopeKind}:${key.scopeId ?? ""}:${key.namespace ?? ""}:${key.stateKey}`;
      fake.state.delete(keyStr);
    },
  } as any;

  return { ...fake, env, clock };
}

describe("rehearseGovernor", () => {
  it("happy path: pause + canary success + resume, clears state", async () => {
    const agents = [
      { id: "dog", companyId: A, name: "Dogfood Tester", status: "active" },
      { id: "prod", companyId: A, name: "Product Designer", status: "active" },
      { id: "summarizer", companyId: A, name: "Summarizer", status: "active" },
    ] as FakeAgent[];
    const repairs: any[] = [];
    const recordFake = async (ctx: any, companyId: string, input: any) => {
      repairs.push(input);
      return { id: `rep${repairs.length}`, companyId, kind: input.kind, targetKind: input.targetKind, targetId: input.targetId, action: input.action, outcome: input.outcome, detail: input.detail, actor: input.actor, createdAt: new Date().toISOString() };
    };
    const { env, ctx } = setup({ agents });
    const readFake = async () => { throw new Error("should not be called"); };

    const result = await rehearseGovernor(env, A, { agentName: "Dogfood Tester" }, { readLimitFailures: readFake as any, recordRepair: recordFake as any });

    expect(result).toMatchObject({ companyId: A, outcome: "completed", canary: "succeeded", resumed: true });
    expect(result.agentId).toBe("dog");
    expect(result.agentName).toBe("Dogfood Tester");
    expect(repairs).toHaveLength(3);
    expect(repairs[0]).toMatchObject({ action: "pause", outcome: "success", detail: expect.stringContaining("[rehearsal]") });
    expect(repairs[1]).toMatchObject({ action: "canary", outcome: "success", detail: expect.stringContaining("[rehearsal]") });
    expect(repairs[2]).toMatchObject({ action: "resume", outcome: "success", detail: expect.stringContaining("[rehearsal]") });
    // State cleared: pausedIds empty or deleted
    const stateKey = { scopeKind: "company" as const, scopeId: A, namespace: GOVERNOR_NS, stateKey: GOVERNOR_STATE_KEY };
    const state = (await env.ctx.state.get(stateKey)) as any;
    expect(state?.pausedIds?.length ?? 0).toBe(0);
  });

  it("canary failure: agent resumed despite failed canary, canary decision is retry", async () => {
    const agents = [{ id: "dog", companyId: A, name: "Dogfood Tester", status: "active" }] as FakeAgent[];
    const repairs: any[] = [];
    const recordFake = async (ctx: any, companyId: string, input: any) => {
      repairs.push(input);
      return { id: `rep${repairs.length}`, companyId, kind: input.kind, targetKind: input.targetKind, targetId: input.targetId, action: input.action, outcome: input.outcome, detail: input.detail, actor: input.actor, createdAt: new Date().toISOString() };
    };
    const { env } = setup({ agents });
    const readFake = (async () => { throw new Error("should not be called"); }) as any;

    const result = await rehearseGovernor(env, A, { agentName: "Dogfood Tester", canaryStatus: "failed" }, { readLimitFailures: readFake, recordRepair: recordFake as any });

    expect(result).toMatchObject({ outcome: "completed", canary: "retry", resumed: true });
    expect(repairs[1]).toMatchObject({ action: "canary", outcome: "error" });
    expect(repairs[2]).toMatchObject({ action: "resume", outcome: "success" });
  });

  it("refusal: governor already active (pausedIds in state)", async () => {
    const agents = [{ id: "dog", companyId: A, name: "Dogfood Tester", status: "active" }] as FakeAgent[];
    const { env } = setup({ agents });
    const stateKey = { scopeKind: "company" as const, scopeId: A, namespace: GOVERNOR_NS, stateKey: GOVERNOR_STATE_KEY };
    await env.ctx.state.set(stateKey, { pausedIds: ["other-agent"], pausedAt: "2026-09-26T09:00:00.000Z", resumeAt: "2026-09-26T10:00:00.000Z" });
    const readFake = (async () => { throw new Error("should not be called"); }) as any;
    const recordFake = (async () => ({ id: "", companyId: "", kind: "", targetKind: "", targetId: "", action: "", outcome: "", detail: "", actor: "", createdAt: "" })) as any;

    const result = await rehearseGovernor(env, A, { agentName: "Dogfood Tester" }, { readLimitFailures: readFake, recordRepair: recordFake });

    expect(result).toMatchObject({ outcome: "refused", reason: "governor_active" });
    expect(result.detail).toBeDefined();
  });

  it("refusal: never-list agent (Summarizer)", async () => {
    const agents = [{ id: "sum", companyId: A, name: "Summarizer", status: "active" }] as FakeAgent[];
    const { env } = setup({ agents });
    const readFake = (async () => { throw new Error("should not be called"); }) as any;
    const recordFake = (async () => ({ id: "", companyId: "", kind: "", targetKind: "", targetId: "", action: "", outcome: "", detail: "", actor: "", createdAt: "" })) as any;

    const result = await rehearseGovernor(env, A, { agentName: "Summarizer" }, { readLimitFailures: readFake, recordRepair: recordFake });

    expect(result).toMatchObject({ outcome: "refused", reason: "never_pause" });
  });

  it("refusal: unknown agent", async () => {
    const agents = [{ id: "dog", companyId: A, name: "Dogfood Tester", status: "active" }] as FakeAgent[];
    const { env } = setup({ agents });
    const readFake = (async () => { throw new Error("should not be called"); }) as any;
    const recordFake = (async () => ({ id: "", companyId: "", kind: "", targetKind: "", targetId: "", action: "", outcome: "", detail: "", actor: "", createdAt: "" })) as any;

    const result = await rehearseGovernor(env, A, { agentName: "NonExistent Agent" }, { readLimitFailures: readFake, recordRepair: recordFake });

    expect(result).toMatchObject({ outcome: "refused", reason: "agent_not_found" });
  });

  it("refusal: agent already paused", async () => {
    const agents = [{ id: "dog", companyId: A, name: "Dogfood Tester", status: "paused" }] as FakeAgent[];
    const { env } = setup({ agents });
    const readFake = (async () => { throw new Error("should not be called"); }) as any;
    const recordFake = (async () => ({ id: "", companyId: "", kind: "", targetKind: "", targetId: "", action: "", outcome: "", detail: "", actor: "", createdAt: "" })) as any;

    const result = await rehearseGovernor(env, A, { agentName: "Dogfood Tester" }, { readLimitFailures: readFake, recordRepair: recordFake });

    expect(result).toMatchObject({ outcome: "refused", reason: "agent_already_paused" });
  });

  it("refusal: empty agentName", async () => {
    const agents = [{ id: "dog", companyId: A, name: "Dogfood Tester", status: "active" }] as FakeAgent[];
    const { env } = setup({ agents });
    const readFake = (async () => { throw new Error("should not be called"); }) as any;
    const recordFake = (async () => ({ id: "", companyId: "", kind: "", targetKind: "", targetId: "", action: "", outcome: "", detail: "", actor: "", createdAt: "" })) as any;

    const result = await rehearseGovernor(env, A, { agentName: "" }, { readLimitFailures: readFake, recordRepair: recordFake });

    expect(result).toMatchObject({ outcome: "refused", reason: "bad_input" });
  });

  it("refusal: multiple agents with same name", async () => {
    const agents = [
      { id: "dog1", companyId: A, name: "Dogfood Tester", status: "active" },
      { id: "dog2", companyId: A, name: "Dogfood Tester", status: "active" },
    ] as FakeAgent[];
    const { env } = setup({ agents });
    const readFake = (async () => { throw new Error("should not be called"); }) as any;
    const recordFake = (async () => ({ id: "", companyId: "", kind: "", targetKind: "", targetId: "", action: "", outcome: "", detail: "", actor: "", createdAt: "" })) as any;

    const result = await rehearseGovernor(env, A, { agentName: "Dogfood Tester" }, { readLimitFailures: readFake, recordRepair: recordFake });

    expect(result).toMatchObject({ outcome: "refused", reason: "bad_input", detail: expect.stringContaining("More than one agent is named") });
  });

  it("refusal: pause fails (agent.pause throws)", async () => {
    const agents = [{ id: "dog", companyId: A, name: "Dogfood Tester", status: "active" }] as FakeAgent[];
    const repairs: any[] = [];
    const recordFake = async (ctx: any, companyId: string, input: any) => {
      repairs.push(input);
      return { id: `rep${repairs.length}`, companyId, kind: input.kind, targetKind: input.targetKind, targetId: input.targetId, action: input.action, outcome: input.outcome, detail: input.detail, actor: input.actor, createdAt: new Date().toISOString() };
    };
    const { env } = setup({ agents, pauseFails: ["dog"] });
    const readFake = (async () => { throw new Error("should not be called"); }) as any;

    const result = await rehearseGovernor(env, A, { agentName: "Dogfood Tester" }, { readLimitFailures: readFake, recordRepair: recordFake as any });

    expect(result).toMatchObject({ outcome: "refused", reason: "not_paused" });
    // governCompany records a repair for the failed pause attempt
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({ action: "pause", outcome: "error" });
  });

  it("resume fails: completed with resumed=false, error repair, state untouched", async () => {
    const agents = [{ id: "dog", companyId: A, name: "Dogfood Tester", status: "active" }] as FakeAgent[];
    const repairs: any[] = [];
    const recordFake = async (ctx: any, companyId: string, input: any) => {
      repairs.push(input);
      return { id: `rep${repairs.length}`, companyId, kind: input.kind, targetKind: input.targetKind, targetId: input.targetId, action: input.action, outcome: input.outcome, detail: input.detail, actor: input.actor, createdAt: new Date().toISOString() };
    };
    const { env } = setup({ agents, resumeFails: ["dog"] });
    const readFake = (async () => { throw new Error("should not be called"); }) as any;

    const result = await rehearseGovernor(env, A, { agentName: "Dogfood Tester" }, { readLimitFailures: readFake, recordRepair: recordFake as any });

    expect(result).toMatchObject({ outcome: "completed", resumed: false });
    expect(repairs).toHaveLength(3);
    expect(repairs[0]).toMatchObject({ action: "pause", outcome: "success" });
    expect(repairs[1]).toMatchObject({ action: "canary", outcome: "success" });
    expect(repairs[2]).toMatchObject({ action: "resume", outcome: "error" });
    // State should be left in place
    const stateKey = { scopeKind: "company" as const, scopeId: A, namespace: GOVERNOR_NS, stateKey: GOVERNOR_STATE_KEY };
    const state = (await env.ctx.state.get(stateKey)) as any;
    expect(state?.pausedIds).toContain("dog");
  });

  it("readLimitFailures is NOT called (uses synthetic failure list)", async () => {
    const agents = [{ id: "dog", companyId: A, name: "Dogfood Tester", status: "active" }] as FakeAgent[];
    let readCalled = false;
    const readFake = (async () => {
      readCalled = true;
      return { total: 0, byAgent: [] };
    }) as any;
    const recordFake = (async () => ({ id: "", companyId: "", kind: "", targetKind: "", targetId: "", action: "", outcome: "", detail: "", actor: "", createdAt: "" })) as any;
    const { env } = setup({ agents });

    await rehearseGovernor(env, A, { agentName: "Dogfood Tester" }, { readLimitFailures: readFake, recordRepair: recordFake });

    expect(readCalled).toBe(false);
  });
});
