import { describe, expect, it } from "vitest";
import { MAIL_SENDERS, PIB_PLUGINS } from "@partnersinbiz/pib-plugin-kit";
import { bodyIsGone, isPrivateMail, PRIVATE_BODY_NOTE, PRIVATE_MAIL_KIND, PRIVATE_REQUEST_FIELDS, PRIVATE_RETRY_NOTE, PRIVATE_STALE_DAYS, scrubbedRequest } from "../src/private-mail.js";
import { withheldIfPrivate } from "../src/gmail/sync.js";
import { EMAIL_PROVIDER_REFERENCE, MAILBOX_DRAFT_SKILL } from "../src/skills.js";
import { MAILBOX_TOOLS } from "../src/tools.js";
import { CO } from "./helpers/memory.js";
import { setup } from "./helpers/setup.js";

const request = {
  key: "crm:msg:a1",
  to: [{ email: "ada@client.co.za" }],
  subject: "Please sign",
  text: "Sign here https://x.example/s.html#pibt_abc",
  html: "<a href=\"https://x.example/s.html#pibt_abc\">Sign</a>",
  attachments: [{ url: "https://r2.example/file?X-Amz-Signature=abc", filename: "a.pdf", mime: "application/pdf" }],
  context: { plugin: PIB_PLUGINS.crm, kind: "client_message", id: "a1", clientKind: "company" as const, clientRef: "acme" },
  labels: ["PiB/Clients"],
  marketing: false,
};

describe("what counts as private mail, and what is kept of it", () => {
  it("is the CRM's client message kind and nothing else", () => {
    expect(PRIVATE_MAIL_KIND).toBe("client_message");
    expect(isPrivateMail({ kind: "client_message" })).toBe(true);
    for (const kind of ["invoice", "campaign_step", "sequence_step", "payslip", "draft", "mail", "", undefined, null]) expect(isPrivateMail({ kind }), String(kind)).toBe(false);
    expect(isPrivateMail(null)).toBe(false);
    expect(isPrivateMail(undefined)).toBe(false);
  });

  it("drops the text, the html and the presigned attachment links, and keeps what says who it was for and why", () => {
    expect([...PRIVATE_REQUEST_FIELDS]).toEqual(["text", "html", "attachments"]);
    const kept = scrubbedRequest(request);
    expect(kept).not.toHaveProperty("text");
    expect(kept).not.toHaveProperty("html");
    expect(kept).not.toHaveProperty("attachments");
    expect(kept).toEqual({ key: "crm:msg:a1", to: request.to, subject: "Please sign", context: request.context, labels: ["PiB/Clients"], marketing: false });
    // The original is not touched (a retry that is still pending keeps its text).
    expect(request.text).toContain("pibt_abc");
    expect(JSON.stringify(kept)).not.toMatch(/pibt_|X-Amz/);
  });

  it("knows a stored private send has lost its text, and that anything else has not", () => {
    expect(bodyIsGone({ context: request.context, request: scrubbedRequest(request) })).toBe(true);
    expect(bodyIsGone({ context: request.context, request })).toBe(false);
    expect(bodyIsGone({ context: { ...request.context, kind: "invoice" }, request: scrubbedRequest(request) })).toBe(false);
    expect(bodyIsGone({ context: request.context, request: { ...scrubbedRequest(request), html: "<p>x</p>" } })).toBe(false);
  });

  it("sweeps a send nobody settled only after the senders' own retry period (three days) has passed", () => {
    expect(PRIVATE_STALE_DAYS).toBe(4);
  });

  it("says in plain words why nothing is shown and why a retry by hand is refused", () => {
    expect(PRIVATE_BODY_NOTE).toMatch(/does not keep or show its text/);
    expect(PRIVATE_RETRY_NOTE).toMatch(/not kept once its send has ended.*new link/);
  });
});

describe("the sent copy the sync finds first", () => {
  const outbound = (over: Record<string, unknown> = {}) => ({ id: "gm_acc-1_g1", companyId: CO, accountId: "acc-1", direction: "outbound" as const, status: "sent" as const, subject: "Please sign", gmailMessageId: "g1", gmailThreadId: "t1", rfcMessageId: "<m1@x>", inReplyTo: null, refs: [], from: null, to: [], cc: [], snippet: "Sign here https://x.example/s.html#pibt_abc", labels: [], attachments: [], bulk: false, receivedAt: "2026-10-04T08:00:00Z", read: true, ...over });

  it("stores no preview for the copy of a client message, found by its Message-ID, and marks it as that send's", async () => {
    const t = setup();
    await t.store.claimSend({ key: "crm:msg:a1", companyId: CO, sourcePlugin: PIB_PLUGINS.crm, accountId: "acc-1", fromAddress: "peet@partnersinbiz.online", to: request.to, subject: "Please sign", context: request.context, request }, false);
    await t.store.markSendSent("crm:msg:a1", { gmailMessageId: "g1", gmailThreadId: "t1", rfcMessageId: "<m1@x>", accountId: "acc-1", fromAddress: "peet@partnersinbiz.online" });
    const row = await withheldIfPrivate(t.env, outbound());
    expect(row).toMatchObject({ snippet: "", sendKey: "crm:msg:a1", sentContext: request.context });
  });

  it("leaves every other message alone: an ordinary send, inbound mail, a message with no Message-ID", async () => {
    const t = setup();
    const invoice = { ...request, key: "billing:invoice:1:send", context: { plugin: PIB_PLUGINS.billing, kind: "invoice", id: "1" } };
    await t.store.claimSend({ key: invoice.key, companyId: CO, sourcePlugin: PIB_PLUGINS.billing, accountId: "acc-1", fromAddress: "peet@partnersinbiz.online", to: invoice.to, subject: "Invoice", context: invoice.context, request: invoice }, false);
    await t.store.markSendSent(invoice.key, { gmailMessageId: "g2", gmailThreadId: "t2", rfcMessageId: "<m2@x>", accountId: "acc-1", fromAddress: "peet@partnersinbiz.online" });
    const ordinary = outbound({ gmailMessageId: "g2", rfcMessageId: "<m2@x>" });
    expect(await withheldIfPrivate(t.env, ordinary)).toBe(ordinary);
    const inbound = outbound({ direction: "inbound" as const });
    expect(await withheldIfPrivate(t.env, inbound)).toBe(inbound);
    const noId = outbound({ rfcMessageId: null });
    expect(await withheldIfPrivate(t.env, noId)).toBe(noId);
  });
});

describe("what agents are told", () => {
  it("the skill and the tool descriptions say a client message is withheld, a hold is for a person, and tracking is the domain's", () => {
    expect(MAILBOX_DRAFT_SKILL).toMatch(/client_message.*withheld: true/s);
    expect(EMAIL_PROVIDER_REFERENCE).toMatch(/Lifting a hold sooner is for a person only/);
    expect(EMAIL_PROVIDER_REFERENCE).toMatch(/Open and click tracking are a setting of the DOMAIN/);
    const text = (name: string) => MAILBOX_TOOLS.find((tool) => tool.name === name)!.description;
    expect(text("get-message")).toMatch(/withheld: true/);
    expect(text("search-mail")).toMatch(/withheld: true/);
    expect(text("list-sending-domains")).toMatch(/holdLifted.*only a person/s);
    expect(text("mail-status")).toMatch(/textKept/);
  });

  it("every plugin that can send a client message is a sender the Mailbox listens to (the CRM is)", () => {
    expect(MAIL_SENDERS).toContain(PIB_PLUGINS.crm);
  });
});
