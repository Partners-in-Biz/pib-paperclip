import { describe, expect, it } from "vitest";
import { BOARD, CO, boot, deal, seed, tool, toolRaw } from "./helpers/crm.js";
import type { Store } from "./helpers/fake-db.js";

const BILLING = "plugin.partnersinbiz.billing";
const asPerson = { companyId: CO, actor: BOARD };

/** Sales (p1, the default) and JagGids (p2, sponsors) for CO; another company's pipeline p9. */
function twoPipelines(): Store {
  const store = seed();
  store.pipelines!.push(
    { id: "p2", company_id: CO, name: "JagGids", created_at: "2026-02-01T00:00:00Z" },
    { id: "p9", company_id: "co-2", name: "Foreign", created_at: "2026-01-01T00:00:00Z" },
  );
  store.pipeline_stages!.push(
    { id: "j-lead", company_id: CO, pipeline_id: "p2", name: "Lead", kind: "open", position: 0 },
    // Same name as a Sales stage: a name is looked up in one pipeline only.
    { id: "j-prop", company_id: CO, pipeline_id: "p2", name: "Proposal", kind: "open", position: 1 },
    { id: "j-won", company_id: CO, pipeline_id: "p2", name: "Signed", kind: "won", position: 2 },
    { id: "j-lost", company_id: CO, pipeline_id: "p2", name: "Declined", kind: "lost", position: 3 },
    { id: "f-open", company_id: "co-2", pipeline_id: "p9", name: "Discovery", kind: "open", position: 0 },
  );
  return store;
}

const row = (store: Store, id: string) => store.deals!.find((d) => d.id === id)!;
/** The invariant: a deal's pipeline is its stage's pipeline. */
const expectInvariant = (store: Store, id: string) => {
  const d = row(store, id);
  expect(store.pipeline_stages!.find((s) => s.id === d.stage_id)!.pipeline_id).toBe(d.pipeline_id);
};
const wins = (emit: { mock: { calls: unknown[][] } }) => emit.mock.calls.filter(([event]) => event === "deal.won");
const moves = (store: Store, id: string) => store.activities!.filter((a) => a.kind === "deal_moved" && a.record_id === id).map((a) => a.body);

describe("create-deal with a pipeline", () => {
  it("lands in the named pipeline's first open stage; omitted, in the default pipeline's", async () => {
    const { harness, store } = await boot({ store: twoPipelines() });
    const sales = await tool(harness, "create-deal", { title: "Website" });
    expect(row(store, sales.id)).toMatchObject({ pipeline_id: "p1", stage_id: "st-open" });
    const byName = await tool(harness, "create-deal", { title: "Gold sponsor", pipeline: "jaggids" });
    expect(row(store, byName.id)).toMatchObject({ pipeline_id: "p2", stage_id: "j-lead" });
    const byId = await tool(harness, "create-deal", { title: "Silver sponsor", pipeline: "p2" });
    expect(row(store, byId.id)).toMatchObject({ pipeline_id: "p2", stage_id: "j-lead" });
    for (const id of [sales.id, byName.id, byId.id]) expectInvariant(store, id);
  });

  it("refuses another company's pipeline", async () => {
    const { harness, store } = await boot({ store: twoPipelines() });
    expect((await toolRaw(harness, "create-deal", { title: "X", pipeline: "p9" })).error).toMatch(/not found/);
    expect(store.deals!.some((d) => d.title === "X")).toBe(false);
  });
});

