/** 0.13.0 on real Postgres: a picture that was on another post is found, and the hook board adds up tagged posts. */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MEDIA_REUSE_DAYS, reusedMedia } from "../src/approval-flow.js";
import { getPost } from "../src/db.js";
import { hookBoard } from "../src/hook-board.js";
import { NAMESPACE } from "../src/namespace.js";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));
const EMBEDDED = fileURLToPath(new URL("../../../db/node_modules/embedded-postgres/dist/index.js", import.meta.url));
const available = await import(EMBEDDED).then(() => true, () => false);

type PgClient = { query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>; connect: () => Promise<void>; end: () => Promise<void> };
const T = (name: string) => `${NAMESPACE}.${name}`;
const IMG = (name: string, assetId: string | null = null) => ({ url: `https://cdn.example/${name}.png`, kind: "image", mime: "image/png", ...(assetId ? { assetId } : {}) });

describe.skipIf(!available)("reused media and the hook board (postgres)", () => {
  let client: PgClient;
  let stop: () => Promise<void>;
  let ctx: PluginContext;

  beforeAll(async () => {
    const { default: EmbeddedPostgres } = (await import(EMBEDDED)) as { default: new (o: Record<string, unknown>) => { initialise: () => Promise<void>; start: () => Promise<void>; stop: () => Promise<void>; getPgClient: () => PgClient } };
    const { createServer } = await import("node:net");
    const port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
    });
    const dir = mkdtempSync(join(tmpdir(), "social-focus-pg-"));
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
    await client.query(`DELETE FROM ${T("post_metrics")}; DELETE FROM ${T("destinations")}; DELETE FROM ${T("posts")}; DELETE FROM ${T("accounts")}`);
    await client.query(`INSERT INTO ${T("accounts")} (id, company_id, platform, scope, display_name) VALUES ('fb', 'co', 'facebook', 'org', 'FB'), ('li', 'co', 'linkedin', 'org', 'LI')`);
  });

  const on = async (postId: string, ...accountIds: string[]) => {
    for (const a of accountIds) await client.query(`INSERT INTO ${T("destinations")} (id, company_id, post_id, account_id, status, result) VALUES ($1, 'co', $2, $3, 'pending', '{}'::jsonb)`, [`${postId}-${a}`, postId, a]);
    return (await getPost(ctx, "co", postId))!;
  };

  async function post(id: string, input: { status?: string; media?: unknown[]; tags?: string[]; body?: string; clientRef?: string | null; scope?: string; owner?: string | null; experimentId?: string | null; createdDaysAgo?: number; publishedDaysAgo?: number | null }) {
    await client.query(
      `INSERT INTO ${T("posts")} (id, company_id, body, overrides, media, status, scope, owner_user_id, client_kind, client_ref, experiment_id, created_at, published_at)
       VALUES ($1, 'co', $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9, $10, now() - make_interval(days => $11), CASE WHEN $12::int IS NULL THEN NULL ELSE now() - make_interval(days => $12::int) END)`,
      [id, input.body ?? `Body of ${id}`, JSON.stringify(input.tags ? { tags: input.tags } : {}), JSON.stringify(input.media ?? []), input.status ?? "review", input.scope ?? "org", input.owner ?? null,
        input.clientRef ? "company" : null, input.clientRef ?? null, input.experimentId ?? null, input.createdDaysAgo ?? 1, input.publishedDaysAgo ?? null],
    );
    return (await getPost(ctx, "co", id))!;
  }

  async function metric(postId: string, destination: string, values: { reach?: number; impressions?: number; views?: number; likes?: number; comments?: number; clicks?: number }, window = "7d") {
    await client.query(
      `INSERT INTO ${T("post_metrics")} (id, company_id, post_id, destination_id, account_id, platform, metric_window, views, likes, comments, shares, impressions, reach, saves, clicks)
       VALUES ($1, 'co', $2, $3, 'acc', 'facebook', $4, $5, $6, $7, 0, $8, $9, 0, $10)`,
      [`${destination}-${window}`, postId, destination, window, values.views ?? 0, values.likes ?? 0, values.comments ?? 0, values.impressions ?? null, values.reach ?? null, values.clicks ?? 0],
    );
  }

  it("finds a picture another post of the same scope already carries, by address or by asset", async () => {
    await post("old", { status: "published", media: [IMG("card", "asset-1")], body: "Small firms run out of time" });
    await post("other", { status: "scheduled", media: [{ ...IMG("renamed"), assetId: "asset-2" }] });
    const byUrl = await post("new1", { media: [IMG("card")] });
    expect(await reusedMedia(ctx, "co", byUrl)).toEqual([{ kind: "image", day: expect.stringMatching(/^\d{4}-\d\d-\d\d$/), excerpt: "Small firms run out of time" }]);
    const byAsset = await post("new2", { media: [{ ...IMG("another-address"), assetId: "asset-2" }] });
    expect(await reusedMedia(ctx, "co", byAsset)).toHaveLength(1);
    const fresh = await post("new3", { media: [IMG("made-for-this-post")] });
    expect(await reusedMedia(ctx, "co", fresh)).toEqual([]);
    expect(await reusedMedia(ctx, "co", await post("text", { media: [] }))).toEqual([]);
  });

  it("does not count drafts, old posts, other scopes, or the other arm of the same experiment", async () => {
    await post("draft", { status: "draft", media: [IMG("a")] });
    await post("ancient", { status: "published", media: [IMG("b")], createdDaysAgo: MEDIA_REUSE_DAYS + 5 });
    await post("client", { status: "published", media: [IMG("c")], clientRef: "c1" });
    await post("mine", { status: "published", media: [IMG("d")], scope: "personal", owner: "u1" });
    await post("arm-a", { status: "published", media: [IMG("e")], experimentId: "exp1" });
    expect(await reusedMedia(ctx, "co", await post("n1", { media: [IMG("a"), IMG("b"), IMG("c"), IMG("d")] }))).toEqual([]);
    expect(await reusedMedia(ctx, "co", await post("arm-b", { media: [IMG("e")], experimentId: "exp1" }))).toEqual([]);
    expect(await reusedMedia(ctx, "co", await post("n2", { media: [IMG("e")] }))).toHaveLength(1);
    // The client's own posts are compared with each other, and a person's with their own.
    expect(await reusedMedia(ctx, "co", await post("client2", { media: [IMG("c")], clientRef: "c1" }))).toHaveLength(1);
    expect(await reusedMedia(ctx, "co", await post("client3", { media: [IMG("c")], clientRef: "c2" }))).toEqual([]);
    expect(await reusedMedia(ctx, "co", await post("mine2", { media: [IMG("d")], scope: "personal", owner: "u1" }))).toHaveLength(1);
    expect(await reusedMedia(ctx, "co", await post("theirs", { media: [IMG("d")], scope: "personal", owner: "u2" }))).toEqual([]);
  });

  it("the same picture on another platform's account is not a repeat; on the same account it is", async () => {
    await post("first", { status: "published", media: [IMG("card")] });
    await on("first", "fb");
    await post("li-version", { media: [IMG("card")] });
    expect(await reusedMedia(ctx, "co", await on("li-version", "li"))).toEqual([]);
    await post("fb-again", { media: [IMG("card")] });
    expect(await reusedMedia(ctx, "co", await on("fb-again", "fb"))).toHaveLength(1);
    await post("both", { media: [IMG("card")] });
    expect(await reusedMedia(ctx, "co", await on("both", "li", "fb"))).toHaveLength(1);
    // No accounts chosen yet: compared with every post of the scope.
    expect(await reusedMedia(ctx, "co", await post("nowhere", { media: [IMG("card")] }))).toHaveLength(1);
  });

  it("the board ranks hooks, bodies and asks of a scope's published posts and names the control", async () => {
    await post("p1", { status: "published", publishedDaysAgo: 3, tags: ["hook:price", "body:demo", "cta:book"] });
    await post("p2", { status: "published", publishedDaysAgo: 5, tags: ["hook:price", "body:explain", "cta:book"] });
    await post("p3", { status: "published", publishedDaysAgo: 6, tags: ["hook:story", "body:explain", "cta:reply"] });
    await post("p4", { status: "partially_published", publishedDaysAgo: 8, tags: ["hook:tip", "body:explain", "cta:reply"] });
    await post("p5", { status: "published", publishedDaysAgo: 2 });
    await post("old", { status: "published", publishedDaysAgo: 60, tags: ["hook:price"] });
    await post("waiting", { status: "scheduled", tags: ["hook:price"] });
    await post("client", { status: "published", publishedDaysAgo: 2, tags: ["hook:client-only"], clientRef: "c1" });
    await metric("p1", "d1", { reach: 100, likes: 5 }, "24h");
    await metric("p1", "d1", { reach: 300, likes: 30, comments: 6 });
    await metric("p2", "d2", { impressions: 200, likes: 14 });
    await metric("p3", "d3", { reach: 300, likes: 9, clicks: 3 });
    await metric("p4", "d4", { views: 300, likes: 3 });
    await metric("old", "d5", { reach: 5000, likes: 900 });
    await metric("client", "d6", { reach: 900, likes: 90 });

    const board = await hookBoard(ctx, "co", null, 28);
    expect(board).toMatchObject({ periodDays: 28, published: 5, tagged: 4, reach: 1100, minReach: 100, control: { hook: "price", body: "demo", cta: "book" } });
    expect(board.hooks.map((h) => [h.name, h.posts, h.reach, h.actions, h.rate, h.verdict])).toEqual([
      ["price", 2, 500, 50, 10, "double down"],
      ["story", 1, 300, 12, 4, "keep testing"],
      ["tip", 1, 300, 3, 1, "drop"],
    ]);
    expect(board.bodies.map((b) => b.name)).toEqual(["demo", "explain"]);
    expect(board.ctas.map((c) => [c.name, c.rate])).toEqual([["book", 10], ["reply", 2.5]]);
    expect(board.notes.join("\n")).toContain("1 of 5 published posts carry no hook tag");
    expect(board.notes.join("\n")).toContain('say "price" again with a different look');

    // A client's board holds only that client's posts.
    const theirs = await hookBoard(ctx, "co", { kind: "company", id: "c1" }, 28);
    expect(theirs.hooks.map((h) => h.name)).toEqual(["client-only"]);
    expect(theirs.hooks[0]!.verdict).toBe("keep testing");
  });

  it("says reach is the job when nothing has reached enough people to rank", async () => {
    await post("p1", { status: "published", publishedDaysAgo: 3, tags: ["hook:a"] });
    await post("p2", { status: "published", publishedDaysAgo: 4, tags: ["hook:b"] });
    await metric("p1", "d1", { impressions: 5, likes: 1 });
    const board = await hookBoard(ctx, "co", null, 28);
    expect(board.hooks.every((h) => h.verdict === "too little reach")).toBe(true);
    expect(board.control).toEqual({ hook: null, body: null, cta: null });
    expect(board.notes.join("\n")).toContain("the first job is reach");
    expect((await hookBoard(ctx, "co", { kind: "company", id: "nobody" }, 28)).notes).toEqual([]);
  });
});
