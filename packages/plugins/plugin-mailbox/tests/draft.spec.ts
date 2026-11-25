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

function switchedOff(ctx: unknown, modules: Record<string, boolean>) {
  (ctx as { state: unknown }).state = {
    get: async (key: { namespace?: string; stateKey?: string }) => (key.namespace === "pib-setup" && key.stateKey === "modules" ? { companyId: CO, modules, updatedAt: "2026-09-26T08:00:00Z" } : null),
    set: async () => undefined,
  };
}

const drafts = (store: ReturnType<typeof setup>["store"]) => [...store.messages.values()].filter((m) => m.direction === "outbound" && m.status === "draft");

describe("mail.draft.requested (PAR-12249: drafts live in the Paperclip Mailbox, never in Gmail Drafts)", () => {
  it("saves the draft in the Mailbox, writes nothing to Gmail and answers with the draft's id", async () => {
    const { gmail, env, host, store } = setup({ fromName: "Partners in Biz" });
    const result = await handleDraftRequested(env, event(request({ replyTo: { email: "outreach@partnersinbiz.online" } })));

    expect(result).toMatchObject({ key: KEY, status: "drafted", gmailDraftId: null, draftUrl: null, account: "peet@partnersinbiz.online", error: null, permanent: false, context: request().context });
    expect(result!.mailboxDraftId).toBeTruthy();
    expect(gmail.calls).toHaveLength(0);
    expect(gmail.drafts).toHaveLength(0);
    expect(gmail.sent).toHaveLength(0);
    expect(store.sends.size).toBe(0);
    const [row] = drafts(store);
    expect(row).toMatchObject({ id: result!.mailboxDraftId, subject: "Your backlink opportunity", body: "Hi Ann, we would like to feature you.", account_id: "acc-1" });
    expect(row!.to_addrs).toEqual([{ email: "ann@client.co.za", name: "Ann Smith" }]);
    expect(row!.draft).toMatchObject({ html: "<p>Hi Ann, we would like to feature you.</p>", replyTo: { email: "outreach@partnersinbiz.online" }, requestKey: KEY, holdForPerson: expect.objectContaining({ reason: expect.any(String) }) });
    expect(results(host.emitted)).toEqual([expect.objectContaining({ key: KEY, status: "drafted", context: expect.objectContaining(request().context) })]);
    expect(sendResults(host.emitted)).toHaveLength(0);
    expect(host.inbox.get(`draft:${KEY}`)).toMatchObject({ status: "drafted" });
    expect(host.inbox.has(KEY)).toBe(false);
  });

  it("uses the account named in `from` when it is a connected Gmail account", async () => {
    const { env, store } = setup();
    store.addAccount({ id: "acc-2", company_id: CO, address: "sales@partnersinbiz.online", token_sealed: store.accounts.get("acc-1")!.token_sealed });
    const result = await handleDraftRequested(env, event(request({ from: "sales@partnersinbiz.online" })));
    expect(result).toMatchObject({ status: "drafted", account: "sales@partnersinbiz.online" });
    expect(drafts(store)[0]!.account_id).toBe("acc-2");
  });

  it("is idempotent: a repeat delivery creates no second draft and re-emits the stored result", async () => {
    const { env, host, store } = setup();
    const first = await handleDraftRequested(env, event(request()));
    const second = await handleDraftRequested(env, event(request()));
    expect(drafts(store)).toHaveLength(1);
    expect(second).toEqual(first);
    const emitted = results(host.emitted);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toEqual(emitted[0]);
  });

  it("a redelivery after a lost answer (no stored result) finds the draft by its request key and saves no second one", async () => {
    const { env, store } = setup();
    const first = await performDraft(env, CO, request());
    const again = await performDraft(env, CO, request());
    expect(drafts(store)).toHaveLength(1);
    expect(again).toMatchObject({ status: "drafted", mailboxDraftId: first.mailboxDraftId });
  });

  it("a failing replacement still answers drafted (the draft is saved), and the retry saves no second draft", async () => {
    const { env, store, host } = setup();
    store.draftsByPurpose = async () => Promise.reject(new Error("statement timeout"));
    const first = await performDraft(env, CO, request());
    expect(first).toMatchObject({ status: "drafted", replacedDraftIds: [] });
    expect(host.ctx.logger.info).toHaveBeenCalledWith("Older drafts not replaced", expect.objectContaining({ key: KEY, error: "statement timeout" }));
    await performDraft(env, CO, request());
    expect(drafts(store)).toHaveLength(1);
  });

  it("one draft per client and purpose: a newer draft replaces the older open one", async () => {
    const { env, store } = setup();
    const ctx = { plugin: PIB_PLUGINS.seo, kind: "seo-approval", id: "sprint-1", clientKind: "company" as const, clientRef: "crm-agri" };
    const first = await handleDraftRequested(env, event(request({ key: "k1", context: ctx, subject: "Please review 2 proposed changes" })));
    const second = await handleDraftRequested(env, event(request({ key: "k2", context: ctx, subject: "Please review 5 proposed changes" })));
    const other = await handleDraftRequested(env, event(request({ key: "k3", context: { ...ctx, clientRef: "crm-hunt" }, subject: "Please review 4 proposed changes" })));
    expect(second!.replacedDraftIds).toEqual([first!.mailboxDraftId]);
    expect(other!.replacedDraftIds).toEqual([]);
    expect(drafts(store).map((d) => d.subject).sort()).toEqual(["Please review 4 proposed changes", "Please review 5 proposed changes"]);
  });

  it("never replaces a draft that was already sent", async () => {
    const { env, store } = setup();
    const ctx = { plugin: PIB_PLUGINS.seo, kind: "seo-approval", id: "sprint-1", clientKind: "company" as const, clientRef: "crm-agri" };
    const first = await handleDraftRequested(env, event(request({ key: "k1", context: ctx })));
    store.messages.get(first!.mailboxDraftId!)!.status = "sent";
    await handleDraftRequested(env, event(request({ key: "k2", context: ctx })));
    expect(store.messages.size).toBe(2);
  });

  it("fails permanently without a connected Gmail account, and repeats the answer", async () => {
    const { gmail, env, host, store } = setup();
    store.accounts.clear();
    const first = await handleDraftRequested(env, event(request()));
    expect(first).toMatchObject({ status: "failed", permanent: true, error: "No Gmail account is connected in Mailbox", gmailDraftId: null, draftUrl: null });
    expect(await handleDraftRequested(env, event(request()))).toEqual(first);
    expect(gmail.calls).toHaveLength(0);

    const { env: env2, store: store2 } = setup();
    const named = await handleDraftRequested(env2, event(request({ key: "k-from", from: "other@partnersinbiz.online" })));
    expect(named).toMatchObject({ status: "failed", permanent: true, error: "No connected Gmail account for other@partnersinbiz.online in Mailbox" });
    expect(drafts(store2)).toHaveLength(0);
    expect(results(host.emitted)).toHaveLength(2);
  });

  it("fails permanently on a bad address, no recipient or no subject", async () => {
    const { env, store } = setup();
    const bad = await handleDraftRequested(env, event(request({ key: "k-bad", to: [{ email: "not an address" }] })));
    expect(bad).toMatchObject({ status: "failed", permanent: true });
    expect(bad!.error).toMatch(/Invalid to address/);
    expect(await handleDraftRequested(env, event(request({ key: "k-none", to: [] })))).toMatchObject({ status: "failed", permanent: true, error: "The draft has no recipients" });
    expect(await handleDraftRequested(env, event(request({ key: "k-subject", subject: "  " })))).toMatchObject({ status: "failed", permanent: true, error: "The draft has no subject" });
    expect(drafts(store)).toHaveLength(0);
  });

  it("fails permanently when `from` is a send-only email provider account", async () => {
    const { env, store } = setup();
    store.addAccount({ id: "esp-1", company_id: CO, address: "hello@updates.client.co.za", provider: "resend", status: "connected" });
    const result = await handleDraftRequested(env, event(request({ from: "hello@updates.client.co.za" })));
    expect(result).toMatchObject({ status: "failed", permanent: true });
    expect(result!.error).toMatch(/send-only email provider account/);
    expect(drafts(store)).toHaveLength(0);
  });

  it("answers with a permanent failure while the Mailbox is off, like a send", async () => {
    const { env, gmail, host, store } = setup();
    switchedOff(host.ctx, { mailbox: false });
    const result = await handleDraftRequested(env, event(request()));
    expect(result).toMatchObject({ status: "failed", permanent: true, error: MAILBOX_OFF });
    expect(gmail.calls).toHaveLength(0);
    expect(drafts(store)).toHaveLength(0);
    expect(results(host.emitted)).toEqual([expect.objectContaining({ status: "failed" })]);
  });

  it("a client's mailbox refuses another party's draft", async () => {
    const { env, store } = setup();
    store.accounts.get("acc-1")!.client_ref = "crm-co-9";
    store.accounts.get("acc-1")!.client_kind = "company";
    const result = await handleDraftRequested(env, event(request({ from: "peet@partnersinbiz.online" })));
    expect(result).toMatchObject({ status: "failed", permanent: true });
    expect(result!.error).toMatch(/belongs to a client/);
    expect(drafts(store)).toHaveLength(0);
  });

  it("a mailbox that must be reconnected still gets the draft: it lives in the Mailbox, not Gmail", async () => {
    const { gmail, env, store } = setup();
    store.accounts.get("acc-1")!.status = "needs_reconnect";
    expect(await handleDraftRequested(env, event(request()))).toMatchObject({ status: "drafted" });
    expect(drafts(store)).toHaveLength(1);
    expect(gmail.calls).toHaveLength(0);
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
