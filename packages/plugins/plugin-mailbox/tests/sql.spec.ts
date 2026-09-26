import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { crmProjectionMigration, decisionsMigration, inboxMigration } from "@partnersinbiz/pib-plugin-kit";
import { SqlStore, type DbClient } from "../src/db.js";
import { NAMESPACE } from "../src/namespace.js";
import type { SendRecordInput } from "../src/gmail/types.js";
import { splitSqlStatements, validateMigrationStatement, validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

const migrationsDir = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

describe("migrations", () => {
  it("keeps 001–002 and adds 003–006", () => {
    expect(files).toEqual(["001_mailbox.sql", "002_mailbox.sql", "003_gmail.sql", "004_crm_projection.sql", "005_decisions_inbox.sql", "006_bounces.sql"]);
  });

  it("pass the host migration guard statement by statement", () => {
    for (const file of files.slice(2)) {
      const sql = readFileSync(new URL(file, migrationsDir), "utf8");
      const statements = splitSqlStatements(sql);
      expect(statements.length, file).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(() => validateMigrationStatement(statement, NAMESPACE), `${file}: ${statement.slice(0, 80)}`).not.toThrow();
      }
    }
  });

  it("uses the kit's projection, decisions and inbox SQL verbatim", () => {
    expect(readFileSync(new URL("004_crm_projection.sql", migrationsDir), "utf8").trim()).toBe(crmProjectionMigration(NAMESPACE).trim());
    expect(readFileSync(new URL("005_decisions_inbox.sql", migrationsDir), "utf8").trim()).toBe(`${decisionsMigration(NAMESPACE)}\n${inboxMigration(NAMESPACE)}`.trim());
    const gmail = readFileSync(new URL("003_gmail.sql", migrationsDir), "utf8");
    for (const table of ["send_requests", "oauth_sessions", "thread_issues"]) expect(gmail).toContain(`CREATE TABLE ${NAMESPACE}.${table}`);
    for (const column of ["gmail_message_id", "gmail_thread_id", "rfc_message_id", "in_reply_to", "refs", "from_addr", "to_addrs", "cc_addrs", "snippet", "labels", "received_at", "triage", "client_kind", "client_ref", "category", "needs_reply", "sent_context", "history_id"]) {
      expect(gmail).toContain(`ADD COLUMN ${column} `);
    }
  });
});

function guardedDb(rows: Record<string, unknown>[] = []) {
  const calls: Array<{ kind: string; sql: string }> = [];
  const db: DbClient = {
    namespace: NAMESPACE,
    async query<T>(sql: string, params: unknown[] = []) {
      validateRuntimeQuery(sql, NAMESPACE);
      validateParams(sql, params);
      calls.push({ kind: "query", sql });
      return rows as T[];
    },
    async execute(sql: string, params: unknown[] = []) {
      validateRuntimeExecute(sql, NAMESPACE);
      validateParams(sql, params);
      calls.push({ kind: "execute", sql });
      return { rowCount: 1 };
    },
  };
  return { db, calls };
}

