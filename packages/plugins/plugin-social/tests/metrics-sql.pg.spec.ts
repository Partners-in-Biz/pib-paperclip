import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearDestinationMetricsError, insertMetrics, setDestinationMetricsError } from "../src/db.js";
import { NAMESPACE } from "../src/namespace.js";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));
const EMBEDDED = fileURLToPath(new URL("../../../db/node_modules/embedded-postgres/dist/index.js", import.meta.url));
const available = await import(EMBEDDED).then(() => true, () => false);

type PgClient = { query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>; connect: () => Promise<void>; end: () => Promise<void> };

describe.skipIf(!available)("metrics conflict-fill and metricsError (postgres)", () => {
  let client: PgClient;
  let stop: () => Promise<void>;
  let ctx: PluginContext;
  const base = { companyId: "co", postId: "p1", destinationId: "d1", accountId: "a1", platform: "facebook", window: "1h", likes: 1, comments: 0, shares: 0 };
  const metric = async () => (await client.query(`SELECT impressions, reach, clicks, saves, views, raw FROM ${NAMESPACE}.post_metrics WHERE destination_id = 'd1' AND metric_window = '1h'`)).rows;
  const dest = async () => (await client.query(`SELECT result FROM ${NAMESPACE}.destinations WHERE id = 'd1'`)).rows[0]!.result as Record<string, unknown>;

  beforeAll(async () => {
    const { default: EmbeddedPostgres } = (await import(EMBEDDED)) as { default: new (o: Record<string, unknown>) => { initialise: () => Promise<void>; start: () => Promise<void>; stop: () => Promise<void>; getPgClient: () => PgClient } };
    const { createServer } = await import("node:net");
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const dir = mkdtempSync(join(tmpdir(), "social-pg-"));
    const pg = new EmbeddedPostgres({ databaseDir: dir, user: "t", password: "t", port, persistent: false, onLog: () => {}, onError: () => {} });
    await pg.initialise();
    await pg.start();
    client = pg.getPgClient();
    await client.connect();
    await client.query(`CREATE SCHEMA ${NAMESPACE}`);
    for (const f of readdirSync(MIGRATIONS).sort()) await client.query(readFileSync(join(MIGRATIONS, f), "utf8"));
    ctx = {
      db: {
        namespace: NAMESPACE,
        execute: async (sql: string, params: unknown[] = []) => ({ rowCount: (await client.query(sql, params)).rowCount ?? 0 }),
        query: async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows,
      },
    } as unknown as PluginContext;
    await client.query(`INSERT INTO ${NAMESPACE}.accounts (id, company_id, platform, scope, display_name) VALUES ('a1', 'co', 'facebook', 'org', 'A')`);
    await client.query(`INSERT INTO ${NAMESPACE}.posts (id, company_id, body) VALUES ('p1', 'co', 'x')`);
    await client.query(`INSERT INTO ${NAMESPACE}.destinations (id, company_id, post_id, account_id, status, result) VALUES ('d1', 'co', 'p1', 'a1', 'published', '{"firstCommentError":"nope"}'::jsonb)`);
    stop = async () => {
      await client.end();
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    };
  }, 90_000);
  afterAll(async () => {
    await stop?.();
  });

  it("inserts, fills only null columns, then reports unchanged", async () => {
    expect(await insertMetrics(ctx, { ...base, views: 0, impressions: null, reach: null, clicks: 3, saves: null })).toBe("inserted");
    expect(await insertMetrics(ctx, { ...base, views: 9, impressions: 100, reach: 50, clicks: 99, saves: 4 })).toBe("filled");
    const [row] = await metric();
    expect(row).toMatchObject({ impressions: 100, reach: 50, clicks: 3, saves: 4, views: 9 });
    expect(row!.raw).toHaveProperty("filledAt");
    expect(await insertMetrics(ctx, { ...base, views: 1, impressions: 7, reach: 7, clicks: 7, saves: 7 })).toBe("unchanged");
  });

  it("a non-null impressions survives a later insert", async () => {
    await client.query(`UPDATE ${NAMESPACE}.post_metrics SET reach = NULL WHERE destination_id = 'd1'`);
    expect(await insertMetrics(ctx, { ...base, views: 1, impressions: 555, reach: 60, clicks: 1, saves: 1 })).toBe("filled");
    expect((await metric())[0]).toMatchObject({ impressions: 100, reach: 60 });
  });

  it("setDestinationMetricsError keeps firstCommentError; clear removes only its key", async () => {
    await setDestinationMetricsError(ctx, "d1", { at: "t", window: "1h", kind: "insights", message: "m" });
    expect(await dest()).toMatchObject({ firstCommentError: "nope", metricsError: { kind: "insights", message: "m" } });
    await clearDestinationMetricsError(ctx, "d1");
    expect(await dest()).toEqual({ firstCommentError: "nope" });
  });
});
