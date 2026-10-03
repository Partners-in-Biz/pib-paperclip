import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { crmProjectionMigration, decisionsMigration, inboxMigration, outboxMigration } from "@partnersinbiz/pib-plugin-kit";
import { SqlStore, type DbClient } from "../src/db.js";
import { NAMESPACE } from "../src/namespace.js";
import type { SendRecordInput } from "../src/gmail/types.js";
import { splitSqlStatements, validateMigrationStatement, validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

const migrationsDir = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

describe("migrations", () => {
  it("keeps 001–007 untouched and adds 008", () => {
    expect(files).toEqual(["001_mailbox.sql", "002_mailbox.sql", "003_gmail.sql", "004_crm_projection.sql", "005_decisions_inbox.sql", "006_bounces.sql", "007_suppressions_outbox.sql", "008_wave3_delegations_senders_domains.sql"]);
  });

  it("008 adds delegation provenance and removals, client mailboxes, per-sender do-not-email rows with erased markers, client mail maps and domain checks", () => {
    const sql = readFileSync(new URL("008_wave3_delegations_senders_domains.sql", migrationsDir), "utf8");
    for (const table of ["delegation_removals", "client_mail_maps", "domain_checks"]) expect(sql).toContain(`CREATE TABLE ${NAMESPACE}.${table}`);
    for (const column of ["source text NOT NULL DEFAULT 'manual'", "granted_by text", "client_kind text", "client_ref text", "from_name text", "sender_key text NOT NULL DEFAULT ''", "email_hash text", "erased_at timestamptz", "reply_to_addr jsonb", "map_state text", "map_id text"]) {
      expect(sql).toContain(column);
    }
    // One do-not-email row per address and sender; the old primary key (company, address) is replaced, never edited in 007.
    expect(sql).toContain("DROP CONSTRAINT suppressions_pkey");
    expect(sql).toContain("ADD PRIMARY KEY (company_id, email, sender_key)");
    expect(sql).toContain("CHECK (match_type IN ('sender_domain', 'sender_address', 'recipient_domain', 'recipient_address'))");
    expect(sql).toContain("CHECK (status IN ('healthy', 'warn', 'bad', 'unknown'))");
    for (const line of sql.split("\n").filter((l) => l.trim().startsWith("--"))) expect(line).not.toMatch(/['"]/);
    // An applied migration is never edited: 007 still has its original primary key.
    expect(readFileSync(new URL("007_suppressions_outbox.sql", migrationsDir), "utf8")).toContain("PRIMARY KEY (company_id, email),");
  });

  it("adds the do-not-email list and the kit outbox, with no quotes in comments", () => {
    const sql = readFileSync(new URL("007_suppressions_outbox.sql", migrationsDir), "utf8");
    expect(sql).toContain(`CREATE TABLE ${NAMESPACE}.suppressions`);
    expect(sql).toContain("CHECK (scope IN ('marketing', 'all'))");
    expect(sql).toContain(outboxMigration(NAMESPACE).trim());
    for (const line of sql.split("\n").filter((l) => l.trim().startsWith("--"))) expect(line).not.toMatch(/['"]/);
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
    await s.replyThread(c, "t1");
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
    await s.dailyCounts(c, 14);
    await s.suppressionsFor(c, ["A@b.co", "x@y.co"]);
    await s.suppressionsFor(c, []);
    await s.upsertSuppression({ companyId: c, email: "a@b.co", scope: "marketing", reason: "unsubscribed", source: "partnersinbiz.crm" });
    await s.listSuppressions(c, 50);
    await s.ownSuppressionsSince("partnersinbiz.mailbox", new Date().toISOString(), 100);
    await s.recordSendFailure(input, "suppressed", true, [{ email: "a@b.co", scope: "all", reason: "bounced" }]);
    // 0.5.0: client mailboxes, delegations that stay removed, per-sender rows, mappings, domain checks and erasure.
    await s.setAccountClient(c, "a", { clientKind: "company", clientRef: "crm-1", fromName: "Acme" });
    await s.setAccountClient(c, "a", { clientKind: null, clientRef: null });
    await s.hasDelegationRemoval("a", "ag");
    await s.insertDefaultDelegation({ id: "d3", companyId: c, accountId: "a", agentId: "ag", canRead: true, canDraft: true, canSend: false, grantedBy: "default:operator" });
    await s.grantDelegation({ id: "d4", companyId: c, accountId: "a", agentId: "ag", canRead: true, canDraft: true, canSend: false, source: "ask", grantedBy: "user-1" });
    await s.removeDelegation(c, "a", "ag", "user-1");
    await s.deleteDefaultDelegations(c, "a");
    await s.upsertSuppression({ companyId: c, email: "A@b.co", scope: "marketing", reason: "unsubscribed", source: "partnersinbiz.mailbox", senderKey: "company:crm-1" });
    await s.crmContact(c, "crm-1");
    await s.listClientMaps(c);
    await s.insertClientMap({ companyId: c, matchType: "sender_domain", pattern: "ahslaw.co.za", clientKind: "company", clientRef: "crm-1", clientName: "AHS Law", note: null, createdBy: "user-1" });
    await s.deleteClientMap(c, "map_1");
    await s.unmappedSummary(c, 30);
    await s.flaggedMessages(c, 30, 200);
    await s.getDomainCheck(c, "client.co.za");
    await s.listDomainChecks(c);
    await s.upsertDomainCheck({ company_id: c, domain: "client.co.za", status: "warn", result: { problems: [] }, source: "manual", client_kind: null, client_ref: null, checked_at: new Date().toISOString(), first_checked_at: new Date().toISOString(), status_since: new Date().toISOString(), dmarc_none_since: null });
    await s.crmContactEmails(c, "crm-1");
    await s.messagesInvolving(c, ["a@b.co"]);
    await s.messagesInvolving(c, []);
    await s.threadIssueIds(c, ["t1"]);
    await s.deleteDecisionsFor(c, ["m1", "m2"]);
    await s.deleteMessages(c, ["m1", "m2"]);
    await s.sendKeysTo(c, ["a@b.co"]);
    await s.redactSends(c, ["k"]);
    await s.scrubInboxResults(c, ["k"]);
    await s.deleteLeadOutbox(c, ["a@b.co"]);
    await s.blankCrmProjection(c, "crm-1", ["a@b.co"]);
    await s.blankCrmProjection(c, null, ["a@b.co"]);
    await s.eraseSuppression({ companyId: c, email: "A@b.co", hash: "h".repeat(64), scope: "all" });
    await s.erasedMarkers(c);
    await s.markSendSent("k", { gmailMessageId: "g", gmailThreadId: "t", rfcMessageId: "<r>", accountId: "a", fromAddress: "x@y.co", skipped: [{ email: "c@d.co", scope: "marketing", reason: "unsubscribed" }] });
    expect(calls.length).toBeGreaterThan(90);
  });

  it("keeps the rules the unit tests rely on in the SQL itself", async () => {
    const { db, calls } = guardedDb();
    const s = new SqlStore(db);
    await s.defaultAccount("co-1");
    await s.suppressionsFor("co-1", ["A@b.co"]);
    await s.upsertSuppression({ companyId: "co-1", email: "a@b.co", scope: "marketing", reason: "unsubscribed", source: "x", senderKey: "company:c1" });
    await s.messagesInvolving("co-1", ["a@b.co"]);
    await s.sendKeysTo("co-1", ["a@b.co"]);
    await s.redactSends("co-1", ["k"]);
    await s.deleteMessages("co-1", ["m1"]);
    await s.scrubInboxResults("co-1", ["k"]);
    const sql = (needle: string) => calls.map((c) => c.sql).find((text) => text.includes(needle)) ?? "";
    // A client's mailbox is never the default sender.
    expect(sql("ORDER BY is_default DESC")).toContain("client_ref IS NULL");
    // An erased person's marker is found by hash as well as by address.
    expect(sql("email_hash = ANY")).toContain("email = ANY");
    // One do-not-email row per address and sender.
    expect(sql("INSERT INTO plugin_mailbox")).toBeTruthy();
    expect(sql("ON CONFLICT (company_id, email, sender_key) DO NOTHING")).toContain("sender_key");
    // Erasure matches every address column: from, to, cc, bcc and the request's cc and bcc.
    expect(sql("lower(from_addr ->> 'email')")).toMatch(/to_addrs \|\| cc_addrs \|\| bcc_addrs/);
    // ...and the Reply-To: a relayed website form holds the visitor there, not in From.
    expect(sql("lower(from_addr ->> 'email')")).toContain("lower(reply_to_addr ->> 'email') = ANY");
    expect(sql("COALESCE(request -> 'cc'")).toMatch(/request -> 'cc'.*request -> 'bcc'/s);
    // A redacted send record keeps its key and status, so a repeated request is still refused as a duplicate.
    const redact = sql("SET to_addrs = '[]'::jsonb");
    expect(redact).toContain("request = jsonb_build_object('key', key, 'erased', true)");
    expect(redact).not.toMatch(/status\s*=|DELETE/);
    // Every delete is scoped to the company, and so is the scrub of a stored send result (the key alone is not enough).
    expect(sql(`DELETE FROM ${NAMESPACE}.messages`)).toContain("WHERE company_id = $1");
    expect(sql(`UPDATE ${NAMESPACE}.inbox SET result`)).toContain("WHERE company_id = $1 AND");
  });

  it("refuses an unsafe namespace", () => {
    const store = new SqlStore({ namespace: "public; drop", query: async () => [], execute: async () => ({ rowCount: 0 }) });
    expect(() => store.t("accounts")).toThrow(/Unsafe/);
  });
});
