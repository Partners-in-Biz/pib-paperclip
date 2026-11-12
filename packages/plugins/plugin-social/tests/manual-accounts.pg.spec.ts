import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SocialConfig } from "../src/config.js";
import { deleteJunkAccounts, duePostRefs, getPost, scheduledPostsWithoutWork } from "../src/db.js";
import { addManualAccountRecord, markDestinationPostedRecord, skipDestinationRecord } from "../src/manual.js";
import { NAMESPACE } from "../src/namespace.js";
import { publishPost } from "../src/publish.js";
import { getPostDetail, listAccountsRecord, type Viewer } from "../src/service.js";
import { validatePostRow } from "../src/validate.js";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));
const EMBEDDED = fileURLToPath(new URL("../../../db/node_modules/embedded-postgres/dist/index.js", import.meta.url));
const available = await import(EMBEDDED).then(() => true, () => false);

type PgClient = { query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>; connect: () => Promise<void>; end: () => Promise<void> };
const viewer: Viewer = { companyId: "co", userId: "u1", agentId: null, runId: null, isAgent: false };
const agent: Viewer = { companyId: "co", userId: null, agentId: "a1", runId: "r1", isAgent: true };
const T = (name: string) => `${NAMESPACE}.${name}`;
const config = { companyId: "co" } as unknown as SocialConfig;