describe("move-deal across pipelines", () => {
  it("open Sales -> JagGids open by stage id: no won effects, pipeline follows, timeline names the pipeline", async () => {
    const { harness, store, emit } = await boot({ store: twoPipelines() });
    const moved = await tool(harness, "move-deal", { dealId: "d-solo", stageId: "j-lead" });
    expect(moved).toMatchObject({ pipelineId: "p2", stageId: "j-lead", stageKind: "open" });
    expect(moved.won).toBeUndefined();
    expectInvariant(store, "d-solo");
    expect(wins(emit)).toHaveLength(0);
    expect(moves(store, "d-solo")).toEqual(["Moved to JagGids: Lead"]);
  });

  it("a stage name is looked up in pipeline when given, else in the deal's own pipeline", async () => {
    const { harness, store } = await boot({ store: twoPipelines() });
    await tool(harness, "move-deal", { dealId: "d-solo", stageId: "proposal", pipeline: "JagGids" });
    expect(row(store, "d-solo")).toMatchObject({ pipeline_id: "p2", stage_id: "j-prop" });
    expectInvariant(store, "d-solo");
    // Now in JagGids: "Lead" without a pipeline is JagGids's Lead; "Discovery" is not a JagGids stage.
    await tool(harness, "move-deal", { dealId: "d-solo", stageId: "Lead" });
    expect(row(store, "d-solo").stage_id).toBe("j-lead");
    expect((await toolRaw(harness, "move-deal", { dealId: "d-solo", stageId: "Discovery" })).error).toMatch(/No stage Discovery/);
    // In Sales, "Proposal" is the Sales one.
    await tool(harness, "move-deal", { dealId: "d-acme", stageId: "Proposal" });
    expect(row(store, "d-acme")).toMatchObject({ pipeline_id: "p1", stage_id: "st-prop" });
  });

  it("pipeline alone: its first open stage; a deal already in it stays in its stage", async () => {
    const { harness, store } = await boot({ store: twoPipelines() });
    await tool(harness, "move-deal", { dealId: "d-acme", pipeline: "JagGids" });
    expect(row(store, "d-acme")).toMatchObject({ pipeline_id: "p2", stage_id: "j-lead" });
    expectInvariant(store, "d-acme");
    await tool(harness, "move-deal", { dealId: "d-acme", stageId: "j-prop" });
    await tool(harness, "move-deal", { dealId: "d-acme", pipeline: "p2" });
    expect(row(store, "d-acme").stage_id).toBe("j-prop");
    expect(moves(store, "d-acme")).toEqual(["Moved to JagGids: Lead", "Moved to Proposal"]);
  });

  it("JagGids open -> JagGids won: won effects once, plain timeline text", async () => {
    const store = twoPipelines();
    store.deals!.push(deal("d-spon", "Gold sponsor", { pipeline_id: "p2", stage_id: "j-lead", account_id: "globex" }));
    const { harness, emit } = await boot({ store });
    const moved = await tool(harness, "move-deal", { dealId: "d-spon", stageId: "won" });
    expect(moved).toMatchObject({ stageId: "j-won", stageKind: "won", won: { emitted: true } });
    await tool(harness, "move-deal", { dealId: "d-spon", stageId: "j-won" });
    expect(wins(emit)).toHaveLength(1);
    expectInvariant(store, "d-spon");
    expect(moves(store, "d-spon")).toEqual(["Moved to Signed"]);
  });

  it("won Sales -> JagGids open clears won_at and has no won effects", async () => {
    const store = twoPipelines();
    store.deals!.push(deal("d-done", "Old site", { stage_id: "st-won", account_id: "globex", won_at: "2026-09-02T00:00:00Z" }));
    const { harness, emit } = await boot({ store });
    await tool(harness, "move-deal", { dealId: "d-done", stageId: "j-lead" });
    expect(row(store, "d-done")).toMatchObject({ pipeline_id: "p2", stage_id: "j-lead", won_at: null });
    expect(wins(emit)).toHaveLength(0);
  });

  it("a legacy deal whose pipeline_id disagrees with its stage moves within its stage's pipeline and is repaired", async () => {
    const store = twoPipelines();
    store.deals!.push(deal("d-legacy", "Legacy sponsor", { pipeline_id: "p1", stage_id: "j-lead" }));
    const { harness } = await boot({ store });
    await tool(harness, "move-deal", { dealId: "d-legacy", stageId: "Proposal" });
    expect(row(store, "d-legacy")).toMatchObject({ pipeline_id: "p2", stage_id: "j-prop" });
    expect(moves(store, "d-legacy")).toEqual(["Moved to Proposal"]);
  });

  it("refuses a stage id outside the given pipeline, another company's stage or pipeline, and neither", async () => {
    const { harness, store } = await boot({ store: twoPipelines() });
    expect((await toolRaw(harness, "move-deal", { dealId: "d-solo", stageId: "st-won", pipeline: "JagGids" })).error).toMatch(/not in pipeline JagGids/);
    expect((await toolRaw(harness, "move-deal", { dealId: "d-solo", stageId: "f-open" })).error).toMatch(/Stage was not found/);
    expect((await toolRaw(harness, "move-deal", { dealId: "d-solo", pipeline: "p9" })).error).toMatch(/not found/);
    expect((await toolRaw(harness, "move-deal", { dealId: "d-solo" })).error).toMatch(/needs stageId, pipeline or both/);
    expect(row(store, "d-solo")).toMatchObject({ pipeline_id: "p1", stage_id: "st-open" });
  });
});

