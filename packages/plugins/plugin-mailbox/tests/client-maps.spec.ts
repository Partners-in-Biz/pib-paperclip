import { describe, expect, it } from "vitest";
import { HANDOFF_EVENTS } from "@partnersinbiz/pib-plugin-kit";
import { addClientMap, clientMapOverview, factsOf, looksLikeClientMail, matchClientMap, normalisePattern, removeClientMap } from "../src/client-maps.js";
import { bySender, leadCapturedFrom, relayedPerson } from "../src/gmail/leads.js";
import { syncAccount } from "../src/gmail/sync.js";
import { ruleCategory, triageState, type TriageFacts } from "../src/gmail/triage.js";
import type { ClientMapRow, MessageRow } from "../src/gmail/types.js";
import { CO } from "./helpers/memory.js";
import { jevAnswers } from "./helpers/fake-gmail.js";
import { JEV_CONFIG, setup } from "./helpers/setup.js";

const AHS = { kind: "company" as const, id: "crm-ahs", name: "AHS Law", domain: "ahslaw.co.za", emails: [], accountIds: [] };
const FORM = {
  From: "WordPress <wordpress@ahslaw.co.za>",
  To: "info@ahslaw.co.za",
  "Reply-To": "Jane Visitor <jane@gmail.com>",
  Subject: "New enquiry via the website form",
  snippet: "Name: Jane Visitor. I need a quote for a property transfer.",
};

function map(over: Partial<ClientMapRow> = {}): ClientMapRow {
  return { id: "m1", company_id: CO, match_type: "sender_domain", pattern: "ahslaw.co.za", client_kind: "company", client_ref: "crm-ahs", client_name: "AHS Law", note: null, created_by: "u", created_at: "2026-10-01T00:00:00.000Z", ...over };
}

const leads = (emitted: Array<{ name: string; payload: Record<string, unknown> }>) => emitted.filter((e) => e.name === HANDOFF_EVENTS.leadCaptured).map((e) => e.payload);

async function syncForm(s: ReturnType<typeof setup>, id = "f1", headers: Record<string, string> = FORM) {
  const { snippet, ...rest } = headers;
  s.gmail.addMessage({ id, headers: rest, snippet: snippet ?? FORM.snippet });
  return syncAccount(s.env, await s.loaded(), s.account, await s.run());
}

