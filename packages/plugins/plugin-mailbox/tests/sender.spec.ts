import { describe, expect, it } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { HANDOFF_EVENTS, MAIL_EVENTS, PIB_PLUGINS, pluginEvent, verifyUnsubscribeToken, type MailSendRequested } from "@partnersinbiz/pib-plugin-kit";
import { handleSendRequested, normaliseRequest } from "../src/gmail/send.js";
import { syncAccount } from "../src/gmail/sync.js";
import { listUnsubscribeHeader, onContactSuppressed } from "../src/suppression.js";
import { accountScopeProblem, accountSenderKey, cleanDisplayName, draftSendContext, effectiveReplyTo, MAX_UNSUBSCRIBE_URL, parseReplyTo, parseUnsubscribeUrl, requestSenderKey } from "../src/sender.js";
import { CO } from "./helpers/memory.js";
import { fakeSelfFetch, forceGate, openGate } from "./helpers/proxy.js";
import { sealedTokens, setup } from "./helpers/setup.js";
import { probeUnsubscribeProxy, PROXY_PROOF_MAX_AGE_MS } from "../src/unsubscribe.js";

const CAMPAIGNS = pluginEvent(PIB_PLUGINS.campaigns, MAIL_EVENTS.sendRequested);
const BILLING = pluginEvent(PIB_PLUGINS.billing, MAIL_EVENTS.sendRequested);
const AHS = { clientKind: "company", clientRef: "crm-ahs" };
const SECRET = "unsubscribe-secret-0123456789";

function request(overrides: Partial<MailSendRequested> = {}): MailSendRequested {
  return {
    key: "campaigns:step:ahs-1:1",
    from: "info@ahslaw.co.za",
    to: [{ email: "ann@lead.co.za", name: "Ann" }],
    subject: "Our conveyancing offer",
    text: "Hi Ann. Reply STOP to stop these emails.",
    marketing: true,
    context: { plugin: PIB_PLUGINS.campaigns, kind: "campaign_step", id: "ahs-1", ...AHS },
    ...overrides,
  };
}

const event = (payload: unknown, eventType: string = CAMPAIGNS): PluginEvent => ({ eventId: crypto.randomUUID(), eventType: eventType as PluginEvent["eventType"], occurredAt: new Date().toISOString(), companyId: CO, payload });

/** The company's own mailbox plus a client's (AHS Law's own Gmail, connected for them). */
function withClientMailbox(config: Record<string, unknown> = {}) {
  const s = setup(config);
  const client = s.store.addAccount({ id: "acc-ahs", company_id: CO, address: "info@ahslaw.co.za", token_sealed: sealedTokens(), client_kind: "company", client_ref: "crm-ahs", from_name: "AHS Law" });
  return { ...s, client };
}

