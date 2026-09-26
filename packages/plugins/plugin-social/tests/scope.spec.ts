import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { scopeInput } from "../src/clients.js";
import type { AccountRow } from "../src/db.js";
import { openPublishFailureIssue, openReconnectIssue } from "../src/issues.js";
import { mediaFromAssetIds } from "../src/media.js";
import { NAMESPACE } from "../src/namespace.js";
import { socialPath } from "../src/oauth/flow.js";
import { handleClientSummary } from "../src/routes.js";
import {
  attachDestination,
  clientSummaryRecord,
  createPostRecord,
  loadSnapshot,
  updateAccountRecord,
  validatePostRecord,
  type Viewer,
} from "../src/service.js";
import { fakeCtx } from "./helpers.js";

const VIEWER: Viewer = { companyId: "co", userId: "user-1", agentId: null, runId: null, isAgent: false };
const T = (name: string) => `${NAMESPACE}.${name}`;

function account(id: string, scope: { kind: "company" | "contact"; id: string; name: string } | null, extra: Partial<AccountRow> = {}): AccountRow {
  return {
    id, company_id: "co", platform: "facebook", scope: "org", owner_user_id: null, status: "connected", secret_ref: null, display_name: `Page ${id}`,
    external_id: `ext-${id}`, handle: null, avatar_url: null, token_enc: "v1.x", refresh_token_enc: null, token_expires_at: null, scopes: [],
    client_kind: scope?.kind ?? null, client_ref: scope?.id ?? null, client_name: scope?.name ?? null, last_error: null, meta: {}, key_version: 1,
    created_by_user_id: "user-1", reconnect_issue_id: null, last_refreshed_at: null, created_at: new Date(), updated_at: new Date(),
    ...extra,
  };
}

const ACME = { kind: "company" as const, id: "c1", name: "Acme" };
const SAM = { kind: "contact" as const, id: "ct1", name: "Sam Sole" };

/** An in-memory world: accounts, CRM rows and posts written through the fake db. */
function world(accounts: AccountRow[], extra: { assets?: Array<Record<string, unknown>>; blocking?: unknown[] } = {}) {
  const posts = new Map<string, Record<string, unknown>>();
  const destinations: Array<{ post_id: string; account_id: string; status: string }> = [];
  const ctx = fakeCtx({
    config: { get: vi.fn(async () => ({})) },
    agents: { managed: { get: vi.fn(async () => { throw new Error("no agent"); }) } },
    companies: { get: vi.fn(async () => ({ id: "co", issuePrefix: "PIB" })) },
  }, {
    queryResult: (sql, params) => {
      if (sql.includes(T("crm_companies"))) return params[1] === "c1" ? [{ id: "c1", name: "Acme", domain: "acme.test", lifecycle: "customer" }] : [];
      if (sql.includes(T("crm_contacts"))) {
        return String(params[1] ?? "").includes("ct1") ? [{ id: "ct1", name: "Sam Sole", emails: ["sam@sole.test"], phones: [], lifecycle: null, tags: [], account_ids: [] }] : [];
      }
      if (sql.includes(`FROM ${T("accounts")} WHERE id = $1 AND company_id = $2`)) return accounts.filter((a) => a.id === params[0]);
      if (sql.includes(`FROM ${T("accounts")} WHERE company_id = $1 AND id = ANY`)) {
        const ids = JSON.parse(String(params[1])) as string[];
        return accounts.filter((a) => ids.includes(a.id));
      }
      if (sql.includes(`FROM ${T("posts")} WHERE id = $1`)) return posts.has(String(params[0])) ? [posts.get(String(params[0]))] : [];
      if (sql.includes(`FROM ${T("destinations")} WHERE post_id = $1`)) return destinations.filter((d) => d.post_id === params[0]).map((d, i) => ({ id: `d${i}`, ...d, attempts: 0 }));
      if (sql.includes(`FROM ${T("media_assets")} WHERE company_id = $1 AND id = ANY`)) return extra.assets ?? [];
      if (sql.includes("AS post_status")) return extra.blocking ?? [];
      return [];
    },
    executeResult: (sql, params) => {
      if (sql.startsWith(`INSERT INTO ${T("posts")}`)) {
        const [id, company_id, body, overrides, media, status, scope, owner_user_id, first_comment, client_kind, client_ref, client_name, source] = params;
        posts.set(String(id), { id, company_id, body, overrides, media, status, scope, owner_user_id, first_comment, client_kind, client_ref, client_name, source, scheduled_at: null });
      }
      if (sql.startsWith(`INSERT INTO ${T("destinations")}`)) destinations.push({ post_id: String(params[2]), account_id: String(params[3]), status: "pending" });
      return 1;
    },
  });
  return { ctx, posts, destinations };
}

