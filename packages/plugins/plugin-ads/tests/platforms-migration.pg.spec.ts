import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const available = await embeddedAvailable();
let pg: Pg;

beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);

afterAll(async () => {
  if (available) await pg.stop();
});

const OLD_PLATFORMS = ["meta", "google", "mock"];
const NEW_PLATFORMS = ["apple", "tiktok", "amazon", "linkedin"];

// The statements as the code wrote them before 009 (PAR-4100): the same column list, only the platform changes.
const insertConnection = (client: Pg["client"], id: string, platform: string) =>
  client.query(`INSERT INTO ${NAMESPACE}.connections (id, company_id, platform, label) VALUES ($1, 'c', $2, 'label')`, [id, platform]);
const insertAccount = (client: Pg["client"], id: string, platform: string, connectionId: string | null = null) =>
  client.query(
    `INSERT INTO ${NAMESPACE}.ad_accounts (id, company_id, platform, external_id, name, currency, scope_key, connection_id) VALUES ($1, 'c', $2, $3, 'Account', 'USD', 'own', $4)`,
    [id, platform, `ext-${id}`, connectionId],
  );

describe.skipIf(!available)("platform CHECKs (009)", () => {
  beforeEach(async () => {
    await pg.reset();
  });

  it.each(NEW_PLATFORMS)("accepts a %s connection and a %s ad account", async (platform) => {
    await insertConnection(pg.client, `conn-${platform}`, platform);
    await insertAccount(pg.client, `acc-${platform}`, platform, `conn-${platform}`);
    const rows = (await pg.client.query(`SELECT platform FROM ${NAMESPACE}.ad_accounts WHERE id = $1`, [`acc-${platform}`])).rows;
    expect(rows).toEqual([{ platform }]);
  });

  it.each(OLD_PLATFORMS)("the old %s inserts still pass against the new schema", async (platform) => {
    await insertConnection(pg.client, `conn-${platform}`, platform);
    await insertAccount(pg.client, `acc-${platform}`, platform, `conn-${platform}`);
  });

  it("still rejects a platform that is not on the list", async () => {
    await expect(insertConnection(pg.client, "conn-x", "snapchat")).rejects.toThrow(/connections_platform/);
    await expect(insertAccount(pg.client, "acc-x", "snapchat")).rejects.toThrow(/ad_accounts_platform/);
  });

  it("applies over 008 and keeps the rows that were already there", async () => {
    let prev: Pg | null = null;
    try {
      prev = await startPg({ upTo: "008" });
      await insertConnection(prev.client, "conn-old", "meta");
      await insertAccount(prev.client, "acc-old", "google");
      // Before 009 the new platforms are refused.
      await expect(insertConnection(prev.client, "conn-tt", "tiktok")).rejects.toThrow(/connections_platform/);
      await expect(insertAccount(prev.client, "acc-tt", "tiktok")).rejects.toThrow(/ad_accounts_platform/);
      // Apply 009 the way the host does, on top of the seeded rows.
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { PLUGIN_ROOT } = await import("./helpers/pg.js");
      await prev.client.query(readFileSync(join(PLUGIN_ROOT, "migrations", "009_platforms_apple_tiktok_amazon_linkedin.sql"), "utf8"));
      expect((await prev.client.query(`SELECT platform FROM ${NAMESPACE}.connections`)).rows).toEqual([{ platform: "meta" }]);
      expect((await prev.client.query(`SELECT platform FROM ${NAMESPACE}.ad_accounts`)).rows).toEqual([{ platform: "google" }]);
      await insertConnection(prev.client, "conn-tt", "tiktok");
      await insertAccount(prev.client, "acc-tt", "tiktok", "conn-tt");
    } finally {
      if (prev) await prev.stop();
    }
  }, 120_000);
});
