import { describe, expect, it } from "vitest";
import { deleteMail, MAX_DELETE_AT_ONCE, quotedText, replyMode, replyRecipients, replySubject, startReply } from "../src/mail-actions.js";

import type { Env } from "../src/gmail/env.js";
import type { MessageRow } from "../src/gmail/types.js";

const ME = "peet@partnersinbiz.online";
const row = (over: Partial<MessageRow> = {}): MessageRow =>
  ({
    id: "m1", company_id: "co", account_id: "acc", subject: "Quote", body: null, direction: "inbound", status: "received", gmail_message_id: "g1", gmail_thread_id: "t1",
    from_addr: { email: "ann@client.co", name: "Ann" }, reply_to_addr: null, to_addrs: [{ email: ME }, { email: "bob@client.co" }], cc_addrs: [{ email: "cat@client.co" }, { email: "ann@client.co" }],
    snippet: "Hello", attachments: [], received_at: "2026-11-04T08:00:00.000Z", created_at: "2026-11-04T08:00:00.000Z", sent_context: null, ...over,
  }) as unknown as MessageRow;

describe("replySubject", () => {
  it("adds the prefix once", () => {
    expect(replySubject("Quote", "reply")).toBe("Re: Quote");
    expect(replySubject("RE: Quote", "reply_all")).toBe("RE: Quote");
    expect(replySubject("Quote", "forward")).toBe("Fwd: Quote");
    expect(replySubject("Fwd: Quote", "forward")).toBe("Fwd: Quote");
    expect(replySubject("", "reply")).toBe("Re: (no subject)");
  });
  it("refuses an unknown mode", () => expect(() => replyMode("send")).toThrow(/Choose/));
});

describe("replyRecipients", () => {
  it("replies to the sender only", () => {
    expect(replyRecipients(row(), ME, "reply")).toEqual({ to: [{ email: "ann@client.co", name: "Ann" }], cc: [] });
  });
  it("prefers Reply-To (a relayed form)", () => {
    expect(replyRecipients(row({ reply_to_addr: { email: "visitor@x.co" } } as Partial<MessageRow>), ME, "reply").to).toEqual([{ email: "visitor@x.co" }]);
  });
  it("reply all adds the others, never the mailbox and never twice", () => {
    const out = replyRecipients(row(), ME.toUpperCase(), "reply_all");
    expect(out.to.map((a) => a.email)).toEqual(["ann@client.co"]);
    expect(out.cc.map((a) => a.email)).toEqual(["bob@client.co", "cat@client.co"]);
  });
  it("a reply to our own sent mail goes to its recipients", () => {
    expect(replyRecipients(row({ direction: "outbound", from_addr: { email: ME } } as Partial<MessageRow>), ME, "reply").to.map((a) => a.email)).toEqual(["bob@client.co"]);
  });
  it("a forward starts empty", () => expect(replyRecipients(row(), ME, "forward")).toEqual({ to: [], cc: [] }));
});

describe("quotedText", () => {
  it("quotes a reply and leaves a line to type on", () => {
    const out = quotedText(row(), "one\ntwo", "reply");
    expect(out.startsWith("\n\nOn ")).toBe(true);
    expect(out).toContain("Ann <ann@client.co> wrote:\n> one\n> two");
  });
  it("heads a forward with the original's details", () => {
    const out = quotedText(row(), "body", "forward");
    expect(out).toContain("---------- Forwarded message ---------\nFrom: Ann <ann@client.co>");
    expect(out).toContain("Subject: Quote");
    expect(out.endsWith("\n\nbody")).toBe(true);
  });
});

function fakeEnv(messages: MessageRow[], gmail: (url: string) => Response) {
  const calls: string[] = [];
  const removed: string[][] = [];
  const env = {
    now: () => Date.now(),
    fetch: async (url: string) => {
      calls.push(String(url));
      return gmail(String(url));
    },
    ctx: {
      logger: { info() {}, warn() {}, error() {} },
      config: { get: async () => ({ encryptionKey: "x".repeat(20) }) },
    },
    store: {
      getMessage: async (_c: string, id: string) => messages.find((m) => m.id === id) ?? null,
      getAccount: async () => ({ id: "acc", company_id: "co", address: ME, status: "connected", token_sealed: "sealed" }),
      deleteMessages: async (_c: string, ids: string[]) => {
        removed.push(ids);
        return ids.length;
      },
    },
  } as unknown as Env;
  return { env, calls, removed };
}

// The token layer is real elsewhere (tokens.spec); here the mail logic is under test.
import { vi } from "vitest";
vi.mock("../src/gmail/tokens.js", async (original) => ({ ...(await original<object>()), withGmail: (_e: unknown, _l: unknown, _a: unknown, fn: (t: string) => Promise<unknown>) => fn("tok") }));
vi.mock("../src/config.js", async (original) => ({ ...(await original<object>()), loadMailboxConfig: async () => ({}) }));

