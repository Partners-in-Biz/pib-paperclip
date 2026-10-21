/**
 * Own metrics event (Postgres): CRM's own.metrics.updated event writes growth_metrics,
 * respects company and scope isolation, and handles repeats and new weeks correctly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { scoreExperimentItems } from "../src/growth-adapter.js";
import { recordMetric } from "../src/growth-ledger.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const B = "bbbbbbbb-0000-4000-8000-0000000000b1";
const RUN = { agentId: "aaaaaaaa-0000-4000-8000-0000000000a1", runId: "run-1", companyId: A, projectId: "" };
const CRM_OWN_METRICS = "plugin.partnersinbiz.crm.own.metrics.updated";

type Out = { error?: string; content?: string; data?: any };

d("own.metrics.updated event (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  const make = () => worlds.make({ savedConfigs: { [A]: { healthIssue: true } }, prefixes: { [A]: "PAR" } });
  const rows = async (w: Hybrid) =>
    (
      await w.client.query(
        "SELECT company_id, subject, channel, metric, \"window\", value::float AS value, source FROM plugin_cockpit_b8a99e8b16.growth_metrics ORDER BY company_id, subject, channel, metric, \"window\"",
      )
    ).rows as Array<{ company_id: string; subject: string; channel: string; metric: string; window: string; value: number; source: string }>;

  it("emits event, writes growth_metrics for website and revenue channels", async () => {
    const w = await make();
    const event = {
      companyId: A,
      payload: {
        scope: "own",
        metrics: [
          { key: "site_conversions", label: "Conversions", value: 100, unit: "count", period: "30d" },
          { key: "site_conversion_rate", label: "Rate", value: 2.5, unit: "percent", period: "30d" },
          { key: "revenue.organic_search", label: "Organic", value: 5000, unit: "ZAR", period: "30d" },
        ],
        updatedAt: "2026-10-21T12:00:00.000Z",
      },
    };
    await w.fire(CRM_OWN_METRICS, event);
    const result = await rows(w);
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ company_id: A, subject: "own", channel: "website", metric: "site_conversions", window: "2026-W43", value: 100, source: "tool" }),
        expect.objectContaining({ company_id: A, subject: "own", channel: "website", metric: "site_conversion_rate", window: "2026-W43", value: 2.5, source: "tool" }),
        expect.objectContaining({ company_id: A, subject: "own", channel: "revenue", metric: "revenue.organic_search", window: "2026-W43", value: 5000, source: "tool" }),
      ]),
    );
  });

  it("repeat in the same week replaces the value", async () => {
    const w = await make();
    await w.fire(CRM_OWN_METRICS, {
      companyId: A,
      payload: {
        scope: "own",
        metrics: [{ key: "site_conversions", label: "Conversions", value: 100, unit: "count", period: "30d" }],
        updatedAt: "2026-10-21T12:00:00.000Z",
      },
    });
    await w.fire(CRM_OWN_METRICS, {
      companyId: A,
      payload: {
        scope: "own",
        metrics: [{ key: "site_conversions", label: "Conversions", value: 120, unit: "count", period: "30d" }],
        updatedAt: "2026-10-22T12:00:00.000Z",
      },
    });
    const result = await rows(w);
    expect(result).toEqual([
      expect.objectContaining({ company_id: A, subject: "own", channel: "website", metric: "site_conversions", window: "2026-W43", value: 120, source: "tool" }),
    ]);
  });

  it("new week adds a row", async () => {
    const w = await make();
    await w.fire(CRM_OWN_METRICS, {
      companyId: A,
      payload: {
        scope: "own",
        metrics: [{ key: "site_conversions", label: "Conversions", value: 100, unit: "count", period: "30d" }],
        updatedAt: "2026-10-21T12:00:00.000Z",
      },
    });
    await w.fire(CRM_OWN_METRICS, {
      companyId: A,
      payload: {
        scope: "own",
        metrics: [{ key: "site_conversions", label: "Conversions", value: 200, unit: "count", period: "30d" }],
        updatedAt: "2026-10-28T12:00:00.000Z",
      },
    });
    const result = await rows(w);
    expect(result.map((r) => [r.window, r.value])).toEqual([
      ["2026-W43", 100],
      ["2026-W44", 200],
    ]);
  });

  it("two companies: company A and B rows are isolated", async () => {
    const w = await make();
    await w.fire(CRM_OWN_METRICS, {
      companyId: A,
      payload: {
        scope: "own",
        metrics: [{ key: "site_conversions", label: "Conversions", value: 100, unit: "count", period: "30d" }],
        updatedAt: "2026-10-21T12:00:00.000Z",
      },
    });
    await w.fire(CRM_OWN_METRICS, {
      companyId: B,
      payload: {
        scope: "own",
        metrics: [{ key: "site_conversions", label: "Conversions", value: 999, unit: "count", period: "30d" }],
        updatedAt: "2026-10-21T12:00:00.000Z",
      },
    });
    const result = await rows(w);
    expect(result.map((r) => [r.company_id, r.value])).toEqual([
      [A, 100],
      [B, 999],
    ]);
  });

  it("scoreExperimentItems reads only the asked company and scope, and a missing window leaves one item unscored", async () => {
    const w = await make();
    const S1 = "client:company:c-one";
    const S2 = "client:company:c-two";
    const put = (companyId: string, subject: string, window: string, value: number) =>
      recordMetric(w.env, companyId, { channel: "book", subject, metric: "units", window, value, source: "tool" });
    await put(A, S1, "2026-W41", 10);
    await put(A, S1, "2026-W42", 20);
    await put(A, S1, "2026-W43", 30);
    await put(A, S2, "2026-W41", 900);
    await put(A, S2, "2026-W42", 900);
    await put(B, S1, "2026-W41", 777);
    await put(B, S1, "2026-W42", 777);
    const items = [
      { arm: "control", subjectId: "2026-W41+2026-W42" },
      { arm: "variant", subjectId: "2026-W43+2026-W44" },
      { arm: "variant", subjectId: "2026-W43" },
    ];
    const cfg = { channel: "book", scopeKey: S1, metric: "units" };
    const forA = await scoreExperimentItems(w.env, A, cfg, items);
    expect(forA.map((i) => [i.value, i.published])).toEqual([[15, true], [null, false], [30, true]]);
    // Scope B's and company B's numbers for the same windows never leak in.
    expect((await scoreExperimentItems(w.env, A, { ...cfg, scopeKey: S2 }, items.slice(0, 1)))[0]!.value).toBe(900);
    expect((await scoreExperimentItems(w.env, B, cfg, items.slice(0, 1)))[0]!.value).toBe(777);
    expect((await scoreExperimentItems(w.env, B, { ...cfg, scopeKey: S2 }, items.slice(0, 1)))[0]!.value).toBeNull();
  });
});