describe("who a send is from", () => {
  it("a client's mailbox sends the client's mail as the client: name, Reply-To, and no PiB address anywhere", async () => {
    const { env, gmail } = withClientMailbox();
    const result = await handleSendRequested(env, event(request({ fromName: "AHS Law Conveyancing", replyTo: { email: "intake@ahslaw.co.za", name: "Intake" } })));
    expect(result).toMatchObject({ status: "sent" });
    const mime = gmail.sent[0]!.mime;
    expect(mime).toContain("From: AHS Law Conveyancing <info@ahslaw.co.za>");
    expect(mime).toContain("Reply-To: Intake <intake@ahslaw.co.za>");
    expect(mime).not.toContain("partnersinbiz");
  });

  it("the request's name beats the mailbox's own name, which beats the company setting", async () => {
    const { env, gmail } = withClientMailbox({ fromName: "Partners in Biz" });
    await handleSendRequested(env, event(request({ key: "k1" })));
    await handleSendRequested(env, event(request({ key: "k2", fromName: "From The Request" })));
    await handleSendRequested(env, event(request({ key: "k3", from: undefined, context: { plugin: PIB_PLUGINS.campaigns, kind: "campaign_step", id: "own" } })));
    expect(gmail.sent.map((s) => /^From: (.+)$/m.exec(s.mime)![1])).toEqual(["AHS Law <info@ahslaw.co.za>", "From The Request <info@ahslaw.co.za>", "Partners in Biz <peet@partnersinbiz.online>"]);
  });

  it("a Reply-To that is the sending address is dropped, and an unusable one is refused for good before anything is sent", async () => {
    const { env, gmail } = withClientMailbox();
    await handleSendRequested(env, event(request({ key: "k1", replyTo: { email: "INFO@ahslaw.co.za" } })));
    expect(gmail.sent[0]!.mime).not.toContain("Reply-To:");
    const bad = await handleSendRequested(env, event({ ...request({ key: "k2" }), replyTo: "not an address" }));
    expect(bad).toMatchObject({ status: "failed", permanent: true, error: "Invalid replyTo address" });
    expect(gmail.sent).toHaveLength(1);
  });

  it("a client's mailbox refuses mail that is not that client's, for good, and nothing leaves", async () => {
    const { env, gmail, store } = withClientMailbox();
    for (const [key, context] of [
      ["other-client", { plugin: PIB_PLUGINS.campaigns, kind: "campaign_step", id: "x", clientKind: "company", clientRef: "crm-other" }],
      ["own", { plugin: PIB_PLUGINS.campaigns, kind: "campaign_step", id: "x" }],
      ["a-contact", { plugin: PIB_PLUGINS.campaigns, kind: "campaign_step", id: "x", clientKind: "contact", clientRef: "crm-ahs" }],
    ] as const) {
      const result = await handleSendRequested(env, event(request({ key, context })));
      expect(result, key).toMatchObject({ status: "failed", permanent: true });
      expect(result!.error, key).toBe("The mailbox info@ahslaw.co.za belongs to a client (company:crm-ahs) and only sends that client's mail. This message is not for them, so it was not sent from there.");
    }
    expect(gmail.sent).toHaveLength(0);
    expect(store.sends.get("other-client")).toMatchObject({ status: "failed", permanent: true });
    expect(await handleSendRequested(env, event(request({ key: "right" })))).toMatchObject({ status: "sent" });
  });

  it("a client's mailbox is never the default sender; with no company mailbox nothing falls back to it", async () => {
    const { env, gmail, store } = withClientMailbox();
    await handleSendRequested(env, event(request({ key: "no-from", from: undefined, context: { plugin: PIB_PLUGINS.campaigns, kind: "campaign_step", id: "own" } })));
    expect(gmail.sent[0]!.mime).toContain("From: peet@partnersinbiz.online");
    expect(gmail.sent[0]!.mime).not.toContain("ahslaw");
    store.accounts.delete("acc-1");
    const none = await handleSendRequested(env, event(request({ key: "no-own", from: undefined, context: { plugin: PIB_PLUGINS.campaigns, kind: "campaign_step", id: "own" } })));
    expect(none).toMatchObject({ status: "failed", permanent: true, error: "No Gmail account is connected in Mailbox" });
    expect(gmail.sent).toHaveLength(1);
  });

  it("the company's own mailbox behaves as before: any sender may use it, even mail about a client", async () => {
    const { env, gmail } = withClientMailbox();
    const result = await handleSendRequested(env, event(request({ key: "own-about-client", from: "peet@partnersinbiz.online" })));
    expect(result).toMatchObject({ status: "sent" });
    expect(gmail.sent[0]!.mime).toContain("From: peet@partnersinbiz.online");
    // An invoice for a client, sent from the default account, with the invoiced customer in its context: unchanged.
    const invoice = await handleSendRequested(env, event({ key: "inv", to: [{ email: "ann@lead.co.za" }], subject: "Invoice", text: "Hi", context: { plugin: PIB_PLUGINS.billing, kind: "invoice", id: "1", ...AHS } }, BILLING));
    expect(invoice).toMatchObject({ status: "sent" });
  });

  it("the sender key is the mailbox's client, not the invoiced customer in a request's context", () => {
    expect(accountSenderKey({ client_kind: null, client_ref: null })).toBe("own");
    expect(accountSenderKey({ client_kind: "company", client_ref: "crm-ahs" })).toBe("company:crm-ahs");
    expect(accountSenderKey({ client_kind: "contact", client_ref: "c1" })).toBe("contact:c1");
    expect(requestSenderKey(request())).toBe("company:crm-ahs");
    expect(accountScopeProblem({ address: "x@y.co", client_kind: null, client_ref: null }, request())).toBeNull();
  });

  it("a draft on a client's mailbox is sent in the client's context, or the mailbox would refuse it", () => {
    expect(draftSendContext({ client_kind: null, client_ref: null }, "d1", "partnersinbiz.mailbox")).toEqual({ plugin: "partnersinbiz.mailbox", kind: "draft", id: "d1" });
    const context = draftSendContext({ client_kind: "company", client_ref: "crm-ahs" }, "d1", "partnersinbiz.mailbox");
    expect(context).toMatchObject({ clientKind: "company", clientRef: "crm-ahs" });
    expect(accountScopeProblem({ address: "info@ahslaw.co.za", client_kind: "company", client_ref: "crm-ahs" }, { context })).toBeNull();
  });

  it("cleans names, reply-to and unsubscribe addresses so nothing can break a header", () => {
    expect(cleanDisplayName("  AHS\r\nBcc: evil@x.co <b>  ")).toBe("AHS Bcc: evil@x.co b");
    expect(cleanDisplayName("x".repeat(300))!.length).toBe(120);
    expect(cleanDisplayName("   ")).toBeNull();
    expect(parseReplyTo(undefined)).toEqual({ address: null, invalid: false });
    expect(parseReplyTo("Intake <INTAKE@x.co>")).toEqual({ address: { email: "intake@x.co", name: "Intake" }, invalid: false });
    expect(parseReplyTo("nope")).toEqual({ address: null, invalid: true });
    expect(effectiveReplyTo({ email: "a@x.co" }, "A@X.CO")).toBeNull();
    expect(parseUnsubscribeUrl("https://u.example.com/u?t=1")).toEqual({ url: "https://u.example.com/u?t=1", invalid: false });
    for (const bad of ["http://u.example.com/u", "https://u.example.com/u>, <mailto:x@y.co", "https://u.example.com/ x", "javascript:alert(1)", "https://u.example.com/\r\nBcc: x@y.co", 42]) {
      expect(parseUnsubscribeUrl(bad).invalid, String(bad)).toBe(true);
    }
    const parsed = normaliseRequest({ key: "k", to: ["a@b.co"], subject: "s", text: "t", fromName: "Evil\r\nBcc: x@y.co", context: { plugin: "p", kind: "k", id: "i" } }, "p")!;
    expect(parsed.request.fromName).toBe("Evil Bcc: x@y.co");
  });
});

