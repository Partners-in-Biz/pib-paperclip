/**
 * The improvements ledger against a real Postgres: a baseline measured now, a
 * re-check that writes improved / no change / worse with both numbers, the
 * overdue list, and the pinned tool facts that become improvements.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ImprovementError } from "../src/improvements-model.js";
import { getImprovement, improvementsBrief, listImprovements, proposeFactPromotions, proposeImprovement, recheckCompany, recheckImprovements, resolveImprovement } from "../src/improvements.js";
import { NAMESPACE } from "../src/namespace.js";
import { addFact } from "../src/memory/service.js";
import * as memory from "../src/memory/store.js";
import { COMPANY, OTHER_COMPANY, embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const OPERATOR = "aaaaaaaa-0000-4000-8000-0000000000a1";
const DEV = "aaaaaaaa-0000-4000-8000-0000000000a2";
const T0 = new Date("2026-10-03T12:00:00.000Z");

d("improvements ledger (Postgres)", () => {
  let h: PgHarness;
  const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);

  const runs = (agentId: string, status: string, count: number, hoursAgo = 2, company = COMPANY) =>
    h.client.query(
      `INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, finished_at, usage_json)
       SELECT gen_random_uuid(), $1, $2, $3, $4::timestamptz - (g || ' minutes')::interval, $4::timestamptz - (g || ' minutes')::interval + interval '30 seconds', '{"costUsd": 1}'::jsonb FROM generate_series(1, $5::int) g`,
      [company, agentId, status, new Date(h.clock.now.getTime() - hoursAgo * 3_600_000).toISOString(), count],
    );

  beforeAll(async () => {
    h = await startPg();
    (h.ctx as unknown as { agents: unknown }).agents = {
      get: async (id: string) => ([OPERATOR, DEV].includes(id) ? { id, name: id === OPERATOR ? "Operator" : "Developer", status: "idle" } : null),
      list: async () => [{ id: OPERATOR, name: "Operator", status: "idle" }, { id: DEV, name: "Developer", status: "idle" }],
    };
  }, 120_000);
  afterAll(async () => {
    await h?.stop();
  });
  beforeEach(async () => {
    await h.reset();
    seq = 0;
    h.clock.now = T0;
    await h.client.query(`INSERT INTO ${NAMESPACE}.roles (company_id, operator_agent_id, owner_user_id) VALUES ($1, $2, 'user-owner')`, [COMPANY, OPERATOR]);
    h.config.set(COMPANY, { healthIssue: true });
  });

  const propose = (extra: Record<string, unknown> = {}, actor = { agentId: OPERATOR, userId: null as string | null }) =>
    proposeImprovement(h.env, COMPANY, { title: "Developer skill: run the build before closing", kind: "skill", metricKey: "company:fail_rate", targetValue: 10, ...extra }, actor);

  describe("propose", () => {
    it("measures the baseline now, sets a re-check two weeks out, and records who owns it", async () => {
      await runs(DEV, "succeeded", 10);
      await runs(DEV, "failed", 5);
      const r = await propose();
      expect(r.baselineFrom).toBe("measured");
      expect(r.deduped).toBe(false);
      const row = r.improvement;
      expect(row).toMatchObject({ kind: "skill", metricKey: "company:fail_rate", direction: "lower", targetValue: 10, status: "open", ownerAgentId: OPERATOR, outcome: null });
      expect(row.baselineValue).toBeCloseTo(33.33, 2);
      expect(row.recheckAt).toBe(day(14).toISOString());
      expect(row.metricLabel).toBe("Run failure rate (7 days)");
      expect(r.message).toContain("is 33.33 toward 10 (lower is better)");
      expect(r.message).toContain(`measured again on ${day(14).toISOString().slice(0, 10)}`);
    });

    it("takes the caller's baseline when given, and needs one for a metric nothing reads", async () => {
      const given = await propose({ baselineValue: 40 });
      expect(given.baselineFrom).toBe("given");
      expect(given.improvement.baselineValue).toBe(40);
      await expect(propose({ metricKey: "manual", baselineValue: undefined, targetValue: undefined })).rejects.toThrow("A manual metric needs baselineValue");
      const manual = await propose({ metricKey: "manual", baselineValue: 12, targetValue: 6, direction: "lower", metricLabel: "Minutes per client report", sourceRef: "retro:2026-W40" });
      expect(manual.improvement.metricLabel).toBe("Minutes per client report");
    });

    it("refuses what cannot work: an unreadable metric with no baseline, a target pointing the wrong way, a bad key, a bad date", async () => {
      await expect(propose({ metricKey: "company:review_coverage", targetValue: 90 })).rejects.toThrow("cannot read company:review_coverage right now");
      await expect(propose({ baselineValue: 20, targetValue: 25 })).rejects.toThrow("does not point the right way");
      await expect(propose({ metricKey: "company:made_up" })).rejects.toThrow("is not a metric key");
      await expect(propose({ baselineValue: 20, recheckInDays: 0 })).rejects.toThrow("between 1 and 120");
      await expect(propose({ baselineValue: 20, recheckAt: "2026-10-01" })).rejects.toThrow("must be in the future");
      await expect(propose({ baselineValue: 20, ownerAgentId: "bbbbbbbb-0000-4000-8000-000000000001" })).rejects.toThrow("not an agent of this company");
      await expect(propose({ title: "" })).rejects.toThrow("title is required");
      await expect(propose({ baselineValue: 20, kind: "magic" })).rejects.toThrow("kind must be one of");
      await expect(propose({ metricKey: "kpi:partnersinbiz.crm:new_leads_week", baselineValue: 5 })).rejects.toThrow("direction is required");
      expect((await listImprovements(h.ctx, COMPANY, { status: "all" })).length).toBe(0);
    });

    it("an agent keeps only its own: the same source is not proposed twice while one is open", async () => {
      const first = await propose({ baselineValue: 30, sourceRef: "retro:2026-W40:build" });
      const again = await propose({ baselineValue: 30, sourceRef: "retro:2026-W40:build", title: "Same thing, reworded" });
      expect(again.deduped).toBe(true);
      expect(again.improvement.id).toBe(first.improvement.id);
      expect(again.message).toContain("already an open improvement");
      expect((await listImprovements(h.ctx, COMPANY)).length).toBe(1);
      // another company has its own
      const other = await proposeImprovement(h.env, OTHER_COMPANY, { title: "x", metricKey: "manual", baselineValue: 1, direction: "lower", sourceRef: "retro:2026-W40:build" }, { agentId: null, userId: "u" });
      expect(other.deduped).toBe(false);
    });
  });

  describe("re-check", () => {
    it("measures again when the date comes and writes the verdict with both numbers", async () => {
      await runs(DEV, "succeeded", 10);
      await runs(DEV, "failed", 10);
      const { improvement } = await propose({ targetValue: 20 }); // baseline 50
      // before the date: nothing happens
      h.clock.now = day(7);
      expect(await recheckCompany(h.env, COMPANY)).toMatchObject({ measured: 0 });
      // two weeks on: the failures stopped, 5 failed of the last 20 finished
      await h.client.query(`DELETE FROM public.heartbeat_runs`);
      h.clock.now = day(15);
      await runs(DEV, "succeeded", 15);
      await runs(DEV, "failed", 5);
      const result = await recheckCompany(h.env, COMPANY);
      expect(result).toMatchObject({ measured: 1, improved: 1, worse: 0, noChange: 0 });
      const done = (await getImprovement(h.ctx, COMPANY, improvement.id))!;
      expect(done).toMatchObject({ status: "resolved", outcome: "improved", resultValue: 25, resolvedAt: day(15).toISOString() });
      expect(done.resultNote).toBe("Run failure rate (7 days) went from 50 to 25 (target 20): improved.");
      const activity = await h.client.query(`SELECT text FROM ${NAMESPACE}.activity WHERE company_id = $1 AND kind = 'improvement'`, [COMPANY]);
      expect(activity.rows).toHaveLength(1);
      // a second run finds nothing left to do
      expect(await recheckCompany(h.env, COMPANY)).toMatchObject({ measured: 0 });
    });

    it("says worse and no change as plainly as improved", async () => {
      const worse = await propose({ targetValue: undefined, baselineValue: 20, sourceRef: "a" });
      const flat = await propose({ targetValue: undefined, baselineValue: 50, sourceRef: "b" });
      const noisy = await propose({ targetValue: undefined, baselineValue: 52, sourceRef: "c" }); // 50 is within 5% of 52
      h.clock.now = day(15);
      await runs(DEV, "succeeded", 10);
      await runs(DEV, "failed", 10);
      const result = await recheckCompany(h.env, COMPANY);
      expect(result).toMatchObject({ measured: 3, improved: 0, worse: 1, noChange: 2, unreadable: 0 });
      const rows = await listImprovements(h.ctx, COMPANY, { status: "all" });
      const by = (id: string) => rows.find((r) => r.id === id)!;
      expect(by(worse.improvement.id)).toMatchObject({ outcome: "worse", resultValue: 50 });
      expect(by(worse.improvement.id).resultNote).toBe("Run failure rate (7 days) went from 20 to 50: worse.");
      expect(by(flat.improvement.id).outcome).toBe("no_change");
      expect(by(noisy.improvement.id).resultNote).toBe("Run failure rate (7 days) went from 52 to 50: no change.");
    });

    it("a manual metric stays open and shows overdue three days after its date; an unreadable one is retried and noted", async () => {
      const manual = await propose({ metricKey: "manual", baselineValue: 12, direction: "lower", targetValue: undefined, recheckInDays: 7, sourceRef: "m" });
      const unreadable = await propose({ metricKey: "company:review_coverage", baselineValue: 40, direction: "higher", targetValue: undefined, recheckInDays: 7, sourceRef: "u" });
      h.clock.now = day(8);
      const result = await recheckCompany(h.env, COMPANY);
      expect(result).toMatchObject({ measured: 0, manual: 1, unreadable: 1 });
      expect((await getImprovement(h.ctx, COMPANY, unreadable.improvement.id))!.resultNote).toContain("Could not be measured on 2026-10-11");
      const early = await improvementsBrief(h.env, COMPANY);
      expect(early).toMatchObject({ open: 2, due: 2, overdue: 0 });
      h.clock.now = day(11);
      const late = await improvementsBrief(h.env, COMPANY);
      expect(late).toMatchObject({ open: 2, due: 2, overdue: 2 });
      expect(late.items[0]).toMatchObject({ status: "open", overdueDays: 4 });
      // the person records the number by hand
      const resolved = await resolveImprovement(h.env, COMPANY, { id: manual.improvement.id, resultValue: 8, note: "Timed three reports" });
      expect(resolved.improvement).toMatchObject({ status: "resolved", outcome: "improved", resultValue: 8 });
      expect(resolved.message).toBe("the number went from 12 to 8: improved.");
      expect(resolved.improvement.resultNote).toBe("the number went from 12 to 8: improved. Timed three reports");
    });

    it("the daily job runs for companies with saved settings only, and reports failures without stopping", async () => {
      await h.client.query(`INSERT INTO ${NAMESPACE}.roles (company_id, operator_agent_id, owner_user_id) VALUES ($1, NULL, 'u2')`, [OTHER_COMPANY]);
      const result = await recheckImprovements(h.env);
      expect(result.companies).toBe(1); // OTHER_COMPANY has no saved settings
      expect(result.failed).toBe(0);
    });
  });

  describe("resolve", () => {
    it("drops one, refuses a second resolution, and refuses an unknown id", async () => {
      const { improvement } = await propose({ baselineValue: 30 });
      const dropped = await resolveImprovement(h.env, COMPANY, { id: improvement.id, drop: true, note: "Not worth it" });
      expect(dropped.improvement).toMatchObject({ status: "dropped", outcome: null, resultNote: "Not worth it" });
      await expect(resolveImprovement(h.env, COMPANY, { id: improvement.id, drop: true })).rejects.toThrow("is already dropped");
      await expect(resolveImprovement(h.env, COMPANY, { id: "imp-nope", drop: true })).rejects.toBeInstanceOf(ImprovementError);
      await expect(resolveImprovement(h.env, OTHER_COMPANY, { id: improvement.id, drop: true })).rejects.toThrow("was not found in this company");
    });

    it("measures the number itself for a metric it reads, and needs resultValue for one it does not", async () => {
      await runs(DEV, "succeeded", 9);
      await runs(DEV, "failed", 1);
      const read = await propose({ baselineValue: 30, targetValue: undefined });
      const resolved = await resolveImprovement(h.env, COMPANY, { id: read.improvement.id });
      expect(resolved.improvement).toMatchObject({ outcome: "improved", resultValue: 10 });
      const manual = await propose({ metricKey: "manual", baselineValue: 5, direction: "lower", targetValue: undefined, sourceRef: "man" });
      await expect(resolveImprovement(h.env, COMPANY, { id: manual.improvement.id })).rejects.toThrow("pass resultValue");
    });
  });

  describe("pinned facts that describe a tool (Q2-12)", () => {
    const actor = { agentId: "agent-x", runId: null, userId: null };
    const fact = (text: string, extra: Record<string, unknown> = {}) => addFact(h.env, COMPANY, { text, client: "own", kind: "rule", pinned: true, area: "general", ...extra }, actor);

    it("turns each into an improvement owned by the Operator, a few a day, with the count as its baseline", async () => {
      for (const text of ["Call partnersinbiz.* tools as MCP tools, never over curl.", "Always pass the client when you call partnersinbiz.seo tools.", "Never use the git worktree for Penny: it fails the run.", "A routine run must end with its turn: detach builds."]) await fact(text);
      await fact("Northwind prefers Tuesdays.", { pinned: true });
      expect(await proposeFactPromotions(h.env, COMPANY)).toBe(3); // PROMOTION_BATCH
      const rows = await listImprovements(h.ctx, COMPANY);
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.kind === "skill" && r.ownerAgentId === OPERATOR && r.metricKey === "company:pinned_tool_facts" && r.baselineValue === 4 && r.status === "open")).toBe(true);
      expect(rows.every((r) => r.sourceRef?.startsWith("fact:") && r.title.startsWith("Fold into the"))).toBe(true);
      // the next run opens the fourth, and then there is nothing left
      expect(await proposeFactPromotions(h.env, COMPANY)).toBe(1);
      expect(await proposeFactPromotions(h.env, COMPANY)).toBe(0);
    });

    it("archiving the fact once the skill carries it makes the count fall, and the re-check says improved", async () => {
      const a = await fact("Call partnersinbiz.* tools as MCP tools, never over curl.");
      await fact("Always pass the client when you call partnersinbiz.seo tools.");
      await proposeFactPromotions(h.env, COMPANY);
      const first = (await listImprovements(h.ctx, COMPANY)).find((r) => r.sourceRef === `fact:${a.fact.id}`)!;
      const resolved = await resolveImprovement(h.env, COMPANY, { id: first.id, archiveFact: true, drop: false, resultValue: 1 });
      expect(resolved.archivedFact).toBe(a.fact.id);
      expect((await memory.getFact(h.ctx, COMPANY, a.fact.id))!.status).toBe("archived");
      expect(resolved.improvement.outcome).toBe("improved"); // 2 -> 1
      // not proposed again inside the cooldown
      expect(await proposeFactPromotions(h.env, COMPANY)).toBe(0);
    });
  });

  describe("a fact promotion that the re-check resolved before the skill change shipped", () => {
    const actor = { agentId: "agent-x", runId: null, userId: null };

    it("can still archive its fact afterwards, without touching the recorded verdict, and nothing else may be resolved twice", async () => {
      const a = await addFact(h.env, COMPANY, { text: "Call partnersinbiz.* tools as MCP tools, never over curl.", client: "own", kind: "rule", pinned: true, area: "general" }, actor);
      await proposeFactPromotions(h.env, COMPANY);
      const promotion = (await listImprovements(h.ctx, COMPANY)).find((r) => r.sourceRef === `fact:${a.fact.id}`)!;
      // day 15: the re-check measures the same count, so it resolves "no change" although the skill still lacks the rule
      h.clock.now = day(15);
      await recheckCompany(h.env, COMPANY);
      const settled = (await getImprovement(h.ctx, COMPANY, promotion.id))!;
      expect(settled).toMatchObject({ status: "resolved", outcome: "no_change" });
      expect((await memory.getFact(h.ctx, COMPANY, a.fact.id))!.status).not.toBe("archived");
      // without archiveFact it is still refused, and now says how
      await expect(resolveImprovement(h.env, COMPANY, { id: promotion.id })).rejects.toThrow("is already resolved (no change). Pass archiveFact to archive its memory fact.");
      await expect(resolveImprovement(h.env, COMPANY, { id: promotion.id, drop: true, archiveFact: true })).rejects.toThrow("is already resolved");
      await expect(resolveImprovement(h.env, COMPANY, { id: promotion.id, archiveFact: true, resultValue: 3 })).rejects.toThrow("is already resolved");
      // the skill ships later: archiving the fact works, and the verdict that was recorded stays
      const late = await resolveImprovement(h.env, COMPANY, { id: promotion.id, archiveFact: true });
      expect(late.archivedFact).toBe(a.fact.id);
      expect(late.message).toBe(`Archived fact ${a.fact.id}. Improvement ${promotion.id} stays resolved (no change).`);
      expect((await memory.getFact(h.ctx, COMPANY, a.fact.id))!.status).toBe("archived");
      expect(await getImprovement(h.ctx, COMPANY, promotion.id)).toMatchObject({ status: "resolved", outcome: "no_change", resultValue: settled.resultValue, resultNote: settled.resultNote });
      // an improvement with no fact behind it is not resolved twice just because archiveFact is passed
      const plain = await propose({ baselineValue: 30 });
      await resolveImprovement(h.env, COMPANY, { id: plain.improvement.id, drop: true });
      await expect(resolveImprovement(h.env, COMPANY, { id: plain.improvement.id, archiveFact: true })).rejects.toThrow("is already dropped");
      // and another company cannot reach the fact through it
      await expect(resolveImprovement(h.env, OTHER_COMPANY, { id: promotion.id, archiveFact: true })).rejects.toThrow("was not found in this company");
    });
  });

  it("lists open and overdue first, and keeps another company's out", async () => {
    await propose({ baselineValue: 30, sourceRef: "1", recheckInDays: 30 });
    await propose({ baselineValue: 30, sourceRef: "2", recheckInDays: 2 });
    await proposeImprovement(h.env, OTHER_COMPANY, { title: "Theirs", metricKey: "manual", baselineValue: 1, direction: "lower" }, { agentId: null, userId: "u" });
    h.clock.now = day(10);
    const brief = await improvementsBrief(h.env, COMPANY);
    expect(brief.open).toBe(2);
    expect(brief.items.map((i) => i.recheckAt)).toEqual([day(2).toISOString().slice(0, 10), day(30).toISOString().slice(0, 10)]);
    expect(brief.items[0]).toMatchObject({ overdueDays: 8 });
    expect(brief.items[1]).not.toHaveProperty("overdueDays");
  });
});
