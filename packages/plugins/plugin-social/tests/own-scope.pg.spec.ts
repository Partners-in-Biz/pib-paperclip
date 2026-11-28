/**
 * Stage B2 (PAR-15210): a person limited to his own companies, under `enforce`, works only on their clients' posts,
 * accounts, media and inbox. His companies are the CRM companies he owns or is on "Managed by" for (the CRM copy's
 * `managers`); a contact is his when it belongs to one of them. A guessed id and another company's record get the same
 * refusal. With the switch off nothing changes.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import { NAME_YOUR_COMPANY, NOT_AMONG_YOUR_COMPANIES, PERMISSION_DENIED, accessCompanyScope, accessGrantScope, isRefusal } from "@partnersinbiz/pib-plugin-kit";
import { ACCESS_TABLE } from "../src/access-table.js";
import { insertInboxItem, insertManualAccount, insertPost, insertTemplate } from "../src/db.js";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import { OWN_SCOPE_RULES } from "../src/own-scope.js";
import { accountVisible, getPostDetail, listPostsRecord, markInboxReadRecord, postVisible, type Viewer } from "../src/service.js";
import plugin from "../src/worker.js";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));
const EMBEDDED = fileURLToPath(new URL("../../../db/node_modules/embedded-postgres/dist/index.js", import.meta.url));
const available = await import(EMBEDDED).then(() => true, () => false);

type PgClient = { query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>; connect: () => Promise<void>; end: () => Promise<void> };
type Db = { namespace: string; query: (sql: string, params?: unknown[]) => Promise<any[]>; execute: (sql: string, params?: unknown[]) => Promise<{ rowCount: number }> };

const COMPANY = "11111111-1111-1111-1111-111111111111";
const OWNER = "user-owner";
const MEMBER = "user-member";
const AGENT = "agent-social";
const member = (principalId: string, membershipRole: string) =>
  ({ id: `${COMPANY}:${principalId}`, companyId: COMPANY, principalType: "user", principalId, status: "active", membershipRole, grants: [] }) as never;

let client: PgClient;
let db: Db;
let stop: () => Promise<void> = async () => undefined;
beforeAll(async () => {
  if (!available) return;
  const { default: EmbeddedPostgres } = (await import(EMBEDDED)) as { default: new (o: Record<string, unknown>) => { initialise: () => Promise<void>; start: () => Promise<void>; stop: () => Promise<void>; getPgClient: () => PgClient } };
  const { createServer } = await import("node:net");
  const port = await new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
  const dir = mkdtempSync(join(tmpdir(), "social-own-pg-"));
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "t", password: "t", port, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  client = pg.getPgClient();
  await client.connect();
  await client.query(`CREATE SCHEMA ${NAMESPACE}`);
  for (const f of readdirSync(MIGRATIONS).sort()) await client.query(readFileSync(join(MIGRATIONS, f), "utf8"));
  // Rows cross the host's JSON RPC (dates as strings); arrays and objects go in as JSON text, as the host sends them.
  const values = (params: unknown[]) => params.map((v) => (v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v));
  db = {
    namespace: NAMESPACE,
    query: async (sql, params = []) => JSON.parse(JSON.stringify((await client.query(sql, values(params))).rows)),
    execute: async (sql, params = []) => ({ rowCount: (await client.query(sql, values(params))).rowCount ?? 0 }),
  };
  stop = async () => {
    await client.end();
    await pg.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}, 120_000);
afterAll(async () => stop());

async function reset() {
  const tables = (await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = '${NAMESPACE}'`)).rows as Array<{ table_name: string }>;
  await client.query(`TRUNCATE ${tables.map((t) => `${NAMESPACE}.${t.table_name}`).join(", ")} CASCADE`);
}

interface World {
  harness: TestHarness;
  ctx: PluginContext;
}

async function world(): Promise<World> {
  const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.example.test" } });
  harness.seed({ companies: [{ id: COMPANY, name: "Partners in Biz", issuePrefix: "PIB", defaultResponsibleUserId: OWNER } as never] });
  harness.seed({ accessMembers: [member(OWNER, "owner"), member(MEMBER, "member")] });
  (harness.ctx as unknown as { db: unknown }).db = db;
  await plugin.definition.setup(harness.ctx);
  return { harness, ctx: harness.ctx };
}

const stateKey = (s: { scopeId?: string; namespace?: string; stateKey: string }) => `${s.scopeId ?? ""}|${s.namespace ?? ""}|${s.stateKey}`;
/** Turns the switch to `mode` for the company with MEMBER on the Client manager preset (own companies). */
function limit(w: World, mode: "enforce" | "off" = "enforce") {
  const rows = new Map<string, unknown>([
    [stateKey(accessCompanyScope(COMPANY)), { mode, rev: 1, userIds: [MEMBER], receivedAt: new Date().toISOString() }],
    [stateKey(accessGrantScope(COMPANY, MEMBER)), { preset: "clientManager" }],
  ]);
  const { get } = w.ctx.state;
  w.ctx.state.get = async (scope: Parameters<typeof get>[0]) => (rows.has(stateKey(scope)) ? rows.get(stateKey(scope)) : get.call(w.ctx.state, scope));
}

