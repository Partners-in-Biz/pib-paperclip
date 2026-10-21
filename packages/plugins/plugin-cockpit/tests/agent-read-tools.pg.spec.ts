/**
 * Agent read tools: repairs-list, governor-state, watchdog-findings.
 * Tests with real Postgres: company scoping, SQL filters, limit capping, redaction.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAgentReadTool } from "../src/agent-read-tools.js";
import { recordRepair } from "../src/repairs.js";
import { GOVERNOR_NS, GOVERNOR_STATE_KEY } from "../src/governor.js";
import { COMPANY, OTHER_COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";
import { randomUUID } from "node:crypto";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

d("agent read tools (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  async function make(options: Parameters<typeof worlds.make>[0] = {}) {
    return await worlds.make(options);
  }

  const addWatchdogIssue = async (w: any, id: string, identifier: string, title: string, description: string, status = "todo", companyId = COMPANY) => {
    const issue = w.pg.addIssue({
      id,
      identifier,
      title,
      description,
      status,
      originKind: "task_watchdog",
    });
    await w.pg.client.query(
      `INSERT INTO public.issues (id, company_id, identifier, title, description, status, origin_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, companyId, identifier, title, description, status, "task_watchdog"],
    );
    return issue;
  };

  const runTool = (
    w: any,
    name: string,
    params: Record<string, unknown> = {},
    companyId = COMPANY,
  ) =>
    runAgentReadTool(w.env, name, params, {
      companyId,
      agentId: "op",
      runId: "run-1",
      projectId: "p1",
    } as any) as Promise<{ content: string; data: unknown; error?: string }>;

  describe("repairs-list", () => {
    it("lists repairs for a company, newest first", async () => {
      const w = await make() as any;
      const r1 = await recordRepair(w.ctx, COMPANY, {
        kind: "agent",
        targetKind: "agent",
        targetId: "agent-1",
        action: "fix",
        outcome: "success",
        detail: "First repair",
        actor: "user",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const r2 = await recordRepair(w.ctx, COMPANY, {
        kind: "grant",
        targetKind: "grant",
        targetId: "grant-1",
        action: "grant",
        outcome: "success",
        detail: "Second repair",
        actor: "user",
      });

      const result = await runTool(w, "repairs-list");
      const repairs = (result.data as any).repairs;
      expect(repairs.length).toBe(2);
      expect(repairs[0].id).toBe(r2.id);
      expect(repairs[1].id).toBe(r1.id);
    });

    it("isolates repairs by company: A never sees B's", async () => {
      const w = await make() as any;
      const r1 = await recordRepair(w.ctx, COMPANY, {
        kind: "agent",
        targetKind: "agent",
        targetId: "agent-1",
        action: "fix",
        outcome: "success",
        detail: "Company A repair",
        actor: "user",
      });
      const r2 = await recordRepair(w.ctx, OTHER_COMPANY, {
        kind: "agent",
        targetKind: "agent",
        targetId: "agent-2",
        action: "fix",
        outcome: "success",
        detail: "Company B repair",
        actor: "user",
      });

      const resultA = await runTool(w, "repairs-list", {}, COMPANY);
      const resultB = await runTool(w, "repairs-list", {}, OTHER_COMPANY);
      const repairsA = (resultA.data as any).repairs;
      const repairsB = (resultB.data as any).repairs;

      expect(repairsA.length).toBe(1);
      expect(repairsA[0].id).toBe(r1.id);
      expect(repairsB.length).toBe(1);
      expect(repairsB[0].id).toBe(r2.id);
    });

    it("respects kind filter", async () => {
      const w = await make() as any;
      await recordRepair(w.ctx, COMPANY, {
        kind: "agent",
        targetKind: "agent",
        targetId: "agent-1",
        action: "fix",
        outcome: "success",
        actor: "user",
      });
      await recordRepair(w.ctx, COMPANY, {
        kind: "grant",
        targetKind: "grant",
        targetId: "grant-1",
        action: "grant",
        outcome: "success",
        actor: "user",
      });

      const result = await runTool(w, "repairs-list", { kind: "agent" });
      const repairs = (result.data as any).repairs;
      expect(repairs.length).toBe(1);
      expect(repairs[0].kind).toBe("agent");
    });

    it("respects since filter (createdAt >= since)", async () => {
      const w = await make() as any;
      const r1 = await recordRepair(w.ctx, COMPANY, {
        kind: "agent",
        targetKind: "agent",
        targetId: "agent-1",
        action: "fix",
        outcome: "success",
        actor: "user",
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const r2 = await recordRepair(w.ctx, COMPANY, {
        kind: "grant",
        targetKind: "grant",
        targetId: "grant-1",
        action: "grant",
        outcome: "success",
        actor: "user",
      });

      const since = r1.createdAt;
      const result = await runTool(w, "repairs-list", { since });
      const repairs = (result.data as any).repairs;
      // Both should be >= since
      expect(repairs.every((r: any) => r.createdAt >= since)).toBe(true);
    });

    it("caps limit at 100: seed 120 repairs, request 1000, get exactly 100", async () => {
      const w = await make() as any;
      for (let i = 0; i < 120; i++) {
        await recordRepair(w.ctx, COMPANY, {
          kind: "agent",
          targetKind: "agent",
          targetId: `agent-${i}`,
          action: "fix",
          outcome: "success",
          detail: `Repair ${i}`,
          actor: "user",
        });
      }

      const result = await runTool(w, "repairs-list", { limit: 1000 });
      const repairs = (result.data as any).repairs;
      expect(repairs.length).toBe(100);
    });

    it("redacts secrets in detail field", async () => {
      const w = await make() as any;
      await recordRepair(w.ctx, COMPANY, {
        kind: "agent",
        targetKind: "agent",
        targetId: "agent-1",
        action: "fix",
        outcome: "success",
        detail: "Bearer sk-12345678901234567890 was used",
        actor: "user",
      });

      const result = await runTool(w, "repairs-list");
      const repairs = (result.data as any).repairs;
      expect(repairs.length).toBe(1);
      expect(repairs[0].detail).not.toContain("sk-1234");
      expect(repairs[0].detail).toContain("[redacted]");
    });

    it("returns empty list when no repairs exist", async () => {
      const w = await make() as any;
      const result = await runTool(w, "repairs-list");
      const repairs = (result.data as any).repairs;
      expect(repairs.length).toBe(0);
      expect(result.content).toContain("Found 0 repairs");
    });
  });

  describe("watchdog-findings", () => {
    it("lists open watchdog findings, newest first", async () => {
      const w = await make() as any;
      const i1 = await addWatchdogIssue(w, randomUUID(), "PIB-100", "Watchdog: chain_idle: blocked", "Agent is stuck");
      await new Promise((resolve) => setTimeout(resolve, 10));
      const i2 = await addWatchdogIssue(w, randomUUID(), "PIB-101", "Watchdog: orphan_blocker: no owner", "Issue has no assignee", "in_progress");

      const result = await runTool(w, "watchdog-findings");
      const findings = (result.data as any).findings;
      expect(findings.length).toBe(2);
      expect(findings[0].identifier).toBe(i2.identifier);
      expect(findings[1].identifier).toBe(i1.identifier);
    });

    it("isolates findings by company: A never sees B's", async () => {
      const w = await make() as any;
      const iaid = randomUUID();
      await w.pg.client.query(
        `INSERT INTO public.issues (id, company_id, identifier, title, description, status, origin_kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [iaid, COMPANY, "PIB-100", "Watchdog: chain_idle", "Company A", "todo", "task_watchdog"],
      );
      const ibid = randomUUID();
      await w.pg.client.query(
        `INSERT INTO public.issues (id, company_id, identifier, title, description, status, origin_kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [ibid, OTHER_COMPANY, "OTH-200", "Watchdog: chain_idle", "Company B", "todo", "task_watchdog"],
      );

      const resultA = await runTool(w, "watchdog-findings", {}, COMPANY);
      const resultB = await runTool(w, "watchdog-findings", {}, OTHER_COMPANY);
      const findingsA = (resultA.data as any).findings;
      const findingsB = (resultB.data as any).findings;

      expect(findingsA.length).toBe(1);
      expect(findingsA[0].identifier).toBe("PIB-100");
      expect(findingsB.length).toBe(1);
      expect(findingsB[0].identifier).toBe("OTH-200");
    });

    it("filters by origin_kind='task_watchdog': excludes manual issues", async () => {
      const w = await make() as any;
      const id1 = randomUUID();
      await w.pg.client.query(
        `INSERT INTO public.issues (id, company_id, identifier, title, description, status, origin_kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id1, COMPANY, "PIB-100", "Watchdog: chain_idle", "Watchdog issue", "todo", "task_watchdog"],
      );
      const id2 = randomUUID();
      await w.pg.client.query(
        `INSERT INTO public.issues (id, company_id, identifier, title, description, status, origin_kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id2, COMPANY, "PIB-101", "Manual issue", "Not a watchdog", "todo", "manual"],
      );

      const result = await runTool(w, "watchdog-findings");
      const findings = (result.data as any).findings;
      expect(findings.length).toBe(1);
      expect(findings[0].identifier).toBe("PIB-100");
    });

    it("excludes done and cancelled issues", async () => {
      const w = await make() as any;
      await addWatchdogIssue(w, randomUUID(), "PIB-100", "Watchdog: chain_idle", "Open", "todo");
      await addWatchdogIssue(w, randomUUID(), "PIB-101", "Watchdog: orphan_blocker", "Done", "done");
      await addWatchdogIssue(w, randomUUID(), "PIB-102", "Watchdog: chain_idle", "Cancelled", "cancelled");

      const result = await runTool(w, "watchdog-findings");
      const findings = (result.data as any).findings;
      expect(findings.length).toBe(1);
      expect(findings[0].identifier).toBe("PIB-100");
    });

    it("excludes hidden issues", async () => {
      const w = await make() as any;
      const uuid = randomUUID();
      await w.pg.client.query(
        `INSERT INTO public.issues (id, company_id, identifier, title, description, status, origin_kind, hidden_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [uuid, COMPANY, "PIB-100", "Watchdog: chain_idle", "Will be hidden", "todo", "task_watchdog"],
      );

      const result = await runTool(w, "watchdog-findings");
      const findings = (result.data as any).findings;
      expect(findings.length).toBe(0);
    });

    it("caps limit at 100: seed 120 issues, request 1000, get exactly 100", async () => {
      const w = await make() as any;
      for (let i = 0; i < 120; i++) {
        await w.pg.client.query(
          `INSERT INTO public.issues (id, company_id, identifier, title, description, status, origin_kind)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [randomUUID(), COMPANY, `PIB-${1000 + i}`, `Watchdog: chain_idle: issue ${i}`, `Issue ${i}`, "todo", "task_watchdog"],
        );
      }

      const result = await runTool(w, "watchdog-findings", { limit: 1000 });
      const findings = (result.data as any).findings;
      expect(findings.length).toBe(100);
    });

    it("redacts secrets in title and bodyExcerpt", async () => {
      const w = await make() as any;
      await addWatchdogIssue(w, randomUUID(), "PIB-100", "Watchdog: chain_idle with Bearer sk-12345678901234567890", "Detail: key sk-9876543210987654 used here");

      const result = await runTool(w, "watchdog-findings");
      const findings = (result.data as any).findings;
      expect(findings.length).toBe(1);
      expect(findings[0].title).not.toContain("sk-1234");
      expect(findings[0].title).toContain("[redacted]");
      expect(findings[0].bodyExcerpt).not.toContain("sk-9876");
      expect(findings[0].bodyExcerpt).toContain("[redacted]");
    });

    it("extracts check field: chain_idle, orphan_blocker, or null", async () => {
      const w = await make() as any;
      await addWatchdogIssue(w, randomUUID(), "PIB-100", "Watchdog: chain_idle: blocked", "no check here");
      await addWatchdogIssue(w, randomUUID(), "PIB-101", "Watchdog: unknown", "orphan_blocker: no owner");
      await addWatchdogIssue(w, randomUUID(), "PIB-102", "Watchdog: unknown title", "unknown description");

      const result = await runTool(w, "watchdog-findings");
      const findings = (result.data as any).findings;
      expect(findings.length).toBe(3);
      expect(findings.find((f: any) => f.identifier === "PIB-100")?.check).toBe(
        "chain_idle",
      );
      expect(findings.find((f: any) => f.identifier === "PIB-101")?.check).toBe(
        "orphan_blocker",
      );
      expect(findings.find((f: any) => f.identifier === "PIB-102")?.check).toBeNull();
    });

    it("returns empty list when no watchdog findings exist", async () => {
      const w = await make() as any;
      const result = await runTool(w, "watchdog-findings");
      const findings = (result.data as any).findings;
      expect(findings.length).toBe(0);
      expect(result.content).toContain("Found 0");
    });
  });

  describe("governor-state", () => {
    it("is company-scoped: company A cannot see company B's state", async () => {
      const w = await make() as any;
      const stateKeyB = {
        scopeKind: "company" as const,
        scopeId: OTHER_COMPANY,
        namespace: GOVERNOR_NS,
        stateKey: GOVERNOR_STATE_KEY,
      };
      const stateB = {
        pausedIds: ["agent-1"],
        pausedAt: "2026-10-20T08:00:00.000Z",
        resumeAt: "2026-10-20T10:00:00.000Z",
      };
      await w.ctx.state.set(stateKeyB, stateB);

      const resultA = await runTool(w, "governor-state", {}, COMPANY);
      expect(resultA.content).toContain("No governor state");
      expect((resultA.data as any).state).toBeNull();

      const resultB = await runTool(w, "governor-state", {}, OTHER_COMPANY);
      expect(resultB.content).toContain("Governor state found");
      expect((resultB.data as any).state).toEqual(stateB);
    });

    it("redacts secret strings recursively in state", async () => {
      const w = await make() as any;
      const stateKey = {
        scopeKind: "company" as const,
        scopeId: COMPANY,
        namespace: GOVERNOR_NS,
        stateKey: GOVERNOR_STATE_KEY,
      };
      const state = {
        pausedIds: ["agent-1"],
        note: "Bearer sk-12345678901234567890 set",
        nested: {
          secretKey: "sk-9876543210987654",
          arr: ["ok", "Bearer sk-1111111111111111"],
        },
      };
      await w.ctx.state.set(stateKey, state);

      const result = await runTool(w, "governor-state");
      const returned = (result.data as any).state;
      expect(returned.note).not.toContain("sk-1234");
      expect(returned.note).toContain("[redacted]");
      expect(returned.nested.secretKey).not.toContain("sk-9876");
      expect(returned.nested.secretKey).toContain("[redacted]");
      expect(returned.nested.arr[1]).not.toContain("sk-1111");
      expect(returned.nested.arr[1]).toContain("[redacted]");
    });

    it("returns null when state is absent", async () => {
      const w = await make() as any;
      const result = await runTool(w, "governor-state");
      expect(result.content).toContain("No governor state");
      expect((result.data as any).state).toBeNull();
    });
  });
});
