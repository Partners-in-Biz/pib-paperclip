/**
 * create-feed-digest against real Postgres (the used-keys query), with the worker's
 * tool wired to the pg-backed db. Nothing is sent and no approval is answered.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NAMESPACE } from "../src/namespace.js";
import { boot, CO, PUBLIC_URL, setIssueStatus } from "./helpers/harness.js";
import { embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";
import { splitSqlStatements, validateMigrationStatement } from "./helpers/sql-guard.js";

const available = await embeddedAvailable();
const FEED_URL = "https://toolchanges.com/feed.xml";
const T = `${NAMESPACE}.campaigns`;

const item = (n: number, category = "tools") =>
  `<item><title>Item ${n} &amp; co</title><link>https://toolchanges.com/p/${n}</link><guid>g-${n}</guid><pubDate>${new Date(Date.UTC(2026, 10, n)).toUTCString()}</pubDate><category>${category}</category><description>About {{first_name}} ${n}</description></item>`;
const feedOf = (...numbers: number[]) => `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${numbers.map((n) => item(n)).join("")}</channel></rss>`;

describe("017_campaigns.sql", () => {
  const sql = readFileSync(new URL("../migrations/017_campaigns.sql", import.meta.url), "utf8");
  it("passes the host guard, only adds nullable columns and an index", () => {
    for (const statement of splitSqlStatements(sql)) expect(() => validateMigrationStatement(statement, NAMESPACE), statement.slice(0, 80)).not.toThrow();
    for (const line of sql.split("\n").filter((l) => l.trim().startsWith("--"))) expect(line).not.toMatch(/['"]/);
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\b(delete|drop|update)\b|ADD COLUMN[^;,]*\b(not null|default)\b/i);
    for (const column of ["feed_url text", "feed_category text", "feed_item_keys jsonb"]) expect(code).toContain(`ADD COLUMN ${column}`);
    expect(code).toContain("WHERE feed_url IS NOT NULL");
  });
});

describe.skipIf(!available)("create-feed-digest (postgres)", () => {
  let pg: PgHarness;
  beforeAll(async () => {
    pg = await startPg();
  }, 60_000);
  afterAll(async () => {
    await pg?.stop();
  });
  beforeEach(async () => {
    await pg.reset();
    await pg.client.query(`INSERT INTO ${NAMESPACE}.crm_contacts (id, company_id, name, emails, tags, updated_at) VALUES ('ada', '${CO}', 'Ada Lovelace', ARRAY['ada@acme.test'], ARRAY['vip'], now())`);
  });

  async function setup(feed: { xml: string }, linkStatus = 200, urls: string[] = [FEED_URL]) {
    const { harness, store } = await boot({ config: { timezone: "Africa/Johannesburg", publicBaseUrl: PUBLIC_URL, digestFeedUrls: urls } });
    (harness.ctx as unknown as { db: unknown }).db = pg.ctx.db;
    const fetch = vi.fn(async (url: string) => (url === FEED_URL ? new Response(feed.xml, { status: 200, headers: { "content-type": "application/rss+xml" } }) : new Response("ok", { status: linkStatus })));
    (harness.ctx as unknown as { http: unknown }).http = { fetch };
    const call = async (params: Record<string, unknown> = {}) =>
      (await harness.executeTool<{ data?: Record<string, any>; error?: string }>("create-feed-digest", { feedUrl: FEED_URL, audienceTags: ["vip"], name: "Weekly", subject: "This week", ...params }, { companyId: CO, agentId: "agent-camp" }));
    return { harness, store, fetch, call };
  }
  const rows = async () => (await pg.client.query(`SELECT id, status, feed_item_keys, approval_issue_id FROM ${T} ORDER BY created_at`)).rows as Array<Record<string, any>>;
  const markLaunched = (id: string) => pg.client.query(`UPDATE ${T} SET status = 'scheduled' WHERE id = $1`, [id]);

  it("drafts 3 items newest first, keeps the keys on the row and opens the launch approval without sending", async () => {
    const { harness, call } = await setup({ xml: feedOf(1, 3, 2) });
    const result = await call();
    expect(result.data).toMatchObject({ created: true, items: 3, approvalOpened: true });
    const [row] = await rows();
    expect(row).toMatchObject({ status: "draft", feed_item_keys: ["g-3", "g-2", "g-1"] });
    const steps = (await pg.client.query(`SELECT body, subject FROM ${NAMESPACE}.campaign_steps`)).rows as Array<{ body: string; subject: string }>;
    expect(steps).toHaveLength(1);
    const blocks = steps[0]!.body.split("\n\n");
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => b.split("\n")[0])).toEqual(["Item 3 & co", "Item 2 & co", "Item 1 & co"]);
    expect(blocks[0]).toContain("https://toolchanges.com/p/3");
    expect(steps[0]!.body).not.toContain("{{first_name}}");
    const issue = await harness.ctx.issues.get(String(row!.approval_issue_id), CO);
    expect(issue?.status).not.toBe("done");
    expect(((await pg.client.query(`SELECT count(*)::int AS n FROM ${NAMESPACE}.outbox`)).rows[0] as { n: number }).n).toBe(0);
  });

  it("a second call while the draft is open creates nothing; once launched the feed has nothing new; one new item gives a one-item digest", async () => {
    const feed = { xml: feedOf(1, 2, 3) };
    const { call } = await setup(feed);
    const first = await call();
    const again = await call();
    expect(again.data).toMatchObject({ created: false, campaignId: first.data!.campaignId, approvalIssueId: first.data!.approvalIssueId });
    expect(await rows()).toHaveLength(1);
    await markLaunched(String(first.data!.campaignId));
    expect((await call()).data).toMatchObject({ created: false, message: expect.stringContaining("Nothing new") });
    expect(await rows()).toHaveLength(1);
    feed.xml = feedOf(1, 2, 3, 4);
    const next = await call();
    expect(next.data).toMatchObject({ created: true, items: 1 });
    expect((await rows())[1]).toMatchObject({ feed_item_keys: ["g-4"] });
  });

  it("a draft whose approval was cancelled keeps its items unused: the next call returns that draft", async () => {
    const { harness, store, call } = await setup({ xml: feedOf(1, 2) });
    const first = await call();
    const issueId = String(first.data!.approvalIssueId);
    (store.issues ??= []).push({ id: issueId, status: "todo", created_at: new Date().toISOString() });
    await setIssueStatus(harness, store, issueId, "cancelled");
    const again = await call();
    expect(again.data).toMatchObject({ created: false, campaignId: first.data!.campaignId, approvalIssueId: null });
    expect(again.data!.message).toContain("request-campaign-approval");
    expect(await rows()).toHaveLength(1);
  });

  it("keeps the draft and returns the errors when preflight refuses the approval", async () => {
    const { call } = await setup({ xml: feedOf(1) }, 404);
    const result = await call();
    expect(result.data).toMatchObject({ created: true, approvalOpened: false, errors: expect.stringContaining("Fix these before asking for approval") });
    const [row] = await rows();
    expect(row).toMatchObject({ status: "draft", approval_issue_id: null, feed_item_keys: ["g-1"] });
    expect((await call()).data).toMatchObject({ created: false, campaignId: row!.id });
  });

  it("refuses a feed that is not on the list without fetching, and audienceTags that are missing or empty", async () => {
    const { call, fetch } = await setup({ xml: feedOf(1) });
    expect((await call({ feedUrl: "https://evil.test/feed.xml" })).error).toMatch(/not an allowed digest feed/);
    expect((await call({ audienceTags: [] })).error).toMatch(/audienceTags/);
    expect((await call({ audienceTags: undefined })).error).toMatch(/audienceTags/);
    expect((await call({ audienceTags: ["a", "b", "c", "d", "e", "f"] })).error).toMatch(/audienceTags/);
    expect(fetch).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(0);
  });

  it("14 new items give a 10-item digest; the other 4 come in the next one", async () => {
    const all = Array.from({ length: 14 }, (_, i) => i + 1);
    const { call } = await setup({ xml: feedOf(...all) });
    const first = await call();
    expect(first.data).toMatchObject({ created: true, items: 10 });
    expect((await rows())[0]!.feed_item_keys).toEqual(all.slice(4).reverse().map((n) => `g-${n}`));
    await markLaunched(String(first.data!.campaignId));
    const next = await call();
    expect(next.data).toMatchObject({ created: true, items: 4 });
    expect((await rows())[1]!.feed_item_keys).toEqual(["g-4", "g-3", "g-2", "g-1"]);
  });

  it("a category digest does not mark another category's items used", async () => {
    const xml = `<rss><channel>${item(1, "seo")}${item(2, "ads")}</channel></rss>`;
    const { call } = await setup({ xml });
    const seo = await call({ category: "seo" });
    expect(seo.data).toMatchObject({ created: true, items: 1 });
    await markLaunched(String(seo.data!.campaignId));
    expect((await call({ category: "ads" })).data).toMatchObject({ created: true, items: 1 });
  });
});
