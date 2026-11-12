import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { deleteJunkAccounts } from "../src/db.js";
import { deleteAccountRecord, markPostPostedRecord, postAnalyticsRecord, type Viewer } from "../src/service.js";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));
const EMBEDDED = fileURLToPath(new URL("../../../db/node_modules/embedded-postgres/dist/index.js", import.meta.url));
const available = await import(EMBEDDED).then(() => true, () => false);

type PgClient = { query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>; connect: () => Promise<void>; end: () => Promise<void> };
const viewer: Viewer = { companyId: "co", userId: "u1", agentId: null, runId: null, isAgent: false };
const T = (name: string) => `${NAMESPACE}.${name}`;

describe.skipIf(!available)("mark-posted X link and post-analytics measurable (postgres)", () => {
  let client: PgClient;
  let stop: () => Promise<void>;
  let ctx: PluginContext;
  const q = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;
  const dest = async (id: string) => (await q(`SELECT status, external_id, external_url, metric_windows, result, last_error, published_at FROM ${T("destinations")} WHERE id = $1`, [id]))[0]!;
  const post = async () => (await q(`SELECT status, error, published_at FROM ${T("posts")} WHERE id = 'p1'`))[0]!;

  beforeAll(async () => {
    const { default: EmbeddedPostgres } = (await import(EMBEDDED)) as { default: new (o: Record<string, unknown>) => { initialise: () => Promise<void>; start: () => Promise<void>; stop: () => Promise<void>; getPgClient: () => PgClient } };
    const { createServer } = await import("node:net");
    const port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
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
      manifest: { id: "partnersinbiz.social" },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
      db: {
        namespace: NAMESPACE,
        execute: async (sql: string, params: unknown[] = []) => ({ rowCount: (await client.query(sql, params)).rowCount ?? 0 }),
        query: async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows,
      },
    } as unknown as PluginContext;
    stop = async () => (await client.end(), await pg.stop(), rmSync(dir, { recursive: true, force: true }));
  }, 90_000);
  afterAll(async () => void (await stop?.()));

  beforeEach(async () => {
    await client.query(`DELETE FROM ${T("destinations")}; DELETE FROM ${T("posts")}; DELETE FROM ${T("accounts")}`);
    await client.query(`INSERT INTO ${T("accounts")} (id, company_id, platform, scope, display_name, handle, status, token_enc) VALUES
      ('ax', 'co', 'x', 'org', 'X', 'PeetStander', 'disabled', NULL),
      ('ax2', 'co', 'x', 'org', 'X2', 'other', 'connected', 'enc'),
      ('ax3', 'co', 'x', 'org', 'X3', 'peetstander', 'connected', 'enc'),
      ('afb', 'co', 'facebook', 'org', 'FB', 'page', 'connected', 'enc')`);
  });

  async function seed(postStatus: string, rows: Array<{ id: string; account: string; status: string; externalId?: string | null; result?: Record<string, unknown> }>) {
    await client.query(`INSERT INTO ${T("posts")} (id, company_id, body, status, error, published_at) VALUES ('p1', 'co', 'x', $1, $2, $3)`, [
      postStatus, postStatus === "published" ? "first comment failed" : null, postStatus === "published" ? "2026-11-05T10:00:00Z" : null,
    ]);
    for (const r of rows) {
      await client.query(
        `INSERT INTO ${T("destinations")} (id, company_id, post_id, account_id, status, external_id, result, metric_windows, published_at)
         VALUES ($1, 'co', 'p1', $2, $3, $4, $5::jsonb, $6, $7)`,
        [r.id, r.account, r.status, r.externalId ?? null, JSON.stringify(r.result ?? {}), r.status === "published" ? ["1h", "24h"] : [], r.status === "published" ? "2026-11-05T10:00:00Z" : null],
      );
    }
  }
  const mark = (url?: string) => markPostPostedRecord(ctx, viewer, { postId: "p1", ...(url ? { url } : {}) });

  describe("mode A: unpublished post", () => {
    const cases: Array<[string, string, string | null]> = [
      ["x.com link of the account handle stores the id", "https://x.com/peetstander/status/1854000000000000001", "1854000000000000001"],
      ["twitter.com link stores the id", "https://twitter.com/PeetStander/status/1854000000000000002?s=20", "1854000000000000002"],
      ["another handle stores null", "https://x.com/someoneelse/status/1854000000000000003", null],
      ["x.com/i/status stores null", "https://x.com/i/status/1854000000000000004", null],
      ["a non-status link stores null", "https://x.com/PeetStander", null],
    ];
    for (const [name, url, expected] of cases) {
      it(name, async () => {
        await seed("failed", [{ id: "d1", account: "ax", status: "failed" }]);
        await mark(url);
        expect(await dest("d1")).toMatchObject({ status: "published", external_id: expected, external_url: url });
        expect((await post()).status).toBe("published");
      });
    }
    it("a non-X destination stores null", async () => {
      await seed("failed", [{ id: "d1", account: "afb", status: "failed" }]);
      await mark("https://x.com/PeetStander/status/1854000000000000005");
      expect(await dest("d1")).toMatchObject({ external_id: null });
    });
  });

  describe("mode B: attach a link to a published post", () => {
    const url = "https://x.com/PeetStander/status/1854000000000000009";
    it("changes the hand-marked null-id row; leaves API-published rows and the post alone", async () => {
      await seed("published", [
        { id: "dm", account: "ax", status: "published", result: { ok: true, manual: true } },
        { id: "dapi", account: "ax3", status: "published", externalId: "1700", result: { ok: true } },
        { id: "dfb", account: "afb", status: "published", externalId: "page_1", result: { ok: true } },
      ]);
      const before = { post: await post(), dapi: await dest("dapi"), dfb: await dest("dfb"), dm: await dest("dm") };
      await mark(url);
      const after = await dest("dm");
      expect(after).toMatchObject({ external_id: "1854000000000000009", external_url: url, metric_windows: [], status: "published", last_error: null });
      expect(after.result).toEqual(before.dm.result);
      expect(after.published_at).toEqual(before.dm.published_at);
      expect(await dest("dapi")).toEqual(before.dapi);
      expect(await dest("dfb")).toEqual(before.dfb);
      expect(await post()).toEqual(before.post);
    });
    it("without a url still throws", async () => {
      await seed("published", [{ id: "dm", account: "ax", status: "published", result: { manual: true } }]);
      await expect(mark()).rejects.toThrow("A published post cannot be marked as posted");
    });
    it("throws when no destination accepts the link", async () => {
      await seed("published", [{ id: "dm", account: "ax", status: "published", result: { manual: true } }]);
      await expect(mark("https://x.com/someoneelse/status/1854000000000000010")).rejects.toThrow("No hand-marked destination on this post accepts this link");
      expect((await dest("dm")).external_id).toBeNull();
    });
  });

  it("post-analytics marks each destination measurable or not, with the reason", async () => {
    await seed("published", [
      { id: "dm", account: "ax2", status: "published", result: { manual: true } },
      { id: "ddis", account: "ax", status: "published", externalId: "1701" },
      { id: "dok", account: "afb", status: "published", externalId: "page_2" },
    ]);
    const out = (await postAnalyticsRecord(ctx, viewer, { postId: "p1" })) as { destinations: Array<{ destinationId: string; measurable: boolean; unmeasuredReason: string | null }> };
    const by = Object.fromEntries(out.destinations.map((d) => [d.destinationId, d]));
    expect(by.dm).toMatchObject({ measurable: false, unmeasuredReason: "no external id (marked posted by hand without a link)" });
    expect(by.ddis).toMatchObject({ measurable: false, unmeasuredReason: "account disabled or disconnected" });
    expect(by.dok).toMatchObject({ measurable: true, unmeasuredReason: null });
  });

  describe("deleting an account keeps the record of what a post published (PAR-10115)", () => {
    const destinationIds = async () => (await q(`SELECT id FROM ${T("destinations")} WHERE post_id = 'p1' ORDER BY id`)).map((r) => r.id);
    const accountExists = async (id: string) => (await q(`SELECT 1 FROM ${T("accounts")} WHERE id = $1`, [id])).length === 1;

    it("refuses to delete a disconnected account with a hand-marked published destination; post-analytics still lists it", async () => {
      await seed("published", [{ id: "dm", account: "ax", status: "published", result: { manual: true } }]);
      await expect(deleteAccountRecord(ctx, viewer, "ax")).rejects.toThrow(/X has 1 published post\. Deleting it would erase/);
      expect(await accountExists("ax")).toBe(true);
      expect(await destinationIds()).toEqual(["dm"]);
      const out = (await postAnalyticsRecord(ctx, viewer, { postId: "p1" })) as { destinations: Array<{ destinationId: string; measurable: boolean; unmeasuredReason: string | null }> };
      expect(out.destinations).toEqual([expect.objectContaining({ destinationId: "dm", measurable: false, unmeasuredReason: "no external id (marked posted by hand without a link)" })]);
    });

    it("still deletes a disconnected account whose destinations never published", async () => {
      await seed("failed", [{ id: "df", account: "ax", status: "failed" }]);
      expect(await deleteAccountRecord(ctx, viewer, "ax")).toEqual({ accountId: "ax", deleted: true });
      expect(await accountExists("ax")).toBe(false);
      expect(await destinationIds()).toEqual([]);
    });

    it("the junk-account sweep skips an account with a published destination", async () => {
      await client.query(`INSERT INTO ${T("accounts")} (id, company_id, platform, scope, display_name, status, token_enc) VALUES
        ('ajunk', 'co', 'x', 'org', 'Junk', 'needs_reconnect', NULL), ('ajunk2', 'co', 'x', 'org', 'Junk2', 'needs_reconnect', NULL)`);
      await seed("published", [{ id: "dj", account: "ajunk", status: "published", externalId: "1702" }]);
      expect(await deleteJunkAccounts(ctx, "co")).toBe(1);
      expect([await accountExists("ajunk"), await accountExists("ajunk2")]).toEqual([true, false]);
      expect(await destinationIds()).toEqual(["dj"]);
    });
  });
});
