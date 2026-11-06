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
});
