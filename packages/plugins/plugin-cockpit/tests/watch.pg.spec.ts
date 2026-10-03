/**
 * The operations watch and the run counts against a real Postgres with the
 * host's SQL rules (one SELECT, bound parameters, core reads only from the
 * manifest's tables). Stand-in `public.heartbeat_runs`, `public.issues` and
 * `public.issue_relations` carry the host columns the queries read.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { listRuns } from "../src/brief.js";
import type { Env } from "../src/env.js";
import { NAMESPACE } from "../src/namespace.js";
import { readBlocked, readRateRows, readStalled, readStorms, readStreakRuns, watchChecks } from "../src/watch.js";
import { COMPANY, OTHER_COMPANY, embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const AGENT = {
  seo: "aaaaaaaa-0000-4000-8000-000000000001",
  rev: "aaaaaaaa-0000-4000-8000-000000000002",
  dev: "aaaaaaaa-0000-4000-8000-000000000003",
  paused: "aaaaaaaa-0000-4000-8000-000000000004",
};

d("operations watch (Postgres)", () => {
  let h: PgHarness;
  const ago = (minutes: number) => new Date(h.clock.now.getTime() - minutes * 60_000).toISOString();

  const run = (agentId: string, status: string, minutesAgo: number, extra: { code?: string | null; issueId?: string | null; error?: string | null; company?: string; id?: string } = {}) =>
    h.client.query(
      `INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, error, error_code, context_snapshot) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [extra.id ?? uuid(), extra.company ?? COMPANY, agentId, status, ago(minutesAgo), extra.error ?? null, extra.code ?? null, extra.issueId === undefined ? null : JSON.stringify({ issueId: extra.issueId })],
    );

  const issue = (id: string, identifier: string, status: string, extra: { title?: string; company?: string; agent?: string | null; user?: string | null; blockedMinutesAgo?: number | null; updatedMinutesAgo?: number; descriptor?: string | null; hidden?: boolean } = {}) =>
    h.client.query(
      `INSERT INTO public.issues (id, company_id, identifier, title, status, assignee_agent_id, assignee_user_id, blocked_transition_at, updated_at, unblock_descriptor, hidden_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
      [
        id,
        extra.company ?? COMPANY,
        identifier,
        extra.title ?? `Issue ${identifier}`,
        status,
        extra.agent ?? null,
        extra.user ?? null,
        extra.blockedMinutesAgo == null ? null : ago(extra.blockedMinutesAgo),
        ago(extra.updatedMinutesAgo ?? 0),
        extra.descriptor ?? null,
        extra.hidden ? ago(1) : null,
      ],
    );

  beforeAll(async () => {
    h = await startPg();
  }, 120_000);
  afterAll(async () => {
    await h?.stop();
  });
  beforeEach(async () => {
    await h.reset();
    seq = 0;
  });

  describe("run counts (listRuns)", () => {
    it("counts every run, not the first 1,000 rows", async () => {
      // The live PAR company had 1,425 runs in 7 days: the old LIMIT 1000 read cut the oldest 425 off.
      await h.client.query(
        `INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at)
         SELECT gen_random_uuid(), $1, $2, CASE WHEN g % 4 = 0 THEN 'failed' ELSE 'succeeded' END, now() - (g || ' minutes')::interval FROM generate_series(1, 1500) g`,
        [COMPANY, AGENT.seo],
      );
      const stats = await listRuns(h.ctx, COMPANY, { now: h.clock.now, days: 7, windowHours: 24 });
      expect(stats).toHaveLength(2);
      const total = (field: "week" | "window" | "day", status?: string) => stats.filter((s) => !status || s.status === status).reduce((sum, s) => sum + s[field], 0);
      expect(total("week")).toBe(1500);
      expect(total("week", "failed")).toBe(375);
      expect(total("window")).toBe(1440); // 24 h of one run a minute
      expect(total("day")).toBe(1440);
    });

    it("counts per agent and status over the week, the window and the last day, with the latest run of each status", async () => {
      await run(AGENT.seo, "succeeded", 60, { id: "11111111-0000-4000-8000-000000000001" });
      await run(AGENT.seo, "failed", 600, { id: "11111111-0000-4000-8000-000000000002" }); // 10 h ago
      await run(AGENT.seo, "failed", 60 * 24 * 3, { id: "11111111-0000-4000-8000-000000000003" }); // 3 days ago
      await run(AGENT.seo, "failed", 60 * 24 * 9, { id: "11111111-0000-4000-8000-000000000004" }); // 9 days ago: outside the 7 days, inside 14
      await run(AGENT.rev, "succeeded", 10);
      await run(AGENT.rev, "succeeded", 10, { company: OTHER_COMPANY });
      const stats = await listRuns(h.ctx, COMPANY, { now: h.clock.now, days: 14, windowHours: 12 });
      const key = (s: { agentId: string; status: string }) => `${s.agentId}|${s.status}`;
      const byKey = Object.fromEntries(stats.map((s) => [key(s), s]));
      expect(Object.keys(byKey).sort()).toEqual([`${AGENT.seo}|failed`, `${AGENT.seo}|succeeded`, `${AGENT.rev}|succeeded`]);
      expect(byKey[`${AGENT.seo}|failed`]).toMatchObject({ week: 2, window: 1, day: 1, lastRunId: "11111111-0000-4000-8000-000000000002" });
      expect(byKey[`${AGENT.seo}|failed`]!.lastStartedAt).toBe(ago(600));
      expect(byKey[`${AGENT.seo}|succeeded`]).toMatchObject({ week: 1, window: 1, day: 1, lastRunId: "11111111-0000-4000-8000-000000000001" });
      expect(byKey[`${AGENT.rev}|succeeded`]).toMatchObject({ week: 1, window: 1, day: 1 });
    });

    it("reads only the period asked for", async () => {
      await run(AGENT.seo, "failed", 60 * 24 * 9);
      expect(await listRuns(h.ctx, COMPANY, { now: h.clock.now, days: 7, windowHours: 24 })).toEqual([]);
    });
  });

  describe("run rate rows", () => {
    it("counts finished runs of the last 24 hours by agent, status and error code", async () => {
      for (let i = 0; i < 5; i += 1) await run(AGENT.seo, "failed", 30 + i, { code: "adapter_failed" });
      await run(AGENT.seo, "failed", 40, { code: "acpx_turn_failed" });
      await run(AGENT.seo, "timed_out", 50, { code: "timeout" });
      for (let i = 0; i < 3; i += 1) await run(AGENT.seo, "succeeded", 60 + i);
      // Not a verdict on the agent: host cancellations, interruptions, runs in flight, runs older than a day, other companies.
      await run(AGENT.seo, "cancelled", 10, { code: "workspace_busy" });
      await run(AGENT.seo, "interrupted", 10, { code: "server_shutdown_interrupted" });
      await run(AGENT.seo, "queued", 5);
      await run(AGENT.seo, "running", 5);
      await run(AGENT.seo, "failed", 60 * 25, { code: "adapter_failed" });
      await run(AGENT.seo, "failed", 10, { code: "adapter_failed", company: OTHER_COMPANY });
      const rows = await readRateRows(h.ctx, COMPANY, h.clock.now);
      const sorted = [...rows].sort((a, b) => `${a.status}${a.errorCode}`.localeCompare(`${b.status}${b.errorCode}`));
      expect(sorted).toEqual([
        { agentId: AGENT.seo, status: "failed", errorCode: "acpx_turn_failed", count: 1 },
        { agentId: AGENT.seo, status: "failed", errorCode: "adapter_failed", count: 5 },
        { agentId: AGENT.seo, status: "succeeded", errorCode: null, count: 3 },
        { agentId: AGENT.seo, status: "timed_out", errorCode: "timeout", count: 1 },
      ]);
    });
  });

  describe("streak rows", () => {
    it("returns each agent's latest finished runs newest first, with the issue they ran on", async () => {
      const i545 = "99999999-0000-4000-8000-000000000545";
      await issue(i545, "PAR-545", "in_progress", { agent: AGENT.seo });
      await run(AGENT.seo, "failed", 1, { code: "adapter_failed", issueId: i545 });
      await run(AGENT.seo, "failed", 2, { code: "adapter_failed", issueId: i545 });
      await run(AGENT.seo, "cancelled", 3, { code: "issue_reassigned" });
      await run(AGENT.seo, "succeeded", 4, { issueId: "not-a-uuid" }); // a context issue id that is no issue (and no uuid)
      await run(AGENT.rev, "failed", 1, { code: "timeout" });
      await run(AGENT.rev, "failed", 1, { code: "timeout", company: OTHER_COMPANY });
      const rows = await readStreakRuns(h.ctx, COMPANY, h.clock.now);
      expect(rows.map((r) => [r.agentId === AGENT.seo ? "seo" : "rev", r.status, r.errorCode, r.identifier])).toEqual([
        ["seo", "failed", "adapter_failed", "PAR-545"],
        ["seo", "failed", "adapter_failed", "PAR-545"],
        ["seo", "succeeded", null, null],
        ["rev", "failed", "timeout", null],
      ]);
      expect(rows[0]!.startedAt).toBe(ago(1));
    });

    it("reads at most the look-back and nothing older than a day", async () => {
      for (let i = 0; i < 14; i += 1) await run(AGENT.seo, "failed", i + 1, { code: "adapter_failed" });
      await run(AGENT.seo, "failed", 60 * 30, { code: "adapter_failed" });
      expect(await readStreakRuns(h.ctx, COMPANY, h.clock.now)).toHaveLength(10);
    });
  });

  describe("retry storms", () => {
    const storm = "99999999-0000-4000-8000-000000000528";
    const quiet = "99999999-0000-4000-8000-000000000529";

    it("finds an issue with four or more failed runs whose latest run also failed, with its error", async () => {
      await issue(storm, "PAR-528", "in_progress", { title: "SEO W1 pages", agent: AGENT.seo });
      await run(AGENT.seo, "failed", 100, { code: "adapter_failed", issueId: storm, error: "spawn E2BIG" });
      await run(AGENT.seo, "failed", 90, { code: "adapter_failed", issueId: storm, error: "spawn E2BIG" });
      await run(AGENT.seo, "timed_out", 80, { code: "timeout", issueId: storm, error: "timed out" });
      await run(AGENT.seo, "failed", 70, { code: "adapter_failed", issueId: storm, error: "spawn E2BIG" });
      await run(AGENT.seo, "failed", 60, { code: "adapter_failed", issueId: storm, error: "spawn E2BIG" });
      await run(AGENT.seo, "cancelled", 50, { code: "issue_reassigned", issueId: storm });
      const rows = await readStorms(h.ctx, COMPANY, h.clock.now);
      expect(rows).toEqual([
        { issueId: storm, identifier: "PAR-528", title: "SEO W1 pages", failed: 5, errorCode: "adapter_failed", codes: 2, agentId: AGENT.seo, firstFailedAt: ago(100), lastError: "spawn E2BIG" },
      ]);
    });

    it("ignores three failures, a storm that ended in a success, a closed issue, other companies and runs without an issue", async () => {
      await issue(quiet, "PAR-529", "in_progress");
      for (let i = 0; i < 3; i += 1) await run(AGENT.seo, "failed", 10 + i, { code: "adapter_failed", issueId: quiet });
      const recovered = "99999999-0000-4000-8000-000000000530";
      await issue(recovered, "PAR-530", "in_progress");
      for (let i = 0; i < 5; i += 1) await run(AGENT.seo, "failed", 20 + i, { code: "adapter_failed", issueId: recovered });
      await run(AGENT.seo, "succeeded", 2, { issueId: recovered });
      const closed = "99999999-0000-4000-8000-000000000531";
      await issue(closed, "PAR-531", "done");
      for (let i = 0; i < 5; i += 1) await run(AGENT.seo, "failed", 20 + i, { code: "adapter_failed", issueId: closed });
      const elsewhere = "99999999-0000-4000-8000-000000000532";
      for (let i = 0; i < 5; i += 1) await run(AGENT.seo, "failed", 20 + i, { code: "adapter_failed", issueId: elsewhere, company: OTHER_COMPANY });
      for (let i = 0; i < 5; i += 1) await run(AGENT.seo, "failed", 20 + i, { code: "adapter_failed" });
      expect(await readStorms(h.ctx, COMPANY, h.clock.now)).toEqual([]);
    });

    it("still names an issue the host no longer has (only its id)", async () => {
      const gone = "99999999-0000-4000-8000-000000000533";
      for (let i = 0; i < 4; i += 1) await run(AGENT.seo, "failed", 10 + i, { code: "adapter_failed", issueId: gone });
      const [row] = await readStorms(h.ctx, COMPANY, h.clock.now);
      expect(row).toMatchObject({ issueId: gone, identifier: null, title: null, failed: 4 });
    });
  });

  describe("blocked with no way out", () => {
    const id = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const DAY = 1440;

    it("lists issues blocked over a day that nothing can wake, oldest first, with the full count", async () => {
      await issue(id(1), "PAR-59", "blocked", { blockedMinutesAgo: 8 * DAY });
      await issue(id(2), "PAR-70", "blocked", { blockedMinutesAgo: 5 * DAY, descriptor: "null" }); // a JSON null is no descriptor
      await issue(id(3), "PAR-64", "blocked", { blockedMinutesAgo: null, updatedMinutesAgo: 3 * DAY }); // no transition time: the last update stands in
      await issue(id(4), "PAR-84", "blocked", { blockedMinutesAgo: 2 * DAY });
      await issue(id(5), "PAR-85", "blocked", { blockedMinutesAgo: 1.5 * DAY });
      await issue(id(6), "PAR-86", "blocked", { blockedMinutesAgo: 1.2 * DAY });
      await issue(id(7), "PAR-87", "blocked", { blockedMinutesAgo: 1.1 * DAY });
      const { total, items } = await readBlocked(h.ctx, COMPANY, h.clock.now);
      expect(total).toBe(7);
      expect(items.map((i) => i.identifier)).toEqual(["PAR-59", "PAR-70", "PAR-64", "PAR-84", "PAR-85"]);
      expect(items[0]).toMatchObject({ id: id(1), title: "Issue PAR-59", since: ago(8 * DAY) });
    });

    it("leaves out what has a way out or is not stuck yet", async () => {
      await issue(id(10), "A-1", "blocked", { blockedMinutesAgo: 2 * DAY, descriptor: JSON.stringify({ owner: { agentId: AGENT.dev }, action: "Merge the PR" }) }); // unblock descriptor
      await issue(id(11), "A-2", "blocked", { blockedMinutesAgo: 2 * DAY, descriptor: JSON.stringify({ owner: "board", action: "Approve" }) });
      await issue(id(12), "A-3", "blocked", { blockedMinutesAgo: 2 * DAY }); // waits on an open blocker issue
      await issue(id(13), "A-3-blocker", "in_progress", { agent: AGENT.dev });
      await h.client.query(`INSERT INTO public.issue_relations (company_id, issue_id, related_issue_id, type) VALUES ($1, $2, $3, 'blocks')`, [COMPANY, id(13), id(12)]);
      await issue(id(14), "A-4", "blocked", { blockedMinutesAgo: 2 * DAY }); // its blocker is done: nothing left to wait for, so it is stuck
      await issue(id(15), "A-4-blocker", "done");
      await h.client.query(`INSERT INTO public.issue_relations (company_id, issue_id, related_issue_id, type) VALUES ($1, $2, $3, 'blocks')`, [COMPANY, id(15), id(14)]);
      await issue(id(16), "A-5", "blocked", { blockedMinutesAgo: 2 * DAY }); // an open question to the owner
      await h.client.query(`INSERT INTO ${NAMESPACE}.asks (id, company_id, issue_id, question, status) VALUES ('ask-1', $1, $2, 'Which domain?', 'open')`, [COMPANY, id(16)]);
      await issue(id(17), "A-6", "blocked", { blockedMinutesAgo: 2 * DAY }); // its question was answered: no longer a way out
      await h.client.query(`INSERT INTO ${NAMESPACE}.asks (id, company_id, issue_id, question, status) VALUES ('ask-2', $1, $2, 'Which domain?', 'answered')`, [COMPANY, id(17)]);
      await issue(id(18), "A-7", "blocked", { blockedMinutesAgo: 2 * DAY, user: "user-1" }); // a person holds it
      await issue(id(19), "A-8", "blocked", { blockedMinutesAgo: 60 }); // blocked an hour ago
      await issue(id(20), "A-9", "blocked", { blockedMinutesAgo: 2 * DAY, hidden: true });
      await issue(id(21), "A-10", "in_progress", { blockedMinutesAgo: 2 * DAY });
      await issue(id(22), "A-11", "blocked", { blockedMinutesAgo: 2 * DAY, company: OTHER_COMPANY });
      const { total, items } = await readBlocked(h.ctx, COMPANY, h.clock.now);
      expect(items.map((i) => i.identifier).sort()).toEqual(["A-4", "A-6"]);
      expect(total).toBe(2);
    });

    it("is empty when nothing is blocked", async () => {
      expect(await readBlocked(h.ctx, COMPANY, h.clock.now)).toEqual({ total: 0, items: [] });
    });
  });

  describe("stalled in progress", () => {
    const id = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const HOUR = 60;

    it("finds in-progress issues whose agent has had no run for 12 hours and nothing queued", async () => {
      await run(AGENT.seo, "succeeded", 20 * HOUR);
      await issue(id(1), "PAR-1", "in_progress", { agent: AGENT.seo, updatedMinutesAgo: 22 * HOUR });
      await issue(id(2), "PAR-2", "in_progress", { agent: AGENT.dev, updatedMinutesAgo: 30 * HOUR }); // never ran
      const { total, items } = await readStalled(h.ctx, COMPANY, h.clock.now);
      expect(total).toBe(2);
      expect(items.map((i) => [i.identifier, i.assigneeAgentId === AGENT.seo ? "seo" : "dev", i.lastRunAt])).toEqual([
        ["PAR-2", "dev", null],
        ["PAR-1", "seo", ago(20 * HOUR)],
      ]);
    });

    it("leaves out working agents, fresh issues, other statuses, unassigned and other companies", async () => {
      await run(AGENT.seo, "succeeded", 2 * HOUR); // ran recently
      await issue(id(10), "B-1", "in_progress", { agent: AGENT.seo, updatedMinutesAgo: 30 * HOUR });
      await run(AGENT.rev, "succeeded", 30 * HOUR);
      await run(AGENT.rev, "queued", 1); // a run waits for capacity
      await issue(id(11), "B-2", "in_progress", { agent: AGENT.rev, updatedMinutesAgo: 30 * HOUR });
      await issue(id(12), "B-3", "in_progress", { agent: AGENT.dev, updatedMinutesAgo: 30 }); // updated half an hour ago
      await issue(id(13), "B-4", "in_review", { agent: AGENT.dev, updatedMinutesAgo: 30 * HOUR });
      await issue(id(14), "B-5", "in_progress", { agent: null, updatedMinutesAgo: 30 * HOUR });
      await issue(id(15), "B-6", "in_progress", { agent: AGENT.dev, updatedMinutesAgo: 30 * HOUR, company: OTHER_COMPANY });
      await issue(id(16), "B-7", "in_progress", { agent: AGENT.dev, updatedMinutesAgo: 30 * HOUR, hidden: true });
      expect(await readStalled(h.ctx, COMPANY, h.clock.now)).toEqual({ total: 0, items: [] });
    });
  });

  describe("watchChecks", () => {
    function envWithAgents(agents: Array<{ id: string; name: string; status: string }>): Env {
      const ctx = { ...h.ctx, agents: { list: async () => agents } } as unknown as PluginContext;
      return { ...h.env, ctx };
    }

    it("runs every rule and returns checks the Operator can act on", async () => {
      const i545 = "99999999-0000-4000-8000-000000000545";
      await issue(i545, "PAR-545", "in_progress", { agent: AGENT.seo, updatedMinutesAgo: 1 });
      // SEO Specialist: 30 runs in a day, a third failed, the latest five on PAR-545 with the same code.
      for (let i = 0; i < 20; i += 1) await run(AGENT.seo, "succeeded", 100 + i * 10);
      for (let i = 0; i < 5; i += 1) await run(AGENT.seo, "failed", 20 + i * 5, { code: "adapter_failed", issueId: i545, error: "spawn E2BIG" });
      for (let i = 0; i < 5; i += 1) await run(AGENT.seo, "failed", 400 + i * 10, { code: "adapter_failed" });
      // A blocked issue nobody can wake, and an in-progress one whose agent is idle and quiet.
      await issue("bbbbbbbb-0000-4000-8000-000000000001", "PAR-59", "blocked", { blockedMinutesAgo: 8 * 1440 });
      await issue("cccccccc-0000-4000-8000-000000000001", "PAR-70", "in_progress", { agent: AGENT.dev, updatedMinutesAgo: 30 * 60 });
      // A paused agent's issue is the agent entry's business, not a stall.
      await issue("cccccccc-0000-4000-8000-000000000002", "PAR-71", "in_progress", { agent: AGENT.paused, updatedMinutesAgo: 30 * 60 });
      const checks = await watchChecks(
        envWithAgents([
          { id: AGENT.seo, name: "SEO Specialist", status: "idle" },
          { id: AGENT.dev, name: "Developer", status: "idle" },
          { id: AGENT.paused, name: "Writer", status: "paused" },
        ]),
        COMPANY,
      );
      expect(checks.map((c) => c.key)).toEqual([`run-rate:${AGENT.seo}`, `run-streak:${AGENT.seo}:adapter_failed`, `retry-storm:${i545}`, "blocked-no-way-out", "stalled-in-progress"]);
      expect(checks[0]).toMatchObject({ status: "warn", title: "SEO Specialist failed 33% of its runs" });
      expect(checks[1]!.detail).toContain("on PAR-545");
      expect(checks[2]!.detail).toContain("Latest error: spawn E2BIG");
      expect(checks[4]!.title).toBe("1 issue is in progress with nobody working on it");
      expect(checks[4]!.detail).toContain("PAR-70");
      expect(checks[4]!.detail).not.toContain("PAR-71");
    });

    it("ignores the runs of an agent that has been terminated", async () => {
      for (let i = 0; i < 5; i += 1) await run(AGENT.seo, "failed", 10 + i, { code: "adapter_failed" });
      for (let i = 0; i < 20; i += 1) await run(AGENT.seo, "failed", 30 + i, { code: "adapter_failed" });
      const checks = await watchChecks(envWithAgents([{ id: AGENT.seo, name: "Old SEO", status: "terminated" }]), COMPANY);
      expect(checks).toEqual([]);
    });

    it("is quiet for a healthy company", async () => {
      for (let i = 0; i < 25; i += 1) await run(AGENT.seo, "succeeded", 10 + i * 10);
      expect(await watchChecks(envWithAgents([{ id: AGENT.seo, name: "SEO Specialist", status: "idle" }]), COMPANY)).toEqual([]);
    });

    it("says so when a rule cannot read, and carries on with the others", async () => {
      for (let i = 0; i < 25; i += 1) await run(AGENT.seo, "succeeded", 10 + i * 10);
      await h.client.query("ALTER TABLE public.issue_relations RENAME TO issue_relations_gone");
      try {
        await issue("bbbbbbbb-0000-4000-8000-000000000001", "PAR-59", "blocked", { blockedMinutesAgo: 8 * 1440 });
        const checks = await watchChecks(envWithAgents([{ id: AGENT.seo, name: "SEO Specialist", status: "idle" }]), COMPANY);
        expect(checks.map((c) => c.key)).toEqual(["watch-unreadable:blocked"]);
        expect(checks[0]!.status).toBe("warn");
      } finally {
        await h.client.query("ALTER TABLE public.issue_relations_gone RENAME TO issue_relations");
      }
    });
  });
});