describe("mapping rules", () => {
  it("normalises a pattern for its type and refuses what cannot be one", () => {
    expect(normalisePattern("sender_domain", " @WWW.AHSLaw.co.za ")).toBe("ahslaw.co.za");
    expect(normalisePattern("recipient_domain", "https://www.ahslaw.co.za/contact")).toBe("ahslaw.co.za");
    expect(normalisePattern("sender_address", " Forms@AHSLaw.co.za ")).toBe("forms@ahslaw.co.za");
    expect(normalisePattern("sender_domain", "localhost")).toBeNull();
    expect(normalisePattern("sender_address", "not an address")).toBeNull();
    expect(normalisePattern("recipient_address", "ahslaw.co.za")).toBeNull();
  });

  it("a specific address beats a domain, the sender beats the recipient, and a domain rule covers subdomains", () => {
    const facts = { from: "forms@mail.ahslaw.co.za", recipients: ["info@ahslaw.co.za", "us@partnersinbiz.online"] };
    const sd = map({ id: "sd", match_type: "sender_domain", pattern: "ahslaw.co.za", client_ref: "A" });
    const sa = map({ id: "sa", match_type: "sender_address", pattern: "forms@mail.ahslaw.co.za", client_ref: "B" });
    const rd = map({ id: "rd", match_type: "recipient_domain", pattern: "ahslaw.co.za", client_ref: "C" });
    const ra = map({ id: "ra", match_type: "recipient_address", pattern: "info@ahslaw.co.za", client_ref: "D" });
    expect(matchClientMap([sd, rd], facts)!.id).toBe("sd");
    expect(matchClientMap([rd, ra], facts)!.id).toBe("ra");
    expect(matchClientMap([sd, sa, rd, ra], facts)!.id).toBe("sa");
    expect(matchClientMap([rd], facts)!.id).toBe("rd");
    expect(matchClientMap([map({ pattern: "ahslaw.co" })], facts)).toBeNull();
    expect(matchClientMap([map({ pattern: "wahslaw.co.za" })], { from: "x@ahslaw.co.za", recipients: [] })).toBeNull();
    // Two domain rules: the longer (more specific) one wins.
    expect(matchClientMap([map({ id: "short", pattern: "co.za", client_ref: "S" }), map({ id: "long", pattern: "ahslaw.co.za", client_ref: "L" })], { from: "x@ahslaw.co.za", recipients: [] })!.id).toBe("long");
  });

  it("our own mailbox address as a recipient proves nothing: every message is addressed to one", () => {
    const rule = map({ match_type: "recipient_address", pattern: "peet@partnersinbiz.online" });
    expect(matchClientMap([rule], { from: "x@y.co", recipients: ["peet@partnersinbiz.online"] })).not.toBeNull();
    expect(matchClientMap([rule], { from: "x@y.co", recipients: ["peet@partnersinbiz.online"] }, new Set(["peet@partnersinbiz.online"]))).toBeNull();
  });

  it("looks for the person behind relayed form mail in Reply-To, only when it is a different address", () => {
    const row = { from_addr: { email: "wordpress@ahslaw.co.za", name: "WordPress" }, reply_to_addr: { email: "jane@gmail.com", name: "Jane" } } as MessageRow;
    expect(relayedPerson(row)).toEqual({ email: "jane@gmail.com", name: "Jane" });
    expect(relayedPerson({ ...row, reply_to_addr: { email: "WordPress@ahslaw.co.za" } } as MessageRow)).toBeNull();
    expect(relayedPerson({ ...row, reply_to_addr: null } as MessageRow)).toBeNull();
    expect(bySender("sender_domain")).toBe(true);
    expect(bySender("recipient_address")).toBe(false);
  });

  it("flags mail that looks like a client's: a relayed form from an automated sender, or a client domain; never spam, bounces, or a free-mail sender", () => {
    const relay = { from_addr: { email: "wordpress@ahslaw.co.za" }, reply_to_addr: { email: "jane@gmail.com" }, bounce: null, bulk: false } as unknown as MessageRow;
    const none = { category: "lead", clientRef: null, clientSource: null } as never;
    expect(looksLikeClientMail(relay, none)).toBe(true);
    expect(looksLikeClientMail({ ...relay, from_addr: { email: "person@ahslaw.co.za" } } as MessageRow, none)).toBe(false);
    expect(looksLikeClientMail({ ...relay, from_addr: { email: "wordpress@gmail.com" } } as MessageRow, none)).toBe(false);
    expect(looksLikeClientMail(relay, { category: "spam", clientRef: null, clientSource: null } as never)).toBe(false);
    expect(looksLikeClientMail({ ...relay, bounce: { recipients: [], rfcIds: [] } } as MessageRow, none)).toBe(false);
    const plain = { from_addr: { email: "partner@ahslaw.co.za" }, reply_to_addr: null, bounce: null, bulk: false } as unknown as MessageRow;
    expect(looksLikeClientMail(plain, { category: "lead", clientRef: "crm-ahs", clientSource: "domain" } as never)).toBe(true);
    expect(looksLikeClientMail(plain, { category: "lead", clientRef: "crm-ahs", clientSource: "email" } as never)).toBe(false);
    expect(looksLikeClientMail(plain, { category: "personal", clientRef: "crm-ahs", clientSource: "domain" } as never)).toBe(false);
  });

  it("reads the facts of a stored message", () => {
    expect(factsOf({ from_addr: { email: "A@X.co" }, to_addrs: [{ email: "B@y.co" }], cc_addrs: [{ email: "c@y.co" }], bcc_addrs: null })).toEqual({ from: "a@x.co", recipients: ["b@y.co", "c@y.co"] });
  });
});