describe.skipIf(!available)("manual accounts: add, publish hand-off, mark as posted (postgres)", () => {
  let client: PgClient;
  let stop: () => Promise<void>;
  let ctx: PluginContext;
  let issues: Array<{ title: string; assigneeUserId?: string }>;
  let closed: string[];
  const q = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;
  const dests = async () => q(`SELECT id, account_id, status, external_url, issue_id, result FROM ${T("destinations")} WHERE post_id = 'p1' ORDER BY id`);

  beforeAll(async () => {
    const { default: EmbeddedPostgres } = (await import(EMBEDDED)) as { default: new (o: Record<string, unknown>) => { initialise: () => Promise<void>; start: () => Promise<void>; stop: () => Promise<void>; getPgClient: () => PgClient } };
    const { createServer } = await import("node:net");
    const port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
    });
    const dir = mkdtempSync(join(tmpdir(), "social-manual-pg-"));
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
      companies: { get: async () => ({ defaultResponsibleUserId: "owner-1" }) },
      issues: {
        create: async (input: { title: string; assigneeUserId?: string }) => {
          issues.push(input);
          return { id: `issue-${issues.length}` };
        },
        createComment: async () => undefined,
        update: async (id: string, patch: { status?: string }) => {
          if (patch.status === "done") closed.push(id);
        },
      },
    } as unknown as PluginContext;
    stop = async () => (await client.end(), await pg.stop(), rmSync(dir, { recursive: true, force: true }));
  }, 90_000);
  afterAll(async () => void (await stop?.()));

  beforeEach(async () => {
    issues = [];
    closed = [];
    await client.query(`DELETE FROM ${T("destinations")}; DELETE FROM ${T("posts")}; DELETE FROM ${T("accounts")}`);
  });

  async function seedPost(status: string, accountIds: string[]) {
    await client.query(
      `INSERT INTO ${T("posts")} (id, company_id, body, overrides, media, status, scheduled_at, scope, owner_user_id)
       VALUES ('p1', 'co', 'Watch the build', '{}'::jsonb, '[{"url":"https://cdn.example/clip.mp4","kind":"video","mime":"video/mp4"}]'::jsonb, $1, now() - interval '1 minute', 'org', 'u1')`,
      [status],
    );
    for (const [i, accountId] of accountIds.entries()) {
      await client.query(`INSERT INTO ${T("destinations")} (id, company_id, post_id, account_id, status, result) VALUES ($1, 'co', 'p1', $2, 'pending', '{}'::jsonb)`, [`d${i + 1}`, accountId]);
    }
  }

  it("a person adds a manual account; an agent cannot; the same handle is refused twice", async () => {
    const added = await addManualAccountRecord(ctx, viewer, { platform: "tiktok", handle: "https://www.tiktok.com/@VeloxMath" });
    expect(added).toMatchObject({ platform: "tiktok", handle: "@VeloxMath", manual: true, belongsTo: "own work" });
    const row = (await q(`SELECT manual, token_enc, status, external_id, secret_ref, scope FROM ${T("accounts")} WHERE id = $1`, [added.id]))[0]!;
    expect(row).toEqual({ manual: true, token_enc: null, status: "connected", external_id: "manual:veloxmath", secret_ref: "manual", scope: "org" });
    await expect(addManualAccountRecord(ctx, viewer, { platform: "tiktok", handle: "@veloxmath" })).rejects.toThrow(/already added/);
    await expect(addManualAccountRecord(ctx, agent, { platform: "tiktok", handle: "@other" })).rejects.toThrow(/person/);
    // The clean-up of token-less leftovers leaves it alone, and it lists as usable.
    expect(await deleteJunkAccounts(ctx, "co")).toBe(0);
    const listed = (await listAccountsRecord(ctx, viewer, {})) as Array<{ id: string; connected: boolean; manual: boolean }>;
    expect(listed.find((a) => a.id === added.id)).toMatchObject({ connected: true, manual: true });
  });

  it("at the publish time the destination waits for a person, one task is opened, and the job leaves it alone", async () => {
    const { id } = await addManualAccountRecord(ctx, viewer, { platform: "tiktok", handle: "@veloxmath" });
    await seedPost("scheduled", [id]);
    const post = (await getPost(ctx, "co", "p1"))!;
    expect((await validatePostRow(ctx, "co", post)).problems).toEqual([]);

    expect(await publishPost(ctx, config, "p1")).toEqual({ attempted: 1, published: 0 });
    const [d] = await dests();
    expect(d).toMatchObject({ status: "awaiting_manual", issue_id: "issue-1" });
    expect((await getPost(ctx, "co", "p1"))!.status).toBe("publishing");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ title: "Post by hand: TikTok", assigneeUserId: "u1" });

    // Nothing is due any more and the post is not failed as "no work left".
    expect(await duePostRefs(ctx)).toEqual([]);
    await client.query(`UPDATE ${T("posts")} SET scheduled_at = now() - interval '10 minutes' WHERE id = 'p1'`);
    expect(await scheduledPostsWithoutWork(ctx)).toEqual([]);

    const detail = await getPostDetail(ctx, viewer, "p1");
    expect(detail.destinations[0]).toMatchObject({ manual: true, status: "awaiting_manual" });
    expect(detail.destinations[0]!.handPost).toEqual({ text: "Watch the build", title: null, firstComment: null, url: "https://www.tiktok.com/upload", prefilled: false, mediaByHand: true });
  });

  it("marking it as posted publishes the post, keeps the link and closes the task", async () => {
    const { id } = await addManualAccountRecord(ctx, viewer, { platform: "tiktok", handle: "@veloxmath" });
    await seedPost("scheduled", [id]);
    await publishPost(ctx, config, "p1");
    await expect(markDestinationPostedRecord(ctx, agent, { postId: "p1", destinationId: "d1" })).rejects.toThrow(/person/);
    await expect(markDestinationPostedRecord(ctx, viewer, { postId: "p1", destinationId: "d1", url: "http://insecure.example" })).rejects.toThrow(/https/);

    const detail = await markDestinationPostedRecord(ctx, viewer, { postId: "p1", destinationId: "d1", url: "https://www.tiktok.com/@veloxmath/video/123" });
    expect(detail.status).toBe("published");
    expect(detail.destinations[0]).toMatchObject({ status: "published", externalUrl: "https://www.tiktok.com/@veloxmath/video/123", handPost: null });
    const [d] = await dests();
    expect((d!.result as { manual: boolean; by: string })).toMatchObject({ manual: true, by: "u1" });
    expect(closed).toEqual(["issue-1"]);
    await expect(markDestinationPostedRecord(ctx, viewer, { postId: "p1", destinationId: "d1" })).rejects.toThrow(/cannot be marked|already published/);
  });

  it("a post can be hand-posted before its time; it stays scheduled until every destination is out", async () => {
    const a = await addManualAccountRecord(ctx, viewer, { platform: "tiktok", handle: "@one" });
    const b = await addManualAccountRecord(ctx, viewer, { platform: "instagram", handle: "@two" });
    await seedPost("scheduled", [a.id, b.id]);
    await client.query(`UPDATE ${T("posts")} SET scheduled_at = now() + interval '1 day' WHERE id = 'p1'`);
    expect((await markDestinationPostedRecord(ctx, viewer, { postId: "p1", destinationId: "d1" })).status).toBe("scheduled");
    expect((await markDestinationPostedRecord(ctx, viewer, { postId: "p1", destinationId: "d2" })).status).toBe("published");
  });

  it("an account with a publishing link cannot be marked by hand unless its publish failed", async () => {
    await client.query(`INSERT INTO ${T("accounts")} (id, company_id, platform, scope, display_name, handle, status, token_enc) VALUES ('afb', 'co', 'facebook', 'org', 'FB', 'page', 'connected', 'enc')`);
    await seedPost("scheduled", ["afb"]);
    await expect(markDestinationPostedRecord(ctx, viewer, { postId: "p1", destinationId: "d1" })).rejects.toThrow(/publishes on its own/);
    await client.query(`UPDATE ${T("destinations")} SET status = 'failed' WHERE id = 'd1'`);
    await client.query(`UPDATE ${T("posts")} SET status = 'failed' WHERE id = 'p1'`);
    expect((await markDestinationPostedRecord(ctx, viewer, { postId: "p1", destinationId: "d1", url: "https://www.facebook.com/page/posts/1" })).status).toBe("published");
  });

  it("skipping records it as not posted, so the post leaves publishing and no failure issue is opened", async () => {
    const { id } = await addManualAccountRecord(ctx, viewer, { platform: "tiktok", handle: "@veloxmath" });
    await seedPost("scheduled", [id]);
    await publishPost(ctx, config, "p1");
    const detail = await skipDestinationRecord(ctx, viewer, { postId: "p1", destinationId: "d1" });
    expect(detail.status).toBe("failed");
    expect(detail.destinations[0]).toMatchObject({ status: "failed", lastError: "Not posted: skipped by a person" });
    expect(issues).toHaveLength(1);
    expect(closed).toEqual(["issue-1"]);
    await expect(skipDestinationRecord(ctx, viewer, { postId: "p1", destinationId: "d1" })).rejects.toThrow(/waits to be posted by hand/);
  });

  it("a switched-off manual account blocks validation like a disconnected one", async () => {
    const { id } = await addManualAccountRecord(ctx, viewer, { platform: "tiktok", handle: "@veloxmath" });
    await seedPost("approved", [id]);
    await client.query(`UPDATE ${T("accounts")} SET status = 'disabled' WHERE id = $1`, [id]);
    const check = await validatePostRow(ctx, "co", (await getPost(ctx, "co", "p1"))!);
    expect(check.problems.join(" ")).toMatch(/disconnected/);
  });
});
