import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { HANDOFF_EVENTS, handleEraseRequest, PIB_PLUGINS, pluginEvent, type ConsentRecorded, type ContactEraseRequested } from "@partnersinbiz/pib-plugin-kit";
import { announceOptOut, ERASED_TEXT, eraseSubject, onConsentRecorded, subjectEmails } from "../src/erasure.js";
import { erasureHash, markerEmail } from "../src/hash.js";
import { isErasedMail, syncAccount } from "../src/gmail/sync.js";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import { checkSuppression } from "../src/suppression.js";
import plugin from "../src/worker.js";
import type { MessageRow } from "../src/gmail/types.js";
import { CO, MemoryStore } from "./helpers/memory.js";
import { setup } from "./helpers/setup.js";
import { validateParams, validateRuntimeExecute, validateRuntimeQuery } from "./helpers/sql-guard.js";

const ANN = "ann@lead.co.za";

function request(over: Partial<ContactEraseRequested> = {}): ContactEraseRequested {
  return { key: "erase:req-1", requestId: "req-1", subject: { email: ANN, contactId: "c-ann" }, scope: "all", reason: "data_subject_request", approvedByUserId: "user-peet", requestedAt: "2026-10-03T08:00:00.000Z", dueBy: null, source: PIB_PLUGINS.crm, ...over };
}

function row(id: string, over: Partial<MessageRow>): MessageRow {
  return {
    id, company_id: CO, account_id: "acc-1", subject: "Hello", body: "", direction: "inbound", status: "synced", created_at: "2026-10-01T09:00:00.000Z", read_at: null,
    gmail_message_id: `g-${id}`, gmail_thread_id: "t1", rfc_message_id: null, in_reply_to: null, refs: [], from_addr: { email: ANN, name: "Ann" }, to_addrs: [{ email: "peet@partnersinbiz.online" }],
    cc_addrs: [], bcc_addrs: [], snippet: "My ID number is 800101", labels: [], attachments: [], bulk: false, received_at: "2026-10-01T09:00:00.000Z", triage: null, triaged_at: null,
    category: "client", urgency: null, needs_reply: null, phishing: null, client_kind: null, client_ref: null, reply_to: null, sent_context: null, send_key: null, draft: null, send_error: null,
    bounce: null, reply_to_addr: null, map_state: null, map_id: null, ...over,
  };
}

