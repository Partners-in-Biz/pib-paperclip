import { describe, expect, it } from "vitest";
import { getAttachment, listMailboxes } from "../src/agent-mail.js";
import { attachmentKey, decodeText, isTextAttachment, TEXT_MAX_BYTES } from "../src/gmail/attachments.js";
import { CO } from "./helpers/memory.js";
import { setup } from "./helpers/setup.js";

const R2 = { r2: { accountId: "acct123", bucket: "pib-private", accessKeyId: "AKID", secretAccessKey: "s3cr3t", prefix: "mailbox" } };
const CSV = "Date,Description,Amount\n2026-09-01,EFT INV-0001,1150.00\n";

function withMessage(ctx: ReturnType<typeof setup>, attachments = [{ attachmentId: "att-1", filename: "Statement Sep.csv", mime: "text/csv", bytes: CSV.length }]) {
  ctx.store.messages.set("gm_acc-1_m1", {
    id: "gm_acc-1_m1", company_id: CO, account_id: "acc-1", subject: "Your statement", body: "", direction: "inbound", status: "synced",
    created_at: new Date().toISOString(), read_at: null, gmail_message_id: "m1", gmail_thread_id: "t1", rfc_message_id: null, in_reply_to: null, refs: [],
    from_addr: { email: "bank@fnb.co.za", name: "FNB" }, to_addrs: [], cc_addrs: [], bcc_addrs: [], snippet: "", labels: [], attachments, bulk: false,
    received_at: new Date().toISOString(), triage: null, triaged_at: null, category: "bank_statement", urgency: null, needs_reply: null, phishing: null,
    client_kind: null, client_ref: null, reply_to: null, sent_context: null, send_key: null, draft: null, send_error: null, bounce: null,
  });
}

describe("list-mailboxes", () => {
  it("lists every account with its status, the default sender and this agent's delegation", async () => {
    const ctx = setup();
    ctx.store.addAccount({ id: "acc-2", company_id: CO, address: "ops@partnersinbiz.online", status: "needs_reconnect", token_sealed: "sealed" });
    ctx.store.delegate("acc-1", "agent-am", { can_send: true });
    ctx.store.delegate("acc-2", "agent-am");
    const result = await listMailboxes(ctx.env, CO, "agent-am");
    expect(result).toMatchObject({ defaultAccountId: "acc-1", defaultAddress: "peet@partnersinbiz.online" });
    expect(result.accounts).toEqual([
      expect.objectContaining({ accountId: "acc-1", status: "connected", isDefault: true, mayRead: true, mayDraft: true, maySend: true, problem: null }),
      expect.objectContaining({ accountId: "acc-2", status: "needs_reconnect", isDefault: false, mayDraft: true, maySend: false, problem: expect.stringMatching(/reconnected by a person/) }),
    ]);
    expect(result.next).toMatch(/mayDraft/);
  });

  it("tells an agent without delegation to ask the owner once", async () => {
    const ctx = setup();
    const result = await listMailboxes(ctx.env, CO, "agent-new");
    expect(result.accounts[0]).toMatchObject({ delegation: null, mayRead: false, mayDraft: false, maySend: false });
    expect(result.next).toMatch(/ask-owner/);
  });
});

