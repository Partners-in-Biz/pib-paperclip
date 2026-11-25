import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerCanvasCards } from "@partnersinbiz/pib-plugin-kit";
import { createPostCardKind } from "../src/canvas-cards.js";
import { insertPost, listPosts } from "../src/db.js";
import { NAMESPACE } from "../src/namespace.js";
import { getPostDetail, listPostsRecord } from "../src/service.js";
import type { Viewer } from "../src/service.js";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));
const EMBEDDED = fileURLToPath(new URL("../../../db/node_modules/embedded-postgres/dist/index.js", import.meta.url));
const available = await import(EMBEDDED).then(() => true, () => false);

type PgClient = { query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>; connect: () => Promise<void>; end: () => Promise<void> };

type Handler = (params: Record<string, unknown>, context: PluginPerformActionContext) => Promise<unknown>;
const CO = "co1";
const ANN = "user-ann";
const BOB = "user-bob";
const viewerOf = (userId: string, companyId = CO): Viewer => ({ companyId, userId, agentId: null, runId: null, isAgent: false });

function actor(userId: string, restricted = false, companyId = CO): PluginPerformActionContext {
  return { companyId, actor: { type: "user", userId, agentId: null, runId: null, companyId, onBehalfOfUserId: userId, onBehalfOfRestricted: restricted } } as PluginPerformActionContext;
}

const post = (id: string, body: string, over: Record<string, unknown> = {}) => ({
  id, company_id: CO, body, overrides: {}, media: [], status: "draft" as const, scope: "org" as const, owner_user_id: null, first_comment: null,
  client_kind: null, client_ref: null, client_name: null, source: "agent", source_ref: null, created_by_agent_id: null, ...over,
});

