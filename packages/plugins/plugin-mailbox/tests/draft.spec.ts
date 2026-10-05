import { describe, expect, it } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { MAIL_EVENTS, MAIL_SENDERS, pluginEvent, PIB_PLUGINS, type MailDraftRequested } from "@partnersinbiz/pib-plugin-kit";
import { draftSenderOf, handleDraftRequested, normaliseDraftRequest, performDraft } from "../src/gmail/draft.js";
import { MAILBOX_OFF } from "../src/gmail/send.js";
import { CO } from "./helpers/memory.js";
import { setup } from "./helpers/setup.js";

const EVENT = pluginEvent(PIB_PLUGINS.seo, MAIL_EVENTS.draftRequested);
const KEY = "seo:outreach:1:draft";

function request(overrides: Partial<MailDraftRequested> = {}): MailDraftRequested {
  return {
    key: KEY,
    to: [{ email: "ann@client.co.za", name: "Ann Smith" }],
    subject: "Your backlink opportunity",
    html: "<p>Hi Ann, we would like to feature you.</p>",
    text: "Hi Ann, we would like to feature you.",
    context: { plugin: PIB_PLUGINS.seo, kind: "outreach", id: "o-1" },
    ...overrides,
  };
}

function event(payload: unknown, eventType: string = EVENT): PluginEvent {
  return { eventId: crypto.randomUUID(), eventType: eventType as PluginEvent["eventType"], occurredAt: new Date().toISOString(), companyId: CO, payload };
}

const results = (emitted: Array<{ name: string; payload: Record<string, unknown> }>) => emitted.filter((e) => e.name === MAIL_EVENTS.draftResult).map((e) => e.payload);
const sendResults = (emitted: Array<{ name: string; payload: Record<string, unknown> }>) => emitted.filter((e) => e.name === MAIL_EVENTS.sendResult);
const draftCalls = (gmail: ReturnType<typeof setup>["gmail"]) => gmail.calls.filter((c) => c.method === "POST" && c.url.pathname.endsWith("/drafts"));

function switchedOff(ctx: unknown, modules: Record<string, boolean>) {
  (ctx as { state: unknown }).state = {
    get: async (key: { namespace?: string; stateKey?: string }) => (key.namespace === "pib-setup" && key.stateKey === "modules" ? { companyId: CO, modules, updatedAt: "2026-09-26T08:00:00Z" } : null),
    set: async () => undefined,
  };
}