describe("scope input", () => {
  it("reads client, the flat pair, and own work", () => {
    expect(scopeInput({})).toBeUndefined();
    expect(scopeInput({ client: "contact:ct1" })).toEqual({ kind: "contact", id: "ct1" });
    expect(scopeInput({ clientRef: "c1" })).toEqual({ kind: "company", id: "c1" });
    expect(scopeInput({ clientRef: "ct1", clientKind: "contact" })).toEqual({ kind: "contact", id: "ct1" });
    expect(scopeInput({ client: null })).toBeNull();
    expect(scopeInput({ client: "own" })).toBeNull();
    expect(scopeInput({ clientRef: "" })).toBeNull();
  });

  it("refuses a malformed client instead of falling back to own work", () => {
    expect(() => scopeInput({ client: "acme" })).toThrow(/company:<id>/);
    expect(() => scopeInput({ client: "company:bad id" })).toThrow(/company:<id>/);
    expect(() => scopeInput({ clientRef: "c1", clientKind: "person" })).toThrow(/clientKind/);
  });
});

describe("social.load is scoped in SQL", () => {
  const scopedTables = ["accounts", "posts", "media_assets", "rss_feeds", "inbox_items"];

  it("own work reads only rows without a client and sends no CRM list", async () => {
    const { ctx } = world([]);
    const snapshot = await loadSnapshot(ctx, VIEWER, {});
    expect(snapshot.scope).toBeNull();
    expect(snapshot.client).toBeNull();
    expect(snapshot).not.toHaveProperty("clients");
    for (const t of scopedTables) {
      const q = ctx.fakeDb.queries.find((x) => x.sql.includes(`FROM ${T(t)} WHERE company_id = $1`));
      expect(q?.sql, t).toContain("client_ref IS NULL");
      expect(q?.params[0]).toBe("co");
    }
    const dest = ctx.fakeDb.queries.find((x) => x.sql.includes(`FROM ${T("destinations")} d`));
    expect(dest?.sql).toContain("p.client_ref IS NULL");
    expect(ctx.fakeDb.queries.some((x) => x.sql.includes("crm_"))).toBe(false);
  });

  it("a contact's workspace reads only that contact's rows and names the client", async () => {
    const { ctx } = world([]);
    const snapshot = await loadSnapshot(ctx, VIEWER, { client: "contact:ct1" });
    expect(snapshot.scope).toBe("contact:ct1");
    expect(snapshot.client).toMatchObject({ kind: "contact", id: "ct1", name: "Sam Sole", email: "sam@sole.test", client: "contact:ct1" });
    for (const t of scopedTables) {
      const q = ctx.fakeDb.queries.find((x) => x.sql.includes(`FROM ${T(t)} WHERE company_id = $1`));
      expect(q?.sql, t).toContain("client_ref = $3 AND COALESCE(client_kind, 'company') = $2");
      expect(q?.params.slice(0, 3)).toEqual(["co", "contact", "ct1"]);
    }
  });

  it("an unknown client is an error the page can show", async () => {
    const { ctx } = world([]);
    await expect(loadSnapshot(ctx, VIEWER, { client: "company:gone" })).rejects.toThrow(/Unknown client company:gone/);
  });

  it("shows a pending account choice only in the scope it was started from", async () => {
    const pickers = [
      { picker_id: "p-own", platform: "facebook", extra: {} },
      { picker_id: "p-acme", platform: "linkedin", extra: { clientKind: "company", clientRef: "c1", clientName: "Acme" } },
    ];
    const base = world([]).ctx;
    const ctx = fakeCtx(
      { config: base.config, agents: base.agents },
      { queryResult: (sql, params) => (sql.includes(T("oauth_sessions")) ? pickers : sql.includes(T("crm_companies")) && params[1] === "c1" ? [{ id: "c1", name: "Acme", domain: null, lifecycle: null }] : []) },
    );
    expect((await loadSnapshot(ctx, VIEWER, {})).pendingPickers.map((p) => p.pickerId)).toEqual(["p-own"]);
    expect((await loadSnapshot(ctx, VIEWER, { client: "company:c1" })).pendingPickers.map((p) => p.pickerId)).toEqual(["p-acme"]);
  });
});

