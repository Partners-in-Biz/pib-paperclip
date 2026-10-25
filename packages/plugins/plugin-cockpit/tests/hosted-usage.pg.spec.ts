/**
 * Hosted usage roll-up (PAR-5301): per hosted company and month the runs, the
 * notional spend, the done issues and the agents, written under the owner company
 * only, on a real Postgres with the host's SQL rules.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rememberCompany } from "@partnersinbiz/pib-plugin-kit";
import { JOBS } from "../src/constants.js";
import { handleApiRoute } from "../src/register.js";
import { hostedUsageRollup, monthsToCompute, parseMonth, sastMonth } from "../src/hosted-usage.js";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const OWNER = "aaaaaaaa-0000-4000-8000-0000000000a1";
const DEMO = "bbbbbbbb-0000-4000-8000-0000000000b1";
const OTHER = "cccccccc-0000-4000-8000-0000000000c1";
const AGENT = "dddddddd-0000-4000-8000-0000000000d1";
const NOW = "2026-10-15T12:00:00.000Z";

describe("SAST month windows", () => {
  it("starts a month at 22:00 UTC on the last day before it", () => {
    expect(sastMonth(new Date("2026-10-15T12:00:00Z"))).toEqual({ month: "2026-10-01", from: "2026-09-30T22:00:00.000Z", to: "2026-10-31T22:00:00.000Z" });
    expect(sastMonth(new Date("2026-09-30T22:30:00Z")).month).toBe("2026-10-01");
    expect(sastMonth(new Date("2026-09-30T21:30:00Z")).month).toBe("2026-09-01");
    expect(sastMonth(new Date("2026-12-20T00:00:00Z"), 1)).toMatchObject({ month: "2027-01-01", from: "2026-12-31T22:00:00.000Z" });
    expect(sastMonth(new Date("2026-01-10T00:00:00Z"), -1)).toMatchObject({ month: "2025-12-01" });
  });
  it("recomputes last month only until 3 days after it ended", () => {
    expect(monthsToCompute(new Date("2026-10-15T12:00:00Z")).map((m) => m.month)).toEqual(["2026-10-01"]);
    expect(monthsToCompute(new Date("2026-11-02T10:00:00Z")).map((m) => m.month)).toEqual(["2026-10-01", "2026-11-01"]);
    // 3 days after the month's end (SAST) is over.
    expect(monthsToCompute(new Date("2026-11-03T22:00:00Z")).map((m) => m.month)).toEqual(["2026-11-01"]);
  });
});

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

d("hosted usage roll-up (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  async function make(prefixes: Record<string, string> = { [OWNER]: "PAR", [DEMO]: "DMO", [OTHER]: "OTH" }, now = NOW) {
    const w = await worlds.make({
      savedConfigs: {},
      prefixes,
      agents: [
        { id: AGENT, companyId: DEMO, name: "Secret agent name", status: "active", role: "general" },
        { id: randomUUID(), companyId: DEMO, name: "Second", status: "idle", role: "general" },
        { id: randomUUID(), companyId: DEMO, name: "Gone", status: "terminated", role: "general" },
        { id: randomUUID(), companyId: OTHER, name: "Other agent", status: "active", role: "general" },
        { id: randomUUID(), companyId: OWNER, name: "Owner agent", status: "active", role: "general" },
      ],
    }, now);
    for (const id of [OWNER, DEMO, OTHER]) await rememberCompany(w.ctx, id);
    return w;
  }
  const run = (w: Hybrid, companyId: string, startedAt: string, usage: unknown) =>
    w.client.query(`INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, usage_json) VALUES ($1, $2, $3, 'succeeded', $4, $5::jsonb)`, [randomUUID(), companyId, AGENT, startedAt, usage === undefined ? null : JSON.stringify(usage)]);
  const issue = (w: Hybrid, companyId: string, status: string, completedAt: string | null) =>
    w.client.query(`INSERT INTO public.issues (id, company_id, title, status, completed_at) VALUES ($1, $2, 'A private title', $3, $4)`, [randomUUID(), companyId, status, completedAt]);
  const rows = async (w: Hybrid) => (await w.client.query(`SELECT *, month::text AS month_text FROM ${NAMESPACE}.hosted_usage ORDER BY hosted_company_id, month`)).rows as Array<Record<string, unknown>>;

  async function seed(w: Hybrid) {
    await run(w, DEMO, "2026-10-02T08:00:00Z", { costUsd: 1.5 });
    await run(w, DEMO, "2026-10-14T08:00:00Z", { costUsd: 0.25 });
    await run(w, DEMO, "2026-10-03T08:00:00Z", { costUsd: "not a number" });
    await run(w, DEMO, "2026-10-04T08:00:00Z", {});
    await run(w, DEMO, "2026-10-05T08:00:00Z", undefined);
    await run(w, DEMO, "2026-09-30T22:30:00Z", { costUsd: 2 }); // 00:30 SAST on 1 October
    await run(w, DEMO, "2026-09-30T21:30:00Z", { costUsd: 100 }); // 23:30 SAST on 30 September
    await run(w, OTHER, "2026-10-05T08:00:00Z", { costUsd: 50 });
    await run(w, OWNER, "2026-10-05T08:00:00Z", { costUsd: 70 });
    await issue(w, DEMO, "done", "2026-10-10T10:00:00Z");
    await issue(w, DEMO, "done", "2026-09-30T22:10:00Z"); // 00:10 SAST on 1 October
    await issue(w, DEMO, "done", "2026-09-30T21:10:00Z"); // September
    await issue(w, DEMO, "in_progress", null);
    await issue(w, OTHER, "done", "2026-10-10T10:00:00Z");
  }

  it("totals the runs, notional spend, done issues and agents of a hosted company; bad usage counts 0; the 22:30 UTC run is next month's", async () => {
    const w = await make();
    await seed(w);
    const result = await hostedUsageRollup(w.env);
    expect(result).toEqual({ owner: true, companies: 2, rows: 2, failed: 0 });
    const demo = (await rows(w)).find((r) => r.hosted_company_id === DEMO)!;
    expect(demo).toMatchObject({ owner_company_id: OWNER, company_name: `Company ${DEMO}`, runs: 6, done_issues: 2, agents: 2 });
    expect(Number(demo.notional_usd)).toBeCloseTo(3.75, 6);
    expect(String(demo.month)).toContain("2026");
    const other = (await rows(w)).find((r) => r.hosted_company_id === OTHER)!;
    expect(other).toMatchObject({ runs: 1, done_issues: 1, agents: 1 });
    expect(Number(other.notional_usd)).toBe(50);
  });

  it("counts the previous month too in the first days of a month, split at the SAST boundary", async () => {
    const w = await make(undefined, "2026-11-02T10:00:00.000Z");
    await seed(w);
    await hostedUsageRollup(w.env);
    const demo = (await rows(w)).filter((r) => r.hosted_company_id === DEMO);
    expect(demo).toHaveLength(2);
    const [oct, nov] = demo;
    expect(oct).toMatchObject({ runs: 6, done_issues: 2 });
    expect(nov).toMatchObject({ runs: 0, done_issues: 0, agents: 2 });
    // September is no longer recomputed: its late run never got a row of its own.
    expect(demo.map((r) => String(r.month_text).slice(0, 7))).not.toContain("2026-09");
  });

  it("does not double count when the job runs twice (through the registered job as well)", async () => {
    const w = await make();
    await seed(w);
    await hostedUsageRollup(w.env);
    const first = await rows(w);
    await w.jobs.get(JOBS.hostedUsageRollup)!();
    await hostedUsageRollup(w.env);
    const again = await rows(w);
    expect(again).toHaveLength(first.length);
    expect(again.map(({ computed_at: _t, ...rest }) => rest)).toEqual(first.map(({ computed_at: _t, ...rest }) => rest));
  });

  it("never writes a row for the owner, and only the owner is an owner_company_id", async () => {
    const w = await make();
    await seed(w);
    await hostedUsageRollup(w.env);
    const all = await rows(w);
    expect(all.some((r) => r.hosted_company_id === OWNER)).toBe(false);
    expect(new Set(all.map((r) => r.owner_company_id))).toEqual(new Set([OWNER]));
    await expect(w.client.query(`INSERT INTO ${NAMESPACE}.hosted_usage (owner_company_id, hosted_company_id, month) VALUES ($1, $1, '2026-10-01')`, [OWNER])).rejects.toThrow();
  });

  it("writes nothing when no known company is the owner", async () => {
    const w = await make({ [DEMO]: "DMO", [OTHER]: "OTH" });
    await seed(w);
    expect(await hostedUsageRollup(w.env)).toEqual({ owner: false, companies: 0, rows: 0, failed: 0 });
    expect(await rows(w)).toHaveLength(0);
  });

  describe("read tool and route", () => {
    const RUN = (companyId: string) => ({ companyId, agentId: AGENT, runId: "r", projectId: "p" }) as never;
    const listed = async (w: Hybrid, companyId: string, params: Record<string, unknown> = {}) =>
      (await w.tools.get("hosted-usage-list")!(params, RUN(companyId))) as { content?: string; data?: { allowed: boolean; rows: Array<Record<string, unknown>> } };
    const insert = (w: Hybrid, hosted: string, name: string, month: string, runs: number) =>
      w.client.query(`INSERT INTO ${NAMESPACE}.hosted_usage (owner_company_id, hosted_company_id, company_name, month, runs, notional_usd, done_issues, agents) VALUES ($1, $2, $3, $4::date, $5, 1.5, 2, 3)`, [OWNER, hosted, name, month, runs]);

    it("parses months", () => {
      expect(parseMonth("2026-10")).toBe("2026-10-01");
      expect(parseMonth("2026-10-17")).toBe("2026-10-01");
      expect(parseMonth("2026-13")).toBeNull();
      expect(parseMonth("nope")).toBeNull();
      expect(parseMonth(undefined)).toBeNull();
    });

    it("gives the owner the rows newest month first, with only the listed fields, and filters by month", async () => {
      const w = await make();
      await insert(w, DEMO, "Demo", "2026-08-01", 1);
      await insert(w, DEMO, "Demo", "2026-10-01", 3);
      await insert(w, OTHER, "Other", "2026-10-01", 4);
      await insert(w, DEMO, "Demo", "2026-09-01", 2);
      await insert(w, DEMO, "Demo", "2025-01-01", 9); // outside the default 6 months
      const all = (await listed(w, OWNER)).data!;
      expect(all.allowed).toBe(true);
      expect(all.rows.map((r) => [r.month, r.companyName])).toEqual([["2026-10-01", "Demo"], ["2026-10-01", "Other"], ["2026-09-01", "Demo"], ["2026-08-01", "Demo"]]);
      expect(Object.keys(all.rows[0]).sort()).toEqual(["agents", "companyName", "computedAt", "doneIssues", "hostedCompanyId", "month", "notionalUsd", "runs"]);
      expect(all.rows[0]).toMatchObject({ hostedCompanyId: DEMO, runs: 3, notionalUsd: 1.5, doneIssues: 2, agents: 3 });
      const filtered = (await listed(w, OWNER, { fromMonth: "2026-09", toMonth: "2026-09" })).data!;
      expect(filtered.rows.map((r) => r.month)).toEqual(["2026-09-01"]);
      const old = (await listed(w, OWNER, { fromMonth: "2025-01" })).data!;
      expect(old.rows).toHaveLength(5);
    });

    it("gives a client company nothing, even when the table holds rows", async () => {
      const w = await make();
      await insert(w, DEMO, "Demo", "2026-10-01", 3);
      expect((await listed(w, DEMO)).data).toEqual({ allowed: false, rows: [] });
      expect((await listed(w, OTHER)).data).toEqual({ allowed: false, rows: [] });
    });

    it("serves the same rows on the route, 403 for a client company, 400 for a bad month", async () => {
      const w = await make();
      await insert(w, DEMO, "Demo", "2026-10-01", 3);
      const call = (companyId: string, query: Record<string, unknown> = {}) =>
        handleApiRoute(w.env, { routeKey: "hosted-usage", method: "GET", companyId, query } as never);
      const ok = await call(OWNER);
      expect(ok.status).toBe(200);
      expect((ok.body as { rows: unknown[] }).rows).toHaveLength(1);
      expect((await call(DEMO)).status).toBe(403);
      expect((await call(OWNER, { fromMonth: "bad" })).status).toBe(400);
    });
  });
});
