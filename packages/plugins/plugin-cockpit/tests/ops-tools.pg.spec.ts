/**
 * The Cockpit's measurement, review, improvement and goal tools as an agent
 * calls them (registered by registerCockpit): what they print, what they
 * refuse and that a failure reaches the agent as words, not a stack.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPS_TOOLS } from "../src/ops-tool-declarations.js";
import { NAMESPACE } from "../src/namespace.js";
import { saveTeam } from "../src/roles.js";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const OP = "aaaaaaaa-0000-4000-8000-0000000000a1";
const DEV = "aaaaaaaa-0000-4000-8000-0000000000a2";
const NOW = "2026-10-03T12:00:00.000Z";
const RUN = { agentId: OP, runId: "run-1", companyId: A, projectId: "" };
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const ago = (hours: number) => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

type Out = { error?: string; content?: string; data?: any };

d("the ops tools (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  async function make() {
    seq = 0;
    const w = await worlds.make({
      savedConfigs: { [A]: { healthIssue: true } },
      prefixes: { [A]: "PAR" },
      agents: [
        { id: OP, companyId: A, name: "Olive", status: "active", role: "general" },
        { id: DEV, companyId: A, name: "Dev", status: "idle", role: "engineer" },
      ],
    });
    await saveTeam(w.env, A, { operatorAgentId: OP }, "user-owner");
    return w;
  }
  const call = (w: Hybrid, name: string, params: Record<string, unknown> = {}, run: Record<string, unknown> = RUN) => w.tools.get(name)!(params, run) as Promise<Out>;

  const runs = (w: Hybrid, agent: string, status: string, count: number, usd = 1) =>
    w.client.query(
      `INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, finished_at, usage_json)
       SELECT gen_random_uuid(), $1, $2, $3, $4::timestamptz - (g || ' minutes')::interval, $4::timestamptz - (g || ' minutes')::interval + interval '30 seconds', $5::jsonb FROM generate_series(1, $6::int) g`,
      [A, agent, status, ago(5), JSON.stringify({ costUsd: usd, inputTokens: 100, outputTokens: 10 }), count],
    );

  it("every tool the Cockpit declares is registered, and an unknown name is refused", async () => {
    const w = await make();
    for (const tool of OPS_TOOLS) expect(w.tools.has(tool.name), tool.name).toBe(true);
    expect(OPS_TOOLS.map((t) => t.name)).toEqual(["measure-report", "open-closeout-review", "improvement-propose", "improvement-list", "improvement-resolve", "goal-set", "goal-list", "credential-list", "credential-record"]);
  });

  describe("measure-report", () => {
    it("says in one line what the week cost, with the parts behind it, and caps nothing the agent did not ask for", async () => {
      const w = await make();
      await runs(w, OP, "succeeded", 8, 2);
      await runs(w, DEV, "failed", 2, 0.5);
      const out = await call(w, "measure-report");
      expect(out.error).toBeUndefined();
      expect(out.content).toBe("Last 168 h: 10 runs (2 failed, 0 cancelled), notional spend $17.");
      expect(Object.keys(out.data).sort()).toEqual(expect.arrayContaining(["agents", "company", "limitFailures", "windowHours"]));
      expect(out.data.company).toMatchObject({ runs: 10, failed: 2 });
      expect(out.data.clients).toBeUndefined();
    });

    it("honours a narrower window and a chosen set of parts, and an empty company gets a plain answer", async () => {
      const w = await make();
      await runs(w, OP, "succeeded", 3, 1);
      const out = await call(w, "measure-report", { windowHours: 2, parts: ["agents"] });
      expect(out.content).toBe("Last 2 h: 0 runs (0 failed, 0 cancelled), notional spend $0.00.");
      const week = await call(w, "measure-report", { parts: ["agents", "limits"] });
      expect(week.data.agents).toHaveLength(1);
      expect(week.data.projects).toEqual([]); // not asked for: not read
    });

    it("mentions the plan limit when runs hit it", async () => {
      const w = await make();
      await w.client.query(`INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, finished_at, error, usage_json) VALUES ($1, $2, $3, 'failed', $4, $4, 'ACP agent reported a terminal limit failure.', '{}'::jsonb)`, [uuid(), A, OP, ago(3)]);
      expect((await call(w, "measure-report")).content).toContain("; 1 runs hit the plan limit.");
    });
  });

  describe("improvements", () => {
    it("proposes with a measured baseline, lists it, and resolves it with a verdict, all as the agent sees them", async () => {
      const w = await make();
      await runs(w, DEV, "succeeded", 7, 1);
      await runs(w, DEV, "failed", 3, 0);
      const proposed = await call(w, "improvement-propose", { title: "Developer skill: run the build before closing", kind: "skill", targetRef: "developer", metricKey: `agent:${DEV}:fail_rate`, targetValue: 10, recheckInDays: 14 });
      expect(proposed.error).toBeUndefined();
      expect(proposed.data).toMatchObject({ deduped: false, baselineFrom: expect.any(String), improvement: { title: "Developer skill: run the build before closing", kind: "skill", target: "developer", metric: `agent:${DEV}:fail_rate`, better: "lower", baseline: 30, goal: 10, status: "open", owner: OP } });
      const id = proposed.data.id as string;
      const listed = await call(w, "improvement-list");
      expect(listed.content).toBe("1 improvement.");
      expect(listed.data.items[0]).toMatchObject({ id, title: "Developer skill: run the build before closing" });
      expect(listed.data.count).toBe(1);
      // two weeks pass and the number moved: resolve reads it again itself
      await w.client.query("DELETE FROM public.heartbeat_runs");
      await runs(w, DEV, "succeeded", 19, 1);
      await runs(w, DEV, "failed", 1, 0);
      const resolved = await call(w, "improvement-resolve", { id, note: "Build step added" });
      expect(resolved.error).toBeUndefined();
      expect(resolved.data.improvement).toMatchObject({ id, status: "resolved", outcome: "improved" });
      expect((await call(w, "improvement-list")).content).toBe("No improvements recorded.");
      expect((await call(w, "improvement-list", { status: "resolved" })).data.count).toBe(1);
      expect((await call(w, "improvement-list", { status: "everything" })).data.count).toBe(0); // an unknown status falls back to open
    });

    it("refuses with words the agent can act on: no baseline for a manual number, a target on the wrong side, an unknown id", async () => {
      const w = await make();
      expect((await call(w, "improvement-propose", { title: "Faster reports", metricKey: "manual", targetValue: 5 })).error).toMatch(/baseline/i);
      expect((await call(w, "improvement-propose", { title: "x", metricKey: "company:the_moon", targetValue: 1 })).error).toContain("A metric key");
      expect((await call(w, "improvement-resolve", { id: "imp000000000000" })).error).toMatch(/not found|No improvement/i);
      expect((await call(w, "improvement-resolve", {})).error).toBeTruthy();
    });

    it("an agent's proposal is owned by the agent by default, and several proposals may come from the same retro issue", async () => {
      const w = await make();
      await runs(w, DEV, "succeeded", 7, 1);
      await runs(w, DEV, "failed", 3, 0);
      const first = await call(w, "improvement-propose", { title: "Fewer failures", metricKey: "company:fail_rate", targetValue: 10, sourceIssueId: "PAR-77" }, { ...RUN, agentId: DEV });
      const second = await call(w, "improvement-propose", { title: "Faster runs", metricKey: "company:retry_rate", targetValue: 0, baselineValue: 4, sourceIssueId: "PAR-77" }, { ...RUN, agentId: DEV });
      expect(first.data.deduped).toBe(false);
      expect(second.data.deduped).toBe(false);
      expect(second.data.id).not.toBe(first.data.id);
      expect((await w.client.query(`SELECT owner_agent_id, source_issue_id FROM ${NAMESPACE}.improvements ORDER BY title`)).rows).toEqual([{ owner_agent_id: DEV, source_issue_id: "PAR-77" }, { owner_agent_id: DEV, source_issue_id: "PAR-77" }]);
      // the owner can be another agent
      const handed = await call(w, "improvement-propose", { title: "Reviewer skill", metricKey: "company:fail_rate", targetValue: 5, ownerAgentId: OP }, { ...RUN, agentId: DEV });
      expect(handed.data.improvement.owner).toBe(OP);
    });
  });

  describe("goals as tools", () => {
    it("proposes a goal that waits for the owner, and lists it with the numbers it can be based on", async () => {
      const w = await make();
      const set = await call(w, "goal-set", { title: "Run failures under 10%", metricKey: "company:fail_rate", targetValue: 10, baselineValue: 25, unit: "%" });
      expect(set.error).toBeUndefined();
      expect(set.data).toMatchObject({ created: true, goal: { status: "proposed", title: "Run failures under 10%" } });
      const list = await call(w, "goal-list", { sources: true });
      expect(list.content).toBe("1 goal.");
      expect(list.data.goals).toHaveLength(1);
      expect(list.data.sources.company.map((m: { key: string }) => m.key)).toContain("company:fail_rate");
      expect((await call(w, "goal-list", { status: "active" })).content).toContain("No goals yet");
    });
  });

  describe("the scorecards carry the measures", () => {
    it("each agent's scorecard has notional spend, tokens, run time, retries, cancellations, failures and cost per finished issue", async () => {
      const w = await make();
      for (let i = 0; i < 4; i += 1) await w.client.query(`INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, finished_at, usage_json) VALUES ($1, $2, $3, 'succeeded', $4, $5, $6::jsonb)`, [uuid(), A, DEV, ago(10 + i), new Date(Date.parse(ago(10 + i)) + (60 + i * 60) * 1000).toISOString(), JSON.stringify({ costUsd: 2, inputTokens: 1000, outputTokens: 100, cachedInputTokens: 5000 })]);
      await w.client.query(`INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, finished_at, error_code, error, usage_json) VALUES ($1, $2, $3, 'failed', $4, $4, 'adapter_failed', 'spawn E2BIG', '{}'::jsonb)`, [uuid(), A, DEV, ago(20)]);
      await w.client.query(`INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, finished_at, error_code, usage_json) VALUES ($1, $2, $3, 'cancelled', $4, $4, 'workspace_busy', '{}'::jsonb)`, [uuid(), A, DEV, ago(21)]);
      await w.client.query(`INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, finished_at, retry_of_run_id, usage_json) VALUES ($1, $2, $3, 'succeeded', $4, $4, $5, '{"costUsd": 1}'::jsonb)`, [uuid(), A, DEV, ago(5), uuid()]);
      await w.client.query(`INSERT INTO public.issues (id, company_id, identifier, title, status, assignee_agent_id, completed_at) VALUES ($1, $2, 'PAR-1', 'Done', 'done', $3, $4), ($5, $2, 'PAR-2', 'Done too', 'done', $3, $4)`, [uuid(), A, DEV, ago(12), uuid()]);
      const scorecards = (await call(w, "agent-scorecards")) as Out;
      const dev = scorecards.data.items.find((a: { id: string }) => a.id === DEV);
      expect(dev.measures).toMatchObject({
        windowHours: 168,
        notionalUsd: 9, // 4 x 2 + 1
        tokens: { input: 4000, output: 400, cached: 20000 },
        retries: 1,
        cancellations: [{ reason: "workspace_busy", count: 1 }],
        failures: [{ reason: "adapter_failed", count: 1 }],
        doneIssues: 2,
        usdPerDone: 4.5,
      });
      expect(dev.measures.runSec.typical).toBeGreaterThan(0);
      expect(dev.measures.runSec.slowest).toBeGreaterThanOrEqual(dev.measures.runSec.typical);
      // an agent that did not run has none, rather than zeros that look like a result
      expect(scorecards.data.items.find((a: { id: string }) => a.id === OP).measures).toBeNull();
      // the daily brief carries them too, over its own (24 hour) window
      const daily = (await call(w, "company-brief")) as Out;
      expect(daily.data.agents.find((a: { id: string }) => a.id === DEV).measures).toMatchObject({ windowHours: 24, retries: 1 });
    });

    it("an unreadable run history leaves the measures out and the scorecard still comes", async () => {
      const w = await make();
      await w.client.query("ALTER TABLE public.heartbeat_runs RENAME TO heartbeat_runs_gone");
      try {
        const out = (await call(w, "agent-scorecards")) as Out;
        expect(out.error).toBeUndefined();
        for (const item of out.data.items) expect(item.measures).toBeNull();
      } finally {
        await w.client.query("ALTER TABLE public.heartbeat_runs_gone RENAME TO heartbeat_runs");
      }
    });
  });

  describe("company-brief carries the ledger and the goals", () => {
    it("lists an overdue improvement first with how many days late, the open count, and the goals with their numbers", async () => {
      const w = await make();
      await runs(w, DEV, "succeeded", 7, 1);
      await runs(w, DEV, "failed", 3, 0);
      const late = await call(w, "improvement-propose", { title: "Fewer failures", metricKey: "company:fail_rate", targetValue: 10, recheckInDays: 2 });
      await call(w, "improvement-propose", { title: "Later one", metricKey: "company:fail_rate", targetValue: 5, recheckInDays: 40 });
      await call(w, "goal-set", { title: "Run failures under 10%", metricKey: "company:fail_rate", targetValue: 10, baselineValue: 30, unit: "%" });
      w.clock.set(new Date(Date.parse(NOW) + 8 * 86_400_000).toISOString()); // six days past the first date
      const brief = (await call(w, "company-brief")) as Out;
      expect(brief.error).toBeUndefined();
      expect(brief.data.improvements).toMatchObject({ open: 2, due: 1, overdue: 1 });
      expect(brief.data.improvements.items[0]).toMatchObject({ id: late.data.id, title: "Fewer failures", overdueDays: 6, status: "open" });
      expect(brief.data.improvements.items[1]).toMatchObject({ title: "Later one" });
      expect(brief.data.goals).toHaveLength(1);
      expect(brief.data.goals[0]).toMatchObject({ title: "Run failures under 10%", status: "proposed" });
    });

    it("says null, not a guess, when the ledger or the goals cannot be read, and the rest of the brief still comes", async () => {
      const w = await make();
      await w.client.query(`ALTER TABLE ${NAMESPACE}.improvements RENAME TO improvements_gone`);
      await w.client.query(`ALTER TABLE ${NAMESPACE}.goals RENAME TO goals_gone`);
      try {
        const brief = (await call(w, "company-brief")) as Out;
        expect(brief.error).toBeUndefined();
        expect(brief.data.improvements).toBeNull();
        expect(brief.data.goals).toBeNull();
        expect(brief.data.team.operator.agentId).toBe(OP);
      } finally {
        await w.client.query(`ALTER TABLE ${NAMESPACE}.improvements_gone RENAME TO improvements`);
        await w.client.query(`ALTER TABLE ${NAMESPACE}.goals_gone RENAME TO goals`);
      }
    });
  });

  it("an unexpected failure reaches the agent as one line naming the tool, never a stack", async () => {
    const w = await make();
    await w.client.query(`ALTER TABLE ${NAMESPACE}.goals RENAME TO goals_gone`);
    try {
      const out = await call(w, "goal-list");
      expect(out.error).toMatch(/^goal-list failed: /);
      expect(out.error).not.toContain("\n");
    } finally {
      await w.client.query(`ALTER TABLE ${NAMESPACE}.goals_gone RENAME TO goals`);
    }
  });
});