describe("RFC 8058 one-click unsubscribe", () => {
  const HTTPS = "https://paperclip.example.com/api/plugins/partnersinbiz.mailbox/webhooks/unsubscribe?token=abc.def";

  it("marketing mail with an https address carries it first, then the mailto, and List-Unsubscribe-Post", async () => {
    const { env, gmail } = withClientMailbox();
    await handleSendRequested(env, event(request({ unsubscribeUrl: HTTPS })));
    const mime = gmail.sent[0]!.mime;
    expect(mime).toContain(`List-Unsubscribe: <${HTTPS}>, <mailto:info@ahslaw.co.za?subject=unsubscribe>`);
    expect(mime).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(mime.indexOf("List-Unsubscribe:")).toBeLessThan(mime.indexOf("List-Unsubscribe-Post:"));
  });

  it("without an https address it is the mailto form only, and no Post header (one-click needs both)", async () => {
    const { env, gmail } = withClientMailbox();
    await handleSendRequested(env, event(request()));
    const mime = gmail.sent[0]!.mime;
    expect(mime).toContain("List-Unsubscribe: <mailto:info@ahslaw.co.za?subject=unsubscribe>");
    expect(mime).not.toContain("List-Unsubscribe-Post");
    expect(listUnsubscribeHeader("a@b.co")).toEqual({ value: "<mailto:a@b.co?subject=unsubscribe>", post: null });
    expect(listUnsubscribeHeader("a@b.co", "https://x.co/u")).toEqual({ value: "<https://x.co/u>, <mailto:a@b.co?subject=unsubscribe>", post: "List-Unsubscribe=One-Click" });
  });

  it("the header is one line under the 998-character limit: an address that is too long is refused for good, and a link that would still push it over is left out, never truncated", () => {
    const base = "https://u.example.com/u?t=";
    const longest = base + "a".repeat(MAX_UNSUBSCRIBE_URL - base.length);
    expect(parseUnsubscribeUrl(longest)).toEqual({ url: longest, invalid: false });
    expect(parseUnsubscribeUrl(`${longest}a`).invalid).toBe(true);
    // The normalised form counts, not only what was given (a space-free unicode path is percent-encoded and grows).
    expect(parseUnsubscribeUrl(`${base}${"é".repeat(300)}`).invalid).toBe(true);
    // The longest address with the longest sending address still fits on one line.
    const longAddress = `${"x".repeat(64)}@${"d".repeat(63)}.${"d".repeat(63)}.${"d".repeat(55)}.co.za`;
    expect(longAddress.length).toBe(254);
    const header = listUnsubscribeHeader(longAddress, longest);
    expect(header.post).toBe("List-Unsubscribe=One-Click");
    expect(`List-Unsubscribe: ${header.value}`.length).toBeLessThanOrEqual(998);
    // Anything beyond that (a link the caller's own check did not see, such as the Mailbox's own) is dropped for the mailto form.
    expect(listUnsubscribeHeader("a@b.co", `https://u.example.com/${"x".repeat(1000)}`)).toEqual({ value: "<mailto:a@b.co?subject=unsubscribe>", post: null });
  });

  it("an address that is not https is refused for good (the sender thinks one-click works), and transactional mail never carries one", async () => {
    const { env, gmail } = withClientMailbox();
    const bad = await handleSendRequested(env, event({ ...request({ key: "bad" }), unsubscribeUrl: "http://u.example.com/u" }));
    expect(bad).toMatchObject({ status: "failed", permanent: true, error: "unsubscribeUrl must be an https address with no spaces" });
    expect(gmail.sent).toHaveLength(0);
    await handleSendRequested(env, event(request({ key: "inv", marketing: undefined, unsubscribeUrl: HTTPS, context: { plugin: PIB_PLUGINS.billing, kind: "invoice", id: "1", ...AHS } }), BILLING));
    expect(gmail.sent[0]!.mime).not.toContain("List-Unsubscribe");
  });

  it("with the secret set but the proxy rule not proved, marketing mail carries the mailto form only and no Post header; it opens when the proof passes and closes when it fails or goes stale", async () => {
    const { env, gmail } = withClientMailbox({ unsubscribe: { secret: SECRET } });
    let now = Date.parse("2026-10-03T10:00:00.000Z");
    (env as { now: () => number }).now = () => now;
    const sentMime = async (key: string) => {
      await handleSendRequested(env, event(request({ key })));
      return gmail.sent.at(-1)!.mime;
    };
    // Never checked: the live state before anyone adds the proxy rule.
    let mime = await sentMime("never-checked");
    expect(mime).toContain("List-Unsubscribe: <mailto:info@ahslaw.co.za?subject=unsubscribe>");
    expect(mime).not.toContain("https://paperclip");
    expect(mime).not.toContain("List-Unsubscribe-Post");
    // Checked and the proxy does not pass the address on: still closed.
    fakeSelfFetch(env, { proxy: false });
    await probeUnsubscribeProxy(env, CO);
    mime = await sentMime("proxy-missing");
    expect(mime).not.toContain("https://paperclip");
    expect(mime).not.toContain("List-Unsubscribe-Post");
    // The rule exists and the Mailbox proved it: the https link and the Post header.
    fakeSelfFetch(env, { proxy: true });
    await probeUnsubscribeProxy(env, CO);
    mime = await sentMime("proxy-proved");
    expect(mime).toMatch(/List-Unsubscribe: <https:\/\/paperclip\.example\.com\/api\/plugins\/partnersinbiz\.mailbox\/webhooks\/unsubscribe\?token=[^>]+>, <mailto:info@ahslaw\.co\.za\?subject=unsubscribe>/);
    expect(mime).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    // The hourly check stopped: after six hours the link is off again.
    now += PROXY_PROOF_MAX_AGE_MS + 60_000;
    mime = await sentMime("proof-stale");
    expect(mime).not.toContain("https://paperclip");
    expect(mime).not.toContain("List-Unsubscribe-Post");
    // A caller's own https address is the caller's responsibility and is never gated.
    await handleSendRequested(env, event(request({ key: "theirs", unsubscribeUrl: HTTPS })));
    expect(gmail.sent.at(-1)!.mime).toContain(`<${HTTPS}>`);
    expect(gmail.sent.at(-1)!.mime).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  });

  it("with an unsubscribe secret and a proved proxy the Mailbox makes its own signed link for a single recipient, for whoever the mailbox sends as", async () => {
    const { env, gmail } = withClientMailbox({ unsubscribe: { secret: SECRET } });
    await openGate(env);
    await handleSendRequested(env, event(request({ key: "own-link" })));
    const url = /List-Unsubscribe: <(https:[^>]+)>/.exec(gmail.sent[0]!.mime)![1]!;
    expect(url.startsWith("https://paperclip.example.com/api/plugins/partnersinbiz.mailbox/webhooks/unsubscribe?token=")).toBe(true);
    const token = decodeURIComponent(new URL(url).searchParams.get("token")!);
    expect(verifyUnsubscribeToken(token, SECRET)).toEqual({ companyId: CO, email: "ann@lead.co.za", senderKey: "company:crm-ahs" });
    expect(verifyUnsubscribeToken(token, "another-secret-0123456789")).toBeNull();
    expect(gmail.sent[0]!.mime).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    // The company's own mailbox signs for `own`.
    await handleSendRequested(env, event(request({ key: "own-mailbox", from: undefined, context: { plugin: PIB_PLUGINS.campaigns, kind: "campaign_step", id: "x" } })));
    const ownUrl = /List-Unsubscribe: <(https:[^>]+)>/.exec(gmail.sent[1]!.mime)![1]!;
    expect(verifyUnsubscribeToken(decodeURIComponent(new URL(ownUrl).searchParams.get("token")!), SECRET)).toMatchObject({ senderKey: "own" });
  });

  it("makes no link for several recipients (a link opts out one address), with no secret, or with a secret that is too short; the caller's link always wins", async () => {
    const many = withClientMailbox({ unsubscribe: { secret: SECRET } });
    await openGate(many.env);
    await handleSendRequested(many.env, event(request({ key: "many", cc: [{ email: "bob@lead.co.za" }] })));
    expect(many.gmail.sent[0]!.mime).not.toContain("https://paperclip");
    // Even with the gate open, no secret (or a short one) means no link of the Mailbox's own.
    const none = withClientMailbox();
    await forceGate(none.env);
    await handleSendRequested(none.env, event(request()));
    expect(none.gmail.sent[0]!.mime).not.toContain("https://paperclip");
    const short = withClientMailbox({ unsubscribe: { secret: "short" } });
    await forceGate(short.env);
    await handleSendRequested(short.env, event(request()));
    expect(short.gmail.sent[0]!.mime).not.toContain("https://paperclip");
    await handleSendRequested(many.env, event(request({ key: "theirs", unsubscribeUrl: HTTPS })));
    expect(many.gmail.sent[1]!.mime).toContain(`<${HTTPS}>`);
  });
});