const crmCompany = (w: World, id: string, name: string, managers: { ownerUserId: string | null; managerUserIds: string[] }) =>
  w.harness.emit("plugin.partnersinbiz.crm.company.upserted", { id, name, domain: null, lifecycle: null, updatedAt: "2026-10-01T00:00:00Z", managers }, { companyId: COMPANY });
const crmContact = (w: World, id: string, name: string, accountIds: string[]) =>
  w.harness.emit("plugin.partnersinbiz.crm.contact.upserted", { id, name, emails: [], phones: [], lifecycle: null, tags: [], accountIds, updatedAt: "2026-10-01T00:00:00Z" }, { companyId: COMPANY });

type Client = { kind: "company" | "contact"; id: string; name: string } | null;
const cols = (c: Client) => ({ client_kind: c?.kind ?? null, client_ref: c?.id ?? null, client_name: c?.name ?? null });
const ACME: Client = { kind: "company", id: "acme", name: "Acme Ltd" };
const JO: Client = { kind: "contact", id: "jo", name: "Jo Acme" };
const OTHER: Client = { kind: "company", id: "other", name: "Other Co" };

async function seedPost(w: World, id: string, c: Client, body = `Spring post ${id}`) {
  await insertPost(w.ctx, { id, company_id: COMPANY, body, overrides: {}, media: [], status: "draft", scope: "org", owner_user_id: null, first_comment: null, source: "agent", source_ref: null, created_by_agent_id: null, scheduled_at: null, ...cols(c) } as never);
}
async function seedAccount(w: World, handle: string, c: Client) {
  const { id } = await insertManualAccount(w.ctx, { company_id: COMPANY, platform: "linkedin", display_name: handle, external_id: `manual:${handle}`, handle, meta: {}, scope: "org", owner_user_id: null, created_by_user_id: OWNER, ...cols(c) });
  return id;
}
async function seedInbox(w: World, id: string, c: Client) {
  await insertInboxItem(w.ctx, { id, company_id: COMPANY, account_id: null, platform: null, kind: "comment", author: "someone", body: "Nice", status: "new", ...cols(c) });
}

type Out = { data?: Record<string, unknown>; error?: string; content?: string };
/** A tool's list answer (the kit wraps an array as `{ items }`). */
const items = <T = { id: string }>(out: Out) => (out.data?.items ?? []) as T[];
/** An agent's run for MEMBER, as core sends it (the host names the person the run works for). */
const tool = (w: World, name: string, params: Record<string, unknown> = {}, forMember = true) =>
  w.harness.executeTool<Out>(name, params, { companyId: COMPANY, agentId: AGENT, runId: "run-1", projectId: "proj-1", ...(forMember ? { onBehalfOfUserId: MEMBER, onBehalfOfRestricted: true } : {}) } as never);
const act = <T = Record<string, unknown>>(w: World, key: string, params: Record<string, unknown> = {}, userId = MEMBER) =>
  w.harness.performAction<T>(key, params, { companyId: COMPANY, actor: { type: "user", userId, agentId: null, runId: null, companyId: COMPANY } } as never);
