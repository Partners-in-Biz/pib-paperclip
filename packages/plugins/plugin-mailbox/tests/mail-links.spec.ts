import { describe, expect, it } from "vitest";
import { taskLinks, threadContext, type LinkIssue, type MailLinksDeps, type MessageLinkRow } from "../src/mail-links.js";
import { taskHref, taskLinkLine, taskTone } from "../src/ui/view.js";
import type { MessageRow } from "../src/gmail/types.js";

function mail(id: string, over: Partial<MessageRow> = {}): MessageRow {
  return {
    id,
    account_id: "acc1",
    subject: "Quote",
    status: "received",
    direction: "inbound",
    gmail_thread_id: "t1",
    gmail_message_id: `g-${id}`,
    received_at: "2026-11-01T08:00:00.000Z",
    created_at: "2026-11-01T08:00:00.000Z",
    from_addr: { email: "jo@client.co", name: "Jo" },
    to_addrs: [],
    snippet: `text of ${id}`,
    attachments: [],
    ...over,
  } as unknown as MessageRow;
}
const issue = (id: string, over: Partial<LinkIssue> = {}): LinkIssue => ({ id, identifier: id.toUpperCase(), title: `Task ${id}`, status: "todo", ...over });
const linkRow = (id: string, over: Partial<MessageLinkRow> = {}): MessageLinkRow => ({ id, account_id: "acc1", status: "received", gmail_thread_id: "t1", gmail_message_id: `g-${id}`, draft_thread_id: null, reply_to_id: null, source_issue_id: null, rewrite_issue_id: null, ...over });

function deps(rows: MessageRow[], over: Partial<MailLinksDeps> = {}): MailLinksDeps {
  return {
    findMessage: async (id) => rows.find((r) => r.id === id) ?? null,
    threadMessages: async (threadId) => rows.filter((r) => r.gmail_thread_id === threadId || r.draft?.threadId === threadId),
    isPrivate: async () => false,
    threadIssueId: async () => null,
    handoffIssueIds: async () => [],
    subtree: async (id) => ({ issues: [issue(id)] }),
    linkRows: async () => [],
    threadIssueRows: async () => [],
    ...over,
  };
}

