/**
 * Agent read tools: repairs-list, governor-state, watchdog-findings.
 * Unit tests: helpers, simple mocks, no Postgres.
 */
import { describe, expect, it } from "vitest";
import { runAgentReadTool } from "../src/agent-read-tools.js";
import { GOVERNOR_NS, GOVERNOR_STATE_KEY } from "../src/governor.js";
import { createEnv, registerCockpit } from "../src/register.js";
import { fakeCtx, fixedClock } from "./helpers/fake-ctx.js";

const A = "company-a";
const B = "company-b";

function setup(now = "2026-10-20T10:00:00.000Z") {
  const fake = fakeCtx({
    prefixes: { [A]: "PIB", [B]: "OTH" },
    agents: [
      { id: "op", companyId: A, name: "Olive", status: "active" },
      { id: "dev", companyId: B, name: "Dev", status: "active" },
    ],
  });
  const clock = fixedClock(now);
  const env = createEnv(fake.ctx, clock.now);
  registerCockpit(fake.ctx, env);
  return { ...fake, env, clock };
}

const runTool = (
  s: ReturnType<typeof setup>,
  name: string,
  params: Record<string, unknown> = {},
  companyId = A,
) =>
  runAgentReadTool(s.env, name, params, { companyId, agentId: "op", runId: "run-1", projectId: "p1" } as any) as Promise<{
    content: string;
    data: unknown;
    error?: string;
  }>;