describe.skipIf(!available)("canvas post cards (postgres)", () => {
  let client: PgClient;
  let stop: () => Promise<void>;
  let ctx: PluginContext;
  const handlers = new Map<string, Handler>();

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
      logger: { info: () => undefined },
    } as unknown as PluginContext;
    await seed();
    stop = async () => {
      await client.end();
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    };
  }, 90_000);
  afterAll(async () => {
    await stop?.();
  });

  async function seed() {
    for (const [id, co, name, deleted] of [["c1", CO, "Acme", false], ["c2", CO, "Beta", false], ["c3", "co2", "Other co client", false], ["c4", CO, "Gone", true]] as const) {
      await client.query(`INSERT INTO ${NAMESPACE}.crm_companies (id, company_id, name, updated_at, deleted) VALUES ($1, $2, $3, now(), $4)`, [id, co, name, deleted]);
    }
    const rows = [
      post("own1", "Spring sale launch\nsecond line"),
      post("acme1", "Spring promo for Acme", { client_kind: "company", client_ref: "c1", client_name: "Acme" }),
      post("acme2", "Acme summer teaser", { client_kind: "company", client_ref: "c1", client_name: "Acme" }),
      post("beta1", "Spring offer for Beta", { client_kind: "company", client_ref: "c2", client_name: "Beta" }),
      post("ann-private", "spring private note", { scope: "personal", owner_user_id: ANN }),
      post("bob-private", "spring bob private", { scope: "personal", owner_user_id: BOB }),
      post("pct", "100% off_sale 50\\ today"),
      post("other-co", "Spring other company", { company_id: "co2" }),
      post("gone1", "Spring deleted soon"),
    ];
    for (const row of rows) await insertPost(ctx, row as never);
    await client.query(`DELETE FROM ${NAMESPACE}.posts WHERE id = 'gone1'`);
    registerCanvasCards({ register: (key, handler) => void handlers.set(key, handler as Handler), kinds: [createPostCardKind(ctx)] });
  }

  const call = (key: string, params: Record<string, unknown>, who: PluginPerformActionContext) => handlers.get(key)!(params, who) as Promise<{ cards?: Array<Record<string, unknown>>; groups?: Array<{ relation: string; cards: Array<{ id: string }> }> } & Record<string, unknown>>;
  const resolve = (ids: string[], who: PluginPerformActionContext) => call("canvas.cards.resolve", { items: ids.map((id) => ({ type: "card-post", id })) }, who);
  const search = async (q: string, who: PluginPerformActionContext) => ((await call("canvas.cards.search", { type: "card-post", q }, who)).cards ?? []).map((c) => c.id as string).sort();
  const related = (id: string, who: PluginPerformActionContext) => call("canvas.cards.related", { of: { plugin: "partnersinbiz.crm", type: "card-company", id } }, who);
  const pageDetail = async (userId: string, id: string) => getPostDetail(ctx, viewerOf(userId), id).then(() => true, () => false);
  const pageList = async (userId: string, params: Record<string, unknown>) => (await listPostsRecord(ctx, viewerOf(userId), params)).map((r) => r.id).sort();

  it("SQL: listPosts with q matches the body case-insensitively and takes % _ and a backslash literally", async () => {
    const ids = async (q: string) => (await listPosts(ctx, CO, { q })).map((r) => r.id).sort();
    expect(await ids("SPRING")).toEqual(["acme1", "beta1", "own1"]);
    expect(await ids("100% off_sale")).toEqual(["pct"]);
    expect(await ids("%")).toEqual(["pct"]);
    expect(await ids("_")).toEqual(["pct"]);
    expect(await ids("50\\")).toEqual(["pct"]);
    expect(await ids("   ")).toHaveLength(5);
    expect((await listPosts(ctx, CO, { q: "spring", scope: { kind: "company", id: "c1" } })).map((r) => r.id)).toEqual(["acme1"]);
    expect((await listPosts(ctx, CO, { q: "spring", limit: 1 }))).toHaveLength(1);
  });

  it("hides another company's id, an unknown id and a deleted post, for every caller", async () => {
    for (const who of [actor(ANN), actor(BOB)]) {
      const out = await resolve(["other-co", "nope", "gone1", "own1"], who);
      expect(out.cards).toMatchObject([{ hidden: true }, { hidden: true }, { hidden: true }, { id: "own1", type: "card-post", title: "Spring sale launch" }]);
    }
  });

  it("a second person never sees the first person's personal post; the owner does", async () => {
    expect((await resolve(["ann-private"], actor(BOB))).cards).toMatchObject([{ hidden: true }]);
    expect((await resolve(["ann-private"], actor(ANN))).cards).toMatchObject([{ id: "ann-private" }]);
  });

  it("resolve agrees with the page's detail action record by record (admin, plain member, refused member)", async () => {
    const ids = ["own1", "acme1", "ann-private", "bob-private", "other-co", "gone1", "nope"];
    for (const userId of [ANN, BOB]) {
      const out = (await resolve(ids, actor(userId))).cards!;
      for (const [i, id] of ids.entries()) expect(out[i]!.hidden !== true, `${userId} ${id}`).toBe(await pageDetail(userId, id));
    }
    expect((await resolve(ids, actor(ANN, true))).cards!.every((c) => c.hidden === true)).toBe(true);
  });

  it("search equals the page's lists (own work plus each client) for the same person and text; a refused member gets nothing", async () => {
    for (const userId of [ANN, BOB]) {
      const pageIds = [...(await pageList(userId, { q: "spring" })), ...(await pageList(userId, { q: "spring", client: "company:c1" })), ...(await pageList(userId, { q: "spring", client: "company:c2" }))].sort();
      expect(await search("spring", actor(userId))).toEqual(pageIds);
    }
    expect(await search("spring", actor(ANN, true))).toEqual([]);
  });

  it("related answers a CRM client with its posts and equals the page's list for that client", async () => {
    for (const userId of [ANN, BOB]) {
      const out = await related("c1", actor(userId));
      expect(out.groups).toHaveLength(1);
      expect(out.groups![0]!.cards.map((c) => c.id).sort()).toEqual(await pageList(userId, { client: "company:c1" }));
    }
    expect((await related("c1", actor(ANN, true))).groups ?? []).toEqual([]);
  });

  it("related with an `of` the caller cannot see in CRM (another company's, deleted, unknown) answers nothing", async () => {
    for (const id of ["c3", "c4", "missing"]) expect((await related(id, actor(ANN))).groups ?? []).toEqual([]);
  });

  it("cards link to the client's Social page", async () => {
    const [acme, own] = (await resolve(["acme1", "own1"], actor(ANN))).cards!;
    expect(acme).toMatchObject({ href: "/social?client=company:c1", subtitle: "Acme", status: "draft" });
    expect(own).toMatchObject({ href: "/social", subtitle: "Own work" });
  });
});

