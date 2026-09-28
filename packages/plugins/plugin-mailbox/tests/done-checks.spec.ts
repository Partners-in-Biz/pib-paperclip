import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { flowStagesFor, type DoneCheckIssue } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { NAMESPACE, PLUGIN_ID } from "../src/namespace.js";
import { SqlStore } from "../src/db.js";
import { cockpitSnapshot } from "../src/cockpit.js";
import { checkReplyThread, mailboxDoneChecks, needsReply, parseReplyOrigin, replyOrigin, unansweredMessage } from "../src/done-checks.js";
import type { MessageRow } from "../src/gmail/types.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

const CO = "co-1";
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function message(id: string, extra: Partial<MessageRow> = {}): MessageRow {
  return {
    id, company_id: CO, account_id: "acc-1", subject: "Can we move the launch?", body: "", direction: "inbound", status: "synced", created_at: ago(60), read_at: null,
    gmail_message_id: `g-${id}`, gmail_thread_id: "th-1", rfc_message_id: null, in_reply_to: null, refs: [], from_addr: { email: "ada@acme.test", name: "Ada" },
    to_addrs: [], cc_addrs: [], bcc_addrs: [], snippet: "", labels: [], attachments: [], bulk: false, received_at: ago(60), triage: null, triaged_at: ago(59),
    category: "client", urgency: 2, needs_reply: 0.9, phishing: 0, client_kind: null, client_ref: null, reply_to: null, sent_context: null, send_key: null, draft: null,
    send_error: null, bounce: null, ...extra,
  };
}

/** A reply draft saved `minutesAgo`, answering the thread. */
function draft(id: string, minutesAgo: number, status = "draft"): MessageRow {
  return message(id, { direction: "outbound", status, gmail_message_id: null, gmail_thread_id: null, received_at: null, created_at: ago(minutesAgo), category: null, needs_reply: null, draft: { replyToMessageId: "m1", threadId: "th-1" } });
}

const issue = (extra: Partial<DoneCheckIssue> = {}): DoneCheckIssue => ({ id: "iss-1", companyId: CO, identifier: "PIB-7", title: "Reply needed", originId: replyOrigin("acc-1", "th-1"), assigneeAgentId: "agent-am", createdAt: ago(58), ...extra });
const store = (rows: MessageRow[]) => ({ replyThread: vi.fn(async () => rows) });

describe("reply issue origin", () => {
  it("is mailbox:reply:<account>:<thread>, one rule for it", () => {
    expect(replyOrigin("acc-1", "th-1")).toBe("mailbox:reply:acc-1:th-1");
    expect(parseReplyOrigin("mailbox:reply:acc-1:th-1")).toEqual({ accountId: "acc-1", threadId: "th-1" });
    for (const bad of ["thread:acc-1:th-1", "mailbox:reply:acc-1", "mailbox:reply::th", null]) expect(parseReplyOrigin(bad)).toBeNull();
    expect(mailboxDoneChecks(store([])).map((rule) => [rule.originPrefix, rule.label])).toEqual([["mailbox:reply:", "Reply needed"]]);
  });
});

describe("reply done-check", () => {
  it("reopens while the newest mail that needs a reply has no answer, naming it", async () => {
    const result = await checkReplyThread(store([message("m1")]), issue());
    expect(result).toEqual({
      done: false,
      missing: ['"Can we move the launch?" from Ada <ada@acme.test> still has no reply: draft one with `create-draft` (accountId `acc-1`, replyToMessageId `m1`), or `correct-triage` it with needsReply false when no reply is needed.'],
    });
  });

  it("passes on a reply draft, a queued draft, or a reply sent from the Mailbox or Gmail", async () => {
    expect(await checkReplyThread(store([message("m1"), draft("d1", 10)]), issue())).toEqual({ done: true });
    expect(await checkReplyThread(store([message("m1"), draft("d1", 10, "queued")]), issue())).toEqual({ done: true });
    const sentFromGmail = message("s1", { direction: "outbound", status: "sent", received_at: ago(5), category: null, needs_reply: null });
    expect(await checkReplyThread(store([message("m1"), sentFromGmail]), issue())).toEqual({ done: true });
  });

  it("passes when nothing needs a reply any more (needsReply corrected, or another category)", async () => {
    expect(await checkReplyThread(store([message("m1", { needs_reply: 0 })]), issue())).toEqual({ done: true });
    expect(await checkReplyThread(store([message("m1", { category: "newsletter" })]), issue())).toEqual({ done: true });
    expect(await checkReplyThread(store([]), issue())).toEqual({ done: true });
  });

  it("an answer to an older message does not answer a newer one", async () => {
    const newer = message("m2", { received_at: ago(20), subject: "Re: Can we move the launch?" });
    const waiting = unansweredMessage([message("m1"), draft("d1", 40), newer], "acc-1");
    expect(waiting?.id).toBe("m2");
    // A "thanks" that needs no reply leaves the thread answered.
    expect(unansweredMessage([message("m1"), draft("d1", 40), { ...newer, needs_reply: 0.1 }], "acc-1")).toBeNull();
  });

  it("ignores phishing, bulk mail and another mailbox's messages", () => {
    expect(needsReply(message("m1", { phishing: 0.95 }))).toBe(false);
    expect(needsReply(message("m1", { bulk: true }))).toBe(false);
    expect(needsReply(message("m1", { direction: "outbound" }))).toBe(false);
    expect(unansweredMessage([message("m1", { account_id: "acc-2" })], "acc-1")).toBeNull();
  });
});

