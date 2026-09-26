import { describe, expect, it } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { MAIL_EVENTS, pluginEvent, PIB_PLUGINS, type MailSendRequested } from "@partnersinbiz/pib-plugin-kit";
import { handleSendRequested, normaliseRequest, retrySend, senderOf } from "../src/gmail/send.js";
import { CO } from "./helpers/memory.js";
import { setup } from "./helpers/setup.js";

const EVENT = pluginEvent(PIB_PLUGINS.billing, MAIL_EVENTS.sendRequested);
const PDF = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10, 0, 1, 2, 3]);

function request(overrides: Partial<MailSendRequested> = {}): MailSendRequested {
  return {
    key: "billing:invoice:inv-1:send",
    to: [{ email: "ann@client.co.za", name: "Ann Smith" }],
    subject: "Invoice INV-0001 from Partners in Biz",
    html: "<p>Hi Ann, your invoice is attached.</p>",
    text: "Hi Ann, your invoice is attached.",
    attachments: [{ url: "https://files.example.com/inv-1.pdf", filename: "INV-0001.pdf", mime: "application/pdf", bytes: PDF.byteLength }],
    context: { plugin: PIB_PLUGINS.billing, kind: "invoice", id: "inv-1", clientKind: "company", clientRef: "crm-co-1" },
    labels: ["PiB/Invoices"],
    ...overrides,
  };
}

function event(payload: unknown, eventType: string = EVENT): PluginEvent {
  return { eventId: crypto.randomUUID(), eventType: eventType as PluginEvent["eventType"], occurredAt: new Date().toISOString(), companyId: CO, payload };
}

const results = (emitted: Array<{ name: string; payload: Record<string, unknown> }>) => emitted.filter((e) => e.name === MAIL_EVENTS.sendResult).map((e) => e.payload);

