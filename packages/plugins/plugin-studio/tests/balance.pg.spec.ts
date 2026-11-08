import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { balanceView, LOW_BALANCE_USD, markOutOfFunds, setBalance } from "../src/balance.js";
import { creditsIn } from "../src/provider.js";
import { USD_PER_CREDIT } from "../src/seedance-price.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const CO = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const available = await embeddedAvailable();
let pg: Pg;

beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);

afterAll(async () => {
  if (available) await pg.stop();
});

function makeCtx(): PluginContext {
  const store = new Map<string, unknown>();
  const k = (i: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) => `${i.scopeKind}|${i.scopeId}|${i.namespace}|${i.stateKey}`;
  return {
    db: pg.db,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    state: {
      get: async (i: never) => (store.has(k(i)) ? store.get(k(i)) : null),
      set: async (i: never, v: unknown) => void store.set(k(i), v),
      delete: async (i: never) => void store.delete(k(i)),
    },
  } as unknown as PluginContext;
}

async function spend(companyId: string, generationId: string, kind: string, amount: number, at: string) {
  await pg.db.execute(
    `INSERT INTO ${pg.db.namespace}.generations (id, group_id, company_id, provider, model, prompt, period, estimated_credits) VALUES ($1, $1, $2, 'higgsfield', 'm', 'p', '2026-11', 1) ON CONFLICT (id) DO NOTHING`,
    [generationId, companyId],
  );
  await pg.db.execute(
    `INSERT INTO ${pg.db.namespace}.credit_ledger (generation_id, kind, company_id, period, credits, created_at) VALUES ($1, $2, $3, '2026-11', $4, $5)`,
    [generationId, kind, companyId, amount, at],
  );
}

describe("creditsIn", () => {
  it("reads a dollar-only estimate as credits at the credit rate", () => {
    expect(creditsIn({ usd: "0.094" })).toBeCloseTo(0.094 / USD_PER_CREDIT, 4);
    expect(creditsIn({ usd: 0.5625 })).toBe(9);
  });
  it("prefers credits when both are given, and treats 0 or junk dollars as no price", () => {
    expect(creditsIn({ credits: 4, usd: "1" })).toBe(4);
    expect(creditsIn({ usd: "0" })).toBeNull();
    expect(creditsIn({ usd: "abc" })).toBeNull();
    expect(creditsIn({ usd: null })).toBeNull();
  });
});

describe.skipIf(!available)("Higgsfield balance estimate (PAR-8388)", () => {
  let ctx: PluginContext;
  beforeEach(async () => {
    await pg.reset();
    ctx = makeCtx();
  });

  it("is empty until an owner enters a balance", async () => {
    expect(await balanceView(ctx, CO)).toMatchObject({ enteredUsd: null, estimatedUsd: null, low: false, outOfFundsAt: null });
  });

  it("subtracts only this company's ledger rows written since the balance was entered, refunds included", async () => {
    await spend(CO, "g-before", "reserve", 50, "2026-11-08T10:00:00Z");
    await setBalance(ctx, CO, "$87.50", "owner-1", new Date("2026-11-08T12:00:00Z"));
    await spend(CO, "g1", "reserve", 16, "2026-11-08T12:05:00Z");
    await spend(CO, "g2", "reserve", 10, "2026-11-08T12:06:00Z");
    await spend(CO, "g2", "refund", -10, "2026-11-08T12:07:00Z");
    await spend(OTHER, "g3", "reserve", 400, "2026-11-08T12:08:00Z");
    const view = await balanceView(ctx, CO);
    expect(view).toMatchObject({ enteredUsd: 87.5, spentCreditsSince: 16, spentUsdSince: 1, estimatedUsd: 86.5, low: false });
    expect(view.estimatedCredits).toBeCloseTo(86.5 / USD_PER_CREDIT, 2);
  });

  it("warns when the estimate drops below the low mark", async () => {
    await setBalance(ctx, CO, 12, "owner-1", new Date("2026-11-08T12:00:00Z"));
    await spend(CO, "g1", "reserve", 48, "2026-11-08T12:01:00Z"); // $3
    const view = await balanceView(ctx, CO);
    expect(view.estimatedUsd).toBe(9);
    expect(view.estimatedUsd! < LOW_BALANCE_USD && view.low).toBe(true);
  });

  it("shows a 402 until the balance is entered again", async () => {
    await setBalance(ctx, CO, 50, "owner-1", new Date("2026-11-08T12:00:00Z"));
    await markOutOfFunds(ctx, CO, new Date("2026-11-08T13:00:00Z"));
    expect(await balanceView(ctx, CO)).toMatchObject({ outOfFundsAt: "2026-11-08T13:00:00.000Z", low: true });
    await setBalance(ctx, CO, 40, "owner-1", new Date("2026-11-08T14:00:00Z"));
    expect(await balanceView(ctx, CO)).toMatchObject({ outOfFundsAt: null, low: false });
  });

  it("refuses an amount that isn't a dollar figure", async () => {
    for (const bad of ["", "abc", -1, null, 1_000_000]) {
      await expect(setBalance(ctx, CO, bad, "owner-1")).rejects.toMatchObject({ code: "bad_balance" });
    }
  });
});