const refusedWith = (result: unknown) => (isRefusal(result) && result.code === PERMISSION_DENIED ? result.message : `not refused: ${JSON.stringify(result)?.slice(0, 200)}`);
/** The refusal text of a key, called as a page action or a tool. */
async function refusal(w: World, key: string, params: Record<string, unknown>): Promise<string> {
  if (key.startsWith("tool:")) {
    const out = await tool(w, key.slice(5), params);
    return out.error?.startsWith("Access refused: ") ? out.error.slice(16, -1) : `not refused: ${JSON.stringify(out).slice(0, 200)}`;
  }
  return refusedWith(await act(w, key, params));
}

describe("Social access table and the own-scope rules", () => {
  it("a row is scoped exactly when it has an own-scope rule, and no settings row is", () => {
    const scoped = Object.entries(ACCESS_TABLE).filter(([, e]) => typeof e === "object" && "resource" in e && e.scoped === true);
    expect(scoped.map(([k]) => k).sort()).toEqual(Object.keys(OWN_SCOPE_RULES).sort());
    for (const [key, entry] of scoped) expect((entry as { resource: string }).resource, key).toMatch(/^social\.(posts|accounts)$/);
  });
});

describe.skipIf(!available)("a person limited to his own companies (enforce)", () => {
  let w: World;
  let acmeAccount: string;
  let otherAccount: string;
  beforeEach(async () => {
    await reset();
    w = await world();
    await crmCompany(w, "acme", "Acme Ltd", { ownerUserId: MEMBER, managerUserIds: [] });
    await crmCompany(w, "beta", "Beta Bakery", { ownerUserId: OWNER, managerUserIds: [MEMBER] });
    await crmCompany(w, "other", "Other Co", { ownerUserId: OWNER, managerUserIds: [] });
    await crmContact(w, "jo", "Jo Acme", ["acme"]);
    await crmContact(w, "zed", "Zed Other", ["other"]);
    for (const [id, c] of [["own-post", null], ["acme-post", ACME], ["jo-post", JO], ["other-post", OTHER]] as const) await seedPost(w, id, c);
    await seedAccount(w, "own", null);
    acmeAccount = await seedAccount(w, "acme", ACME);
    otherAccount = await seedAccount(w, "other", OTHER);
    await seedInbox(w, "acme-item", ACME);
    await seedInbox(w, "other-item", OTHER);
    await insertTemplate(w.ctx, { id: "tpl-1", company_id: COMPANY, name: "House style", body: "Hi", platform: null, scope: "org", owner_user_id: null });
    limit(w);
  });

  it("the page opens his first client, lists only his, and leaves out templates and approver candidates", async () => {
    const load = await act<{ limitedTo?: { client: string; clients: string[] }; posts: Array<{ id: string }>; accounts: Array<{ id: string }>; inbox: Array<{ id: string }>; templates: unknown[]; delegateCandidates: unknown[] }>(w, "social.load", {});
    expect(load.limitedTo).toEqual({ client: "company:acme", clients: ["company:acme", "company:beta", "contact:jo"] });
    expect(load.posts.map((p) => p.id)).toEqual(["acme-post"]);
    expect(load.accounts.map((a) => a.id)).toEqual([acmeAccount]);
    expect(load.inbox.map((i) => i.id)).toEqual(["acme-item"]);
    expect([load.templates, load.delegateCandidates]).toEqual([[], []]);
    expect((await act<{ posts: Array<{ id: string }> }>(w, "social.load", { client: "contact:jo" })).posts.map((p) => p.id)).toEqual(["jo-post"]);
    for (const c of ["company:other", "contact:zed", "own", "company:guessed"]) expect(refusedWith(await act(w, "social.load", { client: c })), c).toBe(NOT_AMONG_YOUR_COMPANIES);
    expect(refusedWith(await act(w, "social.load", { space: "me" }))).toBe(NAME_YOUR_COMPANY);
    expect(items<{ client: string }>(await tool(w, "list-clients")).map((c) => c.client)).toEqual(["company:acme", "company:beta", "contact:jo"]);
  });

  it("every scoped key refuses another company's record and a guessed id with the same answer", async () => {
    const bad: Record<string, Array<Record<string, unknown>>> = {
      post: [{ postId: "other-post" }, { postId: "guessed-id" }],
      "post-or-client": [{ postId: "other-post" }, { postId: "guessed-id" }, { client: "company:other" }],
      posts: [{ postIds: ["acme-post", "other-post"], scheduledAt: "2026-12-01T10:00:00Z" }, { postIds: ["guessed-id"], scheduledAt: "2026-12-01T10:00:00Z" }],
      account: [{ accountId: otherAccount }, { accountId: "guessed-id" }],
      "account-or-client": [{ accountId: otherAccount, kind: "comment", body: "x" }, { accountId: "guessed-id", kind: "comment", body: "x" }],
      inbox: [{ itemId: "other-item" }, { itemId: "guessed-id" }],
      client: [{ client: "company:other" }, { client: "contact:zed" }, { client: "company:guessed" }, { client: "own" }, { clientKind: "company", clientRef: "other" }],
    };
    let checked = 0;
    for (const [key, rule] of Object.entries(OWN_SCOPE_RULES)) {
      for (const params of bad[rule] ?? []) {
        expect(await refusal(w, key, { body: "Hello", ...params }), `${key} ${JSON.stringify(params)}`).toBe(NOT_AMONG_YOUR_COMPANIES);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(150);
    // A call that names no client, or every client, is asked to name one of his.
    for (const key of ["tool:list-posts", "tool:create-post", "social.create-post", "tool:list-inbox", "tool:post-analytics", "tool:record-inbox-item"]) {
      expect(await refusal(w, key, { body: "Hello", kind: "comment" }), key).toBe(NAME_YOUR_COMPANY);
      expect(await refusal(w, key, { body: "Hello", kind: "comment", client: "all" }), key).toBe(NAME_YOUR_COMPANY);
    }
    // The old `scope` name alone would be own work to a handler that reads `client` only.
    expect(await refusal(w, "tool:list-posts", { scope: "company:acme" })).toBe(NAME_YOUR_COMPANY);
  });

  it("his own records open; moving a post to another company or to own work is refused", async () => {
    expect(items(await tool(w, "list-posts", { client: "company:acme" })).map((p) => p.id)).toEqual(["acme-post"]);
    expect((await tool(w, "get-post", { postId: "jo-post" })).error).toBeUndefined();
    expect(isRefusal(await act(w, "social.get-post", { postId: "acme-post" }))).toBe(false);
    expect((await tool(w, "create-post", { body: "For Beta", client: "company:beta" })).error).toBeUndefined();
    expect(await refusal(w, "tool:update-post", { postId: "acme-post", client: "company:other" })).toBe(NOT_AMONG_YOUR_COMPANIES);
    expect(await refusal(w, "tool:update-post", { postId: "acme-post", client: null })).toBe(NOT_AMONG_YOUR_COMPANIES);
    expect(await refusal(w, "tool:update-post", { postId: "acme-post", scope: "company:other" })).toBe(NOT_AMONG_YOUR_COMPANIES);
    expect((await tool(w, "mark-inbox-read", { itemId: "acme-item" })).error).toBeUndefined();
    expect(isRefusal(await act(w, "social.refresh-account", { accountId: acmeAccount }))).toBe(false);
  });

  it("behind the rules, the viewer's clients limit visibility and the scope a read names", async () => {
    const own = { companies: new Set(["acme", "beta"]), contacts: new Set(["jo"]) };
    const v: Viewer = { companyId: COMPANY, userId: MEMBER, agentId: null, runId: null, isAgent: false, own };
    await expect(getPostDetail(w.ctx, v, "other-post")).rejects.toThrow(/not visible/);
    await expect(getPostDetail(w.ctx, v, "own-post")).rejects.toThrow(/not visible/);
    await expect(listPostsRecord(w.ctx, v, { client: "company:other" })).rejects.toThrow(NOT_AMONG_YOUR_COMPANIES);
    await expect(listPostsRecord(w.ctx, v, {})).rejects.toThrow(NOT_AMONG_YOUR_COMPANIES);
    await expect(markInboxReadRecord(w.ctx, v, "other-item")).rejects.toThrow(/not found/);
    const row = { company_id: COMPANY, scope: "org", owner_user_id: null, created_by_agent_id: null } as const;
    expect(postVisible(v, { ...row, ...cols(JO) } as never)).toBe(true);
    expect(postVisible(v, { ...row, ...cols(OTHER) } as never)).toBe(false);
    expect(accountVisible(v, { ...row, ...cols(ACME) } as never)).toBe(true);
    expect(accountVisible(v, { ...row, ...cols(null) } as never)).toBe(false);
    expect(postVisible({ ...v, own: null }, { ...row, ...cols(OTHER) } as never)).toBe(true);
  });

  it("canvas cards and the CRM tile show his clients only", async () => {
    // A person core marks restricted gets no cards at all (the kit's card gate); a limited person core does not mark sees his clients' cards.
    const card = <T>(key: string, params: Record<string, unknown>) =>
      w.harness.performAction<T>(key, params, { companyId: COMPANY, actor: { type: "user", userId: MEMBER, agentId: null, runId: null, companyId: COMPANY, onBehalfOfUserId: MEMBER, onBehalfOfRestricted: false } } as never);
    const cards = (await card<{ cards: Array<{ id: string }> }>("canvas.cards.search", { type: "card-post", q: "spring" })).cards.map((c) => c.id).sort();
    expect(cards).toEqual(["acme-post", "jo-post"]);
    const related = await card<{ groups: Array<{ cards: unknown[] }> }>("canvas.cards.related", { of: { plugin: "partnersinbiz.crm", type: "card-company", id: "other" } });
    expect(related.groups).toEqual([]);
    const resolved = await card<{ cards: Array<{ id: string; hidden?: boolean }> }>("canvas.cards.resolve", { items: [{ type: "card-post", id: "other-post" }, { type: "card-post", id: "acme-post" }] });
    expect(resolved.cards.map((c) => c.hidden === true)).toEqual([true, false]);
    const route = (id: string) =>
      plugin.definition.onApiRequest!({ routeKey: "client-summary", method: "GET", path: "/client-summary", params: {}, query: { kind: "company", id }, body: null, actor: { actorType: "user", actorId: MEMBER, userId: MEMBER }, companyId: COMPANY, headers: {} } as PluginApiRequestInput);
    expect((await route("acme")).status).toBe(200);
    for (const id of ["other", "guessed"]) expect((await route(id)).status, id).toBe(403);
  });

  it("fails closed when his contacts cannot be read; company-wide rows stay closed; an owner is not limited", async () => {
    const { query } = w.ctx.db;
    w.ctx.db.query = (async (sql: string, params?: unknown[]) => {
      if (sql.includes("jsonb_array_elements_text")) throw new Error("read failed");
      return query.call(w.ctx.db, sql, params);
    }) as typeof w.ctx.db.query;
    const out = await tool(w, "list-posts", { client: "company:acme" });
    expect(out.data?.items).toBeUndefined();
    expect(out.error).toMatch(/read failed/);
    w.ctx.db.query = query;
    for (const key of ["social.list-templates", "social.approval-policy", "social.oauth-start", "social.media-presign", "my-social.posts", "social.growth-load"]) {
      expect(isRefusal(await act(w, key, { client: "company:acme" })), key).toBe(true);
    }
    for (const name of ["list-templates", "list-rss-feeds", "connect-account", "create-personal-draft"]) expect((await tool(w, name, { client: "company:acme" })).error, name).toMatch(/^Access refused/);
    const owner = await act<{ limitedTo?: unknown; posts: Array<{ id: string }>; templates: unknown[] }>(w, "social.load", {}, OWNER);
    expect(owner.limitedTo).toBeUndefined();
    expect(owner.posts.map((p) => p.id)).toEqual(["own-post"]);
    expect(owner.templates).toHaveLength(1);
  });
});

describe.skipIf(!available)("the same person with the switch off", () => {
  it("is not limited: own work and every client open, as today", async () => {
    await reset();
    const w = await world();
    await crmCompany(w, "other", "Other Co", { ownerUserId: OWNER, managerUserIds: [] });
    await seedPost(w, "own-post", null);
    await seedPost(w, "other-post", OTHER);
    limit(w, "off");
    const load = await act<{ limitedTo?: unknown; posts: Array<{ id: string }> }>(w, "social.load", {});
    expect(load.limitedTo).toBeUndefined();
    expect(load.posts.map((p) => p.id)).toEqual(["own-post"]);
    expect((await tool(w, "get-post", { postId: "other-post" })).error).toBeUndefined();
    expect(items(await tool(w, "list-posts", { client: "company:other" })).map((p) => p.id)).toEqual(["other-post"]);
  });
});
