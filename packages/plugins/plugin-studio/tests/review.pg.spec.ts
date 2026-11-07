import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { reviewAsset } from "../src/review.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

/**
 * Review against real Postgres, with params bound by the host's own drizzle (tests/helpers/pg.ts `hostBinder`).
 * 0.1.7 passed a JS array to `ANY($4::text[])`; the host expands that to `($4, $5)` and Postgres refused it (live 502).
 */
const CO = "11111111-1111-4111-8111-111111111111";
const available = await embeddedAvailable();
let pg: Pg;

beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);
afterAll(async () => {
  if (available) await pg.stop();
});

describe.skipIf(!available)("review through the host's db binding", () => {
  const T = (name: string) => `${pg.db.namespace}.${name}`;
  const emit = vi.fn(async () => {});
  const ctx = () => ({ db: pg.db, events: { emit } }) as unknown as PluginContext;
  const deps = { signUrl: async () => "https://r2.example/signed", now: () => new Date("2026-11-06T10:00:00Z") };

  beforeEach(async () => {
    await pg.reset();
    emit.mockClear();
    await pg.client.query(
      `INSERT INTO ${T("assets")} (id, company_id, client_kind, client_ref, name, kind, status, source, created_at) VALUES ('a1', $1, NULL, NULL, 'Hero', 'image', 'draft', 'generated', now())`,
      [CO],
    );
    await pg.client.query(
      `INSERT INTO ${T("asset_versions")} (asset_id, version, company_id, r2_key, mime, bytes, sha256) VALUES ('a1', 1, $1, 'studio/a1/v1.png', 'image/png', 10, 'abc')`,
      [CO],
    );
  });

  it("the harness fails a raw JS array the way the live host did", async () => {
    await expect(pg.db.query(`SELECT 1 AS one WHERE 'draft' = ANY($1::text[])`, [["draft", "rejected"]])).rejects.toThrow();
  });

  it("rejects a draft", async () => {
    const out = await reviewAsset(ctx(), CO, { assetId: "a1", decision: "rejected" }, { userId: "u1" }, deps);
    expect(out).toMatchObject({ changed: true });
    const rows = await pg.client.query(`SELECT status FROM ${T("assets")} WHERE id = 'a1'`);
    expect(rows.rows).toEqual([{ status: "rejected" }]);
  });

  it("approves a draft and emits once", async () => {
    const out = await reviewAsset(ctx(), CO, { assetId: "a1", decision: "approved" }, { userId: "u1" }, deps);
    expect(out).toMatchObject({ changed: true, exported: true });
    expect(emit).toHaveBeenCalledTimes(1);
    const rows = await pg.client.query(`SELECT status FROM ${T("assets")} WHERE id = 'a1'`);
    expect(rows.rows).toEqual([{ status: "approved" }]);
  });

  describe("an agent approving its own asset", () => {
    const status = async () => (await pg.client.query(`SELECT status FROM ${T("assets")} WHERE id = 'a1'`)).rows[0].status;
    const makeBy = (agent: string | null) => pg.client.query(`UPDATE ${T("assets")} SET created_by_agent_id = $1 WHERE id = 'a1'`, [agent]);

    it("is refused, names a reviewer not a person, leaves the status and exports nothing", async () => {
      await makeBy("agentA");
      const err = await reviewAsset(ctx(), CO, { assetId: "a1", decision: "approved" }, { agentId: "agentA" }, deps).catch((e) => e);
      expect(err).toMatchObject({ code: "self_approval" });
      expect(String((err as Error).message)).toMatch(/Reviewer/);
      expect(String((err as Error).message)).not.toMatch(/ask a person|Peet|board/i);
      expect(await status()).toBe("draft");
      expect(emit).not.toHaveBeenCalled();
    });

    it("is refused when only the generation (by asset_id) records the agent", async () => {
      await pg.client.query(
        `INSERT INTO ${T("generations")} (id, group_id, company_id, agent_id, provider, model, prompt, name, status, period, estimated_credits, asset_id) VALUES ('g1', 'g1', $1, 'agentA', 'p', 'm', 'x', 'n', 'done', '2026-11', 1, 'a1')`,
        [CO],
      );
      await expect(reviewAsset(ctx(), CO, { assetId: "a1", decision: "approved" }, { agentId: "agentA" }, deps)).rejects.toMatchObject({ code: "self_approval" });
      expect(await status()).toBe("draft");
      expect(emit).not.toHaveBeenCalled();
    });

    it("may still reject its own asset", async () => {
      await makeBy("agentA");
      const out = await reviewAsset(ctx(), CO, { assetId: "a1", decision: "rejected" }, { agentId: "agentA" }, deps);
      expect(out).toMatchObject({ changed: true });
      expect(await status()).toBe("rejected");
    });

    it("another agent can approve it", async () => {
      await makeBy("agentA");
      const out = await reviewAsset(ctx(), CO, { assetId: "a1", decision: "approved" }, { agentId: "agentB" }, deps);
      expect(out).toMatchObject({ exported: true });
      expect(emit).toHaveBeenCalledTimes(1);
    });

    it("a person can approve an agent's asset", async () => {
      await makeBy("agentA");
      const out = await reviewAsset(ctx(), CO, { assetId: "a1", decision: "approved" }, { userId: "u1" }, deps);
      expect(out).toMatchObject({ exported: true });
    });

    it("an asset with no recorded agent behaves as before", async () => {
      const out = await reviewAsset(ctx(), CO, { assetId: "a1", decision: "approved" }, { agentId: "agentA" }, deps);
      expect(out).toMatchObject({ exported: true });
    });
  });
});
