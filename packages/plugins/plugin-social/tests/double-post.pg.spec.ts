import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { samePostOnAccounts } from "../src/validate.js";
import { NAMESPACE } from "../src/namespace.js";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));
const EMBEDDED = fileURLToPath(new URL("../../../db/node_modules/embedded-postgres/dist/index.js", import.meta.url));
const available = await import(EMBEDDED).then(() => true, () => false);

type PgClient = { query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>; connect: () => Promise<void>; end: () => Promise<void> };

describe.skipIf(!available)("double-post guard (postgres)", () => {
  let client: PgClient;
  let stop: () => Promise<void>;
  let ctx: PluginContext;

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
      logger: { info: (m: string, d: unknown) => console.log(m, d), warn: () => {}, error: () => {} },
    } as unknown as PluginContext;
    const q = (sql: string) => client.query(sql);
    await q(`INSERT INTO ${NAMESPACE}.accounts (id, company_id, platform, scope, display_name) VALUES ('fb', 'co', 'facebook', 'org', 'PIB'), ('ig', 'co', 'instagram', 'org', '@pib'), ('li', 'co', 'linkedin', 'org', 'Peet')`);
    const body = "1.4 seconds. That is how fast a Pretoria law firm's site loads on a phone.";
    await q(`INSERT INTO ${NAMESPACE}.posts (id, company_id, body, status, scheduled_at) VALUES
      ('kept', 'co', '${body} utm=linkedin', 'scheduled', '2026-11-18T06:00:00Z'),
      ('copy', 'co', '${body.replace("'", "''")} utm=facebook', 'review', '2026-11-18T06:00:00Z'),
      ('other-account', 'co', '${body.replace("'", "''")}', 'review', '2026-11-18T06:00:00Z'),
      ('far', 'co', '${body.replace("'", "''")}', 'review', '2026-11-25T06:00:00Z'),
      ('fresh', 'co', 'A different post that shares nothing with it at all.', 'review', '2026-11-18T06:00:00Z')`.replace("'1.4 seconds. That is how fast a Pretoria law firm's site", "'1.4 seconds. That is how fast a Pretoria law firm''s site"));
    await q(`INSERT INTO ${NAMESPACE}.destinations (id, company_id, post_id, account_id) VALUES
      ('d1', 'co', 'kept', 'fb'), ('d2', 'co', 'kept', 'ig'), ('d3', 'co', 'kept', 'li'),
      ('d4', 'co', 'copy', 'fb'), ('d5', 'co', 'copy', 'ig'),
      ('d6', 'co', 'other-account', 'li'),
      ('d7', 'co', 'far', 'fb'), ('d8', 'co', 'fresh', 'fb')`);

    stop = async () => {
      await client.end();
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    };
  }, 90_000);
  afterAll(async () => {
    await stop?.();
  });

  const post = async (id: string) => (await client.query(`SELECT * FROM ${NAMESPACE}.posts WHERE id = $1`, [id])).rows[0] as never;

  it("refuses a second copy on an account the scheduled copy already posts to", async () => {
    const problems = await samePostOnAccounts(ctx, "co", await post("copy"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("kept");
    expect(problems[0]).toContain("post it twice");
  });

  it("flags a shared account even when one is only LinkedIn", async () => {
    expect(await samePostOnAccounts(ctx, "co", await post("other-account"))).toHaveLength(1);
  });

  it("allows the same words a week later, and a different post at the same time", async () => {
    expect(await samePostOnAccounts(ctx, "co", await post("far"))).toEqual([]);
    expect(await samePostOnAccounts(ctx, "co", await post("fresh"))).toEqual([]);
  });

  it("ignores an archived copy", async () => {
    await client.query(`UPDATE ${NAMESPACE}.posts SET archived_at = now() WHERE id = 'kept'`);
    expect(await samePostOnAccounts(ctx, "co", await post("copy"))).toEqual([]);
  });
});