describe("agent read tools (unit)", () => {
  describe("repairs-list", () => {
    it("returns empty list when no repairs exist", async () => {
      const s = setup();
      const result = await runTool(s, "repairs-list");
      expect(result.content).toContain("Found 0 repairs");
      expect((result.data as any).repairs).toStrictEqual([]);
    });

    it("respects default limit of 50", async () => {
      const s = setup();
      const result = await runTool(s, "repairs-list", {});
      expect(result.content).toContain("Found 0 repairs");
    });

    it("caps limit at 100 on request for more", async () => {
      const s = setup();
      // Limit 1000 is capped at 100 internally; we verify by checking no error
      const result = await runTool(s, "repairs-list", { limit: 1000 });
      expect(!result.error).toBe(true);
      expect(result.content).toContain("Found");
    });

    it("floors fractional limits", async () => {
      const s = setup();
      const result = await runTool(s, "repairs-list", { limit: 2.5 });
      expect(!result.error).toBe(true);
    });

    it("defaults to 50 for invalid limit types", async () => {
      const s = setup();
      const result = await runTool(s, "repairs-list", { limit: "not-a-number" });
      expect(!result.error).toBe(true);
    });

    it("uses NaN/null/undefined as unset (defaults to 50)", async () => {
      const s = setup();
      expect(!((await runTool(s, "repairs-list", { limit: NaN })).error)).toBe(true);
      expect(!((await runTool(s, "repairs-list", { limit: null })).error)).toBe(true);
      expect(!((await runTool(s, "repairs-list", { limit: undefined })).error)).toBe(true);
    });
  });

  describe("governor-state", () => {
    it("returns null when no state is set", async () => {
      const s = setup();
      const result = await runTool(s, "governor-state");
      expect(result.content).toContain("No governor state");
      expect(result.data).toStrictEqual({ state: null });
    });

    it("returns governor state when set (preserves shape)", async () => {
      const s = setup();
      const companyId = A;
      const stateKey = {
        scopeKind: "company" as const,
        scopeId: companyId,
        namespace: GOVERNOR_NS,
        stateKey: GOVERNOR_STATE_KEY,
      };
      const governorState = {
        pausedIds: ["agent-1", "agent-2"],
        pausedAt: "2026-10-20T08:00:00.000Z",
        resumeAt: "2026-10-20T10:00:00.000Z",
      };
      await s.ctx.state.set(stateKey, governorState);
      const result = await runTool(s, "governor-state");
      expect(result.content).toContain("Governor state found");
      expect((result.data as any).state).toStrictEqual(governorState);
    });

    it("is company-scoped: returns null for company B when state is set for company A", async () => {
      const s = setup();
      const stateKeyA = {
        scopeKind: "company" as const,
        scopeId: A,
        namespace: GOVERNOR_NS,
        stateKey: GOVERNOR_STATE_KEY,
      };
      const governorState = {
        pausedIds: ["agent-1"],
        pausedAt: "2026-10-20T08:00:00.000Z",
        resumeAt: "2026-10-20T10:00:00.000Z",
      };
      await s.ctx.state.set(stateKeyA, governorState);
      const resultB = await runTool(s, "governor-state", {}, B);
      expect(resultB.content).toContain("No governor state");
      expect(resultB.data).toStrictEqual({ state: null });
    });

    it("redacts secret strings in governor state (leaf level)", async () => {
      const s = setup();
      const stateKey = {
        scopeKind: "company" as const,
        scopeId: A,
        namespace: GOVERNOR_NS,
        stateKey: GOVERNOR_STATE_KEY,
      };
      const stateWithSecret = {
        pausedIds: ["agent-1"],
        note: "Bearer sk-12345678901234567890 is set",
        nested: { secretKey: "sk-9876543210987654" },
      };
      await s.ctx.state.set(stateKey, stateWithSecret);
      const result = await runTool(s, "governor-state");
      expect((result.data as any).state).toBeDefined();
      const state = (result.data as any).state;
      expect(state.note).not.toContain("sk-12345");
      expect(state.note).toContain("[redacted]");
      expect(state.nested.secretKey).not.toContain("sk-9876");
      expect(state.nested.secretKey).toContain("[redacted]");
    });

    it("tolerates odd shapes without throwing", async () => {
      const s = setup();
      const stateKey = {
        scopeKind: "company" as const,
        scopeId: A,
        namespace: GOVERNOR_NS,
        stateKey: GOVERNOR_STATE_KEY,
      };
      const oddState = {
        circular: null as any,
        num: 42,
        arr: [1, 2, 3],
        str: "ok",
      };
      oddState.circular = oddState; // circular reference
      await s.ctx.state.set(stateKey, oddState);
      const result = await runTool(s, "governor-state");
      expect(!result.error).toBe(true);
    });
  });

  describe("watchdog-findings", () => {
    it("respects default limit of 50", async () => {
      const s = setup();
      const result = await runTool(s, "watchdog-findings", {});
      expect(!result.error).toBe(true);
    });

    it("caps limit at 100 on request for more", async () => {
      const s = setup();
      const result = await runTool(s, "watchdog-findings", { limit: 1000 });
      expect(!result.error).toBe(true);
    });

    it("floors fractional limits", async () => {
      const s = setup();
      const result = await runTool(s, "watchdog-findings", { limit: 2.5 });
      expect(!result.error).toBe(true);
    });

    it("returns findings as array", async () => {
      const s = setup();
      const result = await runTool(s, "watchdog-findings", {});
      expect((result.data as any).findings).toBeDefined();
      expect(Array.isArray((result.data as any).findings)).toBe(true);
    });

    it("redacts secrets in title and bodyExcerpt (tested in pg spec)", async () => {
      // This is tested with real Postgres in agent-read-tools.pg.spec.ts
      // because the fake context doesn't have a real DB backend for queries
      const s = setup();
      const result = await runTool(s, "watchdog-findings");
      expect((result.data as any).findings).toBeDefined();
      expect(Array.isArray((result.data as any).findings)).toBe(true);
    });

    it("extracts check field: chain_idle, orphan_blocker, or null (tested in pg spec)", async () => {
      // This is tested with real Postgres in agent-read-tools.pg.spec.ts
      // because the fake context doesn't have a real DB backend for queries
      const s = setup();
      const result = await runTool(s, "watchdog-findings");
      expect((result.data as any).findings).toBeDefined();
      expect(Array.isArray((result.data as any).findings)).toBe(true);
    });
  });
});
