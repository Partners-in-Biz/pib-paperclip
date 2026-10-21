/**
 * The growth ledger (Postgres): a channel's `growth.verdict` event writes a
 * row, a duplicate is a no-op, the weekly reconcile (`ledger-upsert`) fills a
 * missing row, and one scope's or company's rows never show in another's.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const B = "bbbbbbbb-0000-4000-8000-0000000000b1";
const NOW = "2026-10-03T12:00:00.000Z";
const RUN = { agentId: "aaaaaaaa-0000-4000-8000-0000000000a1", runId: "run-1", companyId: A, projectId: "" };
const SCOPE_1 = "client:company:c-one";
const SCOPE_2 = "client:company:c-two";
const SOCIAL = "plugin.partnersinbiz.social.growth.verdict";

type Out = { error?: string; content?: string; data?: any };
const verdict = (over: Record<string, unknown> = {}) => ({ scope: SCOPE_1, experimentId: "exp1", verdict: "win", relativeChange: 0.12, items: 12, minPerArm: 3, playbookDecision: "kept", decidedBy: "agent-1", decidedAt: "2026-10-02T08:00:00.000Z", ...over });

d("the growth ledger (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  const make = () => worlds.make({ savedConfigs: { [A]: { healthIssue: true } }, prefixes: { [A]: "PAR" } }, NOW);
  const call = (w: Hybrid, name: string, params: Record<string, unknown> = {}, run: Record<string, unknown> = RUN) => w.tools.get(name)!(params, run) as Promise<Out>;
  const count = async (w: Hybrid) => Number(((await w.client.query("SELECT count(*) AS n FROM plugin_cockpit_b8a99e8b16.growth_ledger")).rows[0] as { n: string }).n);

  it("an event writes a row, with the channel taken from the sending plugin", async () => {
    const w = await make();
    await w.fire(SOCIAL, { companyId: A, payload: verdict() });
    const out = await call(w, "growth-ledger");
    expect(out.data.count).toBe(1);
    expect(out.data.items[0]).toMatchObject({ channel: "social", scopeKey: SCOPE_1, experimentId: "exp1", verdict: "win", relativeChange: 0.12, items: 12, minPerArm: 3, playbookDecision: "kept", decidedAt: "2026-10-02T08:00:00.000Z" });
  });

  it("a duplicate event is a no-op", async () => {
    const w = await make();
    await w.fire(SOCIAL, { companyId: A, payload: verdict() });
    await w.fire(SOCIAL, { companyId: A, payload: verdict() });
    await w.fire(SOCIAL, { companyId: A, payload: verdict({ decidedAt: "2026-10-02T09:30:00.000Z" }) });
    expect(await count(w)).toBe(1);
  });

  it("a changed decision on the same experiment is a new row", async () => {
    const w = await make();
    await w.fire(SOCIAL, { companyId: A, payload: verdict({ playbookDecision: "pending" }) });
    await w.fire(SOCIAL, { companyId: A, payload: verdict({ decidedAt: "2026-10-04T08:00:00.000Z" }) });
    expect(await count(w)).toBe(2);
  });

  it("drops a malformed or companyless event without throwing", async () => {
    const w = await make();
    await w.fire(SOCIAL, { companyId: A, payload: verdict({ verdict: "great" }) });
    await w.fire(SOCIAL, { companyId: A, payload: verdict({ scope: "everyone" }) });
    await w.fire(SOCIAL, { companyId: A, payload: null });
    await w.fire(SOCIAL, { companyId: "", payload: verdict() });
    expect(await count(w)).toBe(0);
  });

  it("reconcile fills a missing row and leaves an existing one alone", async () => {
    const w = await make();
    await w.fire(SOCIAL, { companyId: A, payload: verdict() });
    const input = { channel: "social", scope: SCOPE_1, experimentId: "exp2", verdict: "loss", decidedAt: "2026-10-01T08:00:00.000Z" };
    expect((await call(w, "ledger-upsert", input)).data.created).toBe(true);
    expect((await call(w, "ledger-upsert", input)).data.created).toBe(false);
    // The event already wrote exp1: the reconcile with the same verdict and decision does not add a second row.
    expect((await call(w, "ledger-upsert", { channel: "social", scope: SCOPE_1, experimentId: "exp1", verdict: "win", playbookDecision: "kept" })).data.created).toBe(false);
    expect(await count(w)).toBe(2);
  });

  it("refuses a bad verdict or scope in words", async () => {
    const w = await make();
    expect((await call(w, "ledger-upsert", { channel: "social", scope: SCOPE_1, experimentId: "e", verdict: "great" })).error).toMatch(/verdict must be one of/);
    expect((await call(w, "ledger-upsert", { channel: "social", scope: "everyone", experimentId: "e" })).error).toMatch(/scope must be/);
  });

  it("two scopes: one scope's rows are not returned for the other", async () => {
    const w = await make();
    await w.fire(SOCIAL, { companyId: A, payload: verdict() });
    await w.fire(SOCIAL, { companyId: A, payload: verdict({ scope: SCOPE_2, experimentId: "exp9", verdict: "loss" }) });
    const one = await call(w, "growth-ledger", { scope: SCOPE_1 });
    expect(one.data.items.map((r: any) => r.experimentId)).toEqual(["exp1"]);
    const two = await call(w, "growth-ledger", { scope: SCOPE_2 });
    expect(two.data.items.map((r: any) => r.experimentId)).toEqual(["exp9"]);
    // Writing for scope 2 never touches scope 1's row.
    await call(w, "ledger-upsert", { channel: "social", scope: SCOPE_2, experimentId: "exp10", verdict: "win" });
    expect((await call(w, "growth-ledger", { scope: SCOPE_1 })).data.count).toBe(1);
    expect((await call(w, "growth-ledger", { scope: SCOPE_2 })).data.count).toBe(2);
  });

  it("two companies: a verdict is read and written only in its own company", async () => {
    const w = await make();
    await w.fire(SOCIAL, { companyId: A, payload: verdict() });
    await w.fire(SOCIAL, { companyId: B, payload: verdict({ experimentId: "expB" }) });
    expect((await call(w, "growth-ledger")).data.items.map((r: any) => r.experimentId)).toEqual(["exp1"]);
    const asB = (await call(w, "growth-ledger", {}, { ...RUN, companyId: B })).data;
    expect(asB.items.map((r: any) => r.experimentId)).toEqual(["expB"]);
    // The same experiment id in the other company is its own row.
    expect((await call(w, "ledger-upsert", { channel: "social", scope: SCOPE_1, experimentId: "expB", verdict: "win", playbookDecision: "kept" })).data.created).toBe(true);
  });
});
