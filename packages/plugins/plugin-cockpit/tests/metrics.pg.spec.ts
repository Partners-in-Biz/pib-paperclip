/**
 * The metric reader (metrics.ts) against a real Postgres with the host's SQL
 * rules: every company and agent metric an improvement or a goal may name,
 * read from seeded runs, issues, asks and memory, plus the numbers modules
 * report. A metric that cannot be read says so (null and a note), never 0.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MetricReader, metricCatalog } from "../src/metrics.js";
import { COMPANY_METRICS } from "../src/metrics-keys.js";
import { NAMESPACE } from "../src/namespace.js";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const OP = "aaaaaaaa-0000-4000-8000-0000000000a1";
const REV = "aaaaaaaa-0000-4000-8000-0000000000a2";
const QUIET = "aaaaaaaa-0000-4000-8000-0000000000a3";
const NOW = "2026-10-03T12:00:00.000Z";
const ago = (hours: number) => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

d("reading metrics by key (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  async function make() {
    seq = 0;
    return worlds.make({
      savedConfigs: { [A]: { healthIssue: true } },
      prefixes: { [A]: "PAR" },
      agents: [
        { id: OP, companyId: A, name: "Olive", status: "active", role: "general" },
        { id: REV, companyId: A, name: "Rex", status: "error", role: "general" },
        { id: QUIET, companyId: A, name: "Quinn", status: "idle", role: "general" },
      ],
    }, NOW);
  }

  const run = (w: Hybrid, agent: string, status: string, hoursAgo: number, o: { usd?: number; secs?: number; retryOf?: string; error?: string } = {}) =>
    w.client.query(
      `INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, finished_at, error, context_snapshot, retry_of_run_id, usage_json) VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, $8, $9::jsonb)`,
      [uuid(), A, agent, status, ago(hoursAgo), new Date(Date.parse(ago(hoursAgo)) + (o.secs ?? 60) * 1000).toISOString(), o.error ?? null, o.retryOf ?? null, JSON.stringify({ costUsd: o.usd ?? 0, inputTokens: 100, outputTokens: 10 })],
    );
  const issue = (w: Hybrid, identifier: string, status: string, o: { agent?: string | null; doneHoursAgo?: number; createdHoursAgo?: number; descriptor?: object } = {}) =>
    w.client.query(`INSERT INTO public.issues (id, company_id, identifier, title, status, assignee_agent_id, completed_at, created_at, unblock_descriptor, blocked_transition_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`, [
      uuid(), A, identifier, `Issue ${identifier}`, status, o.agent ?? null, o.doneHoursAgo == null ? null : ago(o.doneHoursAgo), ago(o.createdHoursAgo ?? 100), o.descriptor ? JSON.stringify(o.descriptor) : null, status === "blocked" ? ago(60) : null,
    ]);

  /** A week of work: 12 runs for two agents, 5 finished issues, one limit failure and one retry. */
  async function seedWeek(w: Hybrid) {
    for (let i = 0; i < 6; i += 1) await run(w, OP, "succeeded", 10 + i, { usd: 2 });
    const first = uuid();
    await run(w, OP, "succeeded", 20, { usd: 1, retryOf: first });
    await run(w, OP, "failed", 30, { error: "ACP agent reported a terminal limit failure." });
    await run(w, OP, "failed", 31, { error: "spawn E2BIG" });
    for (let i = 0; i < 3; i += 1) await run(w, REV, "succeeded", 40 + i, { usd: 4 });
    await run(w, OP, "succeeded", 24 * 20, { usd: 99 }); // outside the week
    for (let i = 0; i < 3; i += 1) await issue(w, `PAR-${i}`, "done", { agent: OP, doneHoursAgo: 12 + i });
    for (let i = 3; i < 5; i += 1) await issue(w, `PAR-${i}`, "done", { agent: REV, doneHoursAgo: 40 + i });
  }

  const read = (w: Hybrid, key: string) => new MetricReader(w.env, A).read(key);

  describe("company metrics", () => {
    it("rates, spend and throughput over the last 7 days, as percentages and whole units", async () => {
      const w = await make();
      await seedWeek(w);
      const value = async (key: string) => (await read(w, `company:${key}`)).value;
      expect(await value("fail_rate")).toBeCloseTo(16.67, 2); // 2 failed of 12 finished
      expect(await value("retry_rate")).toBeCloseTo(8.33, 2); // 1 retry in 12 runs
      expect(await value("usd_per_day")).toBeCloseTo(3.57, 2); // 25 USD over 7 days
      expect(await value("usd_per_done")).toBe(5); // 25 USD, 5 issues
      expect(await value("issues_done_7d")).toBe(5);
      expect(await value("limit_failures_7d")).toBe(1);
      const failRate = await read(w, "company:fail_rate");
      expect(failRate).toMatchObject({ key: "company:fail_rate", label: "Run failure rate (7 days)", unit: "%", note: null });
    });

    it("counts what is stuck or waiting: blocked with no way out, unassigned and old, questions to the owner and the age of the oldest", async () => {
      const w = await make();
      await issue(w, "B-1", "blocked", { agent: OP }); // no way out
      await issue(w, "B-2", "blocked", { agent: OP, descriptor: { owner: { agentId: OP }, action: "Merge" } }); // has one
      await issue(w, "U-1", "todo", { createdHoursAgo: 48 });
      await issue(w, "U-2", "todo", { createdHoursAgo: 1 }); // too fresh to count
      await issue(w, "U-3", "todo", { createdHoursAgo: 48, agent: OP }); // somebody holds it
      await w.client.query(`INSERT INTO ${NAMESPACE}.asks (id, company_id, issue_id, question, status, asked_at) VALUES ('a1', $1, 'i1', 'Which domain?', 'open', $2), ('a2', $1, 'i2', 'Which logo?', 'open', $3), ('a3', $1, 'i3', 'Old', 'answered', $4)`, [A, ago(24 * 4), ago(5), ago(24 * 30)]);
      expect((await read(w, "company:blocked_no_way_out")).value).toBe(1);
      expect((await read(w, "company:unassigned_old")).value).toBe(1);
      expect((await read(w, "company:asks_open")).value).toBe(2);
      expect((await read(w, "company:asks_oldest_days")).value).toBe(4);
      const none = await make();
      expect((await read(none, "company:asks_oldest_days")).value).toBe(0);
    });

    it("counts agents in error, pinned facts that describe a tool, and the share of memory briefs that got any feedback", async () => {
      const w = await make();
      await w.client.query(
        `INSERT INTO ${NAMESPACE}.memory_facts (id, company_id, client_ref, area, kind, text, text_hash, pinned, status) VALUES
          ('f1', $1, NULL, 'general', 'rule', 'Always pass the client when you call partnersinbiz.seo tools', 'h1', true, 'active'),
          ('f2', $1, NULL, 'general', 'preference', 'The client prefers short emails', 'h2', true, 'active'),
          ('f3', $1, NULL, 'general', 'rule', 'Always pass the client when you call partnersinbiz.crm tools', 'h3', false, 'active'),
          ('f4', $1, 'company:x', 'general', 'rule', 'Always pass the client when you call partnersinbiz.billing tools', 'h4', true, 'active')`,
        [A],
      );
      for (const id of ["b1", "b2", "b3", "b4"]) await w.client.query(`INSERT INTO ${NAMESPACE}.memory_briefs (id, company_id, method, version, body) VALUES ($1, $2, 'baseline', '1', 'x')`, [id, A]);
      await w.client.query(`INSERT INTO ${NAMESPACE}.memory_feedback (id, company_id, brief_id, kind) VALUES ('m1', $1, 'b1', 'helpful'), ('m2', $1, 'b1', 'noise')`, [A]);
      expect((await read(w, "company:agents_in_error")).value).toBe(1);
      expect((await read(w, "company:pinned_tool_facts")).value).toBe(1); // pinned, company-wide, about a tool: not the preference, not the unpinned one, not the client's
      expect((await read(w, "company:memory_feedback_coverage")).value).toBe(25); // 1 of 4 briefs
    });

    it("says there is nothing to measure rather than reporting zero", async () => {
      const w = await make();
      for (const [key, note] of [
        ["fail_rate", "No finished runs in the window."],
        ["retry_rate", "No runs in the window."],
        ["usd_per_done", "Nothing was finished in the window."],
        ["review_coverage", "No finished code work in the window (or it could not be read)."],
        ["review_latency_p90_hours", "No finished reviews in the window."],
        ["memory_feedback_coverage", "No briefs in the window."],
      ] as const) {
        const reading = await read(w, `company:${key}`);
        expect(reading.value, key).toBeNull();
        expect(reading.note, key).toBe(note);
      }
      expect((await read(w, "company:usd_per_day")).value).toBe(0); // no spend is a real zero
    });
  });

  describe("one agent", () => {
    it("reads that agent's week, labelled with a short id", async () => {
      const w = await make();
      await seedWeek(w);
      const value = async (m: string) => (await read(w, `agent:${OP}:${m}`)).value;
      expect(await value("runs_7d")).toBe(9);
      expect(await value("usd_7d")).toBe(13);
      expect(await value("fail_rate")).toBeCloseTo(22.22, 2);
      expect(await value("retry_rate")).toBeCloseTo(11.11, 2);
      expect(await value("p90_sec")).toBe(60);
      expect(await value("usd_per_done")).toBeCloseTo(4.33, 2);
      expect(await read(w, `agent:${OP}:usd_7d`)).toMatchObject({ label: "Agent aaaaaaaa: notional spend (7 days)", unit: "USD" });
      // the other agent's numbers are its own
      expect((await read(w, `agent:${REV}:usd_7d`)).value).toBe(12);
    });

    it("an agent with no runs has zero runs and spend, and nothing to rate", async () => {
      const w = await make();
      await seedWeek(w);
      expect((await read(w, `agent:${QUIET}:runs_7d`)).value).toBe(0);
      expect((await read(w, `agent:${QUIET}:usd_7d`)).value).toBe(0);
      expect(await read(w, `agent:${QUIET}:fail_rate`)).toMatchObject({ value: null, note: "The agent had no runs in the window." });
    });
  });

  describe("numbers the modules report", () => {
    const report = (w: Hybrid, plugin: string, checkedAt: string, kpis: Array<{ key: string; label: string; raw: number | null; value: string }>) =>
      w.client.query(`INSERT INTO ${NAMESPACE}.snapshots (company_id, plugin_key, kind, payload, checked_at) VALUES ($1, $2, 'cockpit', $3::jsonb, $4)`, [
        A, plugin, JSON.stringify({ plugin, title: plugin, checkedAt, kpis: kpis.map((k) => ({ ...k, group: "pipeline" })), health: [], waiting: [], activity: [], quality: [] }), checkedAt,
      ]);

    it("reads a KPI by key, turns money in minor units into whole units, and says when the report is old", async () => {
      const w = await make();
      await report(w, "partnersinbiz.crm", NOW, [{ key: "new_leads_week", label: "New leads this week", raw: 8, value: "8" }]);
      await report(w, "partnersinbiz.billing", ago(10), [{ key: "received_month", label: "Received this month", raw: 1240000, value: "R 12,400.00" }]);
      expect(await read(w, "kpi:partnersinbiz.crm:new_leads_week")).toMatchObject({ value: 8, label: "New leads this week", note: null });
      const money = await read(w, "kpi:partnersinbiz.billing:received_month");
      expect(money.value).toBe(12400);
      expect(money.note).toContain("partnersinbiz.billing last reported on 2026-10-03 02:00");
    });

    it("says why it cannot: nobody reported, no such number, a number with no value", async () => {
      const w = await make();
      expect(await read(w, "kpi:partnersinbiz.seo:seo_keywords_top10")).toMatchObject({ value: null, note: "partnersinbiz.seo has not reported to the Cockpit." });
      await report(w, "partnersinbiz.crm", NOW, [{ key: "new_leads_week", label: "New leads this week", raw: null, value: "n/a" }]);
      expect(await read(w, "kpi:partnersinbiz.crm:nothing_here")).toMatchObject({ value: null, note: 'partnersinbiz.crm does not report a "nothing_here" number.' });
      expect((await read(w, "kpi:partnersinbiz.crm:new_leads_week")).value).toBeNull();
    });

    it("the catalog lists every company and agent metric and the numbers modules report now", async () => {
      const w = await make();
      await report(w, "partnersinbiz.crm", NOW, [{ key: "new_leads_week", label: "New leads this week", raw: 8, value: "8" }, { key: "no_number", label: "A label", raw: null, value: "x" }]);
      const catalog = await metricCatalog(w.env, A);
      expect(catalog.company.map((m) => m.key)).toEqual(Object.keys(COMPANY_METRICS).map((m) => `company:${m}`));
      expect(catalog.company.find((m) => m.key === "company:review_coverage")).toMatchObject({ better: "higher", unit: "%" });
      expect(catalog.agent.map((m) => m.key)).toContain("agent:<agentId>:p90_sec");
      expect(catalog.kpis).toEqual([{ key: "kpi:partnersinbiz.crm:new_leads_week", label: "New leads this week", plugin: "partnersinbiz.crm", current: 8 }]);
    });
  });

  describe("what it refuses and what it survives", () => {
    it("a key it does not know, and one a person records by hand, are not read", async () => {
      const w = await make();
      expect(await read(w, "company:the_moon")).toMatchObject({ value: null, note: "Not a metric the Cockpit knows." });
      expect(await read(w, "drop table")).toMatchObject({ value: null, note: "Not a metric the Cockpit knows." });
      expect(await read(w, "manual")).toMatchObject({ value: null, note: "Nobody reads this one; a value is recorded when someone measures it." });
    });

    it("a read that fails says so and gives no number, and the others still work", async () => {
      const w = await make();
      await seedWeek(w);
      await w.client.query("ALTER TABLE public.issue_relations RENAME TO issue_relations_gone");
      try {
        const broken = await read(w, "company:blocked_no_way_out");
        expect(broken.value).toBeNull();
        expect(broken.note).toMatch(/^Could not read it: /);
        expect((await read(w, "company:issues_done_7d")).value).toBe(5);
      } finally {
        await w.client.query("ALTER TABLE public.issue_relations_gone RENAME TO issue_relations");
      }
    });

    it("reads the week once however many week metrics are asked for", async () => {
      const w = await make();
      await seedWeek(w);
      const reader = new MetricReader(w.env, A);
      const before = w.pg.statements.length;
      for (const key of ["fail_rate", "retry_rate", "usd_per_day", "usd_per_done", "issues_done_7d"]) await reader.read(`company:${key}`);
      await reader.read(`agent:${OP}:fail_rate`);
      const weekReads = w.pg.statements.slice(before).filter((sql) => /FROM runs/.test(sql));
      expect(weekReads.length).toBeLessThanOrEqual(3); // aggregate, breakdown and done counts: once each, not once per metric
    });
  });
});
