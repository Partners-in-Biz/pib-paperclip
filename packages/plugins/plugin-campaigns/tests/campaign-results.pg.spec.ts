/** Per-version and date-range step numbers against a real Postgres, checked against a hand count of a fixture. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { stepEventStats, stepEventStatsByVersion } from "../src/db.js";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const CO = "11111111-1111-4111-8111-111111111111";

describe.skipIf(!available)("campaign results (postgres)", () => {
  let h: PgHarness;
  let ctx: PluginContext;
  beforeAll(async () => {
    h = await startPg();
    ctx = h.ctx;
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
  });

  let n = 0;
  const ev = (campaign: string, step: number, variant: string | null, type: string, at: string) =>
    h.client.query(
      `INSERT INTO ${NAMESPACE}.campaign_step_events (id, company_id, campaign_id, enrollment_id, step_position, event_type, variant, occurred_at)
       VALUES ($1, $2, $3, 'e1', $4, $5, $6, $7::timestamptz)`,
      [`ev-${n++}`, CO, campaign, step, type, variant, at],
    );

  beforeEach(async () => {
    await h.reset();
    await h.client.query(`INSERT INTO ${NAMESPACE}.campaigns (id, company_id, name, status) VALUES ('c1', $1, 'c1', 'active'), ('c2', $1, 'c2', 'active')`, [CO]);
    await h.client.query(
      `INSERT INTO ${NAMESPACE}.campaign_enrollments (id, company_id, campaign_id, contact_id, status, step_position, next_due_at) VALUES ('e1', $1, 'c1', 'x', 'running', 1, now())`,
      [CO],
    );
    // Step 1: A sent 3 (Nov 1, 2, 10), B sent 2 (Nov 2, 10); A reply 1 (Nov 3), B reply 2 (Nov 11, 12); legacy null variant sent 1 (Nov 1) counts as A.
    for (const at of ["2026-11-01T08:00:00Z", "2026-11-02T08:00:00Z", "2026-11-10T08:00:00Z"]) await ev("c1", 1, "a", "sent", at);
    for (const at of ["2026-11-02T09:00:00Z", "2026-11-10T09:00:00Z"]) await ev("c1", 1, "b", "sent", at);
    await ev("c1", 1, "a", "reply", "2026-11-03T08:00:00Z");
    await ev("c1", 1, "b", "reply", "2026-11-11T08:00:00Z");
    await ev("c1", 1, "b", "reply", "2026-11-12T08:00:00Z");
    await ev("c1", 1, null, "sent", "2026-11-01T10:00:00Z");
    await ev("c1", 2, "a", "sent", "2026-11-05T08:00:00Z");
    await ev("c2", 1, "a", "sent", "2026-11-02T08:00:00Z");
  });

  it("splits by version, null version counting as A", async () => {
    const rows = await stepEventStatsByVersion(ctx, "c1");
    const pick = (step: number, variant: string) => rows.find((r) => r.stepPosition === step && r.variant === variant);
    expect(rows).toHaveLength(3);
    expect(pick(1, "a")).toMatchObject({ sent: 4, replies: 1 });
    expect(pick(1, "b")).toMatchObject({ sent: 2, replies: 2 });
    expect(pick(2, "a")).toMatchObject({ sent: 1, replies: 0 });
  });

  it("limits to a date range (from inclusive, to exclusive)", async () => {
    const rows = await stepEventStatsByVersion(ctx, "c1", { from: "2026-11-02", to: "2026-11-11" });
    const pick = (step: number, variant: string) => rows.find((r) => r.stepPosition === step && r.variant === variant);
    expect(pick(1, "a")).toMatchObject({ sent: 2, replies: 1 });
    expect(pick(1, "b")).toMatchObject({ sent: 2, replies: 0 });
    expect(pick(2, "a")).toMatchObject({ sent: 1 });
  });

  it("keeps the unsplit shape and totals equal the versions summed", async () => {
    const plain = await stepEventStats(ctx, "c1");
    expect(Object.keys(plain[0]!).sort()).toEqual(
      ["bounces", "clicks", "complaints", "delivered", "opens", "replies", "sent", "softBounces", "stepPosition", "unsubscribes"],
    );
    expect(plain.find((s) => s.stepPosition === 1)).toMatchObject({ sent: 6, replies: 3 });
    expect(await stepEventStats(ctx, "c1", { from: "2026-11-11" })).toEqual([expect.objectContaining({ stepPosition: 1, sent: 0, replies: 2 })]);
  });
});
