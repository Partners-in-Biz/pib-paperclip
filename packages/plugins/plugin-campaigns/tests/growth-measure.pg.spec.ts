/**
 * Campaigns experiment measuring (Postgres, 015 tables): a campaign can only be tied to an experiment of its own client scope,
 * and the daily job judges a running experiment on its linked campaign's A/B sends, once, with the kit writing the verdict.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { insertCampaign } from "../src/db.js";
import { createCampaign } from "../src/domain.js";
import { campaignsGrowthEnv, type CampaignsGrowthEnv } from "../src/growth-host.js";
import { linkCampaignToExperiment, linkedCampaigns, measureExperimentsJob } from "../src/growth-measure.js";
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
afterAll(async () => {
  if (available) await pg.stop();
});

function world() {
  const companyId = `co-m${(n += 1)}`;
  const ctx = {
    db: {
      namespace: NAMESPACE,
      query: async (sql: string, params?: unknown[]) => (await pg.client.query(sql, params)).rows,
      execute: async (sql: string, params?: unknown[]) => ({ rowCount: (await pg.client.query(sql, params)).rowCount ?? 0 }),
    },
    logger: { info: () => {}, warn: () => {} },
    events: { emit: vi.fn(async () => {}) },
    issues: { createComment: vi.fn(async () => {}) },
  } as unknown as PluginContext;
  const env: CampaignsGrowthEnv = {
    ...campaignsGrowthEnv(ctx),
    now: () => NOW,
    issuePort: () => ({ createApproval: async () => ({ id: "issue-1" }), isOpen: async () => true, setStatus: async () => {}, comment: async () => {} }),
  };
  return { companyId, ctx, env, store: env.store };
}

async function program(w: ReturnType<typeof world>, clientRef: string | null) {
  const id = `p-${clientRef ?? "own"}-${(n += 1)}`;
  await pg.client.query(
    `INSERT INTO ${NAMESPACE}.growth_programs (id, company_id, client_kind, client_ref, client_name, channel, objective, metric, scope_key, autopilot)
     VALUES ($1, $2, $3, $4, $4, 'campaigns', 'o', 'm', $5, 'off')`,
    [id, w.companyId, clientRef ? "company" : null, clientRef, clientRef ? `client:company:${clientRef}` : "own"],
  );
  return id;
}

async function experiment(w: ReturnType<typeof world>, programId: string, status = "running") {
  const id = `e-${(n += 1)}`;
  await pg.client.query(
    `INSERT INTO ${NAMESPACE}.growth_experiments (id, company_id, program_id, hypothesis, hypothesis_type, variable, arms, metric, min_per_arm, status, started_at)
     VALUES ($1, $2, $3, 'A question lifts replies', 'hook:question', 'Opening', '[]'::jsonb, 'reply rate', 3, $4, '2026-10-01T00:00:00Z')`,
    [id, w.companyId, programId, status],
  );
  return id;
}

async function campaign(w: ReturnType<typeof world>, clientRef: string | null) {
  const c = createCampaign({ companyId: w.companyId, name: "Spring", client: clientRef ? { kind: "company", id: clientRef, name: clientRef } : null });
  await insertCampaign(w.ctx, c);
  return c.id;
}

/** `count` sends of one variant on step 1 ten days before NOW; the first `replies` of them got a reply. */
async function seedSends(w: ReturnType<typeof world>, campaignId: string, variant: "a" | "b", count: number, replies: number, from = 0) {
  for (let i = from; i < from + count; i += 1) {
    const enrollment = `en-${variant}-${campaignId}-${i}`;
    await pg.client.query(
      `INSERT INTO ${NAMESPACE}.campaign_enrollments (id, company_id, campaign_id, contact_id, status, step_position, variant) VALUES ($1, $2, $3, $4, 'done', 1, $5)`,
      [enrollment, w.companyId, campaignId, `ct-${variant}-${i}`, variant],
    );
    const kinds = i - from < replies ? ["sent", "reply"] : ["sent"];
    for (const kind of kinds) {
      await pg.client.query(
        `INSERT INTO ${NAMESPACE}.campaign_step_events (id, company_id, campaign_id, enrollment_id, step_position, event_type, variant, occurred_at) VALUES ($1, $2, $3, $4, 1, $5, $6, '2026-10-11T08:00:00Z')`,
        [`ev-${enrollment}-${kind}`, w.companyId, campaignId, enrollment, kind, variant],
      );
    }
  }
}

describe.skipIf(!available)("campaigns experiment measuring", () => {
  it("links a campaign of the same client and refuses another client's or own work", async () => {
    const w = world();
    const progA = await program(w, "a");
    const expA = await experiment(w, progA);
    const campA = await campaign(w, "a");
    const campB = await campaign(w, "b");
    const campOwn = await campaign(w, null);
    await linkCampaignToExperiment(w.ctx, w.store, w.companyId, expA, campA);
    await expect(linkCampaignToExperiment(w.ctx, w.store, w.companyId, expA, campB)).rejects.toThrow(/another client/);
    await expect(linkCampaignToExperiment(w.ctx, w.store, w.companyId, expA, campOwn)).rejects.toThrow(/another client/);
    expect(await linkedCampaigns(w.ctx, expA)).toEqual([campA]);
  });

  it("refuses an experiment of another company and one that is already measured", async () => {
    const w = world();
    const other = world();
    const exp = await experiment(w, await program(w, "a"));
    const done = await experiment(w, await program(w, "c"), "measured");
    const camp = await campaign(w, "a");
    const campC = await campaign(w, "c");
    await expect(linkCampaignToExperiment(other.ctx, other.store, other.companyId, exp, camp)).rejects.toThrow(/not found/);
    await expect(linkCampaignToExperiment(w.ctx, w.store, w.companyId, done, campC)).rejects.toThrow(/measured/);
  });

  it("the job waits without enough batches, then measures a win and leaves the other scope's experiment alone", async () => {
    const w = world();
    const expA = await experiment(w, await program(w, "a"));
    const expB = await experiment(w, await program(w, "b"));
    const campA = await campaign(w, "a");
    const campB = await campaign(w, "b");
    await linkCampaignToExperiment(w.ctx, w.store, w.companyId, expA, campA);
    await linkCampaignToExperiment(w.ctx, w.store, w.companyId, expB, campB);
    await seedSends(w, campA, "a", 10, 0);
    await seedSends(w, campA, "b", 10, 5);
    await measureExperimentsJob(w.ctx, w.env);
    const status = async (id: string) => ((await pg.client.query(`SELECT status, verdict FROM ${NAMESPACE}.growth_experiments WHERE id = $1`, [id])).rows[0] as { status: string; verdict: string | null });
    expect(await status(expA)).toMatchObject({ status: "running", verdict: null });
    await seedSends(w, campA, "a", 5, 0, 10);
    await seedSends(w, campA, "b", 5, 5, 10);
    const summary = await measureExperimentsJob(w.ctx, w.env);
    expect(summary.errors).toBe(0);
    expect(await status(expA)).toMatchObject({ status: "measured", verdict: "win" });
    expect(await status(expB)).toMatchObject({ status: "running", verdict: null });
    // Measured once: a second run leaves the verdict as it is.
    await measureExperimentsJob(w.ctx, w.env);
    expect(await status(expA)).toMatchObject({ status: "measured", verdict: "win" });
  });
});