describe("the do-not-email list is per sender", () => {
  const send = (s: ReturnType<typeof withClientMailbox>, key: string, from: string | undefined, context: MailSendRequested["context"], extra: Partial<MailSendRequested> = {}) =>
    handleSendRequested(s.env, event(request({ key, from, context, ...extra })));
  const ownContext = { plugin: PIB_PLUGINS.campaigns, kind: "campaign_step", id: "own" };
  const ahsContext = { plugin: PIB_PLUGINS.campaigns, kind: "campaign_step", id: "ahs", ...AHS };

  it("an opt-out from a client's list does not silence the company's own marketing, and the other way round", async () => {
    const s = withClientMailbox();
    s.store.addSuppression(CO, "ann@lead.co.za", "marketing", "unsubscribed", "partnersinbiz.campaigns", "company:crm-ahs");
    expect((await send(s, "own-ok", undefined, ownContext))!.status).toBe("sent");
    expect((await send(s, "ahs-blocked", "info@ahslaw.co.za", ahsContext))).toMatchObject({ status: "failed", permanent: true, suppressed: [{ email: "ann@lead.co.za", scope: "marketing" }] });
    const t = withClientMailbox();
    t.store.addSuppression(CO, "ann@lead.co.za", "marketing", "unsubscribed", "partnersinbiz.campaigns", "own");
    expect((await send(t, "own-blocked", undefined, ownContext))!.status).toBe("failed");
    expect((await send(t, "ahs-ok", "info@ahslaw.co.za", ahsContext))!.status).toBe("sent");
  });

  it("a row from before senders existed still silences everyone's marketing, and a hard bounce stops every send from any sender", async () => {
    const s = withClientMailbox();
    s.store.addSuppression(CO, "ann@lead.co.za", "marketing");
    expect((await send(s, "own", undefined, ownContext))!.status).toBe("failed");
    expect((await send(s, "ahs", "info@ahslaw.co.za", ahsContext))!.status).toBe("failed");
    // ...but transactional mail still goes to a marketing opt-out.
    expect((await send(s, "inv", undefined, { plugin: PIB_PLUGINS.billing, kind: "invoice", id: "1" }, { marketing: undefined }))!.status).toBe("sent");
    const b = withClientMailbox();
    b.store.addSuppression(CO, "ann@lead.co.za", "all", "bounced", "partnersinbiz.mailbox");
    expect((await send(b, "ahs-inv", "info@ahslaw.co.za", ahsContext, { marketing: undefined }))!.status).toBe("failed");
    expect((await send(b, "own-inv", undefined, ownContext, { marketing: undefined }))!.status).toBe("failed");
  });

  it("an unsubscribe reply on a client's mailbox goes on that client's list, is announced with it, and is recorded as withdrawn consent", async () => {
    const s = withClientMailbox();
    s.gmail.addMessage({ id: "stop-1", headers: { From: "Ann <ann@lead.co.za>", To: "info@ahslaw.co.za", Subject: "Unsubscribe" }, snippet: "Unsubscribe" });
    await syncAccount(s.env, await s.loaded(), s.client, await s.run());
    expect(s.store.suppressions.get(`${CO}:ann@lead.co.za:company:crm-ahs`)).toMatchObject({ scope: "marketing", reason: "unsubscribed", sender_key: "company:crm-ahs", source: "partnersinbiz.mailbox" });
    expect([...s.store.suppressions.keys()]).toEqual([`${CO}:ann@lead.co.za:company:crm-ahs`]);
    const suppressed = s.host.emitted.filter((e) => e.name === HANDOFF_EVENTS.contactSuppressed).map((e) => e.payload);
    expect(suppressed).toEqual([expect.objectContaining({ key: "suppress:ann@lead.co.za:unsubscribed:company:crm-ahs", email: "ann@lead.co.za", scope: "marketing", senderKey: "company:crm-ahs" })]);
    const consent = s.host.emitted.filter((e) => e.name === HANDOFF_EVENTS.consentRecorded).map((e) => e.payload);
    expect(consent).toEqual([expect.objectContaining({ purpose: "marketing_email", basis: "consent", granted: false, source: "reply", subject: { email: "ann@lead.co.za", clientKind: "company", clientRef: "crm-ahs" }, recordedBy: "partnersinbiz.mailbox", evidence: { wording: "Unsubscribe" } })]);
    // The company's own marketing to her is not silenced by it.
    expect((await send(s, "own-still-ok", undefined, ownContext))!.status).toBe("sent");
  });

  it("an unsubscribe reply on the company's own mailbox is the company's own list, with the old announcement key", async () => {
    const s = withClientMailbox();
    s.gmail.addMessage({ id: "stop-2", headers: { From: "Bob <bob@lead.co.za>", To: "peet@partnersinbiz.online", Subject: "STOP" }, snippet: "stop" });
    await syncAccount(s.env, await s.loaded(), s.account, await s.run());
    expect(s.store.suppressions.get(`${CO}:bob@lead.co.za:own`)).toMatchObject({ sender_key: "own" });
    const [payload] = s.host.emitted.filter((e) => e.name === HANDOFF_EVENTS.contactSuppressed).map((e) => e.payload);
    expect(payload).toMatchObject({ key: "suppress:bob@lead.co.za:unsubscribed", senderKey: "own" });
  });

  it("a suppression from another plugin keeps its sender; one with none is company-wide; a hard bounce is per address", async () => {
    const s = setup();
    const crm = (payload: Record<string, unknown>) => ({ eventId: "e", eventType: pluginEvent(PIB_PLUGINS.crm, HANDOFF_EVENTS.contactSuppressed), occurredAt: "", companyId: CO, payload } as PluginEvent);
    await onContactSuppressed(s.env, crm({ email: "a@x.co", reason: "unsubscribed", scope: "marketing", senderKey: "company:crm-ahs" }));
    await onContactSuppressed(s.env, crm({ email: "b@x.co", reason: "unsubscribed", scope: "marketing" }));
    await onContactSuppressed(s.env, crm({ email: "c@x.co", reason: "bounced", scope: "all", senderKey: "company:crm-ahs" }));
    expect([...s.store.suppressions.values()].map((r) => [r.email, r.scope, r.sender_key])).toEqual([["a@x.co", "marketing", "company:crm-ahs"], ["b@x.co", "marketing", ""], ["c@x.co", "all", ""]]);
  });
});

