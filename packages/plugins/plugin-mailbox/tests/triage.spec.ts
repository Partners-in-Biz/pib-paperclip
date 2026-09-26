import { describe, expect, it } from "vitest";
import { MAIL_CATEGORIES, MAIL_EVENTS } from "@partnersinbiz/pib-plugin-kit";
import { syncAccount } from "../src/gmail/sync.js";
import { clientOptions, combineTriage, plausibleClients, ruleCategory, triageQuestions, type TriageFacts } from "../src/gmail/triage.js";
import type { CrmClientRow, SendRow } from "../src/gmail/types.js";
import { jevAnswers } from "./helpers/fake-gmail.js";
import { CO } from "./helpers/memory.js";
import { JEV_CONFIG, setup } from "./helpers/setup.js";

const saaiman: CrmClientRow = { kind: "company", id: "crm-co-1", name: "Saaiman Stays", domain: "https://www.saaimanstays.co.za", emails: [], accountIds: [] };
const ann: CrmClientRow = { kind: "contact", id: "crm-ct-1", name: "Ann Smith", domain: null, emails: ["Ann@Saaimanstays.co.za"], accountIds: ["crm-co-1"] };
const solo: CrmClientRow = { kind: "contact", id: "crm-ct-2", name: "Deidre Ras", domain: null, emails: ["deidre@gmail.com"], accountIds: [] };

