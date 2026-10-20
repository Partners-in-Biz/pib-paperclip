/**
 * "Critical" push trigger tests (Postgres).
 * Tests cover: new crit -> one push, unchanged -> none, worse -> push,
 * 4+ agents in error -> push, quiet hours respects critical class, and memory reset.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkCriticalTriggers } from "../src/push/triggers-critical.js";
import { appendPushLog, listRecentPushLog, upsertSubscription, type PushLogEntry } from "../src/push/store.js";
import { saveRoles, type RolesRow } from "../src/db.js";
import { COMPANY, embeddedAvailable, startPg } from "./helpers/pg.js";
import type { Env } from "../src/env.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const OWNER_ID = "owner-user-1";

d("Critical trigger (Postgres)", () => {
  let pg: Awaited<ReturnType<typeof startPg>>;
  let env: Env;

  beforeAll(async () => {
    pg = await startPg();
    env = {
      ctx: pg.ctx,
      skills: { ensure: async () => undefined } as any,
      now: () => new Date("2026-10-20T10:00:00Z"), // SAST daytime (UTC 08:00)
    };

    // Seed roles with owner
    await saveRoles(pg.ctx, {
      companyId: A,
      operatorAgentId: null,
      reviewerAgentId: null,
      ownerUserId: OWNER_ID,
      reviewOutward: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updatedBy: null,
    } as RolesRow);

    // Seed an ok subscription for the owner
    await upsertSubscription(pg.ctx, {
      companyId: A,
      userId: OWNER_ID,
      endpoint: "https://example.com/push/owner-1",
      p256dh: "test-p256dh-1",
      auth: "test-auth-1",
      deviceLabel: "Test Device",
    });
  }, 120_000);

  beforeEach(async () => {
    // Clear critical memory keys and push log before each test
    const epochStart = new Date(0).toISOString();
    await pg.ctx.db.execute(
      `DELETE FROM plugin_cockpit_b8a99e8b16.push_rate WHERE window_start = $1 AND key LIKE $2`,
      [epochStart, "critical:%"],
    );
    await pg.ctx.db.execute(
      `DELETE FROM plugin_cockpit_b8a99e8b16.push_log WHERE company_id = $1`,
      [A],
    );
  });

  afterAll(async () => {
    await pg?.stop();
  });

  async function run(
    healthLevel: "ok" | "warn" | "bad" = "ok",
    errorCount: number = 0,
    authAgentIds: Set<string> = new Set(),
    now?: Date,
  ): Promise<{ count: number; logs: PushLogEntry[] }> {
    const agents = Array.from({ length: errorCount }, (_, i) => ({
      status: "error",
      id: `agent-error-${i}`,
      name: `Agent ${i}`,
    }));

    const envToUse = now ? { ...env, now: () => now } : env;
    const deliverCalls: any[] = [];
    const mockDeliver = async (ctx: any, companyId: string, subs: any[], payload: any) => {
      deliverCalls.push({ companyId, subs, payload });
      if (subs.length > 0) {
        await appendPushLog(ctx, {
          companyId,
          class: payload.class,
          issueRef: payload.tag || null,
          title: payload.title || null,
          status: "sent",
          createdAt: envToUse.now(),
        });
      }
    };

    const count = await checkCriticalTriggers(
      pg.ctx,
      A,
      {
        agents,
        authAgentIds,
        healthLevel,
        publicBaseUrl: "https://example.com",
      },
      { deliver: mockDeliver, now: envToUse.now },
    );

    const logs = await listRecentPushLog(pg.ctx, A, new Date(envToUse.now().getTime() - 24 * 60 * 60 * 1000));
    return { count, logs };
  }

  it("new critical health -> one push", async () => {
    const result = await run("bad");
    expect(result.count).toBe(1);
    const sentLogs = result.logs.filter((l) => l.status === "sent" && l.class === "critical" && l.issueRef === "critical:health");
    expect(sentLogs).toHaveLength(1);
  });

  it("unchanged critical health -> no push on second run", async () => {
    // First run: bad health (new)
    let result = await run("bad");
    expect(result.count).toBe(1);

    // Second run: still bad (not new or worse)
    result = await run("bad");
    expect(result.count).toBe(0);
  });

  it("worse health (warn -> bad) -> push", async () => {
    // First run: warn
    let result = await run("warn");
    expect(result.count).toBe(0);

    // Second run: bad (worse)
    result = await run("bad");
    expect(result.count).toBe(1);
  });

  it("4 agents in error -> one push", async () => {
    const result = await run("ok", 4);
    expect(result.count).toBe(1);
    const sentLogs = result.logs.filter((l) => l.status === "sent" && l.issueRef === "critical:agents");
    expect(sentLogs).toHaveLength(1);
    expect(sentLogs[0]!.title).toContain("4 agents");
  });

  it("error count increases (4 -> 5) -> push", async () => {
    // First run: 4 agents
    let result = await run("ok", 4);
    expect(result.count).toBe(1);

    // Second run: 5 agents (worse)
    result = await run("ok", 5);
    expect(result.count).toBe(1);
  });

  it("error count unchanged (4 -> 4) -> no push", async () => {
    // First run: 4 agents
    let result = await run("ok", 4);
    expect(result.count).toBe(1);

    // Second run: still 4 (unchanged)
    result = await run("ok", 4);
    expect(result.count).toBe(0);
  });

  it("3 agents in error -> no push (threshold is 4)", async () => {
    const result = await run("ok", 3);
    expect(result.count).toBe(0);
  });

  it("critical during quiet hours (23:00 SAST) -> send anyway", async () => {
    const quietHour = new Date("2026-10-20T21:00:00Z"); // 23:00 SAST = UTC 21:00
    const result = await run("bad", 0, new Set(), quietHour);
    expect(result.count).toBe(1);
    const sentLogs = result.logs.filter((l) => l.status === "sent");
    expect(sentLogs).toHaveLength(1);
  });

  it("claude_auth_required agents -> push", async () => {
    const authAgents = new Set(["agent-1", "agent-2"]);
    const result = await run("ok", 0, authAgents);
    expect(result.count).toBe(1);
    const sentLogs = result.logs.filter((l) => l.status === "sent" && l.issueRef === "critical:auth");
    expect(sentLogs).toHaveLength(1);
    expect(sentLogs[0]!.title).toContain("2 agents need re-login");
  });

  it("auth count unchanged -> no push on second run", async () => {
    const authAgents = new Set(["agent-1"]);
    let result = await run("ok", 0, authAgents);
    expect(result.count).toBe(1);

    // Second run: same agents
    result = await run("ok", 0, authAgents);
    expect(result.count).toBe(0);
  });

  it("health critical clears and then occurs again -> fires twice", async () => {
    // First run: bad
    let result = await run("bad");
    expect(result.count).toBe(1);

    // Clear: ok
    result = await run("ok");
    expect(result.count).toBe(0);

    // Recurs: bad again
    result = await run("bad");
    expect(result.count).toBe(1);
  });

  it("multiple conditions fire independently", async () => {
    // Health bad + 4 agents error + auth agents all at once
    const authAgents = new Set(["agent-auth-1"]);
    const result = await run("bad", 4, authAgents);
    expect(result.count).toBe(3); // One for each condition
    const sentLogs = result.logs.filter((l) => l.status === "sent");
    expect(sentLogs).toHaveLength(3);
  });
});