describe("the store query", () => {
  it("reads the thread and its drafts in one guarded statement", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const s = new SqlStore({
      namespace: NAMESPACE,
      async query<T>(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE);
        validateParams(sql, params);
        calls.push({ sql, params });
        return [message("m1", { created_at: new Date(Date.parse(ago(60))) as unknown as string })] as T[];
      },
      async execute() {
        return { rowCount: 0 };
      },
    });
    const rows = await s.replyThread(CO, "th-1");
    expect(calls[0]!.sql).toContain("(gmail_thread_id = $2 OR draft ->> 'threadId' = $2)");
    expect(calls[0]!.params).toEqual([CO, "th-1"]);
    expect(typeof rows[0]!.created_at).toBe("string");
  });
});

describe("closing through the kit loop (issue.updated)", () => {
  async function boot(rows: MessageRow[]) {
    const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.example.com", encryptionKey: "x".repeat(20) } });
    const db = {
      namespace: NAMESPACE,
      async query(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE);
        validateParams(sql, params);
        return sql.includes("draft ->> 'threadId'") ? rows : [];
      },
      async execute(sql: string, params: unknown[] = []) {
        validateRuntimeExecute(sql, NAMESPACE);
        validateParams(sql, params);
        return { rowCount: 1 };
      },
    };
    (harness.ctx as unknown as { db: typeof db }).db = db;
    await plugin.definition.setup(harness.ctx);
    const created = await harness.ctx.issues.create({ companyId: CO, title: "Reply needed: Can we move the launch?", originKind: `plugin:${PLUGIN_ID}`, originId: replyOrigin("acc-1", "th-1"), assigneeAgentId: "agent-am", status: "todo" });
    const comments = vi.spyOn(harness.ctx.issues, "createComment");
    const close = async (actorType: "agent" | "user") => {
      harness.seed({ issues: [{ ...(await harness.ctx.issues.get(created.id, CO))!, status: "done" }] });
      await harness.emit("issue.updated", {}, { companyId: CO, entityId: created.id, actorType, actorId: actorType === "agent" ? "agent-am" : "user-peet" });
      return (await harness.ctx.issues.get(created.id, CO))!.status;
    };
    return { harness, close, comments };
  }

  it("an agent's close with no reply is reopened with what is missing", async () => {
    const { close, comments } = await boot([message("m1")]);
    expect(await close("agent")).toBe("todo");
    expect(String(comments.mock.calls[0]![1])).toMatch(/^\*\*Not done yet\*\* \(Reply needed\):\n- "Can we move the launch\?" from Ada <ada@acme.test> still has no reply/);
  });

  it("a drafted reply lets the close stand, and a person's close is never checked", async () => {
    expect(await (await boot([message("m1"), draft("d1", 5)])).close("agent")).toBe("done");
    expect(await (await boot([message("m1")])).close("user")).toBe("done");
  });
});

describe("company graph", () => {
  it("the Mailbox owns no stage, so its snapshot reports no flows", async () => {
    expect(flowStagesFor(PLUGIN_ID)).toEqual([]);
    const harness = createTestHarness({ manifest, config: {} });
    const db = { namespace: NAMESPACE, query: async () => [], execute: async () => ({ rowCount: 0 }) };
    (harness.ctx as unknown as { db: typeof db }).db = db;
    const snap = await cockpitSnapshot(harness.ctx, CO);
    expect(snap.flows).toBeUndefined();
  });
});
