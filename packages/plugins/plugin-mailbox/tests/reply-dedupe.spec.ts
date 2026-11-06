import { describe, expect, it } from "vitest";
import { SqlStore } from "../src/db.js";
import { NAMESPACE } from "../src/namespace.js";
import { newerSentReply, removeSupersededDrafts, REPLY_REUSE_WINDOW_MS, reusableReplyDraft, type ReplyDraftStore } from "../src/reply-dedupe.js";
import type { MessageRow } from "../src/gmail/types.js";
import { validateParams, validateRuntimeQuery } from "./helpers/sql-guard.js";

const CO = "co-1";
const T0 = Date.parse("2026-11-06T06:03:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

function reply(id: string, createdMs: number, extra: Partial<MessageRow> = {}): MessageRow {
  return {
    id, company_id: CO, account_id: "acc-1", subject: "Re: SlipBook", body: "Thanks", direction: "outbound", status: "draft", created_at: at(createdMs), read_at: null,
    gmail_message_id: null, gmail_thread_id: null, rfc_message_id: null, in_reply_to: null, refs: [], from_addr: null,
    to_addrs: [{ email: "ann@client.test" }], cc_addrs: [], bcc_addrs: [], snippet: "", labels: [], attachments: [], bulk: false, received_at: null, triage: null, triaged_at: null,
    category: null, urgency: null, needs_reply: null, phishing: null, client_kind: null, client_ref: null, reply_to: null, sent_context: null, send_key: null,
    draft: { replyToMessageId: "m-in", threadId: "th-1" }, send_error: null, bounce: null, reply_to_addr: null, map_state: null, map_id: null, ...extra,
  } as MessageRow;
}

/** The two-row store of the incident: replyDrafts newest first, deleteDraft only on an unsent draft. */
function store(rows: MessageRow[]): ReplyDraftStore & { rows: MessageRow[] } {
  return {
    rows,
    async replyDrafts(companyId, accountId, replyToMessageId) {
      return this.rows
        .filter((r) => r.company_id === companyId && r.account_id === accountId && r.direction === "outbound" && r.draft?.replyToMessageId === replyToMessageId)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    },
    async deleteDraft(companyId, id) {
      const i = this.rows.findIndex((r) => r.company_id === companyId && r.id === id && r.status === "draft");
      if (i < 0) return false;
      this.rows.splice(i, 1);
      return true;
    },
  };
}

describe("one reply per message (PAR-8030)", () => {
  it("a second create-draft for the same message within the window gets the open draft back", () => {
    const first = reply("d-1", 0);
    expect(reusableReplyDraft([first], T0 + 450)?.id).toBe("d-1");
    expect(reusableReplyDraft([first], T0 + REPLY_REUSE_WINDOW_MS + 1)).toBeNull();
    // A queued or sent reply is never handed back as an open draft.
    expect(reusableReplyDraft([reply("d-2", 0, { status: "queued" }), reply("d-3", 0, { status: "sent" })], T0 + 450)).toBeNull();
  });

  it("double create + single send leaves one Sent message and no open sibling", async () => {
    // The race the reuse cannot close: both inserts land before either sees the other (450 ms apart in the incident).
    const s = store([reply("66b879fc", 0), reply("47772d3f", 450)]);
    Object.assign(s.rows[0]!, { status: "sent", received_at: at(5_000), gmail_message_id: "g-1" });
    const removed = await removeSupersededDrafts(s, CO, "acc-1", "m-in", "66b879fc");
    expect(removed).toEqual(["47772d3f"]);
    expect(s.rows.map((r) => [r.id, r.status])).toEqual([["66b879fc", "sent"]]);
  });

  it("clean-up leaves other mailboxes, other messages and a draft already queued for sending alone", async () => {
    const s = store([
      reply("sent", 0, { status: "sent", received_at: at(5_000) }),
      reply("queued", 100, { status: "queued" }),
      reply("other-box", 100, { account_id: "acc-2" }),
      reply("other-msg", 100, { draft: { replyToMessageId: "m-other" } }),
    ]);
    expect(await removeSupersededDrafts(s, CO, "acc-1", "m-in", "sent")).toEqual([]);
    expect(s.rows).toHaveLength(4);
  });

  it("Send on the leftover copy is refused when a reply went out after it was saved", () => {
    const ghost = reply("47772d3f", 450);
    const sent = reply("66b879fc", 0, { status: "sent", received_at: at(5_000) });
    expect(newerSentReply([ghost, sent], ghost)?.id).toBe("66b879fc");
    // A sent row without a send time is treated as newer: refusing beats answering twice.
    expect(newerSentReply([ghost, { ...sent, received_at: null }], ghost)?.id).toBe("66b879fc");
  });

  it("a reply written after the earlier answer went out is a deliberate second answer and may be sent", () => {
    const later = reply("d-later", 60 * 60_000);
    const sent = reply("66b879fc", 0, { status: "sent", received_at: at(5_000) });
    expect(newerSentReply([later, sent], later)).toBeNull();
    expect(newerSentReply([reply("d-1", 0)], reply("d-1", 0))).toBeNull();
  });

  it("the store reads replies by mailbox and replied-to message, through the host's SQL guard", async () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      namespace: NAMESPACE,
      async query(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE);
        validateParams(sql, params);
        seen.push({ sql, params });
        return [];
      },
      async execute() {
        return { rowCount: 0 };
      },
    };
    const sql = new SqlStore(db as never);
    expect(await sql.replyDrafts(CO, "acc-1", "m-in")).toEqual([]);
    expect(seen[0]!.sql).toContain(`FROM ${NAMESPACE}.messages`);
    expect(seen[0]!.sql).toContain("draft ->> 'replyToMessageId' = $3");
    expect(seen[0]!.params).toEqual([CO, "acc-1", "m-in"]);
  });
});