function sentRequest(overrides: Partial<SendRow>): SendRow {
  return {
    key: "billing:invoice:inv-1:send",
    company_id: CO,
    source_plugin: "partnersinbiz.billing",
    account_id: "acc-1",
    from_address: "peet@partnersinbiz.online",
    to_addrs: [{ email: "client@acme.com" }],
    subject: "Invoice INV-1",
    status: "sent",
    permanent: false,
    attempts: 1,
    gmail_message_id: "sent-9",
    gmail_thread_id: "th-invoice",
    rfc_message_id: "<pib.invoice@partnersinbiz.online>",
    error: null,
    context: { plugin: "partnersinbiz.billing", kind: "invoice", id: "inv-1", clientKind: "company", clientRef: "crm-co-7" },
    request: {} as SendRow["request"],
    claimed_at: null,
    sent_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("triage with Jev", () => {
  it("sends only the minimal state, maps the answers, logs decisions and labels", async () => {
    const { gmail, env, account, loaded, run, store, host } = setup(JEV_CONFIG);
    let seen: Record<string, unknown> | null = null;
    gmail.jevResponse = (body) => {
      seen = body;
      return jevAnswers({
        category: { type: "choice", choice: "lead", probabilities: { lead: 0.9, other: 0.1 }, confidence: 0.9 },
        urgency: { type: "score", score: 2.2, legend: {}, probabilities: { "2": 0.8, "3": 0.2 }, confidence: 0.8 },
        needs_reply: { type: "noul", noul: 0.93 },
        phishing: { type: "noul", noul: 0.02 },
      })();
    };
    gmail.addMessage({
      id: "j1",
      headers: { From: "Jo Buyer <jo@newbiz.co.za>", To: "peet@partnersinbiz.online", Subject: "Need a new website" },
      snippet: `We want a site with bookings. ${"x".repeat(900)}`,
    });
    await syncAccount(env, await loaded(), account, await run());

    expect(seen).not.toBeNull();
    const request = seen as unknown as { state: Record<string, unknown>; model: string; questions: Record<string, { type: string; criteria: unknown }> };
    expect(Object.keys(request.state).sort()).toEqual(["attachments", "bulk", "fromDomain", "fromKnownClient", "repliesToOurMail", "snippet", "subject"]);
    expect(request.state.fromDomain).toBe("newbiz.co.za");
    expect(String(request.state.snippet).length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(request.state)).not.toContain("jo@newbiz.co.za");
    expect(request.model).toBe("jev-1.13.0");
    expect(Object.keys(request.questions).sort()).toEqual(["category", "needs_reply", "phishing", "urgency"]);
    expect(Object.keys(request.questions.category!.criteria as object).sort()).toEqual([...MAIL_CATEGORIES].sort());
    expect((request.questions.urgency!.criteria as unknown[]).length).toBe(4);

    const row = store.messages.get("gm_acc-1_j1")!;
    expect(row.triage).toMatchObject({ category: "lead", urgency: 2.2, needsReply: 0.93, phishing: 0.02, confidence: 0.9, source: "jev", labels: ["PiB/Lead", "PiB/Needs reply"] });
    expect(row.category).toBe("lead");
    expect(host.decisions.map((d) => d.question_key).sort()).toEqual(["category", "needs_reply", "phishing", "urgency"]);
    expect(host.decisions.every((d) => d.purpose === "mail-triage" && d.subject_id === row.id)).toBe(true);
    expect(gmail.labels.map((l) => l.name)).toEqual(expect.arrayContaining(["PiB/Lead", "PiB/Needs reply"]));
    const event = host.emitted.find((e) => e.name === MAIL_EVENTS.received)!;
    expect(event.payload.triage).toEqual({ category: "lead", urgency: 2.2, needsReply: 0.93, phishing: 0.02, confidence: 0.9, clientKind: null, clientRef: null });
  });

  it("asks for a CRM client only when a plausible candidate exists and acts when confident", async () => {
    const { gmail, env, account, loaded, run, store } = setup(JEV_CONFIG);
    store.crm = [saaiman, solo];
    const questionSets: string[][] = [];
    gmail.jevResponse = (body) => {
      const questions = body.questions as Record<string, { criteria: Record<string, unknown> }>;
      questionSets.push(Object.keys(questions));
      return jevAnswers({
        category: { type: "choice", choice: "client", probabilities: {}, confidence: 0.8 },
        urgency: { type: "score", score: 1, probabilities: {}, confidence: 0.7 },
        needs_reply: { type: "noul", noul: 0.8 },
        phishing: { type: "noul", noul: 0.01 },
        ...(questions.client ? { client: { type: "choice", choice: "Saaiman Stays", probabilities: {}, confidence: 0.86 } } : {}),
      })();
    };
    gmail.addMessage({ id: "c1", headers: { From: "manager@gmail.com", Subject: "Saaiman bookings page is down" }, snippet: "Guests cannot book" });
    gmail.addMessage({ id: "c2", headers: { From: "someone@gmail.com", Subject: "Lunch on Friday?" }, snippet: "See you there" });
    await syncAccount(env, await loaded(), account, await run());
    expect(questionSets.filter((q) => q.includes("client"))).toHaveLength(1);
    expect(store.messages.get("gm_acc-1_c1")!.triage).toMatchObject({ clientKind: "company", clientRef: "crm-co-1", clientName: "Saaiman Stays", clientSource: "jev" });
    expect(store.messages.get("gm_acc-1_c2")!.client_ref).toBeNull();
  });

  it("falls back to rules when Jev is not configured or refuses the call", async () => {
    for (const config of [{}, JEV_CONFIG]) {
      const { gmail, env, account, loaded, run, store, host } = setup(config);
      gmail.jevResponse = () => new Response(JSON.stringify({ error: "bad request" }), { status: 400 });
      gmail.addMessage({ id: "f1", headers: { From: "jo@newbiz.co.za", Subject: "Quote for SEO please" }, snippet: "What is your pricing?" });
      gmail.addMessage({ id: "f2", headers: { From: "news@shop.com", Subject: "Big sale", "List-Unsubscribe": "<mailto:u@shop.com>" }, snippet: "Everything 50% off" });
      await syncAccount(env, await loaded(), account, await run());
      expect(store.messages.get("gm_acc-1_f1")!.triage).toMatchObject({ category: "lead", source: "rules", needsReply: 0.6, urgency: null, phishing: null, labels: ["PiB/Lead"] });
      expect(store.messages.get("gm_acc-1_f2")!.triage).toMatchObject({ category: "newsletter", needsReply: 0.05 });
      expect(host.decisions).toHaveLength(0);
    }
  });
});

describe("deterministic triage", () => {
  it("matches the sender to a CRM contact and uses the contact's company as the client", async () => {
    const { gmail, env, account, loaded, run, store } = setup();
    store.crm = [saaiman, ann, solo];
    gmail.addMessage({ id: "d1", headers: { From: "Ann <ann@saaimanstays.co.za>", Subject: "New photos for the site" } });
    gmail.addMessage({ id: "d2", headers: { From: "deidre@gmail.com", Subject: "Can we move our call" } });
    gmail.addMessage({ id: "d3", headers: { From: "info@saaimanstays.co.za", Subject: "Hello" } });
    await syncAccount(env, await loaded(), account, await run());
    expect(store.messages.get("gm_acc-1_d1")!.triage).toMatchObject({ category: "client", clientKind: "company", clientRef: "crm-co-1", clientSource: "email" });
    expect(store.messages.get("gm_acc-1_d2")!.triage).toMatchObject({ clientKind: "contact", clientRef: "crm-ct-2" });
    // Domain match (not free mail) finds the company too.
    expect(store.messages.get("gm_acc-1_d3")!.triage).toMatchObject({ clientKind: "company", clientRef: "crm-co-1", clientSource: "domain" });
  });

  it("links a reply to the plugin message it answers, by In-Reply-To or by thread", async () => {
    const { gmail, env, account, loaded, run, store, host } = setup();
    store.sends.set("billing:invoice:inv-1:send", sentRequest({}));
    store.sends.set("crm:seq:9", sentRequest({ key: "crm:seq:9", gmail_thread_id: "th-seq", rfc_message_id: "<pib.seq@partnersinbiz.online>", context: { plugin: "partnersinbiz.crm", kind: "sequence-step", id: "enr-9" } }));
    gmail.addMessage({
      id: "rp1",
      threadId: "th-other",
      headers: { From: "client@acme.com", Subject: "Re: Invoice INV-1", "In-Reply-To": "<pib.invoice@partnersinbiz.online>", References: "<pib.invoice@partnersinbiz.online>" },
      snippet: "Thanks, will pay Friday",
    });
    gmail.addMessage({ id: "rp2", threadId: "th-seq", headers: { From: "lead@prospect.com", Subject: "Re: hello" }, snippet: "Not now, maybe next year" });
    await syncAccount(env, await loaded(), account, await run());

    const r1 = store.messages.get("gm_acc-1_rp1")!;
    expect(r1.reply_to).toEqual({ plugin: "partnersinbiz.billing", kind: "invoice", id: "inv-1", clientKind: "company", clientRef: "crm-co-7" });
    expect(r1.triage).toMatchObject({ category: "reply", source: "reply", confidence: 1, clientKind: "company", clientRef: "crm-co-7", clientSource: "reply" });
    expect(store.messages.get("gm_acc-1_rp2")!.reply_to).toMatchObject({ plugin: "partnersinbiz.crm", kind: "sequence-step", id: "enr-9" });
    const event = host.emitted.find((e) => e.name === MAIL_EVENTS.received && e.payload.key === "mail:rp1")!;
    expect(event.payload.replyTo).toMatchObject({ plugin: "partnersinbiz.billing", id: "inv-1" });
    expect(event.payload.inReplyTo).toBe("<pib.invoice@partnersinbiz.online>");
  });
});

describe("bounces", () => {
  it("links a delivery failure notice to the bounced send by its Message-ID (part headers only)", async () => {
    const { gmail, env, account, loaded, run, store, host } = setup();
    store.sends.set("crm:seq:9", sentRequest({ key: "crm:seq:9", gmail_thread_id: "th-seq", rfc_message_id: "<pib.seq@partnersinbiz.online>", context: { plugin: "partnersinbiz.crm", kind: "sequence-step", id: "enr-9" } }));
    gmail.addMessage({
      id: "dsn1",
      threadId: "th-unrelated",
      headers: { From: "Mail Delivery System <MAILER-DAEMON@mx.remote.net>", Subject: "Undelivered Mail Returned to Sender", "Content-Type": 'multipart/report; report-type=delivery-status; boundary="x"' },
      snippet: "This is the mail system at host mx.remote.net.",
      payload: {
        mimeType: "multipart/report",
        parts: [
          { mimeType: "text/plain", data: "I'm sorry to have to inform you" },
          { mimeType: "message/delivery-status", data: "Final-Recipient: rfc822; gone@prospect.com" },
          { mimeType: "message/rfc822", parts: [{ mimeType: "text/plain", headers: { "Message-ID": "<pib.seq@partnersinbiz.online>", Subject: "hello" } }] },
        ],
      },
    });
    await syncAccount(env, await loaded(), account, await run());
    const partsCall = gmail.calls.find((c) => /\/messages\/dsn1$/.test(c.url.pathname) && c.url.searchParams.has("fields"))!;
    expect(partsCall.url.searchParams.get("fields")).toContain("headers(name,value)");
    expect(partsCall.url.searchParams.get("fields")).not.toContain("data");
    const row = store.messages.get("gm_acc-1_dsn1")!;
    expect(row.bounce).toEqual({ recipients: [], rfcIds: ["<pib.seq@partnersinbiz.online>"] });
    expect(row.reply_to).toMatchObject({ plugin: "partnersinbiz.crm", kind: "sequence-step", id: "enr-9" });
    expect(row.triage).toMatchObject({ category: "notification" });
    const event = host.emitted.find((e) => e.name === MAIL_EVENTS.received && e.payload.key === "mail:dsn1")!;
    expect(event.payload).toMatchObject({ replyTo: { plugin: "partnersinbiz.crm", id: "enr-9" }, bounce: { rfcIds: ["<pib.seq@partnersinbiz.online>"] } });
  });

  it("falls back to X-Failed-Recipients, and Gmail's own bounces in the sent thread", async () => {
    const { gmail, env, account, loaded, run, store } = setup();
    store.sends.set("campaigns:c1:ct1", sentRequest({ key: "campaigns:c1:ct1", to_addrs: [{ email: "gone@prospect.com" }], gmail_thread_id: "th-camp", rfc_message_id: "<pib.camp@x>", context: { plugin: "partnersinbiz.campaigns", kind: "campaign-send", id: "c1:ct1" } }));
    gmail.addMessage({ id: "dsn2", headers: { From: "postmaster@outlook.com", Subject: "Delivery failed", "X-Failed-Recipients": "Gone@Prospect.com" } });
    gmail.addMessage({ id: "dsn3", threadId: "th-camp", headers: { From: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", Subject: "Delivery Status Notification (Failure)" } });
    await syncAccount(env, await loaded(), account, await run());
    expect(store.messages.get("gm_acc-1_dsn2")!.bounce).toEqual({ recipients: ["gone@prospect.com"], rfcIds: [] });
    expect(store.messages.get("gm_acc-1_dsn2")!.reply_to).toMatchObject({ plugin: "partnersinbiz.campaigns", id: "c1:ct1" });
    expect(store.messages.get("gm_acc-1_dsn3")!.reply_to).toMatchObject({ plugin: "partnersinbiz.campaigns", id: "c1:ct1" });
  });
});

describe("triage rules and options", () => {
  const facts = (over: Partial<TriageFacts>): TriageFacts => ({ subject: "", snippet: "", fromEmail: "a@b.co", bulk: false, attachments: [], isReply: false, hasClient: false, ...over });

  it("puts proof of payment ahead of reply and invoice", () => {
    expect(ruleCategory(facts({ subject: "Re: Invoice INV-3", isReply: true, attachments: [{ filename: "POP.pdf", mime: "application/pdf" }] }))).toBe("proof_of_payment");
    expect(ruleCategory(facts({ subject: "Re: Invoice INV-3", isReply: true }))).toBe("reply");
    expect(ruleCategory(facts({ subject: "Your bank statement is ready", bulk: true }))).toBe("bank_statement");
    expect(ruleCategory(facts({ subject: "Your order has shipped", bulk: true, fromEmail: "no-reply@shop.com" }))).toBe("notification");
    expect(ruleCategory(facts({ subject: "The site is down", snippet: "error 500" }))).toBe("support");
  });

  it("offers every client name up to 254 plus none, and only candidates beyond that", () => {
    const many: CrmClientRow[] = Array.from({ length: 300 }, (_, i) => ({ kind: "company", id: `c${i}`, name: `Client ${i} Holdings`, domain: null, emails: [], accountIds: [] }));
    const candidates = plausibleClients([...many, saaiman], { subject: "Saaiman invoice", snippet: "", fromDomain: "gmail.com" });
    expect(candidates.map((c) => c.id)).toEqual(["crm-co-1"]);
    const big = clientOptions([...many, saaiman], candidates)!;
    expect(Object.keys(big.criteria)).toEqual(["Saaiman Stays", "none of these"]);
    const small = clientOptions([saaiman, solo], [saaiman])!;
    expect(Object.keys(small.criteria)).toEqual(["Saaiman Stays", "Deidre Ras", "none of these"]);
    expect(small.criteria["Saaiman Stays"]).toBe("Company (saaimanstays.co.za)");
    expect(clientOptions([saaiman], [])).toBeNull();
    expect(triageQuestions(small).client).toMatchObject({ type: "choice" });
  });

  it("ignores a low-confidence Jev category and a low-confidence client", () => {
    const options = clientOptions([saaiman], [saaiman]);
    const triage = combineTriage({
      facts: facts({ subject: "Quote please" }),
      deterministic: { client: null, replyTo: null },
      result: {
        model: "jev-1.13.0",
        inputTokens: 1,
        ids: {},
        answers: {
          category: { type: "choice", choice: "spam", probabilities: {}, confidence: 0.3 },
          client: { type: "choice", choice: "Saaiman Stays", probabilities: {}, confidence: 0.5 },
          needs_reply: { type: "noul", noul: 0.4 },
        },
      },
      options,
      labelPrefix: "PiB",
    });
    expect(triage).toMatchObject({ category: "lead", source: "rules", clientRef: null, needsReply: 0.4 });
  });
});