describe("mail.send.requested", () => {
  it("sends through Gmail with the attachment, labels the message, records it and answers", async () => {
    const { gmail, env, store, host } = setup({ fromName: "Partners in Biz" });
    gmail.files.set("/inv-1.pdf", { status: 200, body: PDF, type: "application/pdf" });
    const result = await handleSendRequested(env, event(request()));

    expect(result).toMatchObject({ key: "billing:invoice:inv-1:send", status: "sent", messageId: "sent-1", threadId: "t-sent-1", permanent: false });
    expect(gmail.sent).toHaveLength(1);
    const mime = gmail.sent[0]!.mime;
    expect(mime).toContain("From: Partners in Biz <peet@partnersinbiz.online>");
    expect(mime).toContain("To: Ann Smith <ann@client.co.za>");
    expect(mime).toContain("Subject: Invoice INV-0001 from Partners in Biz");
    expect(mime).toContain('Content-Disposition: attachment; filename="INV-0001.pdf"');
    expect(mime).toContain(Buffer.from(PDF).toString("base64"));
    expect(mime).toMatch(/Message-ID: <pib\.[0-9a-f]{32}@partnersinbiz\.online>/);

    const row = store.sends.get("billing:invoice:inv-1:send")!;
    expect(row).toMatchObject({ status: "sent", gmail_message_id: "sent-1", gmail_thread_id: "t-sent-1", source_plugin: PIB_PLUGINS.billing });
    expect(row.rfc_message_id).toMatch(/^<pib\./);
    const outbound = store.messages.get("gm_acc-1_sent-1")!;
    expect(outbound).toMatchObject({ direction: "outbound", status: "sent", sent_context: request().context, send_key: "billing:invoice:inv-1:send" });
    expect(gmail.labels.map((l) => l.name)).toEqual(expect.arrayContaining(["PiB", "PiB/Invoices"]));
    expect(gmail.messages.get("sent-1")!.labelIds).toContain(gmail.labels.find((l) => l.name === "PiB/Invoices")!.id);

    expect(results(host.emitted)).toEqual([expect.objectContaining({ key: "billing:invoice:inv-1:send", status: "sent", messageId: "sent-1", context: request().context })]);
    expect(host.inbox.get("billing:invoice:inv-1:send")).toMatchObject({ status: "sent" });
  });

  it("replies in the thread with In-Reply-To and References", async () => {
    const { gmail, env, store, account } = setup();
    await store.insertGmailMessage({
      id: "gm_acc-1_in-1",
      companyId: CO,
      accountId: account.id,
      direction: "inbound",
      status: "synced",
      subject: "Quote",
      gmailMessageId: "in-1",
      gmailThreadId: "th-quote",
      rfcMessageId: "<q2@client.co.za>",
      inReplyTo: null,
      refs: ["<q1@client.co.za>"],
      from: { email: "ann@client.co.za" },
      to: [],
      cc: [],
      snippet: "",
      labels: ["INBOX"],
      attachments: [],
      bulk: false,
      receivedAt: new Date().toISOString(),
      read: true,
    });
    await handleSendRequested(env, event(request({ key: "crm:reply:1", attachments: [], inReplyToMessageId: "in-1", subject: "Re: Quote", context: { plugin: PIB_PLUGINS.crm, kind: "reply", id: "r1" } }), pluginEvent(PIB_PLUGINS.crm, MAIL_EVENTS.sendRequested)));
    const call = gmail.calls.find((c) => c.method === "POST" && c.url.pathname.endsWith("/messages/send"))!;
    expect(JSON.parse(call.body!).threadId).toBe("th-quote");
    expect(gmail.sent[0]!.mime).toContain("In-Reply-To: <q2@client.co.za>");
    expect(gmail.sent[0]!.mime).toContain("References: <q1@client.co.za>\r\n <q2@client.co.za>");
    expect(store.sends.get("crm:reply:1")!.source_plugin).toBe(PIB_PLUGINS.crm);
  });

  it("follows up in a thread: threadId alone gets In-Reply-To from the thread's newest message", async () => {
    const { gmail, env, store, account } = setup();
    await store.insertGmailMessage({
      id: "gm_acc-1_s-1", companyId: CO, accountId: account.id, direction: "outbound", status: "sent", subject: "Hello", gmailMessageId: "s-1",
      gmailThreadId: "th-seq", rfcMessageId: "<pib.step1@partnersinbiz.online>", inReplyTo: null, refs: [], from: { email: gmail.email }, to: [{ email: "lead@x.co" }],
      cc: [], snippet: "", labels: ["SENT"], attachments: [], bulk: false, receivedAt: new Date(Date.now() - 86_400_000).toISOString(), read: true,
    });
    await handleSendRequested(env, event(request({ key: "crm:seq:1:step2", attachments: [], threadId: "th-seq", subject: "Hello", labels: ["PiB/Sequences"], context: { plugin: PIB_PLUGINS.crm, kind: "sequence-step", id: "e1:2" } }), pluginEvent(PIB_PLUGINS.crm, MAIL_EVENTS.sendRequested)));
    const call = gmail.calls.find((c) => c.method === "POST" && c.url.pathname.endsWith("/messages/send"))!;
    expect(JSON.parse(call.body!).threadId).toBe("th-seq");
    expect(gmail.sent[0]!.mime).toContain("In-Reply-To: <pib.step1@partnersinbiz.online>");
    expect(gmail.labels.map((l) => l.name)).toContain("PiB/Sequences");

    // Not in the store: read the thread's headers from Gmail.
    gmail.addMessage({ id: "ext-1", threadId: "th-ext", internalDate: Date.now() - 5000, headers: { "Message-ID": "<a@client>", Subject: "Q" } });
    gmail.addMessage({ id: "ext-2", threadId: "th-ext", internalDate: Date.now() - 1000, headers: { "Message-ID": "<b@client>", References: "<a@client>", Subject: "Re: Q" } });
    await handleSendRequested(env, event(request({ key: "crm:seq:2", attachments: [], threadId: "th-ext", subject: "Re: Q", context: { plugin: PIB_PLUGINS.crm, kind: "reply", id: "x" } }), pluginEvent(PIB_PLUGINS.crm, MAIL_EVENTS.sendRequested)));
    expect(gmail.sent[1]!.mime).toContain("In-Reply-To: <b@client>");
    expect(gmail.sent[1]!.mime).toContain("References: <a@client>\r\n <b@client>");
  });

  it("dedupes repeat deliveries: one Gmail send, the stored result re-emitted", async () => {
    const { gmail, env, host } = setup();
    gmail.files.set("/inv-1.pdf", { status: 200, body: PDF, type: "application/pdf" });
    await handleSendRequested(env, event(request()));
    await handleSendRequested(env, event(request()));
    expect(gmail.sent).toHaveLength(1);
    const sent = results(host.emitted);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
  });

  it("does not send twice while another delivery holds the claim", async () => {
    const { gmail, env, host, store } = setup();
    store.sends.set("billing:invoice:inv-1:send", {
      ...(await (async () => {
        await store.claimSend({ key: "billing:invoice:inv-1:send", companyId: CO, sourcePlugin: PIB_PLUGINS.billing, accountId: "acc-1", fromAddress: null, to: [], subject: "", context: request().context, request: request() }, false);
        return store.sends.get("billing:invoice:inv-1:send")!;
      })()),
    });
    const result = await handleSendRequested(env, event(request()));
    expect(result).toBeNull();
    expect(gmail.sent).toHaveLength(0);
    expect(results(host.emitted)).toHaveLength(0);
    expect(host.inbox.size).toBe(0);
  });

  it("throttles over the per-minute rate: throws, stores nothing, emits nothing", async () => {
    const { gmail, env, host, store } = setup({ sendRatePerMinute: 1 });
    gmail.files.set("/inv-1.pdf", { status: 200, body: PDF, type: "application/pdf" });
    await handleSendRequested(env, event(request()));
    const second = await handleSendRequested(env, event(request({ key: "billing:invoice:inv-2:send" })));
    expect(second).toBeNull();
    expect(gmail.sent).toHaveLength(1);
    expect(store.sends.has("billing:invoice:inv-2:send")).toBe(false);
    expect(host.inbox.has("billing:invoice:inv-2:send")).toBe(false);
    expect(results(host.emitted).map((r) => r.key)).toEqual(["billing:invoice:inv-1:send"]);
  });

  it("fails permanently without a connected account or with a bad address, and repeats the answer", async () => {
    const { gmail, env, host, store } = setup();
    store.accounts.clear();
    const first = await handleSendRequested(env, event(request()));
    expect(first).toMatchObject({ status: "failed", permanent: true, error: "No Gmail account is connected in Mailbox" });
    const again = await handleSendRequested(env, event(request()));
    expect(again).toEqual(first);
    expect(gmail.calls).toHaveLength(0);
    expect(store.sends.get("billing:invoice:inv-1:send")).toMatchObject({ status: "failed", permanent: true });

    const { env: env2 } = setup();
    const bad = await handleSendRequested(env2, event(request({ key: "k-bad", to: [{ email: "not an address" }] })));
    expect(bad).toMatchObject({ status: "failed", permanent: true });
    expect(bad!.error).toMatch(/Invalid to address/);
    const noFrom = await handleSendRequested(env2, event(request({ key: "k-from", from: "other@partnersinbiz.online" })));
    expect(noFrom).toMatchObject({ status: "failed", permanent: true, error: "No connected Gmail account for other@partnersinbiz.online in Mailbox" });
    expect(results(host.emitted)).toHaveLength(2);
  });

  it("fails permanently when an attachment link has expired, and a retry sends it later", async () => {
    const { gmail, env, host, store } = setup();
    gmail.files.set("/inv-1.pdf", { status: 403, body: new Uint8Array(), type: "text/plain" });
    const failed = await handleSendRequested(env, event(request()));
    expect(failed).toMatchObject({ status: "failed", permanent: true });
    expect(failed!.error).toMatch(/HTTP 403/);
    expect(gmail.sent).toHaveLength(0);

    gmail.files.set("/inv-1.pdf", { status: 200, body: PDF, type: "application/pdf" });
    const retried = await retrySend(env, CO, "billing:invoice:inv-1:send");
    expect(retried).toMatchObject({ status: "sent", messageId: "sent-1" });
    expect(store.inboxResults.get("billing:invoice:inv-1:send")).toMatchObject({ status: "sent" });
    expect(results(host.emitted).map((r) => r.status)).toEqual(["failed", "sent"]);
  });

  it("treats Gmail outages and a reconnect as transient: nothing stored, the row waits, the next delivery sends", async () => {
    const { gmail, env, host, store } = setup();
    gmail.files.set("/inv-1.pdf", { status: 200, body: PDF, type: "application/pdf" });
    gmail.intercept = (call) => (call.url.pathname.endsWith("/messages/send") ? new Response(JSON.stringify({ error: { code: 503, message: "Backend Error" } }), { status: 503 }) : null);
    expect(await handleSendRequested(env, event(request()))).toBeNull();
    expect(store.sends.get("billing:invoice:inv-1:send")).toMatchObject({ status: "retrying" });
    expect(host.inbox.size).toBe(0);
    expect(results(host.emitted)).toHaveLength(0);

    gmail.intercept = null;
    const later = await handleSendRequested(env, event(request()));
    expect(later).toMatchObject({ status: "sent" });
    expect(store.sends.get("billing:invoice:inv-1:send")!.attempts).toBe(2);

    const { env: env2, store: store2, gmail: gmail2 } = setup();
    store2.accounts.get("acc-1")!.status = "needs_reconnect";
    expect(await handleSendRequested(env2, event(request({ key: "k-wait", attachments: [] })))).toBeNull();
    expect(store2.sends.get("k-wait")).toMatchObject({ status: "retrying" });
    expect(gmail2.sent).toHaveLength(0);
  });

  it("does not send again when Gmail accepted the message but the answer was lost", async () => {
    const { gmail, env, store } = setup();
    gmail.files.set("/inv-1.pdf", { status: 200, body: PDF, type: "application/pdf" });
    gmail.intercept = async (call) => {
      if (!call.url.pathname.endsWith("/messages/send")) return null;
      gmail.intercept = null;
      await gmail.fetch(call.url.toString(), { method: call.method, body: call.body, headers: call.headers });
      return new Response(JSON.stringify({ error: { code: 503, message: "Backend Error" } }), { status: 503 });
    };
    expect(await handleSendRequested(env, event(request()))).toBeNull();
    expect(gmail.sent).toHaveLength(1);
    expect(store.sends.get("billing:invoice:inv-1:send")!.status).toBe("retrying");
    const later = await handleSendRequested(env, event(request()));
    expect(later).toMatchObject({ status: "sent", messageId: "sent-1" });
    expect(gmail.sent).toHaveLength(1);
  });

  it("uses the upload endpoint for large messages", async () => {
    const { gmail, env } = setup();
    const big = new Uint8Array(4_000_000).fill(65);
    gmail.files.set("/big.pdf", { status: 200, body: big, type: "application/pdf" });
    const result = await handleSendRequested(env, event(request({ key: "big", attachments: [{ url: "https://files.example.com/big.pdf", filename: "big.pdf", mime: "application/pdf" }] })));
    expect(result).toMatchObject({ status: "sent" });
    const call = gmail.calls.find((c) => c.url.pathname.endsWith("/messages/send"))!;
    expect(call.url.pathname).toBe("/upload/gmail/v1/users/me/messages/send");
    expect(call.url.searchParams.get("uploadType")).toBe("multipart");
    expect(call.headers.get("content-type")).toMatch(/^multipart\/related; boundary=/);
  });
});

