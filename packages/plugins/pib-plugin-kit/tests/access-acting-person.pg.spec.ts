import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { actingPersonForRun } from "../src/access/acting-person.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const available = await embeddedAvailable();
let pg: Pg;

const CO = "11111111-1111-4111-8111-111111111111";
const OTHER_CO = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const OTHER_AGENT = "44444444-4444-4444-8444-444444444444";
const run = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// The columns the lookup reads, as core's schema declares them.
const SCHEMA = readFileSync(new URL("../../../db/src/schema/heartbeat_runs.ts", import.meta.url), "utf8");

const ctx = () => ({ db: { query: async (sql: string, params?: unknown[]) => (await pg.client.query(sql, params)).rows } }) as unknown as PluginContext;

beforeAll(async () => {
  if (!available) return;
  pg = await startPg();
  await pg.client.query(`CREATE TABLE public.heartbeat_runs (
    id uuid PRIMARY KEY, company_id uuid NOT NULL, agent_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'queued', responsible_user_id text)`);
  const rows: Array<[number, string, string, string, string | null]> = [
    [1, CO, AGENT, "running", "user-a"],
    [2, OTHER_CO, AGENT, "running", "user-b"],
    [3, CO, OTHER_AGENT, "running", "user-c"],
    [4, CO, AGENT, "succeeded", "user-a"],
    [5, CO, AGENT, "queued", null],
    [6, CO, AGENT, "scheduled_retry", "user-a"],
    [7, CO, AGENT, "cancelled", "user-a"],
  ];
  for (const [n, co, agent, status, user] of rows) {
    await pg.client.query(`INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, responsible_user_id) VALUES ($1, $2, $3, $4, $5)`, [run(n), co, agent, status, user]);
  }
}, 120_000);

afterAll(async () => {
  if (available) await pg.stop();
});

it.runIf(Boolean(process.env.CI))("runs against a real database in CI (never skips there)", () => {
  expect(available).toBe(true);
});

it("reads only columns core's schema declares", () => {
  for (const col of ['uuid("id")', 'uuid("company_id")', 'uuid("agent_id")', 'text("status")', 'text("responsible_user_id")']) expect(SCHEMA).toContain(col);
});

describe.skipIf(!available)("actingPersonForRun on Postgres", () => {
  const lookup = (runId: string, companyId = CO, agentId = AGENT) => actingPersonForRun(ctx(), { runId, companyId, agentId });

  it("gives the person of a live run of this agent and company", async () => {
    expect(await lookup(run(1))).toEqual({ ok: true, userId: "user-a", status: "running" });
    expect(await lookup(run(6))).toEqual({ ok: true, userId: "user-a", status: "scheduled_retry" });
  });

  it("gives nothing for a run of another company", async () => {
    expect(await lookup(run(2))).toEqual({ ok: false, reason: "not-found" });
    expect(await lookup(run(1), OTHER_CO)).toEqual({ ok: false, reason: "not-found" });
  });

  it("gives nothing for a run of another agent", async () => {
    expect(await lookup(run(3))).toEqual({ ok: false, reason: "not-found" });
    expect(await lookup(run(1), CO, OTHER_AGENT)).toEqual({ ok: false, reason: "not-found" });
  });

  it("refuses a run that has ended", async () => {
    expect(await lookup(run(4))).toEqual({ ok: false, reason: "ended", status: "succeeded" });
    expect(await lookup(run(7))).toEqual({ ok: false, reason: "ended", status: "cancelled" });
  });

  it("refuses a run with no person", async () => {
    expect(await lookup(run(5))).toEqual({ ok: false, reason: "no-person", status: "queued" });
  });

  it("gives nothing for an unknown or malformed run id, without a query error", async () => {
    expect(await lookup(run(99))).toEqual({ ok: false, reason: "not-found" });
    expect(await lookup("not-a-uuid")).toEqual({ ok: false, reason: "not-found" });
  });
});
