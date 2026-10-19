/**
 * Claude auth required card (PAR-3902): when agents fail with claude_auth_required
 * in a row, one Cockpit-originated ask opens per company to ask the owner to
 * re-login on the server. Deduped per 24 hours. Tests against real Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureAuthCard } from "../src/auth-card.js";
import { NAMESPACE } from "../src/namespace.js";
import { authStreakAgents } from "../src/watch-model.js";
import { readStreakRuns } from "../src/watch.js";
import { COMPANY, embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const AGENT_ID = "aaaaaaaa-0000-4000-8000-000000000001";

d("Claude auth required card (Postgres)", () => {
  let h: PgHarness;
  const ago = (minutes: number) => new Date(h.clock.now.getTime() - minutes * 60_000).toISOString();

  const run = (agentId: string, status: string, code: string | null, minutesAgo: number) =>
    h.client.query(
      `INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, error_code) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
      [COMPANY, agentId, status, ago(minutesAgo), code],
    );

  const askCount = async () => {
    const result = await h.client.query(`SELECT count(*) AS n FROM ${NAMESPACE}.asks WHERE company_id = $1 AND source = 'cockpit' AND effect ->> 'key' = 'cockpit.auth-card-noted'`, [COMPANY]);
    return Number((result.rows[0] as Record<string, any>).n);
  };

  const openAuthAsks = async () => {
    const result = await h.client.query(
      `SELECT * FROM ${NAMESPACE}.asks WHERE company_id = $1 AND source = 'cockpit' AND effect ->> 'key' = 'cockpit.auth-card-noted' AND status IN ('open', 'answered')`,
      [COMPANY],
    );
    return result.rows as Record<string, any>[];
  };

  beforeAll(async () => {
    h = await startPg();
  }, 120_000);
  afterAll(async () => {
    await h?.stop();
  });
  beforeEach(async () => {
    await h.reset();
    // Set up roles with an owner so ensureAuthCard can proceed
    await h.client.query(`INSERT INTO ${NAMESPACE}.roles (company_id, owner_user_id) VALUES ($1, $2)`, [COMPANY, "owner-user"]);
    // Mock the companies context for openCockpitAsk
    h.ctx.companies = {
      get: async (cid: string) => (cid === COMPANY ? { issuePrefix: "PAR" } : null),
    } as any;
    // Mock agents context for openCockpitAsk
    h.ctx.agents = {
      get: async () => null, // No operator
    } as any;
    // Mock issues.create to return a new issue
    let issueSeq = 0;
    h.ctx.issues = {
      ...h.ctx.issues,
      create: async (input: any) => {
        issueSeq += 1;
        const issueId = `issue-auth-${issueSeq}`;
        const issue = { id: issueId, identifier: `PAR-AUTH-${issueSeq}`, companyId: input.companyId, ...input };
        h.issues.set(issueId, issue);
        return issue;
      },
      createComment: async (issueId: string, body: string, companyId: string) => ({ id: `comment-${issueSeq}`, body }),
    } as any;
  });

  describe("ensureAuthCard", () => {
    it("opens one ask when three claude_auth_required failures are found in a row", async () => {
      await run(AGENT_ID, "failed", "claude_auth_required", 5);
      await run(AGENT_ID, "failed", "claude_auth_required", 6);
      await run(AGENT_ID, "failed", "claude_auth_required", 7);

      // ensureAuthCard is called with agents identified by authStreakAgents
      const streakRuns = await readStreakRuns(h.ctx, COMPANY, h.clock.now);
      const authAgents = authStreakAgents(streakRuns);
      expect(authAgents.size).toBe(1);

      const result = await ensureAuthCard(h.env, COMPANY, [...authAgents.keys()]);
      expect(result.action).toBe("opened");
      expect(await askCount()).toBe(1);

      const asks = await openAuthAsks();
      expect(asks).toHaveLength(1);
      expect(asks[0]).toMatchObject({
        source: "cockpit",
        status: "open",
        kind: "grant",
      });
      expect(asks[0]!.question).toContain("expired");
      expect(asks[0]!.effect).toBeTruthy();
    });

    it("does not identify agents when fewer than three failures are found", async () => {
      await run(AGENT_ID, "failed", "claude_auth_required", 6);
      await run(AGENT_ID, "failed", "claude_auth_required", 7);

      const streakRuns = await readStreakRuns(h.ctx, COMPANY, h.clock.now);
      const authAgents = authStreakAgents(streakRuns);
      expect(authAgents.size).toBe(0);
      expect(await askCount()).toBe(0);
    });

    it("does not identify agents for other error codes", async () => {
      await run(AGENT_ID, "failed", "adapter_failed", 5);
      await run(AGENT_ID, "failed", "adapter_failed", 6);
      await run(AGENT_ID, "failed", "adapter_failed", 7);

      const streakRuns = await readStreakRuns(h.ctx, COMPANY, h.clock.now);
      const authAgents = authStreakAgents(streakRuns);
      expect(authAgents.size).toBe(0);
      expect(await askCount()).toBe(0);
    });

    it("does not duplicate within 24 hours", async () => {
      // First tick: open the card
      await run(AGENT_ID, "failed", "claude_auth_required", 5);
      await run(AGENT_ID, "failed", "claude_auth_required", 6);
      await run(AGENT_ID, "failed", "claude_auth_required", 7);

      const streakRuns = await readStreakRuns(h.ctx, COMPANY, h.clock.now);
      const authAgents = authStreakAgents(streakRuns);
      const first = await ensureAuthCard(h.env, COMPANY, [...authAgents.keys()]);
      expect(first.action).toBe("opened");
      expect(await askCount()).toBe(1);

      // Second tick (23 hours later): should not open another
      h.clock.now = new Date(h.clock.now.getTime() + 23 * 3_600_000);

      const streakRuns2 = await readStreakRuns(h.ctx, COMPANY, h.clock.now);
      const authAgents2 = authStreakAgents(streakRuns2);
      const second = await ensureAuthCard(h.env, COMPANY, [...authAgents2.keys()]);
      expect(second.action).toBe("exists");
      expect(await askCount()).toBe(1); // Still only one
    });

    it("uses authStreakAgents to identify agents correctly", async () => {
      const agent2 = "bbbbbbbb-0000-4000-8000-000000000002";

      // Agent 1: three claude_auth_required failures
      await run(AGENT_ID, "failed", "claude_auth_required", 5);
      await run(AGENT_ID, "failed", "claude_auth_required", 6);
      await run(AGENT_ID, "failed", "claude_auth_required", 7);

      // Agent 2: three adapter_failed failures (should not be identified)
      await run(agent2, "failed", "adapter_failed", 5);
      await run(agent2, "failed", "adapter_failed", 6);
      await run(agent2, "failed", "adapter_failed", 7);

      const streakRuns = await readStreakRuns(h.ctx, COMPANY, h.clock.now);
      const authAgents = authStreakAgents(streakRuns);
      expect(authAgents.size).toBe(1);
      expect(authAgents.has(AGENT_ID)).toBe(true);
      expect(authAgents.has(agent2)).toBe(false);

      const result = await ensureAuthCard(h.env, COMPANY, [...authAgents.keys()]);
      expect(result.action).toBe("opened");
      expect(await askCount()).toBe(1);

      // Only one card for the auth issue, not for adapter_failed
      const asks = await openAuthAsks();
      expect(asks).toHaveLength(1);
      expect(asks[0]!.question).toContain("expired");
    });

    it("includes agent count in the question when multiple agents fail", async () => {
      const agent2 = "bbbbbbbb-0000-4000-8000-000000000002";

      // Both agents fail with claude_auth_required
      for (const agent of [AGENT_ID, agent2]) {
        await run(agent, "failed", "claude_auth_required", 5);
        await run(agent, "failed", "claude_auth_required", 6);
        await run(agent, "failed", "claude_auth_required", 7);
      }

      const streakRuns = await readStreakRuns(h.ctx, COMPANY, h.clock.now);
      const authAgents = authStreakAgents(streakRuns);
      expect(authAgents.size).toBe(2);

      const result = await ensureAuthCard(h.env, COMPANY, [...authAgents.keys()]);
      expect(result.action).toBe("opened");

      const asks = await openAuthAsks();
      expect(asks).toHaveLength(1);
      expect(asks[0]!.question).toContain("2 agents");
    });
  });
});
