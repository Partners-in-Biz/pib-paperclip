/** The default pipeline rule and the open-pipeline figures with two pipelines, on a real Postgres. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dealOpenReport, cockpitSnapshot } from "../src/cockpit.js";
import { defaultPipelineId, ensurePipeline, getDeal, getStage, insertStages, listCompanyStages, listPipelines } from "../src/db.js";
import { moveDealTo } from "../src/handoffs.js";
import { listDealsTool, listStagesTool } from "../src/lookup.js";
import { createPipeline, pipelineForecast } from "../src/worker.js";
import type { Viewer } from "../src/domain.js";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const CO = "co-1";
const OTHER = "co-2";
const N = NAMESPACE;
const viewer: Viewer = { companyId: CO, userId: "u1", agentId: null, role: "owner" };
const available = await embeddedAvailable();

describe.skipIf(!available)("the default pipeline rule on a real Postgres", () => {
  let pg: PgHarness;
  beforeAll(async () => {
    pg = await startPg();
  }, 120_000);
  afterAll(async () => {
    await pg?.stop();
  });
  beforeEach(async () => {
    await pg.reset();
  });

  const q = (sql: string) => pg.client.query(sql);
  const pipeline = (id: string, company: string, name: string, at: string) =>
    q(`INSERT INTO ${N}.pipelines (id, company_id, name, created_at) VALUES ('${id}', '${company}', '${name}', '${at}')`);
  const stage = (id: string, company: string, pipelineId: string, kind: string, position: number) =>
    q(`INSERT INTO ${N}.pipeline_stages (id, company_id, pipeline_id, name, kind, position) VALUES ('${id}', '${company}', '${pipelineId}', '${id}', '${kind}', ${position})`);
  const deal = (id: string, pipelineId: string, stageId: string, amount: number, updated = "now()") =>
    q(`INSERT INTO ${N}.deals (id, company_id, pipeline_id, stage_id, title, amount_minor, currency, updated_at, created_at)
       VALUES ('${id}', '${CO}', '${pipelineId}', '${stageId}', '${id}', ${amount}, 'ZAR', ${updated}, now() - interval '30 days')`);

  const idle = "now() - interval '30 days'";

  async function seedTwo() {
    // An older pipeline with no stages must never win the default rule.
    await pipeline("p-empty", CO, "Empty", "2026-01-01T00:00:00Z");
    await pipeline("p-sales", CO, "Sales", "2026-02-01T00:00:00Z");
    await pipeline("p-spons", CO, "Sponsors", "2026-03-01T00:00:00Z");
    await pipeline("p-other", OTHER, "Theirs", "2025-01-01T00:00:00Z");
    await stage("s-open", CO, "p-sales", "open", 0);
    await stage("s-won", CO, "p-sales", "won", 1);
    await stage("sp-open", CO, "p-spons", "open", 0);
    await stage("sp-won", CO, "p-spons", "won", 1);
    await stage("o-open", OTHER, "p-other", "open", 0);
    await deal("d-sales", "p-sales", "s-open", 100_000, idle);
    await deal("d-spons", "p-spons", "sp-open", 900_000, idle);
    // Legacy: deal.pipeline_id says Sales, its stage belongs to Sponsors. The stage decides.
    await deal("d-legacy", "p-sales", "sp-open", 500_000, idle);
    await deal("d-won-sales", "p-sales", "s-won", 200_000);
    await deal("d-won-spons", "p-spons", "sp-won", 300_000);
  }

  it("picks Sales (oldest with stages) over an older empty pipeline, and hides other companies", async () => {
    await seedTwo();
    expect(await defaultPipelineId(pg.ctx, CO)).toBe("p-sales");
    expect((await listPipelines(pg.ctx, CO)).map((row) => [row.id, row.isDefault])).toEqual([["p-sales", true], ["p-spons", false]]);
    expect(await defaultPipelineId(pg.ctx, OTHER)).toBe("p-other");
    expect((await listCompanyStages(pg.ctx, CO)).map((row) => row.id).sort()).toEqual(["s-open", "s-won", "sp-open", "sp-won"]);
    expect((await ensurePipeline(pg.ctx, CO)).pipelineId).toBe("p-sales");
  });

  it("counts only Sales-stage deals as open (legacy deal excluded) and both pipelines as won", async () => {
    await seedTwo();
    const report = await dealOpenReport(pg.ctx, CO, null);
    expect(report.count).toBe(1);
    // All three open deals are idle; only the Sales-stage one may be counted.
    expect(report.stuck).toBe(1);
    expect(report.oldestDays).toBe(30);
    const snap = await cockpitSnapshot(pg.ctx, CO);
    const kpi = (key: string) => snap.kpis.find((row) => row.key === key);
    expect(kpi("pipeline")).toMatchObject({ raw: 100_000, label: "Open pipeline · Sales" });
    expect(kpi("deals_won_month")).toMatchObject({ raw: 2 });
    expect(snap.flows?.find((row) => row.stage === "deal.open")).toMatchObject({ count: 1, amountMinor: 100_000 });
  });

  it("insertStages writes N rows with positions in one call", async () => {
    await pipeline("p-x", CO, "X", "2026-01-01T00:00:00Z");
    await insertStages(pg.ctx, CO, "p-x", [{ name: "A", kind: "open", position: 0 }, { name: "B", kind: "won", position: 1 }, { name: "C", kind: "lost", position: 2 }]);
    const rows = (await q(`SELECT name, kind, position FROM ${N}.pipeline_stages WHERE pipeline_id = 'p-x' ORDER BY position`)).rows;
    expect(rows).toEqual([{ name: "A", kind: "open", position: 0 }, { name: "B", kind: "won", position: 1 }, { name: "C", kind: "lost", position: 2 }]);
  });

  it("ensurePipeline on an empty company creates Sales with 5 stages", async () => {
    const result = await ensurePipeline(pg.ctx, "co-new");
    const pipelines = (await q(`SELECT name FROM ${N}.pipelines WHERE company_id = 'co-new'`)).rows;
    expect(pipelines).toEqual([{ name: "Sales" }]);
    expect((await q(`SELECT count(*)::int AS n FROM ${N}.pipeline_stages WHERE pipeline_id = '${result.pipelineId}'`)).rows).toEqual([{ n: 5 }]);
  });

  it("create-pipeline on a real DB writes Sales (5 stages), the new pipeline and its N stages", async () => {
    const made = await createPipeline(pg.ctx, viewer, { name: "JagGids", stages: [{ name: "Lead", kind: "open" }, { name: "Signed", kind: "won" }, { name: "Declined", kind: "lost" }] });
    expect(made).toMatchObject({ name: "JagGids", isDefault: false });
    expect((await q(`SELECT name FROM ${N}.pipelines WHERE company_id = '${CO}' ORDER BY created_at, id`)).rows).toEqual([{ name: "Sales" }, { name: "JagGids" }]);
    expect((await q(`SELECT name, kind, position FROM ${N}.pipeline_stages WHERE pipeline_id = '${made.pipelineId}' ORDER BY position`)).rows)
      .toEqual([{ name: "Lead", kind: "open", position: 0 }, { name: "Signed", kind: "won", position: 1 }, { name: "Declined", kind: "lost", position: 2 }]);
    expect((await listPipelines(pg.ctx, CO)).map((row) => [row.name, row.isDefault])).toEqual([["Sales", true], ["JagGids", false]]);
  });

  it("filters list-deals, list-stages and pipeline-forecast by pipeline (id or name)", async () => {
    await seedTwo();
    const ids = async (params: Record<string, unknown>) => (await listDealsTool(pg.ctx, viewer, params)).deals.map((row: { id: string }) => row.id).sort();
    expect(await ids({ pipeline: "p-spons" })).toEqual(["d-legacy", "d-spons", "d-won-spons"]);
    expect(await ids({ pipeline: "sponsors" })).toEqual(["d-legacy", "d-spons", "d-won-spons"]);
    expect(await ids({})).toHaveLength(5);
    expect(await ids({ pipeline: "Sales", stage: "s-open" })).toEqual(["d-sales"]);
    expect((await listDealsTool(pg.ctx, viewer, { pipeline: "Sponsors" })).deals.find((row: { id: string }) => row.id === "d-legacy")).toMatchObject({ pipeline: { id: "p-spons", name: "Sponsors" } });

    const dflt = await listStagesTool(pg.ctx, viewer, {});
    expect(dflt.stages.map((row: { id: string }) => row.id)).toEqual(["s-open", "s-won"]);
    expect(dflt.pipelines.map((row: { name: string; isDefault: boolean }) => [row.name, row.isDefault])).toEqual([["Sales", true], ["Sponsors", false]]);
    expect((await listStagesTool(pg.ctx, viewer, { pipeline: "Sponsors" })).stages.map((row: { id: string }) => row.id)).toEqual(["sp-open", "sp-won"]);

    const open = (f: { totalOpenMinor: number }) => f.totalOpenMinor;
    const sales = await pipelineForecast(pg.ctx, viewer, {});
    const spons = await pipelineForecast(pg.ctx, viewer, { pipeline: "Sponsors" });
    expect(sales.pipeline).toEqual({ id: "p-sales", name: "Sales" });
    expect(open(sales)).toBe(100_000);
    expect(spons.pipeline).toEqual({ id: "p-spons", name: "Sponsors" });
    expect(open(spons)).toBe(1_400_000);
    expect(open(sales) + open(spons)).toBe(1_500_000);
  });

  it("another company's pipeline is not found in all three", async () => {
    await seedTwo();
    await expect(listDealsTool(pg.ctx, viewer, { pipeline: "p-other" })).rejects.toThrow(/not found/);
    await expect(listStagesTool(pg.ctx, viewer, { pipeline: "p-other" })).rejects.toThrow(/not found/);
    await expect(pipelineForecast(pg.ctx, viewer, { pipeline: "p-other" })).rejects.toThrow(/not found/);
  });
  it("moveDealTo across pipelines writes the stage's pipeline_id, clears won_at and names the pipeline (T4)", async () => {
    await seedTwo();
    await q(`UPDATE ${N}.deals SET won_at = now() WHERE id = 'd-won-sales'`);
    const won = (await getDeal(pg.ctx, "d-won-sales"))!;
    await moveDealTo(pg.ctx, won, (await getStage(pg.ctx, "sp-open"))!, "in a test");
    const moved = await q(`SELECT pipeline_id, stage_id, won_at FROM ${N}.deals WHERE id = 'd-won-sales'`);
    expect(moved.rows[0]).toMatchObject({ pipeline_id: "p-spons", stage_id: "sp-open", won_at: null });
    const timeline = await q(`SELECT body FROM ${N}.activities WHERE record_id = 'd-won-sales' AND kind = 'deal_moved'`);
    expect((timeline.rows as Array<{ body: string }>).map((row) => row.body)).toEqual(["Moved to Sponsors: sp-open"]);
    // A legacy row (Sales on the row, a Sponsors stage) moved within Sponsors is repaired.
    const legacy = (await getDeal(pg.ctx, "d-legacy"))!;
    await moveDealTo(pg.ctx, legacy, (await getStage(pg.ctx, "sp-open"))!, "in a test");
    const repaired = await q(`SELECT pipeline_id FROM ${N}.deals WHERE id = 'd-legacy'`);
    expect(repaired.rows[0]).toMatchObject({ pipeline_id: "p-spons" });
  });
});
