/** record-metric experiment tagging (Postgres): the arm lives on the item row, one per metric window. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";
import { defaultChannelForScope, parseTag } from "../src/growth-tagging.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const B = "bbbbbbbb-0000-4000-8000-0000000000b1";
const RUN = { agentId: "aaaaaaaa-0000-4000-8000-0000000000a1", runId: "run-1", companyId: A, projectId: "" };
const S1 = "client:company:c-one";
const S2 = "client:company:c-two";
type Out = { error?: string; content?: string; data?: any };
const NS = "plugin_cockpit_b8a99e8b16";

describe("tag parsing and default channel", () => {
  it("takes both or neither, and empty clears", () => {
    expect(parseTag({})).toBeNull();
    expect(parseTag({ experimentId: "e1", arm: "control" })).toEqual({ experimentId: "e1", arm: "control" });
    expect(parseTag({ experimentId: "" })).toEqual({ experimentId: null, arm: null });
    expect(() => parseTag({ experimentId: "e1" })).toThrow(/go together/);
    expect(() => parseTag({ arm: "control" })).toThrow(/needs an experimentId/);
  });
  it("maps scope kind to a default channel", () => {
    expect(defaultChannelForScope("product:p1")).toBe("aso");
    expect(defaultChannelForScope("book:b1")).toBe("book");
    expect(defaultChannelForScope("own")).toBe("website");
    expect(defaultChannelForScope("client:company:x")).toBe("website");
  });
});

d("record-metric tagging (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  // The harness reset leaves the growth tables alone, so each test starts by emptying them.
  const make = async () => {
    const w = await worlds.make({ savedConfigs: { [A]: { healthIssue: true } }, prefixes: { [A]: "PAR" } });
    for (const t of ["growth_experiment_items", "growth_experiments", "growth_programs", "growth_metrics"]) await w.client.query(`DELETE FROM ${NS}.${t}`);
    return w;
  };
  const call = (w: Hybrid, params: Record<string, unknown>, run: Record<string, unknown> = RUN) => w.tools.get("record-metric")!(params, run) as Promise<Out>;
  const base = { channel: "website", subject: S1, metric: "site_conversions", window: "2026-W41", value: 10 };

  async function seed(w: Hybrid, opts: { company?: string; scope?: string; channel?: string; metric?: string; status?: string; id?: string } = {}) {
    const company = opts.company ?? A;
    const id = opts.id ?? "exp1";
    const program = `prog-${company}-${opts.channel ?? "website"}-${opts.scope ?? S1}`;
    await w.client.query(
      `INSERT INTO ${NS}.growth_programs (id, company_id, channel, objective, metric, scope_key) VALUES ($1, $2, $3, 'grow', $4, $5) ON CONFLICT DO NOTHING`,
      [program, company, opts.channel ?? "website", opts.metric ?? "site_conversions", opts.scope ?? S1],
    );
    await w.client.query(
      `INSERT INTO ${NS}.growth_experiments (id, company_id, program_id, hypothesis, hypothesis_type, variable, arms, metric, status)
       VALUES ($1, $2, $3, 'h', 'copy', 'headline', $4::jsonb, $5, $6)`,
      [id, company, program, JSON.stringify([{ key: "control", description: "a" }, { key: "variant", description: "b" }]), opts.metric ?? "site_conversions", opts.status ?? "running"],
    );
  }
  const items = async (w: Hybrid) => (await w.client.query(`SELECT experiment_id, arm, subject_kind, subject_id FROM ${NS}.growth_experiment_items ORDER BY experiment_id, subject_id`)).rows;
  const metrics = async (w: Hybrid) => ((await w.client.query(`SELECT count(*)::int AS n FROM ${NS}.growth_metrics`)).rows[0] as { n: number }).n;

  it("writes the number and the item; a second window of the same arm is a second item", async () => {
    const w = await make();
    await seed(w);
    expect((await call(w, { ...base, experimentId: "exp1", arm: "control" })).error).toBeUndefined();
    await call(w, { ...base, window: "2026-W42", experimentId: "exp1", arm: "control" });
    expect(await items(w)).toEqual([
      { experiment_id: "exp1", arm: "control", subject_kind: "window", subject_id: "2026-W41" },
      { experiment_id: "exp1", arm: "control", subject_kind: "window", subject_id: "2026-W42" },
    ]);
    expect(await metrics(w)).toBe(2);
  });

  it("a repeat switches the arm without a second item", async () => {
    const w = await make();
    await seed(w);
    await call(w, { ...base, experimentId: "exp1", arm: "control" });
    await call(w, { ...base, experimentId: "exp1", arm: "variant" });
    expect((await items(w)).map((r: any) => r.arm)).toEqual(["variant"]);
  });

  it("an empty experimentId clears the tag and keeps the number", async () => {
    const w = await make();
    await seed(w);
    await call(w, { ...base, experimentId: "exp1", arm: "control" });
    expect((await call(w, { ...base, value: 11, experimentId: "" })).error).toBeUndefined();
    expect(await items(w)).toEqual([]);
    expect(await metrics(w)).toBe(1);
  });

  it("refuses a bad tag and writes nothing", async () => {
    const w = await make();
    await seed(w);
    await seed(w, { id: "exp-done", status: "measured", scope: "client:company:c-three", channel: "revenue" });
    expect((await call(w, { ...base, experimentId: "exp1" })).error).toMatch(/go together/);
    expect((await call(w, { ...base, arm: "control" })).error).toMatch(/needs an experimentId/);
    expect((await call(w, { ...base, experimentId: "nope", arm: "control" })).error).toMatch(/not found/);
    expect((await call(w, { ...base, experimentId: "exp1", arm: "third" })).error).toMatch(/arm must be one of control, variant/);
    expect((await call(w, { ...base, metric: "visits", experimentId: "exp1", arm: "control" })).error).toMatch(/measures site_conversions/);
    expect((await call(w, { ...base, channel: "revenue", experimentId: "exp1", arm: "control" })).error).toMatch(/runs on website/);
    expect((await call(w, { ...base, subject: S2, experimentId: "exp1", arm: "control" })).error).toMatch(/belongs to client:company:c-one/);
    expect((await call(w, { ...base, subject: "client:company:c-three", channel: "revenue", experimentId: "exp-done", arm: "control" })).error).toMatch(/is measured/);
    expect(await items(w)).toEqual([]);
    expect(await metrics(w)).toBe(0);
  });

  it("two scopes and two companies never touch each other's items", async () => {
    const w = await make();
    await seed(w, { id: "expA1" });
    await seed(w, { id: "expA2", scope: S2 });
    await seed(w, { id: "expB1", company: B });
    // Scope A's experiment cannot be tagged from scope B, nor from another company.
    expect((await call(w, { ...base, subject: S2, experimentId: "expA1", arm: "control" })).error).toBeTruthy();
    expect((await call(w, { ...base, experimentId: "expB1", arm: "control" })).error).toMatch(/not found/);
    expect((await call(w, { ...base, experimentId: "expA1", arm: "control" }, { ...RUN, companyId: B })).error).toMatch(/not found/);
    await call(w, { ...base, experimentId: "expA1", arm: "control" });
    await call(w, { ...base, subject: S2, experimentId: "expA2", arm: "variant" });
    await call(w, { ...base, experimentId: "expB1", arm: "control" }, { ...RUN, companyId: B });
    // Clearing in scope A leaves scope B's and company B's items alone.
    await call(w, { ...base, experimentId: "" });
    expect((await items(w)).map((r: any) => r.experiment_id)).toEqual(["expA2", "expB1"]);
  });
});