describe("strict scope: a post only uses its own client's accounts and media", () => {
  it("refuses another client's account and writes nothing", async () => {
    const { ctx, posts, destinations } = world([account("a-acme", ACME)]);
    await expect(createPostRecord(ctx, VIEWER, { body: "Hi", client: "contact:ct1", accountIds: ["a-acme"] })).rejects.toThrow(/belongs to Acme; this post is for Sam Sole/);
    expect(posts.size).toBe(0);
    expect(destinations).toHaveLength(0);
  });

  it("refuses a client's account for own work (no more 'no client fits everyone')", async () => {
    const { ctx } = world([account("a-acme", ACME)]);
    await expect(createPostRecord(ctx, VIEWER, { body: "Hi", accountIds: ["a-acme"] })).rejects.toThrow(/this post is for own work/);
  });

  it("refuses an own-work account for a client post", async () => {
    const { ctx } = world([account("a-own", null)]);
    await expect(createPostRecord(ctx, VIEWER, { body: "Hi", clientKind: "company", clientRef: "c1", accountIds: ["a-own"] })).rejects.toThrow(/belongs to own work/);
  });

  it("creates the post in its scope with matching accounts", async () => {
    const { ctx, posts, destinations } = world([account("a-sam", SAM)]);
    const post = await createPostRecord(ctx, VIEWER, { body: "Hi", client: "contact:ct1", accountIds: ["a-sam"] });
    expect(post).toMatchObject({ client: "contact:ct1", clientKind: "contact", clientRef: "ct1", clientName: "Sam Sole" });
    expect([...posts.values()][0]).toMatchObject({ client_kind: "contact", client_ref: "ct1", client_name: "Sam Sole" });
    expect(destinations).toEqual([expect.objectContaining({ account_id: "a-sam" })]);
  });

  it("attach-destination checks the account's scope against the post", async () => {
    const { ctx, posts } = world([account("a-own", null), account("a-acme", ACME)]);
    const post = await createPostRecord(ctx, VIEWER, { body: "Own post" });
    expect(posts.get(post.id)).toMatchObject({ client_ref: null, client_kind: null });
    await expect(attachDestination(ctx, VIEWER, { postId: post.id, accountId: "a-acme" })).rejects.toThrow(/belongs to Acme/);
    await expect(attachDestination(ctx, VIEWER, { postId: post.id, accountId: "a-own" })).resolves.toMatchObject({ id: post.id });
  });

  it("refuses media from another scope", async () => {
    const assets = [{ id: "m1", name: "logo.png", url: "https://m/logo.png", kind: "image", client_kind: "company", client_ref: "c1", client_name: "Acme" }];
    const { ctx } = world([], { assets });
    await expect(mediaFromAssetIds(ctx, "co", ["m1"], null)).rejects.toThrow(/Media "logo.png" belongs to Acme/);
    await expect(mediaFromAssetIds(ctx, "co", ["m1"], { kind: "company", id: "c1" })).resolves.toHaveLength(1);
  });

  it("validation flags a legacy destination on another scope's account", async () => {
    const { ctx, posts, destinations } = world([account("a-own", null)]);
    posts.set("legacy", { id: "legacy", company_id: "co", body: "Old", overrides: {}, media: [], status: "draft", scope: "org", client_kind: "company", client_ref: "c1", client_name: "Acme" });
    destinations.push({ post_id: "legacy", account_id: "a-own", status: "pending" });
    const result = await validatePostRecord(ctx, VIEWER, "legacy");
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("Page a-own belongs to own work, not Acme");
  });
});

