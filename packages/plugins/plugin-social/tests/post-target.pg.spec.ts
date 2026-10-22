import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertPost, updatePostContent } from "../src/db.js";
import { NAMESPACE } from "../src/namespace.js";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));
const EMBEDDED = fileURLToPath(new URL("../../../db/node_modules/embedded-postgres/dist/index.js", import.meta.url));
const available = await import(EMBEDDED).then(() => true, () => false);

type PgClient = { query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>; connect: () => Promise<void>; end: () => Promise<void> };

describe.skipIf(!available)("reply / quote / note columns (postgres)", () => {
  let client: PgClient;
  let stop: () => Promise<void>;
  let ctx: PluginContext;
  const row = async () => (await client.query(`SELECT reply_to_url, quote_url, note, body FROM ${NAMESPACE}.posts WHERE id = 'p1'`)).rows[0];

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
    await insertPost(ctx, {
      id: "p1", company_id: "co", body: "Agreed.", overrides: {}, media: [], status: "draft", scope: "org", owner_user_id: null, first_comment: null,
      client_kind: null, client_ref: null, client_name: null, source: "agent", source_ref: null, created_by_agent_id: null,
      reply_to_url: "https://x.com/peet/status/42", note: "HOLD until PAR-1",
    } as never);
    stop = async () => {
      await client.end();
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    };
  }, 90_000);
  afterAll(async () => {
    await stop?.();
  });

  it("stores the target and note on insert", async () => {
    expect(await row()).toMatchObject({ reply_to_url: "https://x.com/peet/status/42", quote_url: null, note: "HOLD until PAR-1" });
  });

  it("keeps every field that is not passed", async () => {
    await updatePostContent(ctx, "co", "p1", { body: "Edited." });
    expect(await row()).toMatchObject({ body: "Edited.", reply_to_url: "https://x.com/peet/status/42", note: "HOLD until PAR-1" });
  });

  it("clears the note and keeps the reply, then swaps the reply for a quote", async () => {
    await updatePostContent(ctx, "co", "p1", { note: null });
    expect(await row()).toMatchObject({ reply_to_url: "https://x.com/peet/status/42", note: null });
    await updatePostContent(ctx, "co", "p1", { replyToUrl: null, quoteUrl: "https://x.com/anna/status/77" });
    expect(await row()).toMatchObject({ reply_to_url: null, quote_url: "https://x.com/anna/status/77" });
  });

  it("does not touch another company's post", async () => {
    expect(await updatePostContent(ctx, "other", "p1", { quoteUrl: null })).toBe(0);
    expect(await row()).toMatchObject({ quote_url: "https://x.com/anna/status/77" });
  });
});
