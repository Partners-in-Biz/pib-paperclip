/** The growth metric tool (Postgres): one number per company, channel, scope, metric and window. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const B = "bbbbbbbb-0000-4000-8000-0000000000b1";
const RUN = { agentId: "aaaaaaaa-0000-4000-8000-0000000000a1", runId: "run-1", companyId: A, projectId: "" };
const S1 = "client:company:c-one";
const S2 = "client:company:c-two";
type Out = { error?: string; content?: string; data?: any };

d("record-metric (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  const make = () => worlds.make({ savedConfigs: { [A]: { healthIssue: true } }, prefixes: { [A]: "PAR" } });
  const call = (w: Hybrid, params: Record<string, unknown>, run: Record<string, unknown> = RUN) => w.tools.get("record-metric")!(params, run) as Promise<Out>;
  const rows = async (w: Hybrid) => (await w.client.query("SELECT company_id, subject, \"window\", value::float AS value, source FROM plugin_cockpit_b8a99e8b16.growth_metrics ORDER BY company_id, subject, \"window\"")).rows as Array<{ company_id: string; subject: string; window: string; value: number; source: string }>;
  const base = { channel: "website", subject: S1, metric: "conversions", window: "2026-W41", value: 10 };

  it("records a number, and a repeat for the same window replaces it", async () => {
    const w = await make();
    expect((await call(w, base)).error).toBeUndefined();
    await call(w, { ...base, value: 14 });
    expect(await rows(w)).toEqual([{ company_id: A, subject: S1, window: "2026-W41", value: 14, source: "tool" }]);
  });

  it("another window is another number", async () => {
    const w = await make();
    await call(w, base);
    await call(w, { ...base, window: "2026-W42", value: 20, source: "csv" });
    expect((await rows(w)).map((r) => [r.window, r.value, r.source])).toEqual([["2026-W41", 10, "tool"], ["2026-W42", 20, "csv"]]);
  });

  it("two scopes and two companies keep their own numbers", async () => {
    const w = await make();
    await call(w, base);
    await call(w, { ...base, subject: S2, value: 99 });
    await call(w, { ...base, value: 7 }, { ...RUN, companyId: B });
    await call(w, { ...base, subject: S2, value: 100 });
    expect((await rows(w)).map((r) => [r.company_id, r.subject, r.value])).toEqual([[A, S1, 10], [A, S2, 100], [B, S1, 7]]);
  });

  it("refuses bad input in words", async () => {
    const w = await make();
    expect((await call(w, { ...base, value: "ten" })).error).toMatch(/value must be a number/);
    expect((await call(w, { ...base, subject: "everyone" })).error).toMatch(/subject must be/);
    expect((await call(w, { ...base, source: "guess" })).error).toMatch(/source must be one of/);
    expect(await rows(w)).toEqual([]);
  });
});