describe("threadContext", () => {
  it("gives a reply draft its thread, oldest first, without drafts, and opens the message it answers", async () => {
    const rows = [
      mail("m2", { received_at: "2026-11-02T08:00:00.000Z" }),
      mail("m1"),
      mail("other", { account_id: "acc2" }),
      mail("d1", { status: "draft", direction: "outbound", gmail_thread_id: null, gmail_message_id: null, draft: { replyToMessageId: "m2", threadId: "t1" } } as Partial<MessageRow>),
    ];
    const out = await threadContext(deps(rows), "d1");
    expect(out.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(out.messages.find((m) => m.id === "m2")?.replyingTo).toBe(true);
    expect(out.messages.some((m) => m.current)).toBe(false);
  });

  it("gives a draft that answers nothing no thread", async () => {
    const out = await threadContext(deps([mail("d1", { status: "draft", gmail_thread_id: null, gmail_message_id: null, draft: {} } as Partial<MessageRow>)]), "d1");
    expect(out).toMatchObject({ threadId: null, messages: [], tasks: [] });
  });

  it("hides the text of private client mail", async () => {
    const out = await threadContext(deps([mail("m1"), mail("m2")], { isPrivate: async (r) => r.id === "m2" }), "m1");
    expect(out.messages.find((m) => m.id === "m2")).toMatchObject({ private: true, snippet: null });
    expect(out.messages.find((m) => m.id === "m1")?.snippet).toBe("text of m1");
  });

  it("lists the reply task, its subtasks in tree order, hand-offs and the draft's task, each once", async () => {
    const rows = [mail("m1"), mail("d1", { status: "draft", gmail_thread_id: null, gmail_message_id: null, draft: { replyToMessageId: "m1", threadId: "t1", sourceIssueId: "child" } } as Partial<MessageRow>)];
    const out = await threadContext(
      deps(rows, {
        threadIssueId: async (accountId, threadId) => (accountId === "acc1" && threadId === "t1" ? "root" : null),
        handoffIssueIds: async (id) => (id === "m1" ? ["hand"] : []),
        subtree: async (id) =>
          id === "root"
            ? { issues: [issue("grand", { parentId: "child" }), issue("child", { parentId: "root" }), issue("root", { assigneeAgentId: "a1" })], assignees: { a1: { name: "Operator" } } }
            : id === "child"
              ? { issues: [issue("child")] }
              : { issues: [issue(id)] },
      }),
      "d1",
    );
    expect(out.tasks.map((t) => [t.id, t.link, t.depth])).toEqual([["root", "reply", 0], ["child", "subtask", 1], ["grand", "subtask", 2], ["hand", "handoff", 0]]);
    expect(out.tasks[0]?.assignee).toBe("Operator");
  });

  it("leaves out a task that can't be read, and refuses a message that isn't there", async () => {
    const out = await threadContext(deps([mail("m1")], { threadIssueId: async () => "gone", subtree: async () => null }), "m1");
    expect(out.tasks).toEqual([]);
    await expect(threadContext(deps([]), "nope")).rejects.toThrow("Message not found");
  });
});

describe("taskLinks", () => {
  it("shows a thread's tasks on every listed mail of that thread, with totals", async () => {
    const out = await taskLinks(
      deps([], {
        linkRows: async () => [linkRow("m1"), linkRow("m2"), linkRow("m3", { gmail_thread_id: "t3" })],
        threadIssueRows: async () => [{ account_id: "acc1", gmail_thread_id: "t1", issue_id: "root" }],
        handoffIssueIds: async (id) => (id === "m2" ? ["hand"] : []),
        subtree: async (id) => (id === "root" ? { issues: [issue("root", { status: "done" }), issue("kid", { parentId: "root", status: "in_progress" })] } : { issues: [issue(id, { status: "cancelled" })] }),
      }),
      ["m1", "m2", "m3"],
    );
    expect(Object.keys(out).sort()).toEqual(["m1", "m2"]);
    expect(out.m1).toMatchObject({ primary: { id: "root", status: "done" }, total: 3, open: 1 });
    expect(out.m2).toEqual(out.m1);
  });

  it("does not mix up the same thread id on two mailboxes", async () => {
    const out = await taskLinks(
      deps([], {
        linkRows: async () => [linkRow("m1"), linkRow("m2", { account_id: "acc2" })],
        threadIssueRows: async () => [{ account_id: "acc2", gmail_thread_id: "t1", issue_id: "root" }],
      }),
      ["m1", "m2"],
    );
    expect(Object.keys(out)).toEqual(["m2"]);
  });

  it("links a draft through its thread, and through the task that wrote it when it answers nothing", async () => {
    const out = await taskLinks(
      deps([], {
        linkRows: async () => [
          linkRow("reply", { status: "draft", gmail_thread_id: null, gmail_message_id: null, draft_thread_id: "t1", reply_to_id: "m1" }),
          linkRow("cold", { status: "draft", gmail_thread_id: null, gmail_message_id: null, source_issue_id: "writer" }),
          linkRow("none", { status: "draft", gmail_thread_id: null, gmail_message_id: null }),
        ],
        threadIssueRows: async () => [{ account_id: "acc1", gmail_thread_id: "t1", issue_id: "root" }],
      }),
      ["reply", "cold", "none"],
    );
    expect(out.reply?.primary.id).toBe("root");
    expect(out.cold?.primary.id).toBe("writer");
    expect(out.none).toBeUndefined();
  });

  it("asks for nothing when given nothing", async () => {
    expect(await taskLinks(deps([]), [])).toEqual({});
  });
});

describe("task wording", () => {
  it("names the first task and how many more", () => {
    expect(taskLinkLine({ primary: { id: "x", identifier: "PAR-12", status: "in_progress" }, total: 3 })).toBe("PAR-12 · In progress +2");
    expect(taskLinkLine({ primary: { id: "x", identifier: null, status: "done" }, total: 1 })).toBe("Task · Done");
  });
  it("gives status a tone and a link", () => {
    expect(taskTone("done")).toBe("ok");
    expect(taskTone("blocked")).toBe("bad");
    expect(taskHref({ id: "uuid", identifier: "PAR-12" })).toBe("/issues/PAR-12");
    expect(taskHref({ id: "uuid" })).toBe("/issues/uuid");
  });
});
