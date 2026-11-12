import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { checkMusicCap, musicUsage } from "../src/music/stable-audio-price.js";
import { overview } from "../src/service.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const CO = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PERIOD = "2026-11";

const available = await embeddedAvailable();
let pg: Pg;
let seq = 0;

beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);
afterAll(async () => {
  if (available) await pg.stop();
});

const ctxOf = (db: unknown = pg.db) =>
  ({
    db,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    state: { get: async () => null, set: async () => undefined, delete: async () => undefined },
    config: { get: async () => ({}) },
    projects: { list: async () => [] },
    agents: { list: async () => [] },
  }) as unknown as PluginContext;

async function row(provider: string, company: string, kind: string, credits: number, period = PERIOD) {
  const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  await pg.db.execute(
    `INSERT INTO ${pg.db.namespace}.generations (id, group_id, company_id, provider, model, prompt, period, estimated_credits) VALUES ($1, $1, $2, $3, 'm', 'p', $4, 1)`,
    [id, company, provider, period],
  );
  await pg.db.execute(`INSERT INTO ${pg.db.namespace}.credit_ledger (generation_id, kind, company_id, period, credits) VALUES ($1, $2, $3, $4, $5)`, [id, kind, company, period, credits]);
}

describe.skipIf(!available)("Stable Audio monthly cap (PAR-10255)", () => {
  beforeEach(async () => {
    await pg.reset();
  });

  it("at 398.72 the next track (1.28) passes; at 399.36 it is refused with provider_cap_reached", async () => {
    await row("stability", CO, "reserve", 398.72);
    await expect(checkMusicCap(ctxOf(), PERIOD)).resolves.toBe(398.72);
    await row("stability", CO, "reserve", 0.64);
    await expect(checkMusicCap(ctxOf(), PERIOD)).rejects.toMatchObject({ code: "provider_cap_reached", message: expect.stringContaining("USD 25") });
  });

  it("sums two companies, ignores Higgsfield and xAI, nets refunds, ignores other months", async () => {
    await row("stability", CO, "reserve", 100);
    await row("stability", OTHER, "reserve", 50);
    await row("higgsfield", CO, "reserve", 999);
    await row("xai", CO, "reserve", 999);
    await row("stability", CO, "reserve", 500, "2026-10");
    expect(await musicUsage(ctxOf(), PERIOD)).toBe(150);
    await row("stability", CO, "refund", -30);
    expect(await musicUsage(ctxOf(), PERIOD)).toBe(120);
  });

  it("fails closed when the usage read throws", async () => {
    const broken = { ...pg.db, query: async () => Promise.reject(new Error("db down")) };
    await expect(checkMusicCap(ctxOf(broken), PERIOD)).rejects.toThrow("db down");
  });

  it("overview reports music usage in dollars, and unknown (with every other field) when the read throws", async () => {
    await row("stability", CO, "reserve", 160);
    const ok = await overview(ctxOf(), CO);
    expect(ok.musicUsage).toMatchObject({ status: "ok", provider: "stability", usedUsd: 10, capUsd: 25, remainingUsd: 15 });
    const flaky = {
      ...pg.db,
      query: (sql: string, params?: unknown[]) => (sql.includes("'stability'") ? Promise.reject(new Error("db down")) : pg.db.query(sql, params as never)),
    };
    const bad = await overview(ctxOf(flaky), CO);
    expect(bad.musicUsage).toEqual({ status: "unknown" });
    const { musicUsage: _a, ...rest } = bad;
    const { musicUsage: _b, ...restOk } = ok;
    expect(Object.keys(rest).sort()).toEqual(Object.keys(restOk).sort());
  });
});
