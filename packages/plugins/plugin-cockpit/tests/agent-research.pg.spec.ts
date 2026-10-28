/**
 * The weekly agent research job against a real Postgres: which distilled agents
 * are eligible, who is ranked first, and that a second run in the same ISO week
 * opens nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentResearch, researchCompany, researchOriginId } from "../src/agent-research.js";
import { ORIGIN } from "../src/constants.js";
import { proposeImprovement } from "../src/improvements.js";
import { NAMESPACE } from "../src/namespace.js";
import { COMPANY, embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const T0 = new Date("2026-10-05T04:00:00.000Z"); // a Monday, ISO week 41
const OPERATOR = "aaaaaaaa-0000-4000-8000-0000000000a1";
const COACH = "cccccccc-0000-4000-8000-000000000001";
const HASH = "0123456789abcdef";

// Template keys whose eval file Cockpit ships.
const KEYS = ["developer", "planner", "code-reviewer", "senior-developer", "seo-specialist", "pib"];
const agentId = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;

d("weekly agent research (Postgres)", () => {
  let h: PgHarness;
  let agents: Array<Record<string, unknown>>;
  let created: Array<Record<string, any>>;

  const distilled = (n: number, key = KEYS[n - 1]!, evalFile: string | null = `${key}.json`) => ({
    id: agentId(n),
    name: `Agent ${key}`,
    status: "idle",
    metadata: { pibPack: { pack: "pib", version: 2, key, hash: HASH, appliedAt: "2026-10-01T00:00:00.000Z", ...(evalFile ? { evalFile } : {}) } },
  });

  const runs = (id: string, status: string, count: number) =>
    h.client.query(
      `INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, finished_at, error_code, usage_json)
       SELECT gen_random_uuid(), $1, $2, $3, $4::timestamptz - (g || ' minutes')::interval, $4::timestamptz - (g || ' minutes')::interval + interval '30 seconds', CASE WHEN $3 = 'failed' THEN 'adapter_failed' END, '{"costUsd": 1}'::jsonb FROM generate_series(1, $5::int) g`,
      [COMPANY, id, status, new Date(T0.getTime() - 3_600_000).toISOString(), count],
    );
  /** `failed` of `total` runs failed. */
  const history = async (n: number, total: number, failed: number) => {
    if (failed > 0) await runs(agentId(n), "failed", failed);
    if (total > failed) await runs(agentId(n), "succeeded", total - failed);
  };

  beforeAll(async () => {
    h = await startPg();
    const ctx = h.ctx as unknown as { agents: unknown; issues: Record<string, unknown> };
    ctx.agents = { list: async () => agents, get: async (id: string) => agents.find((a) => a.id === id) ?? null };
    ctx.issues.create = async (input: Record<string, any>) => {
      const id = `00000000-0000-4000-8000-${String(created.length + 1).padStart(12, "0")}`;
      created.push({ id, ...input });
      await h.client.query(
        `INSERT INTO public.issues (id, company_id, title, description, status, assignee_agent_id, origin_kind, origin_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, input.companyId, input.title, input.description, input.status ?? "todo", input.assigneeAgentId ?? null, input.originKind ?? null, input.originId ?? null],
      );
      return { id };
    };
    ctx.issues.requestWakeup = async () => ({ queued: true });
  }, 120_000);
  afterAll(async () => {
    await h?.stop();
  });
  beforeEach(async () => {
    await h.reset();
    h.clock.now = T0;
    created = [];
    agents = [{ id: COACH, name: "Reflection Coach", status: "idle" }];
    await h.client.query(`INSERT INTO ${NAMESPACE}.roles (company_id, operator_agent_id, owner_user_id) VALUES ($1, $2, 'user-owner')`, [COMPANY, OPERATOR]);
    h.config.set(COMPANY, { healthIssue: true });
  });

  it("opens an issue for the five worst by 7-day fail rate and leaves the sixth", async () => {
    agents.push(...[1, 2, 3, 4, 5, 6].map((n) => distilled(n)));
    // fail rates: 1 = 10%, 2 = 50%, 3 = 30%, 4 = 70%, 5 = 20%, 6 = 40%
    await history(1, 30, 3);
    await history(2, 30, 15);
    await history(3, 30, 9);
    await history(4, 30, 21);
    await history(5, 30, 6);
    await history(6, 30, 12);
    const r = await researchCompany(h.env, COMPANY);
    expect(r).toMatchObject({ eligible: 6, opened: 5, alreadyOpened: 0 });
    expect(created.map((i) => i.title)).toEqual([4, 2, 6, 3, 5].map((n) => `Autoresearch: Agent ${KEYS[n - 1]} (week 41)`));
    expect(created.every((i) => i.assigneeAgentId === COACH && i.originKind === ORIGIN.autoresearch)).toBe(true);
    expect(created[0]!.description).toContain("fail rate: 70%");
    expect(created[0]!.description).toContain(`current hash: \`${HASH}\``);
    expect(created[0]!.description).toContain("adapter_failed: 21");
  });

  it("does not rank an agent with fewer than 20 runs in the window", async () => {
    agents.push(distilled(1), distilled(2));
    await history(1, 19, 19); // every run failed, but only 19 runs
    await history(2, 20, 2);
    const r = await researchCompany(h.env, COMPANY);
    expect(r).toMatchObject({ eligible: 1, opened: 1 });
    expect(created[0]!.title).toBe("Autoresearch: Agent planner (week 41)");
  });

  it("skips an agent that is not distilled: no pibPack, no evalFile, or an eval file Cockpit does not ship", async () => {
    agents.push({ id: agentId(1), name: "Plain", status: "idle" }, distilled(2, "planner", null), distilled(3, "developer", "no-such-agent.json"));
    for (const n of [1, 2, 3]) await history(n, 30, 15);
    const r = await researchCompany(h.env, COMPANY);
    expect(r).toMatchObject({ eligible: 0, opened: 0 });
    expect(created).toEqual([]);
  });

  it("skips an agent with an open improvement aimed at its template, and one with an open Distill: issue", async () => {
    agents.push(distilled(1), distilled(2), distilled(3));
    for (const n of [1, 2, 3]) await history(n, 30, 15);
    await proposeImprovement(h.env, COMPANY, { title: "Developer template: build first", kind: "template", targetRef: "developer", metricKey: "company:fail_rate", targetValue: 10 }, { agentId: OPERATOR, userId: null });
    await h.addIssueToDb({ id: "00000000-0000-4000-8000-0000000000d1", companyId: COMPANY, identifier: "PAR-1", title: "Distill: planner", status: "todo" });
    const r = await researchCompany(h.env, COMPANY);
    expect(r).toMatchObject({ eligible: 1, opened: 1 });
    expect(created[0]!.title).toBe("Autoresearch: Agent code-reviewer (week 41)");
  });

  it("opens nothing on a second run in the same ISO week, then again the next week", async () => {
    agents.push(distilled(1), distilled(2));
    await history(1, 30, 15);
    await history(2, 30, 6);
    expect(await agentResearch(h.env)).toMatchObject({ companies: 1, opened: 2, alreadyOpened: 0 });
    h.clock.now = new Date(T0.getTime() + 3 * 86_400_000);
    expect(await agentResearch(h.env)).toMatchObject({ opened: 0, alreadyOpened: 2 });
    expect(created).toHaveLength(2);
    const rows = await h.client.query(`SELECT origin_id FROM public.issues WHERE origin_kind = $1 ORDER BY origin_id`, [ORIGIN.autoresearch]);
    expect((rows.rows as Array<{ origin_id: string }>).map((r) => r.origin_id)).toEqual([researchOriginId(agentId(1), "2026-W41"), researchOriginId(agentId(2), "2026-W41")].sort());
  });

  it("opens fewer than five when fewer are eligible, and nothing when none is", async () => {
    agents.push(distilled(1), distilled(2));
    await history(1, 30, 15);
    await history(2, 30, 6);
    expect(await researchCompany(h.env, COMPANY)).toMatchObject({ eligible: 2, opened: 2 });
    await h.reset();
    await h.client.query(`INSERT INTO ${NAMESPACE}.roles (company_id, operator_agent_id, owner_user_id) VALUES ($1, $2, 'user-owner')`, [COMPANY, OPERATOR]);
    h.config.set(COMPANY, { healthIssue: true });
    created = [];
    const none = await agentResearch(h.env);
    expect(none).toMatchObject({ companies: 1, eligible: 0, opened: 0 });
    expect(created).toEqual([]);
  });

  it("reports a missing Reflection Coach instead of opening unassigned issues", async () => {
    agents = [distilled(1)];
    await history(1, 30, 15);
    expect(await researchCompany(h.env, COMPANY)).toMatchObject({ eligible: 1, opened: 0, noCoach: 1 });
    expect(created).toEqual([]);
  });
});