describe("moving an account between scopes", () => {
  it("is refused while unpublished posts of the old scope use it", async () => {
    const { ctx } = world([account("a-own", null)], { blocking: [{ post_id: "p1", post_status: "scheduled", client_ref: null, client_name: null }] });
    await expect(updateAccountRecord(ctx, VIEWER, { accountId: "a-own", client: "company:c1" })).rejects.toThrow(/cannot move to Acme: 1 unpublished post for own work still uses it \(1 scheduled\)/);
    expect(ctx.fakeDb.executes.some((x) => x.sql.includes("SET client_kind"))).toBe(false);
  });

  it("moves the account and its inbox, and drops it from the old scope's feeds", async () => {
    const { ctx } = world([account("a-own", null)]);
    const out = await updateAccountRecord(ctx, VIEWER, { accountId: "a-own", client: "contact:ct1" });
    expect(out).toMatchObject({ moved: true });
    const writes = ctx.fakeDb.executes.map((x) => x.sql);
    expect(writes.find((sql) => sql.startsWith(`UPDATE ${T("accounts")} SET client_kind`))).toBeTruthy();
    expect(writes.find((sql) => sql.startsWith(`UPDATE ${T("inbox_items")} SET client_kind`))).toBeTruthy();
    expect(writes.find((sql) => sql.includes("array_remove(account_ids, $1)"))).toContain("NOT COALESCE((client_ref = $4 AND COALESCE(client_kind, 'company') = $3), false)");
    const move = ctx.fakeDb.executes.find((x) => x.sql.startsWith(`UPDATE ${T("accounts")} SET client_kind`))!;
    expect(move.params).toEqual(["a-own", "co", "contact", "ct1", "Sam Sole"]);
  });

  it("leaves the scope alone when the client is not changed", async () => {
    const { ctx } = world([account("a-acme", ACME)]);
    await updateAccountRecord(ctx, VIEWER, { accountId: "a-acme", client: "company:c1" });
    expect(ctx.fakeDb.executes.some((x) => x.sql.includes("SET client_kind"))).toBe(false);
  });
});

describe("OAuth return path keeps the workspace", () => {
  it("adds the session's client to the Social path", async () => {
    const { ctx } = world([]);
    expect(await socialPath(ctx, "co", { connected: "facebook" })).toBe("/PIB/social?tab=accounts&connected=facebook");
    const path = await socialPath(ctx, "co", { picker: "pk1" }, { kind: "contact", id: "ct1" });
    expect(path).toBe("/PIB/social?tab=accounts&picker=pk1&client=contact%3Act1");
    expect(new URLSearchParams(path!.split("?")[1]).get("client")).toBe("contact:ct1");
  });
});