describe("forwarded client mail before and after a mapping (Q1a-9 part b)", () => {
  it("unmapped, it stays the company's own lead exactly as before, and is flagged for a mapping", async () => {
    const s = setup();
    await syncForm(s);
    const row = [...s.store.messages.values()][0]!;
    expect(row).toMatchObject({ category: "lead", client_kind: null, map_state: "needs_mapping", map_id: null });
    expect(row.reply_to_addr).toEqual({ email: "jane@gmail.com", name: "Jane Visitor" });
    const [lead] = leads(s.host.emitted);
    expect(lead).toMatchObject({ key: `mail:f1`, source: "email", clientKind: null, clientRef: null, email: "wordpress@ahslaw.co.za" });
    expect(await s.store.unmappedSummary(CO, 30)).toEqual([expect.objectContaining({ domain: "ahslaw.co.za", n: 1, sample_id: row.id })]);
  });

  it("a mapping on the sender files later mail under the client: a lead in the client's scope, the visitor as the person, source form", async () => {
    const s = setup();
    s.store.crm.push(AHS);
    await addClientMap(s.env, CO, { matchType: "sender_domain", pattern: "ahslaw.co.za", clientKind: "company", clientRef: "crm-ahs" }, "user-peet");
    await syncForm(s);
    const row = [...s.store.messages.values()][0]!;
    expect(row).toMatchObject({ category: "lead", client_kind: "company", client_ref: "crm-ahs", map_state: "mapped", map_id: "map_1" });
    expect(row.triage).toMatchObject({ clientSource: "mapping", clientName: "AHS Law", mapping: { id: "map_1", type: "sender_domain" } });
    const [lead] = leads(s.host.emitted);
    expect(lead).toMatchObject({
      key: "mail:f1",
      source: "form",
      clientKind: "company",
      clientRef: "crm-ahs",
      name: "Jane Visitor",
      email: "jane@gmail.com",
      mentionsClientRef: "crm-ahs",
    });
    expect(String(lead!.email)).not.toContain("ahslaw");
    // It is the client's lead: no reply issue for the company's own Account Manager.
    expect([...s.host.issues.values()]).toEqual([]);
  });

  it("with no Reply-To there is no person to name: the website's address is not one", async () => {
    const s = setup();
    s.store.crm.push(AHS);
    await addClientMap(s.env, CO, { matchType: "sender_address", pattern: "wordpress@ahslaw.co.za", clientKind: "company", clientRef: "crm-ahs" }, null);
    const { "Reply-To": _drop, ...noReply } = FORM;
    void _drop;
    await syncForm(s, "f2", { ...noReply, snippet: "I need a quote for a property transfer." });
    const row = [...s.store.messages.values()][0]!;
    expect(row).toMatchObject({ map_state: "mapped", client_ref: "crm-ahs" });
    // Without a visitor in Reply-To the mapped mail is the client's mail, not a lead from a person.
    expect(leads(s.host.emitted).every((l) => l.email === null || l.email !== "wordpress@ahslaw.co.za")).toBe(true);
  });

  it("a client's lead goes to the CRM in the client's scope even when the visitor is already a contact of ours, and the company does not answer a visitor of its client's website as itself", async () => {
    const s = setup({ triageIssueAssignee: "agent-am" });
    s.store.crm.push(AHS, { kind: "contact", id: "c-jane", name: "Jane", domain: null, emails: ["jane@gmail.com"], accountIds: [] });
    await addClientMap(s.env, CO, { matchType: "sender_domain", pattern: "ahslaw.co.za", clientKind: "company", clientRef: "crm-ahs" }, null);
    await syncForm(s);
    expect(leads(s.host.emitted)).toEqual([expect.objectContaining({ key: "mail:f1", clientKind: "company", clientRef: "crm-ahs", email: "jane@gmail.com", source: "form" })]);
    expect([...s.host.issues.values()]).toEqual([]);
  });

  it("the company's own lead from an existing contact is still the Account Manager's reply, not a hand-off (unchanged)", async () => {
    const s = setup({ triageIssueAssignee: "agent-am" });
    s.store.crm.push({ kind: "contact", id: "c-pieter", name: "Pieter", domain: null, emails: ["pieter@gmail.com"], accountIds: [] });
    s.gmail.addMessage({ id: "own-1", headers: { From: "Pieter <pieter@gmail.com>", To: "peet@partnersinbiz.online", Subject: "Quote for a website" }, snippet: "I would like a quote" });
    await syncAccount(s.env, await s.loaded(), s.account, await s.run());
    expect(leads(s.host.emitted)).toEqual([]);
    expect([...s.host.issues.values()]).toEqual([expect.objectContaining({ title: "Reply needed: Quote for a website" })]);
  });

  it("mail BCC'd or forwarded TO a client's address is filed by a recipient mapping, and stays what its words say (an enquiry is a lead, not 'client' mail)", async () => {
    const s = setup();
    s.store.crm.push(AHS);
    await addClientMap(s.env, CO, { matchType: "recipient_address", pattern: "info@ahslaw.co.za", clientKind: "company", clientRef: "crm-ahs" }, null);
    s.gmail.addMessage({ id: "b1", headers: { From: "Pieter <pieter@gmail.com>", To: "info@ahslaw.co.za", Subject: "Quote for a will" }, snippet: "I would like a quote for drafting a will" });
    await syncAccount(s.env, await s.loaded(), s.account, await s.run());
    const row = [...s.store.messages.values()][0]!;
    expect(row).toMatchObject({ category: "lead", client_kind: "company", client_ref: "crm-ahs", map_state: "mapped" });
    const [lead] = leads(s.host.emitted);
    // A recipient mapping is not a website relay: the sender is the person.
    expect(lead).toMatchObject({ source: "email", clientKind: "company", clientRef: "crm-ahs", email: "pieter@gmail.com" });
  });

  it("adding a mapping afterwards files the flagged mail and re-sends those leads in the client's scope under a new key", async () => {
    const s = setup();
    s.store.crm.push(AHS);
    await syncForm(s);
    s.host.emitted.length = 0;
    const result = await addClientMap(s.env, CO, { matchType: "sender_domain", pattern: "ahslaw.co.za", clientKind: "company", clientRef: "crm-ahs", note: "The AHS Law website form" }, "user-peet");
    expect(result).toMatchObject({ filed: 1, rehanded: 1, map: { pattern: "ahslaw.co.za", client_name: "AHS Law", note: "The AHS Law website form", created_by: "user-peet" } });
    const row = [...s.store.messages.values()][0]!;
    expect(row).toMatchObject({ client_kind: "company", client_ref: "crm-ahs", map_state: "mapped", category: "lead" });
    const [lead] = leads(s.host.emitted);
    expect(lead).toMatchObject({ key: "mail:f1:client:company:crm-ahs", supersedes: "mail:f1", source: "form", clientKind: "company", clientRef: "crm-ahs", email: "jane@gmail.com", name: "Jane Visitor" });
    expect(await s.store.unmappedSummary(CO, 30)).toEqual([]);
    // Nothing flagged is left to file a second time.
    expect(await addClientMap(s.env, CO, { matchType: "sender_domain", pattern: "ahslaw.co.za", clientKind: "company", clientRef: "crm-ahs" }, null)).toMatchObject({ filed: 0, rehanded: 0 });
  });

  it("removing a mapping makes new mail the company's own again; mail already filed keeps its client", async () => {
    const s = setup();
    s.store.crm.push(AHS);
    const { map } = await addClientMap(s.env, CO, { matchType: "sender_domain", pattern: "ahslaw.co.za", clientKind: "company", clientRef: "crm-ahs" }, null);
    await syncForm(s, "f1");
    expect(await removeClientMap(s.store, CO, map.id)).toEqual({ removed: true });
    expect(await removeClientMap(s.store, CO, map.id)).toEqual({ removed: false });
    await syncForm(s, "f2", { ...FORM, Subject: "Another enquiry" });
    const rows = [...s.store.messages.values()];
    expect(rows.find((r) => r.gmail_message_id === "f1")).toMatchObject({ client_ref: "crm-ahs", map_state: "mapped" });
    expect(rows.find((r) => r.gmail_message_id === "f2")).toMatchObject({ map_state: "needs_mapping" });
  });
});