describe("mail.draft.requested", () => {
  it("creates a Gmail draft (never a send) and answers with the draft's ids and Gmail link", async () => {
    const { gmail, env, host, store } = setup({ fromName: "Partners in Biz" });
    const result = await handleDraftRequested(env, event(request({ replyTo: { email: "outreach@partnersinbiz.online" } })));

    expect(result).toMatchObject({
      key: KEY,
      status: "drafted",
      gmailDraftId: "draft-1",
      gmailMessageId: "draft-msg-1",
      threadId: "t-draft-msg-1",
      account: "peet@partnersinbiz.online",
      draftUrl: "https://mail.google.com/mail/u/peet@partnersinbiz.online/#drafts?compose=draft-msg-1",
      error: null,
      permanent: false,
      context: request().context,
    });
    expect(draftCalls(gmail)).toHaveLength(1);
    expect(draftCalls(gmail)[0]!.url.pathname).toBe("/gmail/v1/users/me/drafts");
    expect(gmail.count("POST", "/messages/send")).toBe(0);
    expect(gmail.sent).toHaveLength(0);
    expect(store.sends.size).toBe(0);
    expect(gmail.drafts).toHaveLength(1);
    const mime = gmail.drafts[0]!.mime;
    expect(mime).toContain("From: Partners in Biz <peet@partnersinbiz.online>");
    expect(mime).toContain("To: Ann Smith <ann@client.co.za>");
    expect(mime).toContain("Reply-To: outreach@partnersinbiz.online");
    expect(mime).toContain("Subject: Your backlink opportunity");
    expect(mime).toContain("multipart/alternative");
    expect(mime).toContain("text/html");
    expect(mime).not.toContain("List-Unsubscribe");

    expect(results(host.emitted)).toEqual([expect.objectContaining({ key: KEY, status: "drafted", draftUrl: result!.draftUrl, context: expect.objectContaining(request().context) })]);
    expect(sendResults(host.emitted)).toHaveLength(0);
    // Kept apart from a send request that uses the same key.
    expect(host.inbox.get(`draft:${KEY}`)).toMatchObject({ status: "drafted" });
    expect(host.inbox.has(KEY)).toBe(false);
  });

  it("uses the account `from` names when it is a connected Gmail account", async () => {
    const { gmail, env, store } = setup();
    store.addAccount({ id: "acc-2", company_id: CO, address: "sales@partnersinbiz.online", token_sealed: store.accounts.get("acc-1")!.token_sealed });
    const result = await handleDraftRequested(env, event(request({ from: "sales@partnersinbiz.online" })));
    expect(result).toMatchObject({ status: "drafted", account: "sales@partnersinbiz.online" });
    expect(gmail.drafts[0]!.mime).toContain("From: ");
    expect(gmail.drafts[0]!.mime).toContain("sales@partnersinbiz.online");
  });

  it("is idempotent: a repeat delivery creates no second Gmail draft and re-emits the stored result", async () => {
    const { gmail, env, host } = setup();
    const first = await handleDraftRequested(env, event(request()));
    const second = await handleDraftRequested(env, event(request()));
    expect(gmail.drafts).toHaveLength(1);
    expect(draftCalls(gmail)).toHaveLength(1);
    expect(second).toEqual(first);
    const emitted = results(host.emitted);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toEqual(emitted[0]);
  });

  it("finds a draft whose answer was lost instead of creating a second one", async () => {
    const { gmail, env, host } = setup();
    gmail.intercept = async (call) => {
      if (call.method !== "POST" || !call.url.pathname.endsWith("/drafts")) return null;
      gmail.intercept = null;
      await gmail.fetch(call.url.toString(), { method: call.method, body: call.body, headers: call.headers });
      return new Response(JSON.stringify({ error: { code: 503, message: "Backend Error" } }), { status: 503 });
    };
    expect(await handleDraftRequested(env, event(request()))).toBeNull();
    expect(gmail.drafts).toHaveLength(1);
    expect(host.inbox.size).toBe(0);
    const later = await handleDraftRequested(env, event(request()));
    expect(later).toMatchObject({ status: "drafted", gmailDraftId: "draft-1", gmailMessageId: "draft-msg-1" });
    expect(gmail.drafts).toHaveLength(1);
  });

  it("fails permanently without a connected Gmail account, and repeats the answer", async () => {
    const { gmail, env, host, store } = setup();
    store.accounts.clear();
    const first = await handleDraftRequested(env, event(request()));
    expect(first).toMatchObject({ status: "failed", permanent: true, error: "No Gmail account is connected in Mailbox", gmailDraftId: null, draftUrl: null });
    expect(await handleDraftRequested(env, event(request()))).toEqual(first);
    expect(gmail.calls).toHaveLength(0);

    const { env: env2, gmail: gmail2 } = setup();
    const named = await handleDraftRequested(env2, event(request({ key: "k-from", from: "other@partnersinbiz.online" })));
    expect(named).toMatchObject({ status: "failed", permanent: true, error: "No connected Gmail account for other@partnersinbiz.online in Mailbox" });
    expect(gmail2.drafts).toHaveLength(0);
    expect(results(host.emitted)).toHaveLength(2);
  });

  it("fails permanently on a bad address, no recipient or no subject, and never calls Gmail", async () => {
    const { gmail, env } = setup();
    const bad = await handleDraftRequested(env, event(request({ key: "k-bad", to: [{ email: "not an address" }] })));
    expect(bad).toMatchObject({ status: "failed", permanent: true });
    expect(bad!.error).toMatch(/Invalid to address/);
    const none = await handleDraftRequested(env, event(request({ key: "k-none", to: [] })));
    expect(none).toMatchObject({ status: "failed", permanent: true, error: "The draft has no recipients" });
    const noSubject = await handleDraftRequested(env, event(request({ key: "k-subject", subject: "  " })));
    expect(noSubject).toMatchObject({ status: "failed", permanent: true, error: "The draft has no subject" });
    expect(gmail.calls).toHaveLength(0);
  });

  it("fails permanently when `from` is a send-only email provider account", async () => {
    const { gmail, env, store } = setup();
    store.addAccount({ id: "esp-1", company_id: CO, address: "hello@updates.client.co.za", provider: "resend", status: "connected" });
    const result = await handleDraftRequested(env, event(request({ from: "hello@updates.client.co.za" })));
    expect(result).toMatchObject({ status: "failed", permanent: true });
    expect(result!.error).toMatch(/send-only email provider account/);
    expect(gmail.calls).toHaveLength(0);
    expect(gmail.drafts).toHaveLength(0);
  });

  it("answers with a permanent failure while the Mailbox is off, like a send", async () => {
    const { env, gmail, host } = setup();
    switchedOff(host.ctx, { mailbox: false });
    const result = await handleDraftRequested(env, event(request()));
    expect(result).toMatchObject({ status: "failed", permanent: true, error: MAILBOX_OFF });
    expect(gmail.calls).toHaveLength(0);
    expect(results(host.emitted)).toEqual([expect.objectContaining({ status: "failed" })]);
  });

  it("a client's mailbox refuses another party's draft", async () => {
    const { env, gmail, store } = setup();
    store.accounts.get("acc-1")!.client_ref = "crm-co-9";
    store.accounts.get("acc-1")!.client_kind = "company";
    const result = await handleDraftRequested(env, event(request({ from: "peet@partnersinbiz.online" })));
    expect(result).toMatchObject({ status: "failed", permanent: true });
    expect(result!.error).toMatch(/belongs to a client/);
    expect(gmail.drafts).toHaveLength(0);
  });

  it("treats Gmail trouble as transient: performDraft throws, the handler stores and emits nothing, the next delivery drafts", async () => {
    const { gmail, env, host } = setup();
    gmail.intercept = (call) => (call.url.pathname.endsWith("/drafts") && call.method === "POST" ? new Response(JSON.stringify({ error: { code: 503, message: "Backend Error" } }), { status: 503 }) : null);
    await expect(performDraft(env, CO, request())).rejects.toThrow(/Gmail: Backend Error/);
    expect(await handleDraftRequested(env, event(request()))).toBeNull();
    expect(host.inbox.size).toBe(0);
    expect(results(host.emitted)).toHaveLength(0);

    gmail.intercept = (call) => (call.url.pathname.endsWith("/drafts") && call.method === "POST" ? new Response(JSON.stringify({ error: { code: 429, message: "Rate Limit Exceeded", status: "RESOURCE_EXHAUSTED" } }), { status: 429 }) : null);
    await expect(performDraft(env, CO, request())).rejects.toThrow();

    gmail.intercept = null;
    expect(await handleDraftRequested(env, event(request()))).toMatchObject({ status: "drafted" });
    expect(gmail.drafts).toHaveLength(1);
  });

  it("a mailbox that must be reconnected throws (transient) and creates nothing", async () => {
    const { gmail, env, store, host } = setup();
    store.accounts.get("acc-1")!.status = "needs_reconnect";
    await expect(performDraft(env, CO, request())).rejects.toThrow(/must be reconnected/);
    expect(await handleDraftRequested(env, event(request()))).toBeNull();
    expect(gmail.drafts).toHaveLength(0);
    expect(host.inbox.size).toBe(0);
  });

  it("a message Gmail refuses (400) fails for good", async () => {
    const { gmail, env } = setup();
    gmail.intercept = (call) => (call.url.pathname.endsWith("/drafts") && call.method === "POST" ? new Response(JSON.stringify({ error: { code: 400, message: "Invalid To header" } }), { status: 400 }) : null);
    expect(await handleDraftRequested(env, event(request()))).toMatchObject({ status: "failed", permanent: true, error: "Gmail: Invalid To header" });
  });

  it("uses the upload endpoint for a large draft", async () => {
    const { gmail, env } = setup();
    const result = await handleDraftRequested(env, event(request({ key: "big", html: `<p>${"a".repeat(4_000_000)}</p>`, text: "a".repeat(100) })));
    expect(result).toMatchObject({ status: "drafted" });
    const call = draftCalls(gmail)[0]!;
    expect(call.url.pathname).toBe("/upload/gmail/v1/users/me/drafts");
    expect(call.url.searchParams.get("uploadType")).toBe("multipart");
    expect(gmail.count("POST", "/messages/send")).toBe(0);
  });
});

