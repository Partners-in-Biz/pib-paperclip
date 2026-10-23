/**
 * A real Postgres (embedded-postgres from the monorepo) for testing kit migrations.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "./free-port.js";

const here = fileURLToPath(new URL(".", import.meta.url));
export const PLUGIN_KIT_ROOT = join(here, "../..");
const EMBEDDED = join(PLUGIN_KIT_ROOT, "../../db/node_modules/embedded-postgres/dist/index.js");

type PgClient = { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>; connect: () => Promise<void>; end: () => Promise<void> };

export async function embeddedAvailable(): Promise<boolean> {
  try {
    await import(EMBEDDED);
    return true;
  } catch {
    return false;
  }
}

export interface Pg {
  client: PgClient;
  /** Reset all tables in the given namespace. */
  reset: (namespace: string) => Promise<void>;
  stop: () => Promise<void>;
}

export async function startPg(): Promise<Pg> {
  const { default: EmbeddedPostgres } = (await import(EMBEDDED)) as { default: new (opts: Record<string, unknown>) => { initialise: () => Promise<void>; start: () => Promise<void>; stop: () => Promise<void>; getPgClient: () => PgClient } };
  const dir = mkdtempSync(join(tmpdir(), "kit-pg-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "t", password: "t", port, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  const client = pg.getPgClient();
  await client.connect();
  await client.query("SET TIME ZONE 'UTC'");

  return {
    client,
    async reset(namespace: string) {
      const tables = (await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = '${namespace}'`)).rows as Array<{ table_name: string }>;
      if (tables.length) await client.query(`TRUNCATE ${tables.map((t) => `${namespace}.${t.table_name}`).join(", ")} CASCADE`);
    },
    async stop() {
      await client.end();
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