describe("managing mappings", () => {
  it("refuses a made-up client, a free-mail domain, the company's own domain and mailbox, a bad rule, and the same rule for another client", async () => {
    const s = setup();
    s.store.crm.push(AHS);
    const add = (over: Record<string, unknown>) => addClientMap(s.env, CO, { matchType: "sender_domain", pattern: "ahslaw.co.za", clientKind: "company", clientRef: "crm-ahs", ...over } as never, null);
    await expect(add({ clientRef: "crm-made-up" })).rejects.toThrow(/The CRM has no company crm-made-up in this company/);
    await expect(add({ clientKind: "contact", clientRef: "crm-ahs" })).rejects.toThrow(/The CRM has no contact/);
    await expect(add({ pattern: "gmail.com" })).rejects.toThrow(/free mail domain/);
    await expect(add({ pattern: "partnersinbiz.online" })).rejects.toThrow(/the company's own domain/);
    await expect(add({ pattern: "mail.partnersinbiz.online" })).rejects.toThrow(/the company's own domain/);
    await expect(add({ matchType: "recipient_address", pattern: "peet@partnersinbiz.online" })).rejects.toThrow(/one of this company's own mailboxes/);
    await expect(add({ matchType: "recipient_address", pattern: "not-an-address" })).rejects.toThrow(/pattern must be an email address/);
    await expect(add({ pattern: "nope" })).rejects.toThrow(/pattern must be a domain/);
    await expect(add({ matchType: "everything" })).rejects.toThrow(/matchType must be one of/);
    await expect(add({ clientKind: "team" })).rejects.toThrow(/clientKind must be company or contact/);
    expect(s.store.maps).toEqual([]);
    // An alias on the company's own domain is fine (it is how a client's mail is forwarded to us).
    await expect(add({ matchType: "recipient_address", pattern: "leads+ahslaw@partnersinbiz.online" })).resolves.toMatchObject({ map: { pattern: "leads+ahslaw@partnersinbiz.online" } });
    await add({});
    s.store.crm.push({ ...AHS, id: "crm-other", name: "Other Firm" });
    await expect(add({ clientRef: "crm-other" })).rejects.toThrow(/Mail from this domain ahslaw\.co\.za is already mapped to AHS Law\. Remove that mapping first\./);
    // The same rule for the same client is idempotent.
    await expect(add({})).resolves.toMatchObject({ map: { id: "map_2" } });
    expect(s.store.maps).toHaveLength(2);
  });

  it("lists the mappings with the sender domains of mail waiting for one", async () => {
    const s = setup();
    s.store.crm.push(AHS);
    await syncForm(s, "f1");
    await syncForm(s, "f2", { ...FORM, Subject: "Second enquiry" });
    await addClientMap(s.env, CO, { matchType: "recipient_domain", pattern: "unrelated.co.za", clientKind: "company", clientRef: "crm-ahs" }, "u");
    const overview = await clientMapOverview(s.store, CO);
    expect(overview.maps).toEqual([expect.objectContaining({ matchType: "recipient_domain", pattern: "unrelated.co.za", clientName: "AHS Law" })]);
    expect(overview.unmapped).toEqual([expect.objectContaining({ domain: "ahslaw.co.za", messages: 2 })]);
  });

  it("a lead keeps the company's own shape when no mapping is passed (the unscoped lead is unchanged)", () => {
    const row = { id: "r", account_id: "a", gmail_message_id: "g1", gmail_thread_id: "t1", subject: "Hi", snippet: "I need help", from_addr: { email: "Ann@X.co", name: "Ann" }, reply_to_addr: { email: "other@x.co" }, triage: null, client_kind: null, client_ref: null, received_at: "2026-10-03T00:00:00.000Z", created_at: "2026-10-03T00:00:00.000Z" } as unknown as MessageRow;
    expect(leadCapturedFrom(row)).toMatchObject({ source: "email", name: "Ann", email: "ann@x.co", clientKind: null, clientRef: null });
    // A recipient mapping does not use Reply-To: the sender is the person.
    expect(leadCapturedFrom(row, null, { match_type: "recipient_domain", client_kind: "company", client_ref: "c" })).toMatchObject({ source: "email", email: "ann@x.co", clientKind: "company", clientRef: "c" });
    expect(leadCapturedFrom(row, null, { match_type: "sender_domain", client_kind: "company", client_ref: "c" })).toMatchObject({ source: "form", email: "other@x.co", name: null });
  });
});

describe("relayed form mail is a lead for the client, whatever the sender looks like", () => {
  const facts = (over: Partial<TriageFacts> = {}): TriageFacts => ({ subject: "New message from your website", snippet: "hello", fromEmail: "wordpress@ahslaw.co.za", bulk: false, attachments: [], isReply: false, hasClient: false, ...over });

  it("by the rules: a relay is a lead; a sender who is a client of ours is client mail; proof of payment and replies still win", () => {
    expect(ruleCategory(facts({ relay: true }))).toBe("lead");
    expect(ruleCategory(facts({ relay: true, hasClient: true }))).toBe("lead");
    expect(ruleCategory(facts({ hasClient: true }))).toBe("client");
    expect(ruleCategory(facts({ relay: true, isReply: true }))).toBe("reply");
    expect(ruleCategory(facts({ relay: true, subject: "Proof of payment attached" }))).toBe("proof_of_payment");
    expect(ruleCategory(facts({ relay: true, bounce: true }))).toBe("notification");
  });

  it("Jev is told it is a client's website form, only when it is; and its answer cannot turn the visitor's enquiry into client mail", async () => {
    const s = setup(JEV_CONFIG);
    s.store.crm.push(AHS);
    await addClientMap(s.env, CO, { matchType: "sender_domain", pattern: "ahslaw.co.za", clientKind: "company", clientRef: "crm-ahs" }, null);
    const seen: Array<Record<string, unknown>> = [];
    s.gmail.jevResponse = (body) => {
      seen.push(body);
      return jevAnswers({
        category: { type: "choice", choice: "client", probabilities: { client: 0.95 }, confidence: 0.95 },
        urgency: { type: "score", score: 1, probabilities: { "1": 1 }, confidence: 0.9 },
        needs_reply: { type: "noul", noul: 0.9 },
        phishing: { type: "noul", noul: 0.01 },
      })();
    };
    await syncForm(s);
    expect((seen[0] as { state: Record<string, unknown> }).state).toMatchObject({ clientWebsiteForm: true, fromKnownClient: false });
    const row = [...s.store.messages.values()][0]!;
    expect(row).toMatchObject({ category: "lead", map_state: "mapped", client_ref: "crm-ahs" });
    expect(row.triage).toMatchObject({ source: "rules", labels: expect.arrayContaining(["PiB/Lead"]) });
    // A spam verdict is never overridden.
    const t = setup(JEV_CONFIG);
    t.store.crm.push(AHS);
    await addClientMap(t.env, CO, { matchType: "sender_domain", pattern: "ahslaw.co.za", clientKind: "company", clientRef: "crm-ahs" }, null);
    t.gmail.jevResponse = jevAnswers({
      category: { type: "choice", choice: "spam", probabilities: { spam: 0.97 }, confidence: 0.97 },
      urgency: { type: "score", score: 0, probabilities: { "0": 1 }, confidence: 0.9 },
      needs_reply: { type: "noul", noul: 0.05 },
      phishing: { type: "noul", noul: 0.5 },
    });
    await syncForm(t, "spam-1");
    expect([...t.store.messages.values()][0]).toMatchObject({ category: "spam", map_state: "mapped" });
    expect(leads(t.host.emitted)).toEqual([]);
    // Without a mapping the state carries no such flag (the minimal state Jev sees is unchanged).
    expect(triageState({ from_addr: { email: "a@b.co" }, subject: "s", snippet: "s", attachments: [], bulk: false } as never, { isReply: false, knownClient: false })).not.toHaveProperty("clientWebsiteForm");
  });
});