function seeded() {
  const s = setup();
  const { store, host } = s;
  store.crm.push({ kind: "contact", id: "c-ann", name: "Ann Lead", domain: null, emails: [ANN, "ann@home.co.za"], accountIds: [] }, { kind: "contact", id: "c-bob", name: "Bob", domain: null, emails: ["bob@x.co.za"], accountIds: [] });
  for (const m of [
    row("m-in", {}),
    row("m-out", { direction: "outbound", status: "sent", from_addr: { email: "peet@partnersinbiz.online" }, to_addrs: [{ email: ANN, name: "Ann" }] }),
    row("m-draft", { direction: "outbound", status: "draft", gmail_message_id: null, gmail_thread_id: null, from_addr: null, to_addrs: [{ email: "ann@home.co.za" }], draft: { replyToMessageId: "m-in" } }),
    row("m-cc", { from_addr: { email: "bob@x.co.za" }, to_addrs: [{ email: "peet@partnersinbiz.online" }], cc_addrs: [{ email: ANN }], gmail_thread_id: "t3" }),
    row("m-bob", { from_addr: { email: "bob@x.co.za" }, gmail_thread_id: "t2" }),
  ]) store.messages.set(m.id, m);
  store.threadIssues.set("acc-1:t1", "issue-9");
  host.issues.set("issue-9", { id: "issue-9", title: "Reply needed: Hello", description: "From Ann <ann@lead.co.za>: My ID number is 800101", status: "todo" });
  store.decisionsLog.push({ company_id: CO, subject_id: "m-in" }, { company_id: CO, subject_id: "m-bob" });
  const send = (key: string, to: string, extra: Record<string, unknown> = {}) =>
    store.sends.set(key, { key, company_id: CO, source_plugin: "partnersinbiz.billing", account_id: "acc-1", from_address: "peet@partnersinbiz.online", to_addrs: [{ email: to }], subject: "Invoice INV-7 for Ann", status: "sent", permanent: false, attempts: 1, gmail_message_id: "g", gmail_thread_id: "t", rfc_message_id: "<r>", error: null, context: { plugin: "partnersinbiz.billing", kind: "invoice", id: "7" }, request: { key, to: [{ email: to }], subject: "Invoice INV-7 for Ann", text: "Dear Ann, you owe R1000", ...extra } as never, claimed_at: null, sent_at: "2026-10-01T10:00:00.000Z", created_at: "2026-10-01T10:00:00.000Z", updated_at: "2026-10-01T10:00:00.000Z", skipped: [] });
  send("billing:inv-7", ANN);
  send("billing:inv-8", "bob@x.co.za");
  send("campaigns:cc", "bob@x.co.za", { cc: [{ email: "ann@home.co.za" }] });
  store.inboxResults.set("billing:inv-7", { key: "billing:inv-7", status: "failed", error: "Not sent: ann@lead.co.za unsubscribed", suppressed: [{ email: ANN }], permanent: true });
  store.leadOutbox.push({ company_id: CO, key: "mail:g-m-in", payload: { key: "mail:g-m-in", email: ANN, name: "Ann" } }, { company_id: CO, key: "mail:g-m-bob", payload: { key: "mail:g-m-bob", email: "bob@x.co.za" } });
  store.addSuppression(CO, ANN, "marketing", "unsubscribed", "partnersinbiz.mailbox", "own");
  store.addSuppression(CO, ANN, "marketing", "unsubscribed", "partnersinbiz.campaigns", "company:crm-ahs");
  store.addSuppression(CO, "ann@home.co.za", "all", "bounced", "partnersinbiz.mailbox");
  store.addSuppression(CO, "bob@x.co.za", "marketing");
  return s;
}