describe("request parsing", () => {
  it("reads the sender from the event type and cleans the payload", () => {
    expect(senderOf("plugin.partnersinbiz.payroll.mail.send.requested")).toBe("partnersinbiz.payroll");
    expect(senderOf("plugin.partnersinbiz.payroll.mail.received")).toBeNull();
    expect(normaliseRequest({ to: ["a@b.co"] }, "x")).toBeNull();
    const parsed = normaliseRequest({ key: "k", to: ["Ann <ANN@b.co>", "ann@b.co"], subject: "Hi\r\nBcc: x@y.z", text: "t", attachments: [{ url: "http://evil.example/x", filename: "x" }] }, "partnersinbiz.seo")!;
    expect(parsed.request.to).toEqual([{ email: "ann@b.co", name: "Ann" }]);
    expect(parsed.request.subject).toBe("Hi Bcc: x@y.z");
    expect(parsed.request.context.plugin).toBe("partnersinbiz.seo");
    expect(parsed.problem).toBe("Attachment x has no https URL");
    expect(normaliseRequest({ key: "k", to: [], text: "t" }, "x")!.problem).toBe("The message has no recipients");
    expect(normaliseRequest({ key: "k", to: ["a@b.co"] }, "x")!.problem).toBe("The message has no body");
  });
});
