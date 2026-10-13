// LeaseDb backed by embedded Postgres with drizzle, binding exactly like host plugin-database.ts.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NAMESPACE } from "../../src/namespace.js";
import * as guard from "./sql-guard.js";

const DB_PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../db/node_modules");
const here = path.dirname(fileURLToPath(import.meta.url));

export async function startHostDb() {
  const EmbeddedPostgres = (await import(`${DB_PKG}/embedded-postgres/dist/index.js`)).default;
  const { drizzle } = await import(`${DB_PKG}/drizzle-orm/postgres-js/index.js`);
  const sql = (await import(`${DB_PKG}/drizzle-orm/sql/sql.js`)).sql as any;
  const postgres = (await import(`${DB_PKG}/postgres/src/index.js`)).default;

  const dir = mkdtempSync(path.join(tmpdir(), "tel-host-db-"));
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "t", password: "t", port: 54322, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  const client = postgres({ host: "127.0.0.1", port: 54322, user: "t", password: "t", database: "postgres", onnotice: () => {} });
  const orm = drizzle(client);
  await client.unsafe(`CREATE SCHEMA ${NAMESPACE}`);
  for (const f of readdirSync(path.join(here, "../../migrations")).sort())
    await client.unsafe(readFileSync(path.join(here, "../../migrations", f), "utf8"));

  const bindSql = (stmt: string, params: readonly unknown[] = []) => {
    if (!params.length) return sql.raw(stmt);
    const chunks: any[] = [];
    let c = 0;
    for (const m of stmt.matchAll(/\$(\d+)/g)) {
      chunks.push(sql.raw(stmt.slice(c, m.index)));
      chunks.push(sql`${params[Number(m[1]) - 1]}`);
      c = m.index! + m[0].length;
    }
    return chunks.push(sql.raw(stmt.slice(c))), sql.join(chunks, sql.raw(""));
  };

  return {
    db: {
      async execute(text: string, params: unknown[] = []) {
        guard.validateRuntimeExecute(text, NAMESPACE);
        guard.validateParams(text, params);
        return { rowCount: Number((await orm.execute(bindSql(text, params)) as any).count ?? 0) };
      },
      async query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
        guard.validateRuntimeQuery(text, NAMESPACE);
        guard.validateParams(text, params);
        return JSON.parse(JSON.stringify([...(await orm.execute(bindSql(text, params)) as Iterable<unknown>)])) as T[];
      },
      async unguardedQuery<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
        return JSON.parse(JSON.stringify([...(await orm.execute(bindSql(text, params)) as Iterable<unknown>)])) as T[];
      },
    },
    async reset() { await client.unsafe(`TRUNCATE TABLE ${NAMESPACE}.tel_recordings CASCADE`); },
    async stop() { await client.end(); await pg.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}