describe("erasing one person from the Mailbox", () => {
  it("removes their mail, drafts, decisions, send content, waiting lead and CRM copy, and nobody else's", async () => {
    const { env, store, host } = seeded();
    const outcome = await eraseSubject(env, CO, request());
    expect(outcome.errors).toBeUndefined();
    expect(outcome.counts).toEqual({ messages: 3, drafts: 1, replyIssues: 1, sendRecords: 2, pendingLeads: 1, crmCopies: 1, doNotEmailRowsReplaced: 3, doNotEmailMarkers: 2 });
    // Messages: her mail, our mail to her, the draft to her other address, and the one that copied her. Bob's own mail stays.
    expect([...store.messages.keys()]).toEqual(["m-bob"]);
    expect(store.decisionsLog).toEqual([{ company_id: CO, subject_id: "m-bob" }]);
    // A send record keeps its key and status (so a repeated request is still refused), but nothing about her.
    expect(store.sends.get("billing:inv-7")).toMatchObject({ key: "billing:inv-7", status: "sent", subject: ERASED_TEXT, to_addrs: [], skipped: [], request: { key: "billing:inv-7", erased: true } });
    expect(store.sends.get("campaigns:cc")).toMatchObject({ subject: ERASED_TEXT, to_addrs: [], request: { erased: true } });
    expect(JSON.stringify([...store.sends.values()].filter((s) => s.key !== "billing:inv-8"))).not.toMatch(/ann@|Dear Ann|owe R1000/);
    expect(store.sends.get("billing:inv-8")).toMatchObject({ subject: "Invoice INV-7 for Ann", to_addrs: [{ email: "bob@x.co.za" }] });
    expect(store.inboxResults.get("billing:inv-7")).toEqual({ key: "billing:inv-7", status: "failed", permanent: true });
    expect(store.leadOutbox.map((r) => r.key)).toEqual(["mail:g-m-bob"]);
    expect(store.crm.find((c) => c.id === "c-ann")).toMatchObject({ name: "", emails: [] });
    expect(store.crm.find((c) => c.id === "c-bob")).toMatchObject({ name: "Bob", emails: ["bob@x.co.za"] });
    // The Reply-needed issue stays; her text goes.
    expect(host.issues.get("issue-9")).toMatchObject({ status: "todo", title: `Reply needed: ${ERASED_TEXT}`, description: expect.stringMatching(/erased on request \(data subject erasure req-1\)/) });
    expect(JSON.stringify(host.issues.get("issue-9"))).not.toMatch(/Ann|800101/);
    expect(store.suppressions.has(`${CO}:bob@x.co.za:`)).toBe(true);
  });

  it("keeps only a hash of each address as the do-not-email marker, and says what else it keeps", async () => {
    const { env, store } = seeded();
    const outcome = await eraseSubject(env, CO, request());
    const rows = [...store.suppressions.values()];
    expect(rows.some((r) => JSON.stringify(r).includes("ann@"))).toBe(false);
    const markers = rows.filter((r) => r.email_hash);
    expect(markers.map((m) => m.email_hash).sort()).toEqual([erasureHash(ANN), erasureHash("ann@home.co.za")].sort());
    expect(markers.every((m) => m.email === markerEmail(m.email_hash!) && m.sender_key === "" && m.erased_at && m.reason === "manual")).toBe(true);
    // The home address had a hard bounce: its marker is for every send, and so is the other (scope all).
    expect(markers.map((m) => m.scope)).toEqual(["all", "all"]);
    expect(outcome.retained!.map((r) => r.what)).toEqual([
      "A do-not-email marker for each address (a one-way hash; no address, name or text)",
      "The Gmail copies of 2 conversations in the connected mailbox",
      "Agents' comments on the Reply-needed issues",
    ]);
    expect(outcome.retained!.map((r) => r.why).join(" ")).toMatch(/cannot delete Gmail mail permanently/);
    // The hash is the one the CRM's ledger keeps (SHA-256 of the subject key).
    expect(erasureHash("Ann@Lead.co.za")).toBe(erasureHash(ANN));
    expect(erasureHash(ANN)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("erases a relayed website form where the person is only in Reply-To (the From is the website)", async () => {
    const { env, store } = seeded();
    // A client's contact form: From is the site, the visitor is Reply-To, the snippet carries what they typed.
    store.messages.set("m-form", row("m-form", { from_addr: { email: "wordpress@client.co.za", name: "WordPress" }, reply_to_addr: { email: "Ann@Lead.co.za", name: "Ann" }, to_addrs: [{ email: "peet@partnersinbiz.online" }], snippet: "Name: Ann. Phone 082 123 4567. I need a quote", gmail_thread_id: "t-form", client_kind: "company", client_ref: "crm-client" }));
    // Someone else's relayed form on the same site stays.
    store.messages.set("m-form-bob", row("m-form-bob", { from_addr: { email: "wordpress@client.co.za" }, reply_to_addr: { email: "bob@x.co.za" }, gmail_thread_id: "t-form-bob" }));
    store.decisionsLog.push({ company_id: CO, subject_id: "m-form" });
    const outcome = await eraseSubject(env, CO, request());
    expect(outcome.errors).toBeUndefined();
    expect(outcome.counts).toMatchObject({ messages: 4 });
    expect(store.messages.has("m-form")).toBe(false);
    expect(store.messages.has("m-form-bob")).toBe(true);
    expect(store.decisionsLog.some((d) => d.subject_id === "m-form")).toBe(false);
    expect(JSON.stringify([...store.messages.values()])).not.toMatch(/ann@lead|082 123/i);
    expect(outcome.retained!.map((r) => r.what)).toContain("The Gmail copies of 3 conversations in the connected mailbox");
  });

  it("the person is never mailed again: marketing and transactional sends are refused, whichever of their addresses", async () => {
    const { env, store } = seeded();
    await eraseSubject(env, CO, request());
    for (const email of [ANN, "ann@home.co.za", "Ann@Lead.co.za"]) {
      for (const marketing of [true, false]) {
        const check = await checkSuppression(store, CO, { key: "k", to: [{ email }], subject: "s", text: "t", marketing, context: { plugin: "p", kind: "k", id: "i" } }, "company:crm-ahs");
        expect(check, `${email} ${marketing}`).toMatchObject({ blocked: true, skipped: [{ email: email.toLowerCase(), scope: "all", reason: "manual" }] });
      }
    }
    const other = await checkSuppression(store, CO, { key: "k", to: [{ email: "carol@x.co" }], subject: "s", text: "t", marketing: true, context: { plugin: "p", kind: "k", id: "i" } });
    expect(other.blocked).toBe(false);
  });

  it("is safe to run again: a second run finds nothing, and the kit answers a repeated request from its stored result without running at all", async () => {
    const s = seeded();
    const memo = new Map<string, unknown>();
    const state = s.host.ctx.state as unknown as { get: (k: { stateKey?: string }) => Promise<unknown>; set: (k: { stateKey?: string }, v: unknown) => Promise<void> };
    state.get = async (key) => memo.get(String(key.stateKey)) ?? null;
    state.set = async (key, value) => void memo.set(String(key.stateKey), value);
    const erase = vi.fn((req: ContactEraseRequested, companyId: string) => eraseSubject(s.env, companyId, req));
    const options = { plugin: PIB_PLUGINS.mailbox, erase };
    const first = await handleEraseRequest(s.host.ctx, options, CO, request());
    expect(first).toMatchObject({ status: "erased", plugin: "partnersinbiz.mailbox", requestId: "req-1" });
    const again = await handleEraseRequest(s.host.ctx, options, CO, request());
    expect(again).toEqual(first);
    expect(erase).toHaveBeenCalledTimes(1);
    // Run directly a second time: nothing left but the markers (her CRM copy is blank now, so only the address in the request is known).
    const second = await eraseSubject(s.env, CO, request());
    expect(second.counts).toMatchObject({ messages: 0, drafts: 0, replyIssues: 0, sendRecords: 0, pendingLeads: 0, doNotEmailRowsReplaced: 0, doNotEmailMarkers: 1 });
    expect([...s.store.suppressions.values()].filter((r) => r.email_hash)).toHaveLength(2);
  });

  it("an erasure nobody approved is refused and erases nothing", async () => {
    const s = seeded();
    const result = await handleEraseRequest(s.host.ctx, { plugin: PIB_PLUGINS.mailbox, erase: (r, c) => eraseSubject(s.env, c, r) }, CO, request({ approvedByUserId: "" }));
    expect(result).toMatchObject({ status: "failed", error: expect.stringMatching(/Not approved by a person/) });
    expect(s.store.messages.size).toBe(5);
  });

  it("refuses an address that is one of the company's own mailboxes: erasing it would erase the whole mailbox", async () => {
    const { env, store } = seeded();
    const outcome = await eraseSubject(env, CO, request({ subject: { email: "Peet@PartnersInBiz.online" } }));
    expect(outcome.counts).toEqual({});
    expect(outcome.errors![0]).toMatch(/belongs to one of this company's own mailboxes.*nothing was erased/);
    expect(store.messages.size).toBe(5);
    // The kit reports it as failed, so it is retried and shows on the stale-erasure check, not silently done.
    const s = seeded();
    const result = await handleEraseRequest(s.host.ctx, { plugin: PIB_PLUGINS.mailbox, erase: (r, c) => eraseSubject(s.env, c, r) }, CO, request({ subject: { email: "peet@partnersinbiz.online" } }));
    expect(result.status).toBe("failed");
  });

  it("a withdrawn consent (scope marketing_only) erases no mail: it puts every address on the marketing list", async () => {
    const { env, store } = seeded();
    const outcome = await eraseSubject(env, CO, request({ scope: "marketing_only" }));
    expect(outcome).toEqual({ counts: { marketingSuppressions: 2 }, retained: [] });
    expect(store.messages.size).toBe(5);
    expect(store.suppressions.get(`${CO}:ann@lead.co.za:`)).toMatchObject({ scope: "marketing", reason: "unsubscribed", sender_key: "" });
    // An address that already bounced stays blocked for every send: the withdrawal never weakens it.
    expect(store.suppressions.get(`${CO}:ann@home.co.za:`)).toMatchObject({ scope: "all", reason: "bounced" });
  });

  it("finds the addresses from the CRM copy when the request carries only the contact, and says so when there is nothing to match", async () => {
    const { env, store } = seeded();
    expect(await subjectEmails(store, CO, request({ subject: { contactId: "c-ann" } }))).toEqual([ANN, "ann@home.co.za"]);
    expect(await subjectEmails(store, CO, request({ subject: { email: "bad", contactId: "nope" } }))).toEqual([]);
    const phone = await eraseSubject(env, CO, request({ subject: { phone: "+27821234567" } }));
    expect(phone.counts).toEqual({});
    expect(phone.retained).toEqual([expect.objectContaining({ what: "Nothing by phone number" })]);
    const byContact = await eraseSubject(env, CO, request({ subject: { contactId: "c-ann" } }));
    expect(byContact.counts).toMatchObject({ messages: 3, drafts: 1 });
  });

  it("a reply issue that is already gone is not a failure; any other error keeps the request open", async () => {
    const gone = seeded();
    gone.host.ctx.issues.update = (async () => { throw new Error("Issue not found"); }) as never;
    expect((await eraseSubject(gone.env, CO, request())).errors).toBeUndefined();
    const broken = seeded();
    broken.host.ctx.issues.update = (async () => { throw new Error("capability missing"); }) as never;
    const outcome = await eraseSubject(broken.env, CO, request());
    expect(outcome.errors).toEqual([expect.stringMatching(/reply issue issue-9: capability missing/)]);
    // The data was still erased: the retry only has the issue left.
    expect(broken.store.messages.size).toBe(1);
  });
});

describe("old mail of an erased person is never imported again", () => {
  const erasedAt = "2026-10-03T08:00:00.000Z";
  const marker = () => new Map([[erasureHash(ANN), erasedAt]]);
  const incoming = (receivedAt: string, from: string = ANN) => ({ from: { email: from }, to: [{ email: "peet@partnersinbiz.online" }], cc: [], receivedAt });

  it("skips mail received before the erasure and keeps mail they send afterwards", () => {
    expect(isErasedMail(incoming("2026-10-01T00:00:00.000Z"), marker(), "peet@partnersinbiz.online")).toBe(true);
    expect(isErasedMail(incoming("2026-10-04T00:00:00.000Z"), marker(), "peet@partnersinbiz.online")).toBe(false);
    expect(isErasedMail(incoming("2026-10-01T00:00:00.000Z", "bob@x.co.za"), marker(), "peet@partnersinbiz.online")).toBe(false);
    expect(isErasedMail(incoming("2026-10-01T00:00:00.000Z"), new Map(), "peet@partnersinbiz.online")).toBe(false);
    // A relayed website form: the visitor is Reply-To, the From is the site.
    const form = (receivedAt: string, replyTo: string | null) => ({ from: { email: "wordpress@client.co.za" }, to: [{ email: "peet@partnersinbiz.online" }], cc: [], receivedAt, replyToAddr: replyTo ? { email: replyTo } : null });
    expect(isErasedMail(form("2026-10-01T00:00:00.000Z", "Ann@Lead.co.za"), marker(), "peet@partnersinbiz.online")).toBe(true);
    expect(isErasedMail(form("2026-10-04T00:00:00.000Z", ANN), marker(), "peet@partnersinbiz.online")).toBe(false);
    expect(isErasedMail(form("2026-10-01T00:00:00.000Z", "bob@x.co.za"), marker(), "peet@partnersinbiz.online")).toBe(false);
    expect(isErasedMail(form("2026-10-01T00:00:00.000Z", null), marker(), "peet@partnersinbiz.online")).toBe(false);
    // Our own mailbox is never an erased person.
    expect(isErasedMail({ from: { email: "peet@partnersinbiz.online" }, to: [{ email: ANN }], cc: [], receivedAt: "2026-10-04T00:00:00.000Z" }, new Map([[erasureHash("peet@partnersinbiz.online"), erasedAt]]), "peet@partnersinbiz.online")).toBe(false);
  });

  it("a resync after the erasure does not bring her mail back; a new message from her is a new message", async () => {
    const s = seeded();
    await eraseSubject(s.env, CO, request());
    const marker = [...s.store.suppressions.values()].find((r) => r.email_hash === erasureHash(ANN))!;
    marker.erased_at = new Date().toISOString();
    s.gmail.addMessage({ id: "old-1", headers: { From: "Ann <ann@lead.co.za>", To: "peet@partnersinbiz.online", Subject: "Old question" }, snippet: "from last week", internalDate: Date.now() - 3 * 86_400_000 }, { history: false });
    s.gmail.addMessage({ id: "new-1", headers: { From: "Ann <ann@lead.co.za>", To: "peet@partnersinbiz.online", Subject: "A new question" }, snippet: "from now", internalDate: Date.now() + 60_000 }, { history: false });
    await syncAccount(s.env, await s.loaded(), s.account, await s.run());
    const subjects = [...s.store.messages.values()].map((m) => m.subject);
    expect(subjects).not.toContain("Old question");
    expect(subjects).toContain("A new question");
  });
});

describe("a relayed form of an erased visitor is not imported again", () => {
  it("a resync after the erasure skips the old form mail whose Reply-To is the erased person, and imports a new one", async () => {
    const s = seeded();
    await eraseSubject(s.env, CO, request());
    const marker = [...s.store.suppressions.values()].find((r) => r.email_hash === erasureHash(ANN))!;
    marker.erased_at = new Date().toISOString();
    const form = (id: string, subject: string, internalDate: number) =>
      s.gmail.addMessage({ id, headers: { From: "WordPress <wordpress@client.co.za>", "Reply-To": "Ann <ann@lead.co.za>", To: "peet@partnersinbiz.online", Subject: subject }, snippet: "Name: Ann", internalDate }, { history: false });
    form("form-old", "Old form", Date.now() - 3 * 86_400_000);
    form("form-new", "New form", Date.now() + 60_000);
    await syncAccount(s.env, await s.loaded(), s.account, await s.run());
    const subjects = [...s.store.messages.values()].map((m) => m.subject);
    expect(subjects).not.toContain("Old form");
    expect(subjects).toContain("New form");
  });
});

describe("withdrawn consent from other plugins", () => {
  const consent = (over: Partial<ConsentRecorded> = {}): ConsentRecorded => ({ key: "consent:email:ann@lead.co.za:marketing_email:t", subject: { email: ANN }, purpose: "marketing_email", basis: "consent", granted: false, source: "form", recordedAt: "2026-10-03T08:00:00.000Z", recordedBy: "partnersinbiz.crm", ...over });

  it("puts the address on the sender's marketing list; a given consent or another purpose changes nothing", async () => {
    const { env, store } = setup();
    await onConsentRecorded(env, CO, consent());
    expect(store.suppressions.get(`${CO}:${ANN}:`)).toMatchObject({ scope: "marketing", reason: "unsubscribed", source: "partnersinbiz.crm", sender_key: "" });
    await onConsentRecorded(env, CO, consent({ subject: { email: "bob@x.co.za", clientKind: "company", clientRef: "crm-ahs" }, purpose: "newsletter" }));
    expect(store.suppressions.get(`${CO}:bob@x.co.za:company:crm-ahs`)).toMatchObject({ sender_key: "company:crm-ahs" });
    const before = store.suppressions.size;
    await onConsentRecorded(env, CO, consent({ granted: true, subject: { email: "carol@x.co" } }));
    await onConsentRecorded(env, CO, consent({ purpose: "service_messages", subject: { email: "dan@x.co" } }));
    await onConsentRecorded(env, CO, consent({ subject: { phone: "+27821234567" } }));
    expect(store.suppressions.size).toBe(before);
    // A person who unsubscribed is never put back on by a later "given": only a person removes them.
    await onConsentRecorded(env, CO, consent({ granted: true }));
    expect(store.suppressions.has(`${CO}:${ANN}:`)).toBe(true);
  });

  it("announces an opt-out the Mailbox saw as consent.recorded, with the client when the mailbox is a client's, and no address beyond the subject", async () => {
    const { env, host } = setup();
    await announceOptOut(env, CO, { email: "ann@lead.co.za", senderKey: "company:crm-ahs", source: "reply", wording: "Unsubscribe", at: "2026-10-03T08:00:00.000Z" });
    await announceOptOut(env, CO, { email: "bob@x.co", senderKey: "own", source: "unsubscribe_link", at: "2026-10-03T09:00:00.000Z" });
    const [a, b] = host.emitted.filter((e) => e.name === HANDOFF_EVENTS.consentRecorded).map((e) => e.payload);
    expect(a).toMatchObject({ key: "consent:email:ann@lead.co.za:marketing_email:2026-10-03T08:00:00.000Z", subject: { email: "ann@lead.co.za", clientKind: "company", clientRef: "crm-ahs" }, granted: false, source: "reply", evidence: { wording: "Unsubscribe" } });
    expect(b).toMatchObject({ subject: { email: "bob@x.co", clientKind: null, clientRef: null }, source: "unsubscribe_link" });
  });
});

describe("the receivers in the worker", () => {
  it("answers the CRM's erasure request and records a withdrawn consent, through the host SQL guard", async () => {
    const harness = createTestHarness({ manifest, config: { publicBaseUrl: "https://paperclip.example.com", encryptionKey: "x".repeat(20) } });
    const executed: string[] = [];
    const db = {
      namespace: NAMESPACE,
      async query(sql: string, params: unknown[] = []) {
        validateRuntimeQuery(sql, NAMESPACE);
        validateParams(sql, params);
        return [];
      },
      async execute(sql: string, params: unknown[] = []) {
        validateRuntimeExecute(sql, NAMESPACE);
        validateParams(sql, params);
        executed.push(sql);
        return { rowCount: 1 };
      },
    };
    (harness.ctx as unknown as { db: typeof db }).db = db;
    await plugin.definition.setup(harness.ctx);
    const emit = vi.spyOn(harness.ctx.events, "emit");
    await harness.emit(pluginEvent(PIB_PLUGINS.crm, HANDOFF_EVENTS.contactEraseRequested), request({ subject: { email: ANN } }) as unknown as Record<string, unknown>, { companyId: CO });
    const completed = emit.mock.calls.find(([name]) => name === HANDOFF_EVENTS.contactEraseCompleted)![2] as Record<string, unknown>;
    expect(completed).toMatchObject({ requestId: "req-1", plugin: "partnersinbiz.mailbox", status: "erased" });
    expect(executed.some((sql) => sql.includes(`DELETE FROM ${NAMESPACE}.suppressions`))).toBe(true);
    expect(executed.some((sql) => sql.includes(`INSERT INTO ${NAMESPACE}.suppressions`) && sql.includes("email_hash"))).toBe(true);
    executed.length = 0;
    await harness.emit(pluginEvent(PIB_PLUGINS.crm, HANDOFF_EVENTS.consentRecorded), { key: "consent:1", subject: { email: ANN }, purpose: "marketing_email", basis: "consent", granted: false, source: "form", recordedAt: "2026-10-03T08:00:00.000Z" }, { companyId: CO });
    expect(executed.some((sql) => sql.includes(`INSERT INTO ${NAMESPACE}.suppressions`))).toBe(true);
  });

  it("MemoryStore stands in for the SQL: its marker answers under the address that was asked for", async () => {
    const store = new MemoryStore();
    await store.eraseSuppression({ companyId: CO, email: ANN, hash: erasureHash(ANN), scope: "all" });
    const rows = await store.suppressionsFor(CO, ["ANN@lead.co.za"]);
    expect(rows).toEqual([expect.objectContaining({ email: "ann@lead.co.za", scope: "all", email_hash: erasureHash(ANN) })]);
  });
});