describe("deleteMail", () => {
  it("moves it to the Bin in Gmail, then takes it off the page", async () => {
    const { env, calls, removed } = fakeEnv([row()], () => new Response("{}", { status: 200 }));
    await expect(deleteMail(env, "co", ["m1"])).resolves.toEqual({ deleted: 1, failed: [] });
    expect(calls[0]).toMatch(/\/messages\/g1\/trash$/);
    expect(removed).toEqual([["m1"]]);
  });
  it("keeps the row when Gmail refuses, and says so", async () => {
    const { env, removed } = fakeEnv([row()], () => new Response(JSON.stringify({ error: { message: "no" } }), { status: 403 }));
    const out = await deleteMail(env, "co", ["m1"]);
    expect(out.deleted).toBe(0);
    expect(out.failed).toHaveLength(1);
    expect(removed).toEqual([]);
  });
  it("mail already gone from Gmail only leaves the hub", async () => {
    const { env, removed } = fakeEnv([row()], () => new Response("{}", { status: 404 }));
    await expect(deleteMail(env, "co", ["m1"])).resolves.toEqual({ deleted: 1, failed: [] });
    expect(removed).toEqual([["m1"]]);
  });
  it("mail that was never in Gmail makes no Gmail call", async () => {
    const { env, calls, removed } = fakeEnv([row({ gmail_message_id: null })], () => new Response("{}"));
    await deleteMail(env, "co", ["m1"]);
    expect(calls).toEqual([]);
    expect(removed).toEqual([["m1"]]);
  });
  it("refuses an empty or oversized list and ignores unknown ids", async () => {
    const { env } = fakeEnv([], () => new Response("{}"));
    await expect(deleteMail(env, "co", [])).rejects.toThrow(/Choose/);
    await expect(deleteMail(env, "co", Array.from({ length: MAX_DELETE_AT_ONCE + 1 }, (_, i) => `m${i}`))).rejects.toThrow(/at most/);
    await expect(deleteMail(env, "co", ["nope"])).resolves.toEqual({ deleted: 0, failed: [] });
  });

});

describe("startReply", () => {
  const gmailBody = () =>
    new Response(JSON.stringify({ id: "g1", threadId: "t1", labelIds: [], payload: { mimeType: "text/plain", headers: [], body: { data: Buffer.from("Full text").toString("base64url") } } }));
  const deps = (saved: Array<Record<string, any>>, isPrivate = false) => ({ isPrivate: async () => isPrivate, insertDraft: async (d: Record<string, any>) => void saved.push(d) });

  it("saves a threaded draft with the whole original quoted, and sends nothing", async () => {
    const saved: Array<Record<string, any>> = [];
    const { env, calls } = fakeEnv([row()], gmailBody);
    const out = await startReply(env, "co", "user-1", "m1", "reply", deps(saved));
    expect(saved[0]).toMatchObject({ id: out.id, subject: "Re: Quote", accountId: "acc", to: [{ email: "ann@client.co", name: "Ann" }], cc: [] });
    expect(saved[0]!.body).toContain("> Full text");
    expect(saved[0]!.draft).toMatchObject({ replyToMessageId: "m1", threadId: "t1", by: { kind: "user", id: "user-1" } });
    expect(calls.some((url) => /\/send/.test(url))).toBe(false);
  });
  it("a forward is a new thread and names a file that does not fit", async () => {
    const saved: Array<Record<string, any>> = [];
    const big = { attachmentId: "a1", filename: "big.zip", mime: "application/zip", bytes: 50 * 1024 * 1024 };
    const { env } = fakeEnv([row({ attachments: [big] } as unknown as Partial<MessageRow>)], gmailBody);
    const out = await startReply(env, "co", "user-1", "m1", "forward", deps(saved));
    expect(out.skippedFiles).toEqual(["big.zip"]);
    expect(saved[0]!.to).toEqual([]);
    expect(saved[0]!.draft).toMatchObject({ replyToMessageId: null, threadId: null });
  });
  it("a private message is never copied into the new mail", async () => {
    const saved: Array<Record<string, any>> = [];
    const { env, calls } = fakeEnv([row()], gmailBody);
    await startReply(env, "co", "user-1", "m1", "reply", deps(saved, true));
    expect(saved[0]!.body).toBe("");
    expect(calls).toEqual([]);
  });
  it("a missing message is refused", async () => {
    const { env } = fakeEnv([], gmailBody);
    await expect(startReply(env, "co", "u", "nope", "reply", deps([]))).rejects.toThrow(/not found/);
  });
});
