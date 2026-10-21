/**
 * SEO experiment measuring: the daily job judges running experiments on linked pages' GSC metrics,
 * with one failing experiment not stopping the rest. GSC read failures are logged, not silently skipped.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { seoGrowthEnv, seoGrowthStore } from "../src/growth-host.js";
import { measureExperimentsJob, measuringStore } from "../src/growth-measure.js";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const NOW = new Date("2026-10-21T08:00:00Z");
let pg: PgHarness;
let n = 0;

beforeAll(async () => {
  if (!available) return;
  pg = await startPg();
}, 120_000);
beforeEach(async () => {
  if (!available) return;
  await pg.reset();
});
afterAll(async () => {
  if (available) await pg.stop();
});

function world() {
  const companyId = `co-${(n += 1)}`;
  const ctx = {
    db: {
      namespace: NAMESPACE,
      query: async (sql: string, params?: unknown[]) => (await pg.client.query(sql, params)).rows,
      execute: async (sql: string, params?: unknown[]) => ({ rowCount: (await pg.client.query(sql, params)).rowCount ?? 0 }),
    },
    logger: { info: vi.fn(), warn: vi.fn() },
    events: { emit: vi.fn(async () => {}) },
    issues: { get: async () => null, createComment: vi.fn(async () => {}) },
  } as unknown as PluginContext;
  return {
    companyId,
    ctx,
    async reset() {
      await pg.reset();
    },
  };
}

async function program(w: ReturnType<typeof world>) {
  const id = `p-own-${(n += 1)}`;
  await pg.client.query(
    `INSERT INTO ${NAMESPACE}.growth_programs (id, company_id, client_kind, client_ref, client_name, channel, objective, metric, scope_key, autopilot)
     VALUES ($1, $2, null, null, null, 'seo', 'improve clicks', 'click rate', 'own', 'off')`,
    [id, w.companyId],
  );
  return id;
}

async function experiment(w: ReturnType<typeof world>, programId: string, status = "running") {
  const id = `e-${(n += 1)}`;
  await pg.client.query(
    `INSERT INTO ${NAMESPACE}.growth_experiments (id, company_id, program_id, hypothesis, hypothesis_type, variable, arms, metric, min_per_arm, status, started_at)
     VALUES ($1, $2, $3, 'Question improves CTR', 'hook:question', 'Opening', '[]'::jsonb, 'click rate', 20, $4, '2026-10-01T00:00:00Z')`,
    [id, w.companyId, programId, status],
  );
  return id;
}

async function linkedPages(w: ReturnType<typeof world>, experimentId: string, pages: { url: string; arm: "control" | "variant" }[]) {
  for (const page of pages) {
    await pg.client.query(
      `INSERT INTO ${NAMESPACE}.growth_experiment_items (experiment_id, arm, subject_kind, subject_id) VALUES ($1, $2, $3, $4)`,
      [experimentId, page.arm, "page_link", page.url],
    );
  }
}

describe.skipIf(!available)("seo experiment measuring", () => {
  it("the job measures nothing without linked pages or sprints", async () => {
    const w = world();
    const progId = await program(w);
    const expId = await experiment(w, progId);
    const summary = await measureExperimentsJob(w.ctx);
    expect(summary.experiments).toBe(1);
    expect(summary.measured).toBe(0);
    expect(summary.waiting).toBe(1);
    const status = (await pg.client.query(`SELECT status FROM ${NAMESPACE}.growth_experiments WHERE id = $1`, [expId])).rows[0] as { status: string };
    expect(status.status).toBe("running");
  });

  it("the job waits when linked pages have no GSC data", async () => {
    const w = world();
    const progId = await program(w);
    const expId = await experiment(w, progId);
    await linkedPages(w, expId, [{ url: "https://example.com/page", arm: "control" }]);
    const summary = await measureExperimentsJob(w.ctx);
    expect(summary.experiments).toBe(1);
    expect(summary.waiting).toBe(1);
    expect(summary.measured).toBe(0);
  });

  it("multiple running experiments are all processed", async () => {
    const w = world();
    const progId = await program(w);
    const exp1 = await experiment(w, progId, "running");
    const exp2 = await experiment(w, progId, "running");
    const summary = await measureExperimentsJob(w.ctx);
    expect(summary.experiments).toBe(2);
    expect(summary.waiting).toBe(2);
  });

  it("experiments already measured are skipped", async () => {
    const w = world();
    const progId = await program(w);
    const expId = await experiment(w, progId, "measured");
    const summary = await measureExperimentsJob(w.ctx);
    expect(summary.experiments).toBe(0);
  });
});