describe("get-attachment", () => {
  it("returns a statement's text and a 15-minute private link", async () => {
    const ctx = setup(R2);
    withMessage(ctx);
    ctx.store.delegate("acc-1", "agent-bk");
    ctx.gmail.attachments.set("m1:att-1", new TextEncoder().encode(CSV));
    const result = await getAttachment(ctx.env, CO, "agent-bk", "gm_acc-1_m1", "att-1");
    expect(result).toMatchObject({ filename: "Statement Sep.csv", mime: "text/csv", bytes: CSV.length, text: CSV, note: null });
    const [[path, object]] = [...ctx.gmail.r2.entries()];
    expect(path).toMatch(new RegExp(`^/pib-private/mailbox/${CO}/attachments/\\d{4}-\\d{2}/[0-9a-f-]{36}-statement-sep\\.csv$`));
    expect(new TextDecoder().decode(object!.body)).toBe(CSV);
    expect(result.url).toMatch(/^https:\/\/acct123\.r2\.cloudflarestorage\.com\/pib-private\/mailbox\//);
    expect(result.url).toContain("X-Amz-Expires=900");
    expect(Date.parse(result.urlExpiresAt!) - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(result.next).toMatch(/import-statement/);
  });

  it("works without R2 for text files, and says what is missing for a PDF", async () => {
    const ctx = setup();
    withMessage(ctx, [
      { attachmentId: "att-1", filename: "statement.ofx", mime: "application/octet-stream", bytes: 20 },
      { attachmentId: "att-2", filename: "POP.pdf", mime: "application/pdf", bytes: 5 },
    ]);
    ctx.store.delegate("acc-1", "agent-bk");
    ctx.gmail.attachments.set("m1:att-1", new TextEncoder().encode("<OFX>...</OFX>"));
    ctx.gmail.attachments.set("m1:att-2", new Uint8Array([37, 80, 68, 70, 45]));
    const ofx = await getAttachment(ctx.env, CO, "agent-bk", "m1", "att-1");
    expect(ofx).toMatchObject({ text: "<OFX>...</OFX>", url: null });
    expect(ofx.note).toMatch(/The text is included/);
    const pdf = await getAttachment(ctx.env, CO, "agent-bk", "m1", "att-2");
    expect(pdf).toMatchObject({ text: null, url: null });
    expect(pdf.note).toMatch(/ask-owner/);
    expect(ctx.gmail.r2.size).toBe(0);
  });

  it("finds the file again when Gmail issued a new attachment id", async () => {
    const ctx = setup(R2);
    withMessage(ctx, [{ attachmentId: "stale", filename: "Statement.csv", mime: "text/csv", bytes: CSV.length }]);
    ctx.store.delegate("acc-1", "agent-bk");
    ctx.gmail.addMessage({ id: "m1", headers: { From: "bank@fnb.co.za", Subject: "Your statement" }, payload: { mimeType: "multipart/mixed", parts: [{ mimeType: "text/csv", filename: "Statement.csv", attachmentId: "fresh", size: CSV.length }] } });
    ctx.gmail.attachments.set("m1:fresh", new TextEncoder().encode(CSV));
    const result = await getAttachment(ctx.env, CO, "agent-bk", "gm_acc-1_m1", "stale");
    expect(result.text).toBe(CSV);
  });

  it("finds the message from the Gmail id and the mailbox address in the Bank statement issue", async () => {
    const ctx = setup();
    withMessage(ctx);
    ctx.store.addAccount({ id: "acc-2", company_id: CO, address: "accounts@partnersinbiz.online", token_sealed: "sealed" });
    ctx.store.delegate("acc-1", "agent-bk", { can_draft: false });
    ctx.gmail.attachments.set("m1:att-1", new TextEncoder().encode(CSV));
    const result = await getAttachment(ctx.env, CO, "agent-bk", "m1", "att-1", "peet@partnersinbiz.online");
    expect(result).toMatchObject({ accountId: "acc-1", gmailMessageId: "m1", text: CSV });
    await expect(getAttachment(ctx.env, CO, "agent-bk", "m1", "att-1", "accounts@partnersinbiz.online")).rejects.toThrow(/Message not found/);
    await expect(getAttachment(ctx.env, CO, "agent-bk", "m1", "att-1", "nobody@x.co")).rejects.toThrow(/No mailbox nobody@x\.co/);
  });

  it("needs read access, a listed attachment, and a connected mailbox", async () => {
    const ctx = setup();
    withMessage(ctx);
    await expect(getAttachment(ctx.env, CO, "agent-x", "gm_acc-1_m1", "att-1")).rejects.toThrow(/You may not read peet@partnersinbiz\.online\. Ask the owner once/);
    ctx.store.delegate("acc-1", "agent-x");
    await expect(getAttachment(ctx.env, CO, "agent-x", "gm_acc-1_m1", "nope")).rejects.toThrow(/get-message lists each attachmentId/);
    ctx.store.accounts.get("acc-1")!.status = "needs_reconnect";
    await expect(getAttachment(ctx.env, CO, "agent-x", "gm_acc-1_m1", "att-1")).rejects.toThrow(/not connected to Gmail right now/);
  });

  it("returns text only for statement-like files up to 200 KB", () => {
    expect(isTextAttachment("x.CSV", "application/octet-stream")).toBe(true);
    expect(isTextAttachment("x.qif", "")).toBe(true);
    expect(isTextAttachment("x.bin", "text/plain")).toBe(true);
    expect(isTextAttachment("x.pdf", "application/pdf")).toBe(false);
    expect(TEXT_MAX_BYTES).toBe(200 * 1024);
    expect(decodeText(new Uint8Array([0x52, 0xe9, 0x73]))).toBe("Rés");
    expect(decodeText(new TextEncoder().encode("﻿Date,Amount"))).toBe("Date,Amount");
    expect(() => attachmentKey({ prefix: "mailbox" }, "../evil", "a.csv")).toThrow(/Unsafe/);
  });
});