describe("update-deal across pipelines", () => {
  it("a stage change into another pipeline moves the deal; pipeline alone too", async () => {
    const { harness, store } = await boot({ store: twoPipelines() });
    const result = await harness.performAction<Record<string, any>>("crm.update-deal", { dealId: "d-solo", stageId: "j-prop" }, asPerson);
    expect(result).toMatchObject({ pipelineId: "p2", stageName: "Proposal", stageKind: "open" });
    expectInvariant(store, "d-solo");
    await tool(harness, "update-deal", { dealId: "d-acme", pipeline: "JagGids", title: "Acme sponsorship" });
    expect(row(store, "d-acme")).toMatchObject({ pipeline_id: "p2", stage_id: "j-lead", title: "Acme sponsorship" });
  });

  it("an edit without a move repairs a legacy deal's pipeline_id", async () => {
    const store = twoPipelines();
    store.deals!.push(deal("d-legacy", "Legacy sponsor", { pipeline_id: "p1", stage_id: "j-lead" }));
    const { harness } = await boot({ store });
    const result = await tool(harness, "update-deal", { dealId: "d-legacy", title: "Legacy sponsor 2027" });
    expect(result).toMatchObject({ pipelineId: "p2", stageName: "Lead" });
    expectInvariant(store, "d-legacy");
  });

  it("refuses another company's stage or pipeline", async () => {
    const { harness, store } = await boot({ store: twoPipelines() });
    expect((await toolRaw(harness, "update-deal", { dealId: "d-solo", stageId: "f-open" })).error).toMatch(/Stage was not found/);
    expect((await toolRaw(harness, "update-deal", { dealId: "d-solo", pipeline: "Foreign" })).error).toMatch(/not found/);
    expect(row(store, "d-solo")).toMatchObject({ pipeline_id: "p1", stage_id: "st-open" });
  });
});

describe("quote acceptance across pipelines", () => {
  const quote = (extra: Record<string, unknown> = {}) => ({ key: "billing:quote:q1:accepted", quoteId: "q1", number: "Q-0001", dealId: null, clientKind: "company", clientRef: "acme", totalMinor: 250_000, currency: "ZAR", acceptedAt: "2026-09-27T08:00:00Z", ...extra });

  it("with a deal id: the deal's own pipeline's won stage", async () => {
    const store = twoPipelines();
    store.deals!.push(deal("d-spon", "Gold sponsor", { pipeline_id: "p2", stage_id: "j-prop", account_id: "globex" }));
    const { harness, emit } = await boot({ store });
    await harness.emit(`${BILLING}.quote.accepted`, quote({ dealId: "d-spon", clientRef: "globex" }), { companyId: CO });
    expect(row(store, "d-spon")).toMatchObject({ pipeline_id: "p2", stage_id: "j-won" });
    expect(wins(emit)).toHaveLength(1);
  });

  it("without a deal id: each deal is classified by its own stage and won in its own pipeline", async () => {
    const store = twoPipelines();
    // Acme: an open JagGids deal and a won JagGids deal (not open, so no "pick the deal").
    store.deals = [
      deal("d-acme", "Acme sponsor", { account_id: "acme", pipeline_id: "p2", stage_id: "j-prop" }),
      deal("d-acme-won", "Acme last year", { account_id: "acme", pipeline_id: "p2", stage_id: "j-won" }),
    ];
    const { harness } = await boot({ store });
    await harness.emit(`${BILLING}.quote.accepted`, quote(), { companyId: CO });
    expect(row(store, "d-acme")).toMatchObject({ pipeline_id: "p2", stage_id: "j-won" });
    expectInvariant(store, "d-acme");
  });

  it("a new deal for the sale goes to the default pipeline", async () => {
    const store = twoPipelines();
    store.deals!.push(deal("d-globex-won", "Globex sponsor", { account_id: "globex", pipeline_id: "p2", stage_id: "j-won" }));
    const { harness } = await boot({ store });
    await harness.emit(`${BILLING}.quote.accepted`, quote({ clientRef: "globex" }), { companyId: CO });
    const created = store.deals!.find((d) => d.title === "Quote Q-0001")!;
    expect(created).toMatchObject({ pipeline_id: "p1", stage_id: "st-won" });
  });
});