describe("a warning, never a block, for a sending domain with no authentication", () => {
  it("a marketing send from a domain whose last check is bad still goes out and says what is wrong; transactional mail says nothing", async () => {
    const s = withClientMailbox();
    await s.store.upsertDomainCheck({
      company_id: CO, domain: "ahslaw.co.za", status: "bad", source: "account", client_kind: "company", client_ref: "crm-ahs", checked_at: new Date().toISOString(), first_checked_at: new Date().toISOString(), status_since: new Date().toISOString(), dmarc_none_since: null,
      result: { problems: [{ code: "spf_missing", severity: "bad", message: "ahslaw.co.za has no SPF record.", fix: "Add one." }], sendReady: false },
    });
    const marketing = await handleSendRequested(s.env, event(request()));
    expect(marketing).toMatchObject({ status: "sent", warnings: ["ahslaw.co.za has no SPF record."] });
    const invoice = await handleSendRequested(s.env, event(request({ key: "inv", marketing: undefined })));
    expect(invoice).toMatchObject({ status: "sent" });
    expect(invoice).not.toHaveProperty("warnings");
    expect(s.gmail.sent).toHaveLength(2);
  });
});

describe("a client's marketing from the company's own mailbox", () => {
  it("still goes (the Mailbox blocks nothing) but the result warns that the opt-out lands on the company's list, not the client's", async () => {
    const s = withClientMailbox();
    const ownMailbox = await handleSendRequested(s.env, event(request({ key: "wrong-mailbox", from: s.account.address, context: { plugin: PIB_PLUGINS.campaigns, kind: "campaign_step", id: "ahs", ...AHS } })));
    expect(ownMailbox).toMatchObject({ status: "sent" });
    expect((ownMailbox as { warnings?: string[] }).warnings).toEqual([expect.stringMatching(/Marketing for company:crm-ahs was sent from the company's own mailbox peet@.*opt-out is recorded on the company's list, not the client's/)]);
    // From the client's own mailbox, for the company itself, or not marketing at all: nothing to warn about.
    for (const [key, from, context, marketing] of [
      ["right-mailbox", "info@ahslaw.co.za", { plugin: PIB_PLUGINS.campaigns, kind: "campaign_step", id: "ahs", ...AHS }, true],
      ["own-marketing", s.account.address, { plugin: PIB_PLUGINS.campaigns, kind: "campaign_step", id: "own" }, true],
      ["invoice", s.account.address, { plugin: PIB_PLUGINS.billing, kind: "invoice", id: "1", ...AHS }, undefined],
    ] as const) {
      const result = await handleSendRequested(s.env, event(request({ key, from, context: context as MailSendRequested["context"], marketing: marketing as boolean | undefined })));
      expect(result, key).toMatchObject({ status: "sent" });
      expect(result, key).not.toHaveProperty("warnings");
    }
  });
});