describe("draft request parsing", () => {
  it("reads the sender from the event type and cleans the payload", () => {
    expect(draftSenderOf("plugin.partnersinbiz.seo.mail.draft.requested")).toBe("partnersinbiz.seo");
    expect(draftSenderOf("plugin.partnersinbiz.seo.mail.send.requested")).toBeNull();
    expect(normaliseDraftRequest({ to: ["a@b.co"] }, "x")).toBeNull();
    const parsed = normaliseDraftRequest({ key: "k", to: ["Ann <ANN@b.co>", "ann@b.co"], subject: "Hi\r\nBcc: x@y.z", text: "t" }, "partnersinbiz.seo")!;
    expect(parsed.request.to).toEqual([{ email: "ann@b.co", name: "Ann" }]);
    expect(parsed.request.subject).toBe("Hi Bcc: x@y.z");
    expect(parsed.request.context.plugin).toBe("partnersinbiz.seo");
    expect(parsed.problem).toBeNull();
    expect(normaliseDraftRequest({ key: "k", to: [], subject: "s" }, "x")!.problem).toBe("The draft has no recipients");
  });

  it("every MAIL_SENDERS plugin is a draft requester the handler understands", () => {
    for (const sender of MAIL_SENDERS) expect(draftSenderOf(pluginEvent(sender, MAIL_EVENTS.draftRequested))).toBe(sender);
  });
});