describe("runtime SQL passes the host guard", () => {
  it("covers every store method", async () => {
    const { db, calls } = guardedDb();
    const s = new SqlStore(db);
    const c = "co-1";
    const input: SendRecordInput = {
      key: "k",
      companyId: c,
      sourcePlugin: "partnersinbiz.billing",
      accountId: "a",
      fromAddress: "x@y.co",
      to: [{ email: "a@b.co" }],
      subject: "s",
      context: { plugin: "p", kind: "k", id: "i" },
      request: { key: "k", to: [], subject: "s", context: { plugin: "p", kind: "k", id: "i" } },
    };
    await s.listSyncAccounts();
    await s.listAccounts(c);
    await s.getAccount(c, "a");
    await s.findAccountByAddress(c, "x@y.co");
    await s.defaultAccount(c);
    await s.insertAccount({ id: "a", companyId: c, provider: "gmail", address: "x@y.co", ownerUserId: null, isDefault: true });
    await s.updateAccount(c, "a", { status: "connected", token_sealed: "v1.x", token_expires_at: new Date().toISOString(), sync_stats: { a: 1 }, is_default: false, key_version: 1 });
    await s.updateAccount(c, "a", {});
    await s.markNeedsReconnect(c, "a", "boom");
    await s.setDefaultAccount(c, "a");
    await s.tryLockSync("a", 300);
    await s.unlockSync("a");
    await s.mergeLabelIds("a", { "PiB/Lead": "Label_1" });
    await s.existingGmailIds("a", ["m1", "m2"]);
    await s.existingGmailIds("a", []);
    await s.insertGmailMessage({
      id: "gm_a_m1", companyId: c, accountId: "a", direction: "inbound", status: "synced", subject: "s", gmailMessageId: "m1", gmailThreadId: "t1",
      rfcMessageId: "<x@y>", inReplyTo: null, refs: [], from: { email: "a@b.co" }, to: [], cc: [], snippet: "", labels: ["INBOX"], attachments: [], bulk: false,
      receivedAt: new Date().toISOString(), read: false,
    });
    await s.updateLabels("a", "m1", ["INBOX", "UNREAD"]);
    await s.untriaged("a", 10);
    await s.setTriage(c, "gm_a_m1", { triage: {} as never, category: "lead", urgency: 1, needsReply: 0.5, phishing: 0, clientKind: null, clientRef: null, replyTo: null });
    await s.recentInbound("a", 30, 200);
    await s.getMessage(c, "id");
    await s.getMessageByGmailId(c, "m1");
    await s.getMessageByRfcId(c, "<x@y>");
    await s.outboundByRfcIds(c, ["<x@y>"]);
    await s.outboundInThread(c, "t1");
    await s.latestInThread(c, "t1");
    await s.listInbox(c, { limit: 10 });
    await s.listInbox(c, { accountId: "a", category: "lead", needsReply: true, clientKind: "company", clientRef: "r", limit: 10 });
    await s.markDraftSent(c, "d", { gmailMessageId: "g", gmailThreadId: "t", rfcMessageId: null, accountId: "a", fromAddress: "x@y.co", context: input.context, sendKey: "k" });
    await s.setDraftStatus(c, "d", "draft", "err");
    await s.recentClaims("a");
    await s.claimSend(input, false);
    await s.recordSendFailure(input, "bad", true);
    await s.markRetrying(input, "later");
    await s.markSendSent("k", { gmailMessageId: "g", gmailThreadId: "t", rfcMessageId: "<r>", accountId: "a", fromAddress: "x@y.co" });
    await s.getSend(c, "k");
    await s.listSends(c, { limit: 10 });
    await s.listSends(c, { status: "failed", limit: 10 });
    await s.sendByThread(c, "t");
    await s.sendsByRfcIds(c, ["<r>"]);
    await s.sendToRecipient(c, "a@b.co");
    await s.setInboxResult("k", { status: "sent" });
    await s.claimThreadIssue(c, "a", "t");
    await s.setThreadIssue("a", "t", "issue-1");
    await s.insertOAuthSession({ state: "st", companyId: c, createdByUserId: "u", returnTo: "/x", ttlSeconds: 900 });
    await s.getOAuthSession("st");
    await s.deleteOAuthSession("st");
    await s.crmContactsByEmail(c, "a@b.co");
    await s.crmCompaniesByDomain(c, "b.co");
    await s.crmCompany(c, "crm-1");
    await s.crmClients(c, 100);
    await s.listDelegations(c);
    await s.insertLegacyAccount({ id: "a2", companyId: c, provider: "gmail", address: "z@y.co", secretRef: null, ownerUserId: null });
    await s.insertDelegation({ id: "d1", companyId: c, accountId: "a", agentId: "ag", canRead: true, canDraft: true, canSend: false });
    await s.delegationFor("a", "ag");
    await s.readableAccounts(c, "ag");
    await s.insertDraft({ id: "d2", companyId: c, accountId: "a", subject: "s", body: "b", to: [{ email: "a@b.co" }], cc: [], bcc: [], draft: { html: null } });
    await s.recentMessages(c, 50);
    await s.unreadCount(c);
    await s.markRead(c, "m");
    await s.threadRows(c, "a", 10);
    await s.threadRows(c, null, 10);
    await s.listTemplates(c);
    await s.insertTemplate({ id: "t", companyId: c, name: "n", subject: "s", body: "b" });
    await s.sendCounts(c);
    await s.categoryCounts(c);
    expect(calls.length).toBeGreaterThan(60);
  });

  it("refuses an unsafe namespace", () => {
    const store = new SqlStore({ namespace: "public; drop", query: async () => [], execute: async () => ({ rowCount: 0 }) });
    expect(() => store.t("accounts")).toThrow(/Unsafe/);
  });
});
