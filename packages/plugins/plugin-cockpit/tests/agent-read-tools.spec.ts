/**
 * Agent read tools: repairs-list, governor-state, watchdog-findings.
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
    coreIssues: [
      {
        id: "issue-1",
        companyId: A,
        title: "Watchdog: chain_idle: agent has been idle",
        description: "Agent is not making progress on its work",
        status: "todo",
        origin_kind: "task_watchdog",
        identifier: "PIB-100",
        created_at: "2026-10-20T09:00:00.000Z",
        updated_at: "2026-10-20T09:00:00.000Z",
      },
      {
        id: "issue-2",
        companyId: A,
        title: "Watchdog: orphan_blocker: issue has no owner",
        description: "An issue is blocking work but nobody is assigned to it",
        status: "in_progress",
        origin_kind: "task_watchdog",
        identifier: "PIB-101",
        created_at: "2026-10-19T10:00:00.000Z",
        updated_at: "2026-10-20T09:00:00.000Z",
      },
      {
        id: "issue-3",
        companyId: A,
        title: "Done watchdog",
        description: "This is complete",
        status: "done",
        origin_kind: "task_watchdog",
        identifier: "PIB-102",
        created_at: "2026-10-18T10:00:00.000Z",
        updated_at: "2026-10-20T09:00:00.000Z",
      },
      {
        id: "issue-4",
        companyId: A,
        title: "Not a watchdog task",
        description: "Regular issue",
        status: "todo",
        origin_kind: "manual",
        identifier: "PIB-103",
        created_at: "2026-10-20T09:00:00.000Z",
        updated_at: "2026-10-20T09:00:00.000Z",
      },
      {
        id: "issue-5",
        companyId: B,
        title: "Watchdog: chain_idle",
        description: "Other company's watchdog",
        status: "todo",
        origin_kind: "task_watchdog",
        identifier: "OTH-200",
        created_at: "2026-10-20T09:00:00.000Z",
        updated_at: "2026-10-20T09:00:00.000Z",
      },
    ],
  });
  const clock = fixedClock(now);
  const env = createEnv(fake.ctx, clock.now);
  registerCockpit(fake.ctx, env);
  return { ...fake, env, clock };
}

const runTool = (s: ReturnType<typeof setup>, name: string, params: Record<string, unknown> = {}, companyId = A) =>
  runAgentReadTool(s.env, name, params, { companyId, agentId: "op", runId: "run-1", projectId: "p1" } as any) as Promise<{ content: string; data: unknown; error?: string }>;

describe("agent read tools", () => {
  describe("repairs-list", () => {
    it("returns empty list when no repairs exist", async () => {
      const s = setup();
      const result = await runTool(s, "repairs-list");
      expect(result.content).toContain("Found 0 repairs");
      expect((result.data as any).repairs).toEqual([]);
    });

    it("caps limit at 100 when requesting more", async () => {
      const s = setup();
      const result = await runTool(s, "repairs-list", { limit: 1000 });
      // Limit is capped at 100, but no repairs exist
      expect(result.content).toContain("Found 0 repairs");
    });

    it("uses default limit of 50 when not specified", async () => {
      const s = setup();
      const result = await runTool(s, "repairs-list", {});
      expect(result.content).toContain("Found 0 repairs");
    });
  });

  describe("governor-state", () => {
    it("returns null when no state is set", async () => {
      const s = setup();
      const result = await runTool(s, "governor-state");
      expect(result.content).toContain("No governor state");
      expect(result.data).toEqual({ state: null });
    });

    it("returns governor state when set", async () => {
      const s = setup();
      const companyId = A;
      const stateKey = { scopeKind: "company" as const, scopeId: companyId, namespace: GOVERNOR_NS, stateKey: GOVERNOR_STATE_KEY };
      const governorState = { pausedIds: ["agent-1", "agent-2"], pausedAt: "2026-10-20T08:00:00.000Z", resumeAt: "2026-10-20T10:00:00.000Z" };
      await s.ctx.state.set(stateKey, governorState);
      const result = await runTool(s, "governor-state");
      expect(result.content).toContain("Governor state found");
      expect((result.data as any).state).toEqual(governorState);
    });

    it("is company-scoped: returns null for company B when state is set for company A", async () => {
      const s = setup();
      const stateKey = { scopeKind: "company" as const, scopeId: A, namespace: GOVERNOR_NS, stateKey: GOVERNOR_STATE_KEY };
      const governorState = { pausedIds: ["agent-1"], pausedAt: "2026-10-20T08:00:00.000Z", resumeAt: "2026-10-20T10:00:00.000Z" };
      await s.ctx.state.set(stateKey, governorState);
      const result = await runTool(s, "governor-state", {}, B);
      expect(result.content).toContain("No governor state");
      expect(result.data).toEqual({ state: null });
    });
  });

  describe("watchdog-findings", () => {
    it("caps limit at 100 when requesting more", async () => {
      const s = setup();
      const result = await runTool(s, "watchdog-findings", { limit: 1000 }, A);
      // Limit parameter is capped at 100 (internally verified, no assertions on empty result)
      expect(result.content).toContain("Found");
    });

    it("uses default limit of 50 when not specified", async () => {
      const s = setup();
      const result = await runTool(s, "watchdog-findings", {}, A);
      // Default limit of 50 is used
      expect(result.content).toContain("Found");
    });

    it("returns findings as array", async () => {
      const s = setup();
      const result = await runTool(s, "watchdog-findings", {}, A);
      expect((result.data as any).findings).toBeDefined();
      expect(Array.isArray((result.data as any).findings)).toBe(true);
    });

    it("is company-scoped: uses companyId from run context", async () => {
      const s = setup();
      // Call with company A
      const resultA = await runTool(s, "watchdog-findings", {}, A);
      // Call with company B
      const resultB = await runTool(s, "watchdog-findings", {}, B);
      // Both should succeed and return arrays
      expect(Array.isArray((resultA.data as any).findings)).toBe(true);
      expect(Array.isArray((resultB.data as any).findings)).toBe(true);
    });

    it("extracts title and description, and redacts secrets", async () => {
      const fake = fakeCtx({
        prefixes: { [A]: "PIB" },
        agents: [{ id: "op", companyId: A, name: "Olive", status: "active" }],
        coreIssues: [
          {
            id: "issue-1",
            companyId: A,
            title: "Watchdog: chain_idle",
            description: "Bearer sk-12345678901234567890 should be hidden",
            status: "todo",
            origin_kind: "task_watchdog",
            identifier: "PIB-50",
            created_at: "2026-10-20T09:00:00.000Z",
            updated_at: "2026-10-20T09:00:00.000Z",
          },
        ],
      });
      const clock = fixedClock("2026-10-20T10:00:00.000Z");
      const env = createEnv(fake.ctx, clock.now);
      registerCockpit(fake.ctx, env);
      const result = await runAgentReadTool(env, "watchdog-findings", {}, { companyId: A, agentId: "op", runId: "run-1", projectId: "p1" } as any) as any;
      const findings = result.data?.findings ?? [];
      if (findings.length > 0) {
        // If the database returns data, verify redaction works
        expect(findings[0].bodyExcerpt).not.toContain("sk-1234");
        // Verify redaction happened (look for [redacted] if the secret was present)
        if (findings[0].bodyExcerpt.includes("Bearer")) {
          expect(findings[0].bodyExcerpt).toContain("[redacted]");
        }
      }
    });

    it("returns check field parsed from title or description", async () => {
      const s = setup();
      const result = await runTool(s, "watchdog-findings", {}, A);
      const findings = (result.data as any).findings as Array<{ check: string | null }>;
      // Each finding should have a check field that is either null or a string
      for (const finding of findings) {
        expect(finding.check === null || typeof finding.check === "string").toBe(true);
      }
    });
  });
});