describe("client-summary route", () => {
  const summaryRow = { connected: "4", needs_reconnect: "1", scheduled_week: "6", failed: "2", last_published: new Date("2026-09-20T08:00:00Z") };

  it("summarises one client's social work", async () => {
    const ctx = fakeCtx({}, { queryResult: () => [summaryRow] });
    const summary = await clientSummaryRecord(ctx, "co", { kind: "company", id: "c1" });
    expect(summary.headline).toBe("4 accounts · 6 scheduled · 2 failed · 1 to reconnect");
    expect(summary.stats).toEqual([
      { label: "Connected accounts", value: 4, tone: "ok" },
      { label: "Needs reconnect", value: 1, tone: "warn" },
      { label: "Scheduled (next 7 days)", value: 6 },
      { label: "Failed posts (30 days)", value: 2, tone: "bad" },
      { label: "Last published", value: "2026-09-20" },
    ]);
    const q = ctx.fakeDb.queries[0]!;
    expect(q.params).toEqual(["co", "company", "c1"]);
    expect(q.sql).toContain("client_ref = $3 AND COALESCE(client_kind, 'company') = $2");
  });

  it("uses the host-resolved company and validates kind and id", async () => {
    const ctx = fakeCtx({}, { queryResult: () => [{ connected: 0, needs_reconnect: 0, scheduled_week: 0, failed: 0, last_published: null }] });
    const base = { routeKey: "client-summary", method: "GET", path: "/client-summary", params: {}, body: null, actor: { actorType: "user" as const, actorId: "u" }, headers: {} };
    expect((await handleClientSummary(ctx, { ...base, companyId: "co", query: { companyId: "co", kind: "person", id: "x" } })).status).toBe(400);
    expect((await handleClientSummary(ctx, { ...base, companyId: "co", query: { companyId: "co", kind: "contact", id: "" } })).status).toBe(400);
    expect((await handleClientSummary(ctx, { ...base, companyId: "co", query: { companyId: "co", kind: "contact", id: "bad id" } })).status).toBe(400);
    const ok = await handleClientSummary(ctx, { ...base, companyId: "co", query: { companyId: "other", kind: "contact", id: "ct1" } });
    expect(ok).toEqual({ status: 200, body: { headline: "No social accounts yet", stats: expect.any(Array) } });
    expect(ctx.fakeDb.queries[0]!.params).toEqual(["co", "contact", "ct1"]);
  });
});

describe("issues for client work", () => {
  function issueCtx() {
    const create = vi.fn(async () => ({ id: "issue-1" }));
    const ctx = fakeCtx({
      issues: { create, requestWakeup: vi.fn(async () => ({})) },
      agents: { managed: { get: vi.fn(async () => { throw new Error("no agent"); }) } },
      projects: { managed: { get: vi.fn(async () => ({ projectId: "proj" })) } },
      companies: { get: vi.fn(async () => ({ id: "co", defaultResponsibleUserId: "owner" })) },
    });
    return { ctx, create };
  }
  const post = (scope: { kind: "company" | "contact"; id: string; name: string } | null) => ({
    id: "p1", company_id: "co", body: "Hello", overrides: {}, media: [], status: "failed" as const, scheduled_at: null, scope: "org" as const,
    owner_user_id: "user-1", client_kind: scope?.kind ?? null, client_ref: scope?.id ?? null, client_name: scope?.name ?? null, first_comment: null,
    source: "manual", source_ref: null, failure_issue_id: null, published_at: null, error: null, created_by_agent_id: null, created_at: null, updated_at: null,
  });

  it("prefix the title with the client name and state the scope for the agent", async () => {
    const { ctx, create } = issueCtx();
    await openPublishFailureIssue(ctx, { companyId: "co", post: post(SAM), failed: [], published: 0 });
    const input = (create.mock.calls[0] as unknown as [{ title: string; description: string }])[0];
    expect(input.title).toBe("[Sam Sole] Social post failed to publish");
    expect(input.description).toContain('clientKind: "contact"');
    expect(input.description).toContain('clientRef: "ct1"');
    await openReconnectIssue(ctx, "co", account("a1", ACME), "Token expired");
    expect((create.mock.calls[1] as unknown as [{ title: string }])[0].title).toBe("[Acme] Reconnect Facebook: Page a1");
  });

  it("leave own work unprefixed", async () => {
    const { ctx, create } = issueCtx();
    await openPublishFailureIssue(ctx, { companyId: "co", post: post(null), failed: [], published: 0 });
    const input = (create.mock.calls[0] as unknown as [{ title: string; description: string }])[0];
    expect(input.title).toBe("Social post failed to publish");
    expect(input.description).toContain("Scope: own work");
  });
});

describe("migration 011", () => {
  it("is on disk", () => {
    expect(existsSync(new URL("../migrations/011_social.sql", import.meta.url))).toBe(true);
  });
});
