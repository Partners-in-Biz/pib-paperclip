import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as db from "../src/db.js";
import { NAMESPACE } from "../src/namespace.js";
import { assertMigrationStatement, fakeCtx, splitStatements } from "./helpers.js";

const MIGRATIONS = new URL("../migrations/", import.meta.url);

describe("migrations", () => {
  it("uses the host namespace", () => {
    expect(NAMESPACE).toBe("plugin_social_e70c4e79f2");
  });

  it("every statement passes the host migration guard", () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    expect(files.slice(-5)).toEqual(["008_social.sql", "009_social.sql", "010_social.sql", "011_social.sql", "012_social.sql"]);
    for (const file of files) {
      for (const statement of splitStatements(readFileSync(new URL(file, MIGRATIONS), "utf8"))) {
        expect(() => assertMigrationStatement(statement), `${file}: ${statement.slice(0, 70)}`).not.toThrow();
      }
    }
  });

  it("adds the columns the code reads", () => {
    const sql = ["008_social.sql", "010_social.sql"].map((f) => readFileSync(new URL(f, MIGRATIONS), "utf8")).join("\n");
    for (const column of ["client_ref", "meta jsonb", "key_version", "first_comment", "attempts integer", "next_attempt_at", "external_url", "issue_id", "r2_key", "pending_options", "created_by_user_id", "partially_published", "ON DELETE CASCADE", "ON DELETE SET NULL"]) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain(`CREATE TABLE ${NAMESPACE}.mastodon_apps`);
    expect(sql).toContain(`CREATE TABLE ${NAMESPACE}.rss_seen_items`);
    expect(readFileSync(new URL("009_social.sql", MIGRATIONS), "utf8")).toContain(`CREATE TABLE ${NAMESPACE}.crm_companies`);
  });

  it("011 adds client_kind to every scoped table and backfills companies", () => {
    const sql = readFileSync(new URL("011_social.sql", MIGRATIONS), "utf8");
    for (const t of ["accounts", "posts", "media_assets", "rss_feeds", "inbox_items"]) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE ${NAMESPACE}\\.${t}\\s+ADD COLUMN IF NOT EXISTS client_kind text`));
      expect(sql).toContain(`UPDATE ${NAMESPACE}.${t} SET client_kind = 'company' WHERE client_ref IS NOT NULL AND client_kind IS NULL`);
      expect(sql).toContain(`CREATE INDEX IF NOT EXISTS ${t}_scope ON ${NAMESPACE}.${t}`);
    }
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS client_name text");
    expect(sql).not.toMatch(/\bDELETE\b/i);
  });
});

describe("runtime SQL passes the host guard", () => {
  it("every data-access function issues guard-compliant statements", async () => {
    const accountRow = { id: "a1", company_id: "co", platform: "facebook", meta: {}, external_id: "p1" };
    const ctx = fakeCtx({}, { queryResult: (sql) => (sql.includes(".accounts") && sql.includes("external_id = $3") ? [accountRow] : []) });
    const media = [{ assetId: "m", url: "https://m/a.jpg", kind: "image" as const, mime: null, width: null, height: null, durationS: null, altText: null, bytes: null }];
    const calls: Array<() => Promise<unknown>> = [
      () => db.listAccounts(ctx, "co"),
      () => db.listAccounts(ctx, "co", null),
      () => db.listAccounts(ctx, "co", { kind: "contact", id: "ct1" }),
      () => db.getAccountsByIds(ctx, "co", ["a1", "a2"]),
      () => db.setAccountScope(ctx, "co", "a1", { client_kind: "contact", client_ref: "ct1", client_name: "Sam" }),
      () => db.setInboxScopeForAccount(ctx, "co", "a1", { client_kind: null, client_ref: null, client_name: null }),
      () => db.detachAccountFromOtherFeeds(ctx, "co", "a1", null),
      () => db.detachAccountFromOtherFeeds(ctx, "co", "a1", { kind: "company", id: "c1" }),
      () => db.unpublishedDestinationsOutside(ctx, "co", "a1", null),
      () => db.unpublishedDestinationsOutside(ctx, "co", "a1", { kind: "company", id: "c1" }),
      () => db.destinationsForScope(ctx, "co", null),
      () => db.destinationsForScope(ctx, "co", { kind: "contact", id: "ct1" }),
      () => db.scopeSummary(ctx, "co", null),
      () => db.scopeSummary(ctx, "co", { kind: "company", id: "c1" }),
      () => db.getAccount(ctx, "co", "a1"),
      () => db.companiesWithAccounts(ctx),
      () => db.accountsExpiringBefore(ctx, "co", new Date().toISOString()),
      () => db.upsertAccount(ctx, { company_id: "co", platform: "facebook", display_name: "P", external_id: "p1", handle: null, avatar_url: null, token_enc: "v1.x", token_expires_at: null, scopes: ["a"], meta: { pageId: "p1" }, key_version: 1, client_kind: null, client_ref: null, client_name: null, created_by_user_id: "u" }),
      () => db.upsertAccount(fakeCtx(), { company_id: "co", platform: "x", display_name: "P", external_id: "x1", handle: "h", avatar_url: null, token_enc: "v1.x", token_expires_at: "2026-10-01T00:00:00Z", scopes: [], meta: {}, key_version: 1, client_kind: "company", client_ref: "c", client_name: "C", created_by_user_id: null }),
      () => db.saveAccountToken(ctx, "a1", { tokenEnc: "v1.y", keyVersion: 1, expiresAt: null, status: "connected", meta: { a: 1 } }),
      () => db.setAccountState(ctx, "a1", { status: "needs_reconnect", lastError: "x", reconnectIssueId: "i" }),
      () => db.updateAccountSettings(ctx, "co", "a1", { meta: { boardId: "b" }, status: "disabled" }),
      () => db.disconnectAccount(ctx, "co", "a1", "note"),
      () => db.lockAccountRefresh(ctx, "a1"),
      () => db.unlockAccountRefresh(ctx, "a1"),
      () => db.deleteJunkAccounts(ctx, "co"),
      () => db.flagLegacyTokens(ctx, "co"),
      () => db.createOauthSession(ctx, { state: "s", companyId: "co", platform: "x", label: "X", extra: { codeVerifier: "v" }, createdByUserId: "u", ttlSeconds: 900 }),
      () => db.getOauthSession(ctx, "s"),
      () => db.getPickerSession(ctx, "co", "p"),
      () => db.listPendingPickers(ctx, "co", "u"),
      () => db.consumeOauthSession(ctx, "s"),
      () => db.setSessionPending(ctx, "s", "p", "sealed"),
      () => db.deleteOauthSession(ctx, "s"),
      () => db.deleteExpiredOauthSessions(ctx),
      () => db.getMastodonApp(ctx, "co", "https://m.social"),
      () => db.saveMastodonApp(ctx, { companyId: "co", instanceUrl: "https://m.social", clientId: "c", clientSecretEnc: "v1.z", redirectUri: "r", keyVersion: 1 }),
      () => db.listPosts(ctx, "co", { status: "draft", scope: { kind: "company", id: "c" }, limit: 10 }),
      () => db.listPosts(ctx, "co", { scope: null }),
      () => db.listPosts(ctx, "co"),
      () => db.getPost(ctx, "co", "p"),
      () => db.insertPost(ctx, { id: "p", company_id: "co", body: "b", status: "draft", scope: "org", owner_user_id: null, media, overrides: { x: { text: "t" } }, first_comment: null, client_kind: null, client_ref: null, client_name: null, source: "manual", source_ref: null, created_by_agent_id: null }),
      () => db.updatePostContent(ctx, "co", "p", { body: "b", media, overrides: {}, firstComment: null, scope: { client_kind: "contact", client_ref: "ct", client_name: "Sam" } }),
      () => db.updatePostContent(ctx, "co", "p", { body: "b" }),
      () => db.setPostStatus(ctx, "co", "p", ["approved"], "scheduled", new Date().toISOString()),
      () => db.setPostOutcome(ctx, "p", { status: "published", error: null, publishedAt: true }),
      () => db.setPostFailureIssue(ctx, "p", "i"),
      () => db.deletePost(ctx, "co", "p"),
      () => db.duePostRefs(ctx),
      () => db.scheduledPostsWithoutWork(ctx),
      () => db.destinationsForPost(ctx, "p"),
      () => db.destinationsForCompany(ctx, "co"),
      () => db.insertDestination(ctx, { companyId: "co", postId: "p", accountId: "a" }),
      () => db.deleteDestination(ctx, "co", "p", "a"),
      () => db.claimDestinations(ctx, "p", "tok"),
      () => db.releaseStaleClaims(ctx),
      () => db.saveDestinationOutcome(ctx, "d", { status: "retrying", nextAttemptAt: new Date().toISOString(), externalId: null, externalUrl: null, lastError: "e", result: { ok: false } }),
      () => db.setDestinationIssue(ctx, "p", "i"),
      () => db.resetFailedDestinations(ctx, "co", "p"),
      () => db.publishedDestinationsForMetrics(ctx),
      () => db.recentPublishedForAccount(ctx, "a"),
      () => db.markMetricWindows(ctx, "d", ["1h", "24h"]),
      () => db.setDestinationExternal(ctx, "d", "e", null),
      () => db.listTemplates(ctx, "co"),
      () => db.insertTemplate(ctx, { id: "t", company_id: "co", name: "n", body: "b", platform: null }),
      () => db.insertMetrics(ctx, { companyId: "co", postId: "p", destinationId: "d", accountId: "a", platform: "x", window: "1h", views: 1, likes: 2, comments: 3, shares: 4, raw: { a: 1 } }),
      () => db.metricsForPost(ctx, "co", "p"),
      () => db.metricsForCompany(ctx, "co"),
      () => db.metricsForCompany(ctx, "co", null),
      () => db.metricsForCompany(ctx, "co", { kind: "company", id: "c1" }),
      () => db.accountMetrics(ctx, "co"),
      () => db.insertMediaAsset(ctx, { id: "m", company_id: "co", name: "n", url: "https://m", kind: "image", r2_key: "k", mime: "image/png", bytes: 1, width: 1, height: 1, duration_s: null, alt_text: null, client_kind: null, client_ref: null, client_name: null, source_url: null }),
      () => db.listMediaAssets(ctx, "co"),
      () => db.listMediaAssets(ctx, "co", { kind: "contact", id: "ct" }),
      () => db.getMediaAssets(ctx, "co", ["m1", "m2"]),
      () => db.insertRssFeed(ctx, { id: "f", company_id: "co", url: "https://f", account_id: null, account_ids: ["a", "b"], client_kind: null, client_ref: null, client_name: null, created_by_user_id: null }),
      () => db.listRssFeeds(ctx, "co"),
      () => db.listRssFeeds(ctx, "co", null),
      () => db.getRssFeed(ctx, "co", "f"),
      () => db.activeRssFeeds(ctx),
      () => db.setRssFeedActive(ctx, "co", "f", false),
      () => db.markRssFeedChecked(ctx, "f", { title: "t", error: null, lastItemAt: new Date().toISOString() }),
      () => db.seenRssKeys(ctx, "f", ["k1"]),
      () => db.insertRssSeen(ctx, { companyId: "co", feedId: "f", itemKey: "k", title: "t", link: null, publishedAt: null, postId: null }),
      () => db.insertInboxItem(ctx, { id: "i", company_id: "co", account_id: "a", platform: "x", kind: "mention", author: "a", body: "b", status: "new", external_id: "e" }),
      () => db.listInboxItems(ctx, "co", 10, "new"),
      () => db.listInboxItems(ctx, "co", 10, undefined, { kind: "company", id: "c1" }),
      () => db.insertInboxItem(ctx, { id: "i2", company_id: "co", account_id: "a", platform: "x", kind: "mention", author: "a", body: "b", status: "new", external_id: "e2", client_kind: "contact", client_ref: "ct", client_name: "Sam" }),
      () => db.getInboxItem(ctx, "co", "i"),
      () => db.setInboxItemStatus(ctx, "co", "i", "read"),
      () => db.saveInboxReply(ctx, "co", "i", { status: "replied", replyBody: "r", replyExternalId: "x", replied: true }),
    ];
    for (const call of calls) await call();
    expect(ctx.fakeDb.executes.length + ctx.fakeDb.queries.length).toBeGreaterThan(60);
  });
});
