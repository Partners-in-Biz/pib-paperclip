import { describe, expect, it, vi } from "vitest";
import { verifyChain } from "../src/esign-audit.js";
import { runEsignCare, esignHealth, esignIssueResolved, ESIGN_REMIND_AFTER_DAYS, MAX_ESIGN_REMINDERS, statusLine } from "../src/esign.js";
import { configurePagesDir, HOST_HASHED_NAME, generatePageId, pageFileName } from "../src/esign-pages.js";
import { sha256Hex } from "../src/esign-render.js";
import { tokenHash } from "../src/esign-store.js";
import { handleSignWebhook, SignRejected, MIN_SIGN_MS } from "../src/esign-public.js";
import { syncAllPages } from "../src/esign-sync.js";
import { settleStuckMessages } from "../src/care-approvals.js";
import { runClientCareJob } from "../src/care-jobs.js";
import { scrubSettledBody } from "../src/outbound.js";
import { BOARD, CO, DAY, UUID, bootCare, canaryClient, decide, enableFor, linkIn, makeDoc, sentMail, answerSend, sendAndApprove, signBody, signDelivery, SERVER_IPS, tool, usePages, VISITOR_IP } from "./helpers/esign.js";
import { OWNER, issuesWith } from "./helpers/care.js";

const pages = usePages();
const rejected = async (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as Error);
const sign = (booted: Awaited<ReturnType<typeof bootCare>>, body: unknown, headers: Record<string, string> = {}, now?: Date) =>
  handleSignWebhook(booted.harness.ctx, signDelivery(body as Record<string, unknown>, headers), { serverIps: SERVER_IPS, ...(now ? { now } : {}) });
const docRow = (booted: Awaited<ReturnType<typeof bootCare>>, id?: string) => booted.store.sign_documents!.find((row) => !id || row.id === id)!;

/** A real client with e-sign on, a document sent to Ada, approved, and the Mailbox's confirmation: the state a client is asked to sign in. */
async function sentToAda(extraDoc: Record<string, unknown> = {}) {
  const booted = await bootCare();
  const comments = vi.spyOn(booted.harness.ctx.issues, "createComment");
  await enableFor(booted);
  const made = await makeDoc(booted, "company:acme", extraDoc);
  const out = await sendAndApprove(booted, made.documentId);
  return { booted, comments, made, ...out, doc: docRow(booted, made.documentId) };
}

/** Everything the plugin said in comments on one issue. */
const saidOn = (comments: { mock: { calls: unknown[][] } }, issueId: string): string => comments.mock.calls.filter((call) => call[0] === issueId).map((call) => String(call[1])).join("\n");

describe("e-sign is off until the owner turns it on for a client", () => {
  it("refuses a real client, and says what to do", async () => {
    const booted = await bootCare();
    await expect(makeDoc(booted, "company:acme")).rejects.toThrow(/only on for the canary client until the owner turns it on for Acme Plumbing/);
    expect(booted.store.sign_documents ?? []).toHaveLength(0);
  });

  it("refuses to send a document for a client that is switched off again", async () => {
    const booted = await bootCare();
    await enableFor(booted);
    const made = await makeDoc(booted, "company:acme");
    await booted.harness.performAction("crm.disable-esign", { client: "company:acme" }, { companyId: CO, actor: BOARD });
    await expect(tool(booted.harness, "send-for-signature", { documentId: made.documentId })).rejects.toThrow(/only on for the canary client/);
  });

  it("only a person can turn it on, and must confirm", async () => {
    const booted = await bootCare();
    const agent = { type: "agent", agentId: "am-1" } as never;
    await expect(booted.harness.performAction("crm.enable-esign", { client: "company:acme", confirm: true }, { companyId: CO, actor: agent })).rejects.toThrow(/Only a person/);
    await expect(booted.harness.performAction("crm.enable-esign", { client: "company:acme" }, { companyId: CO, actor: BOARD })).rejects.toThrow(/confirm true/);
    const done = await enableFor(booted, "company:acme", { templatesReviewed: false, note: "Peet agreed on a call" });
    expect(done).toMatchObject({ enabled: true, templatesReviewed: false });
    expect(booted.store.esign_clients).toHaveLength(1);
    expect(booted.store.esign_clients![0]).toMatchObject({ client_ref: "acme", enabled_by: "user:local-board", templates_reviewed: false });
    // Again is not a second row.
    expect((await enableFor(booted)).note).toMatch(/already on/);
    expect(booted.store.esign_clients).toHaveLength(1);
    // No agent tool turns it on.
    const names = (await import("../src/tools.js")).CRM_TOOLS.map((tool) => tool.name);
    expect(names).not.toContain("enable-esign");
  });

  it("the canary client always has it, and its documents are dry runs", async () => {
    const booted = await bootCare();
    const client = await canaryClient(booted);
    const made = await makeDoc(booted, client);
    expect(made).toMatchObject({ status: "draft", canary: true });
    const sent = await tool(booted.harness, "send-for-signature", { documentId: made.documentId });
    booted.emit.mockClear();
    await decide(booted.harness, sent.approvalIssueId, "done", "user");
    // Nothing is queued: every address is on the canary domain.
    expect(sentMail(booted.emit)).toHaveLength(0);
    expect(booted.store.care_approvals!.find((a) => a.kind === "esign_request")!.status).toBe("dry_run");
    const got = await tool(booted.harness, "get-sign-document", { documentId: made.documentId });
    expect(got.status).toBe("sent");
    // Its own link is shown so the journey can be run: the page and the token.
    const { pageId, token } = linkIn(got.canaryLink);
    expect(pages.has(pageId)).toBe(true);
    expect(tokenHash(token)).toBe(booted.store.sign_tokens![0]!.token_hash);
  });
});

describe("making a document", () => {
  it("freezes the text, its SHA-256 and the exact consent wording, and records who made it", async () => {
    const booted = await bootCare();
    await enableFor(booted);
    const made = await makeDoc(booted, "company:acme", { dealId: "d-acme" });
    const row = docRow(booted);
    expect(made).toMatchObject({ status: "draft", kind: "proposal", to: "Ada Lovelace <ada@acme.co.za>", templateVersion: "2026-10-v1" });
    expect(row.content).toContain("# Proposal: SEO retainer");
    expect(row.content).toContain("Prepared for **Acme Plumbing** by **PiB**");
    expect(row.content).toContain("Monthly fee: **R 4,500.00**");
    expect(row.content_sha256).toBe(sha256Hex(row.content));
    expect(row.consent_text).toBe('I have read "Proposal: SEO retainer" from PiB and I agree to it. I understand that typing my name below is my electronic signature.');
    expect(row.consent_sha256).toBe(sha256Hex(row.consent_text));
    expect(row).toMatchObject({ status: "draft", deal_id: "d-acme", value_minor: 450_000, currency: "ZAR", template_reviewed: true, created_by: "agent:agent-1", recipient_email: "ada@acme.co.za" });
    expect(row.page_id).toMatch(/^[a-z2-7]{24}$/);
    // The first row of the audit trail records the text it began from.
    expect(booted.store.sign_events).toHaveLength(1);
    expect(booted.store.sign_events![0]).toMatchObject({ kind: "created", seq: 1 });
    // Nothing went out and nothing is online yet.
    expect(booted.store.outbox ?? []).toHaveLength(0);
    expect(pages.all()).toEqual([]);
  });

  it("works from a quote's lines and totals them, or from text an agent wrote", async () => {
    const booted = await bootCare();
    await enableFor(booted);
    const quote = await tool<Record<string, any>>(booted.harness, "create-sign-document", { client: "company:acme", template: "quote", variables: { quote_number: "Q-0007", lines: [{ description: "Audit", unitMinor: 150_000 }, { description: "Reporting", quantity: 3, unitMinor: 20_000 }] }, quoteId: "bq-1", quoteNumber: "Q-0007" });
    expect(quote).toMatchObject({ kind: "quote", title: "Quote Q-0007 for Acme Plumbing" });
    expect(docRow(booted, quote.documentId)).toMatchObject({ value_minor: 210_000, quote_id: "bq-1", quote_number: "Q-0007" });
    const hand = await tool<Record<string, any>>(booted.harness, "create-sign-document", { client: "company:acme", kind: "contract", title: "Hosting terms", bodyMarkdown: "Hosting is billed monthly in advance.\n\n- 99% uptime target\n- 30 days notice" });
    expect(docRow(booted, hand.documentId).content.startsWith("# Hosting terms\n\nHosting is billed")).toBe(true);
    expect(docRow(booted, hand.documentId).template_key).toBeNull();
  });

  it("refuses what is wrong in plain words", async () => {
    const booted = await bootCare();
    await enableFor(booted);
    const make = (extra: Record<string, unknown>) => tool(booted.harness, "create-sign-document", { client: "company:acme", ...extra });
    await expect(make({})).rejects.toThrow(/Give a template/);
    await expect(make({ template: "proposal", bodyMarkdown: "x" })).rejects.toThrow(/not both/);
    await expect(make({ template: "nope" })).rejects.toThrow(/template must be one of/);
    await expect(make({ template: "proposal", variables: {} })).rejects.toThrow(/needs: scope/);
    await expect(make({ kind: "proposal", title: "T", bodyMarkdown: "short" })).rejects.toThrow(/too short/);
    await expect(make({ kind: "proposal", title: "T", bodyMarkdown: `x ${"a".repeat(60_001)}` })).rejects.toThrow(/too long/);
    await expect(make({ kind: "proposal", title: "T", bodyMarkdown: "Dear {{client_name}}, please agree to the terms below this line." })).rejects.toThrow(/placeholders/);
    await expect(make({ template: "proposal", variables: { scope: "x" }, validDays: 0 })).rejects.toThrow(/validDays/);
    await expect(make({ template: "proposal", variables: { scope: "x" }, toEmail: "stranger@elsewhere.test" })).rejects.toThrow(/not on any of this client's people/);
    await expect(make({ template: "proposal", variables: { scope: "x" }, dealId: "d-solo" })).rejects.toThrow(/another client/);
    await expect(make({ template: "proposal", variables: { scope: "x" }, dealId: "nope" })).rejects.toThrow(/deal was not found/);
    await expect(tool(booted.harness, "create-sign-document", { client: "company:foreign", template: "proposal", variables: { scope: "x" } })).rejects.toThrow(/not found or is not visible/);
    expect(booted.store.sign_documents ?? []).toHaveLength(0);
  });

  it("a name or a price cannot become markup in the page the client opens", async () => {
    const { booted, pageId, doc } = await sentToAda({ variables: { scope: "Work <script>alert(1)</script> [x](javascript:alert(1))" } });
    const html = pages.read(pageId)!;
    expect(html).not.toMatch(/<script>alert|href="javascript/i);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(doc.status).toBe("sent");
    expect(booted.store.sign_documents).toHaveLength(1);
  });
});

describe("sending: the link is made only when a person approves, and nobody reads it", () => {
  it("opens an approval that shows the text and the email with a note where the link goes", async () => {
    const booted = await bootCare();
    await enableFor(booted);
    const made = await makeDoc(booted, "company:acme");
    const sent = await tool<Record<string, any>>(booted.harness, "send-for-signature", { documentId: made.documentId });
    expect(sent).toMatchObject({ status: "awaiting_approval", to: "Ada Lovelace <ada@acme.co.za>" });
    const issue = (await booted.harness.ctx.issues.get(sent.approvalIssueId, CO))!;
    expect(issue.assigneeUserId).toBe(OWNER);
    expect(issue.title).toBe("Approve signing link for Acme Plumbing: Proposal: SEO retainer");
    expect(issue.description).toContain(docRow(booted).content_sha256);
    expect(issue.description).toContain("The text the client will be asked to sign");
    expect(issue.description).toContain("Monthly SEO work");
    expect(issue.description).toContain("[the private signing link is added when the email is sent]");
    expect(issue.description).toContain("[the date the link stops working, set when the email is sent]");
    expect(issue.description).not.toMatch(/\{\{|pibt_/);
    // Not a link yet: no token, no page, no email, and the status says so.
    expect(booted.store.sign_tokens ?? []).toHaveLength(0);
    expect(pages.all()).toEqual([]);
    expect(booted.store.outbox ?? []).toHaveLength(0);
    expect(docRow(booted).status).toBe("awaiting_approval");
    // The text is on the work issue where a person can read all of it, assigned like other CRM work.
    const work = (await issuesWith(booted.harness, "crm:esign:"))[0]!;
    expect(work.title).toBe('Get "Proposal: SEO retainer" signed by Acme Plumbing');
    expect(work.description).toMatch(/Never\*\* copy, paste or ask for the signing link/);
    expect(booted.documents.bodyOf(work.id, "agreement")).toBe(docRow(booted).content);
    // A second ask is refused, not a second email.
    await expect(tool(booted.harness, "send-for-signature", { documentId: made.documentId })).rejects.toThrow(/already waiting/);
  });

  it("when a person approves: the link is made, stored only as a hash, and goes in the Mailbox email and nowhere else", async () => {
    const { booted, mail, link, pageId, token, doc } = await sentToAda();
    expect(mail).toMatchObject({ to: [{ email: "ada@acme.co.za", name: "Ada Lovelace" }], subject: "Please read and sign: Proposal: SEO retainer", marketing: false });
    // The uuid address, the only one the host serves a plugin's files on (the plugin key address answers every request with an error).
    expect(link).toMatch(new RegExp(`^https://paperclip\\.partnersinbiz\\.online/_plugins/${UUID}/ui/s/[a-z2-7]{24}\\.html#pibt_[a-z2-7]{40}$`));
    expect(link).not.toContain("partnersinbiz.crm");
    expect(mail.text).toContain(`Open it here: ${link}`);
    expect(mail.text).toMatch(/works until \d+ [A-Z][a-z]{2} \d{4}\./);
    expect(mail.text).not.toContain("{{");
    // The record holds the hash of the token, never the token, and the approval's own copy of the email has a placeholder.
    expect(booted.store.sign_tokens).toHaveLength(1);
    expect(booted.store.sign_tokens![0]).toMatchObject({ token_hash: tokenHash(token), doc_id: doc.id });
    // The whole store, the outbox included: the Mailbox answered, so the queued email's text is blanked and no table holds the token.
    expect(JSON.stringify(booted.store)).not.toContain(token);
    expect(booted.store.outbox).toHaveLength(1);
    expect(booted.store.outbox![0]).toMatchObject({ status: "done" });
    expect(booted.store.outbox![0]!.payload).toMatchObject({ key: mail.key, subject: mail.subject });
    expect(booted.store.outbox![0]!.payload).not.toHaveProperty("text");
    expect(booted.store.outbox![0]!.payload).not.toHaveProperty("html");
    expect(JSON.stringify(booted.store.care_approvals)).toContain("{{signing_link}}");
    expect(doc.canary_token ?? null).toBeNull();
    // The page is online for this document, in the open state, and the Mailbox's answer made the status "sent".
    const html = pages.read(pageId)!;
    expect(html).toContain('data-state="open"');
    expect(html).toContain(`data-sha="${doc.content_sha256}"`);
    expect(html).toContain("Monthly SEO work");
    expect(doc.status).toBe("sent");
    expect(Date.parse(doc.expires_at) - Date.now()).toBeGreaterThan(13 * DAY);
    expect(Date.parse(doc.next_reminder_at) - Date.now()).toBeGreaterThan(2.9 * DAY);
    expect(booted.store.sign_events!.map((e) => e.kind)).toEqual(["created", "send_requested", "link_issued", "sent"]);
    // No tool ever gives a real client's link to an agent.
    const got = await tool<Record<string, any>>(booted.harness, "get-sign-document", { documentId: doc.id, includeContent: true });
    expect(JSON.stringify(got)).not.toMatch(/pibt_|#pibt|canaryLink/);
    expect(got.statusLine).toMatch(/^Sent to Ada Lovelace on \d+ \w+ \d{4}, not opened yet\./);
    expect(got.content).toContain("# Proposal: SEO retainer");
  });

  it("an agent that closes the approval does not send it: it is reopened for the person", async () => {
    const booted = await bootCare();
    await enableFor(booted);
    const made = await makeDoc(booted, "company:acme");
    const sent = await tool<Record<string, any>>(booted.harness, "send-for-signature", { documentId: made.documentId });
    const reopened = await decide(booted.harness, sent.approvalIssueId, "done", "agent");
    expect(reopened.status).toBe("todo");
    expect(booted.store.sign_tokens ?? []).toHaveLength(0);
    expect(booted.store.outbox ?? []).toHaveLength(0);
  });

  it("a refused approval makes it a draft again and nothing is made", async () => {
    const booted = await bootCare();
    await enableFor(booted);
    const made = await makeDoc(booted, "company:acme");
    const sent = await tool<Record<string, any>>(booted.harness, "send-for-signature", { documentId: made.documentId });
    await decide(booted.harness, sent.approvalIssueId, "cancelled", "user");
    expect(docRow(booted).status).toBe("draft");
    expect(booted.store.sign_tokens ?? []).toHaveLength(0);
    expect(pages.all()).toEqual([]);
    // It can be sent again.
    expect((await tool<Record<string, any>>(booted.harness, "send-for-signature", { documentId: made.documentId })).status).toBe("awaiting_approval");
  });

  it("when the Mailbox cannot send it, the links made for it die and the document is a draft again", async () => {
    const booted = await bootCare();
    await enableFor(booted);
    const made = await makeDoc(booted, "company:acme");
    const out = await sendAndApprove(booted, made.documentId, { answer: false });
    await answerSend(booted.harness, out.mail.key, "failed", { permanent: true, error: "The address does not exist" });
    expect(docRow(booted).status).toBe("draft");
    expect(booted.store.sign_tokens![0]!.revoked_at).toBeTruthy();
    expect(pages.has(out.pageId)).toBe(false);
    // The dead link signs nothing.
    const doc = docRow(booted);
    const failure = await rejected(sign(booted, signBody(doc as never, out.token)));
    expect(failure).toBeInstanceOf(SignRejected);
    expect(failure!.message).toMatch(/not valid/);
  });

  it("a document that expired can be sent again for a new link, with the same text", async () => {
    const { booted, made, doc } = await sentToAda({ validDays: 1 });
    await runEsignCare(booted.harness.ctx, CO, new Date(Date.now() + 2 * DAY));
    expect(docRow(booted).status).toBe("expired");
    const again = await sendAndApprove(booted, made.documentId);
    expect(again.token).not.toBe(booted.store.sign_tokens![0]!.token_hash);
    expect(docRow(booted)).toMatchObject({ status: "sent", content_sha256: doc.content_sha256 });
    expect(booted.store.care_approvals!.filter((a) => a.kind === "esign_request")).toHaveLength(2);
  });
});

describe("where the signing link lives: in the email, and in the CRM's outbox only until the Mailbox answers", () => {
  const outboxRow = (booted: Awaited<ReturnType<typeof bootCare>>, key: string) => booted.store.outbox!.find((row) => row.key === key)!;

  it("while the Mailbox has not answered, the queued email holds the link (it has to: it is sent from there); once it answers the CRM holds none", async () => {
    const booted = await bootCare();
    await enableFor(booted);
    const made = await makeDoc(booted, "company:acme");
    const out = await sendAndApprove(booted, made.documentId, { answer: false });
    // Pending: the redeliver job still has to send exactly this text.
    expect(outboxRow(booted, out.mail.key).status).toBe("pending");
    expect(outboxRow(booted, out.mail.key).payload.text).toContain(out.token);
    // Everything else the CRM keeps is free of it: no table but the pending outbox row.
    expect(JSON.stringify({ ...booted.store, outbox: undefined })).not.toContain(out.token);
    await answerSend(booted.harness, out.mail.key, "sent");
    expect(outboxRow(booted, out.mail.key).status).toBe("done");
    expect(JSON.stringify(booted.store)).not.toContain(out.token);
    expect(JSON.stringify(booted.store)).not.toContain("pibt_");
    // What the row keeps is what the settlement needs: the key, the recipient, the subject, the answer.
    expect(outboxRow(booted, out.mail.key).payload).toMatchObject({ key: out.mail.key, subject: out.mail.subject, to: [{ email: "ada@acme.co.za" }] });
    // The same answer again changes nothing and does not bring the text back.
    await answerSend(booted.harness, out.mail.key, "sent");
    expect(JSON.stringify(booted.store)).not.toContain("pibt_");
  });

  it("a permanent failure blanks it too, and so does an answer that arrives twice before the first scrub took", async () => {
    const booted = await bootCare();
    await enableFor(booted);
    const made = await makeDoc(booted, "company:acme");
    const out = await sendAndApprove(booted, made.documentId, { answer: false });
    await answerSend(booted.harness, out.mail.key, "failed", { permanent: true, error: "The address does not exist" });
    expect(outboxRow(booted, out.mail.key).status).toBe("failed");
    expect(JSON.stringify(booted.store)).not.toContain(out.token);
    expect(outboxRow(booted, out.mail.key).payload).not.toHaveProperty("text");
  });

  it("a temporary failure leaves the pending row alone: the redeliver job still has to send it", async () => {
    const booted = await bootCare();
    await enableFor(booted);
    const made = await makeDoc(booted, "company:acme");
    const out = await sendAndApprove(booted, made.documentId, { answer: false });
    await answerSend(booted.harness, out.mail.key, "failed", { permanent: false, error: "Gmail is busy" });
    expect(outboxRow(booted, out.mail.key).status).toBe("pending");
    expect(outboxRow(booted, out.mail.key).payload.text).toContain(out.token);
  });

  it("the hourly settlement blanks a row the outbox gave up on, and leaves a pending one", async () => {
    const booted = await bootCare();
    await enableFor(booted);
    const made = await makeDoc(booted, "company:acme");
    const out = await sendAndApprove(booted, made.documentId, { answer: false });
    expect(await settleStuckMessages(booted.harness.ctx, CO)).toBe(0);
    expect(outboxRow(booted, out.mail.key).payload.text).toContain(out.token);
    // The outbox gave up after its last retry.
    Object.assign(outboxRow(booted, out.mail.key), { status: "failed", last_error: "No answer from the receiving plugin" });
    expect(await settleStuckMessages(booted.harness.ctx, CO)).toBe(1);
    expect(JSON.stringify(booted.store)).not.toContain(out.token);
    expect(booted.store.care_approvals!.find((a) => a.kind === "esign_request")!.status).toBe("failed");
    expect(docRow(booted).status).toBe("draft");
  });

  it("the hourly settlement also blanks a row the Mailbox answered but whose answer event never reached the CRM", async () => {
    const booted = await bootCare();
    await enableFor(booted);
    const made = await makeDoc(booted, "company:acme");
    const out = await sendAndApprove(booted, made.documentId, { answer: false });
    // The Mailbox did send it (the outbox row is done), but the result event was lost on the way.
    Object.assign(outboxRow(booted, out.mail.key), { status: "done", result: { key: out.mail.key, status: "sent", messageId: "gm-9", threadId: "gt-9", sentAt: new Date().toISOString() } });
    expect(await settleStuckMessages(booted.harness.ctx, CO)).toBe(1);
    expect(JSON.stringify(booted.store)).not.toContain(out.token);
    expect(booted.store.care_approvals!.find((a) => a.kind === "esign_request")!.status).toBe("sent");
    expect(docRow(booted).status).toBe("sent");
    expect(pages.read(out.pageId)).toContain('data-state="open"');
  });

  it("a reminder's email is blanked the same way", async () => {
    const { booted } = await sentToAda();
    await runEsignCare(booted.harness.ctx, CO, new Date(Date.now() + 4 * DAY));
    const reminder = booted.store.care_approvals!.find((a) => a.kind === "esign_reminder")!;
    booted.emit.mockClear();
    await decide(booted.harness, reminder.issue_id, "done", "user");
    const [mail] = sentMail(booted.emit);
    const fresh = linkIn(mail.text);
    expect(outboxRow(booted, mail.key).payload.text).toContain(fresh.token);
    await answerSend(booted.harness, mail.key, "sent");
    expect(JSON.stringify(booted.store)).not.toContain(fresh.token);
    expect(booted.store.outbox!.every((row) => !("text" in row.payload) && !("html" in row.payload))).toBe(true);
  });

  it("scrubSettledBody touches only the key it is given, and never a pending row", async () => {
    const booted = await bootCare();
    booted.store.outbox!.push(
      { key: "crm:msg:a", company_id: CO, event: "mail.send.requested", payload: { key: "crm:msg:a", subject: "A", text: "keep me", html: "<p>keep</p>" }, status: "pending" },
      { key: "crm:msg:b", company_id: CO, event: "mail.send.requested", payload: { key: "crm:msg:b", subject: "B", text: "blank me", html: "<p>blank</p>" }, status: "done" },
      { key: "crm:msg:c", company_id: CO, event: "mail.send.requested", payload: { key: "crm:msg:c", subject: "C", text: "other", html: "<p>other</p>" }, status: "done" },
    );
    expect(await scrubSettledBody(booted.harness.ctx, "crm:msg:a")).toBe(false);
    expect(await scrubSettledBody(booted.harness.ctx, "crm:msg:b")).toBe(true);
    expect(booted.store.outbox!.map((row) => row.payload)).toEqual([
      { key: "crm:msg:a", subject: "A", text: "keep me", html: "<p>keep</p>" },
      { key: "crm:msg:b", subject: "B" },
      { key: "crm:msg:c", subject: "C", text: "other", html: "<p>other</p>" },
    ]);
  });
});

describe("the client opens the page and signs", () => {
  it("a view is counted, the status moves to opened, and the trail does not fill up with repeats", async () => {
    const { booted, doc } = await sentToAda();
    const view = { action: "view", pageId: doc.page_id };
    expect(await sign(booted, view)).toMatchObject({ status: "viewed" });
    expect(docRow(booted)).toMatchObject({ status: "viewed", view_count: 1 });
    await sign(booted, view);
    await sign(booted, view);
    expect(docRow(booted).view_count).toBe(3);
    expect(booted.store.sign_events!.filter((e) => e.kind === "viewed")).toHaveLength(1);
    // After ten minutes the next view is written down again.
    await sign(booted, view, {}, new Date(Date.now() + 11 * 60_000));
    expect(booted.store.sign_events!.filter((e) => e.kind === "viewed")).toHaveLength(2);
    expect((await tool<Record<string, any>>(booted.harness, "get-sign-document", { documentId: doc.id })).statusLine).toMatch(/^Opened 4 times/);
  });

  it("a signature records the typed name, time, a keyed hash of the address, the browser and the text's SHA-256 in a chain that verifies", async () => {
    const { booted, token, doc, pageId } = await sentToAda();
    const result = await sign(booted, signBody({ pageId: doc.page_id, contentSha256: doc.content_sha256, consentSha256: doc.consent_sha256 }, token));
    expect(result.status).toBe("signed");
    if (result.status === "signed") expect(await result.effects).toEqual([]);
    const row = docRow(booted);
    expect(row).toMatchObject({ status: "signed", signer_name: "Ada Lovelace", name_matches: true });
    expect(row.signed_at).toBeTruthy();
    expect(row.signer_ip_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(row.signer_ip_hash).not.toContain("203");
    expect(JSON.stringify(row)).not.toContain(VISITOR_IP);
    expect(row.signer_user_agent).toContain("Mozilla/5.0");
    const kinds = booted.store.sign_events!.map((e) => e.kind);
    expect(kinds).toEqual(["created", "send_requested", "link_issued", "sent", "consent_given", "signed"]);
    const signed = booted.store.sign_events!.find((e) => e.kind === "signed")!;
    expect(signed.detail).toMatchObject({ typedName: "Ada Lovelace", contentSha256: doc.content_sha256, consentSha256: doc.consent_sha256, nameMatchesRecipient: true });
    expect(signed.ip_hash).toBe(row.signer_ip_hash);
    expect(row.audit_head).toBe(signed.hash);
    // The whole chain verifies, and so does the tool.
    expect(verifyChain(doc.id, doc.content_sha256, booted.store.sign_events!.map((e) => ({ id: e.id ?? "", companyId: e.company_id, docId: e.doc_id, seq: e.seq, kind: e.kind, actor: e.actor, ipHash: e.ip_hash, userAgent: e.user_agent, detail: e.detail, prevHash: e.prev_hash, hash: e.hash, at: e.at }))).ok).toBe(true);
    expect(await tool(booted.harness, "verify-sign-document", { documentId: doc.id })).toMatchObject({ ok: true, problems: [] });
    // The link is dead now, and the page is the signed copy.
    expect(booted.store.sign_tokens![0]!.revoked_at).toBeTruthy();
    const html = pages.read(pageId)!;
    expect(html).toContain('data-state="signed"');
    expect(html).toContain("Signed by <strong>Ada Lovelace</strong>");
    expect(html).toContain(row.audit_head);
  });

  it("the signed copy is stored on the work issue and the deal, the deal moves to won, and Billing is told", async () => {
    const { booted, comments, token, doc, made } = await sentToAda({ dealId: "d-acme", quoteId: "bq-9", quoteNumber: "Q-0009" });
    booted.emit.mockClear();
    const result = await sign(booted, signBody({ pageId: doc.page_id, contentSha256: doc.content_sha256, consentSha256: doc.consent_sha256 }, token));
    if (result.status === "signed") expect(await result.effects).toEqual([]);
    const row = docRow(booted, made.documentId);
    expect(row.effects_done_at).toBeTruthy();
    // The issue document: the exact text, then the evidence.
    const work = (await issuesWith(booted.harness, "crm:esign:"))[0]!;
    const copy = booted.documents.bodyOf(work.id, "signed-copy")!;
    expect(copy.startsWith(doc.content.trimEnd())).toBe(true);
    expect(copy).toContain("Signed by: Ada Lovelace");
    expect(copy).toContain("Basic electronic signature");
    expect(copy).toContain(`Audit trail fingerprint: ${row.audit_head}`);
    expect(row.signed_copy_sha256).toBe(sha256Hex(copy));
    expect(row.signed_copy_html).toContain("Signed electronically");
    expect(row.signed_copy_html).not.toContain("<script");
    // The deal is linked to the signed document and won.
    const deal = booted.store.deals!.find((d) => d.id === "d-acme")!;
    expect(deal.stage_id).toBe("st-won");
    expect(deal.custom).toMatchObject({ signedDocumentId: doc.id, signedDocumentSha256: doc.content_sha256, quoteId: "bq-9", quoteNumber: "Q-0009" });
    expect(booted.store.activities!.some((a) => a.kind === "document_signed" && a.record_type === "deal" && a.record_id === "d-acme")).toBe(true);
    // Billing: deal.accepted always, quote.accepted in the shape Billing reads, both recorded so they are re-sent for a day.
    const accepted = booted.emit.mock.calls.find((call) => call[0] === "deal.accepted")![2] as Record<string, any>;
    expect(accepted).toMatchObject({ key: `crm:esign:${doc.id}:accepted`, documentId: doc.id, dealId: "d-acme", quoteId: "bq-9", clientKind: "company", clientRef: "acme", valueMinor: 450_000, currency: "ZAR", signerName: "Ada Lovelace", contentSha256: doc.content_sha256, auditHead: row.audit_head });
    const quote = booted.emit.mock.calls.find((call) => call[0] === "quote.accepted")![2] as Record<string, any>;
    expect(quote).toMatchObject({ key: `crm:esign:${doc.id}:quote-accepted`, quoteId: "bq-9", number: "Q-0009", dealId: "d-acme", clientKind: "company", clientRef: "acme", totalMinor: 450_000, currency: "ZAR" });
    expect(booted.store.handoffs!.map((h) => h.event)).toEqual(expect.arrayContaining(["deal.accepted", "quote.accepted", "deal.won"]));
    // The work issue says so, and the signed copy waits as an email for a person to approve (never sent by itself).
    expect(saidOn(comments, work.id)).toMatch(/Signed by Ada Lovelace/);
    const copyApproval = booted.store.care_approvals!.find((a) => a.kind === "esign_copy")!;
    expect(copyApproval.status).toBe("open");
    expect(copyApproval.payload.draft.text).toContain("Thank you for signing");
    expect(copyApproval.payload.draft.text).toContain("Audit trail fingerprint");
    expect(booted.emit.mock.calls.filter((call) => call[0] === "mail.send.requested")).toHaveLength(0);
  });

  it("the signed copy goes to the client only when a person approves it", async () => {
    const { booted, token, doc } = await sentToAda();
    const result = await sign(booted, signBody({ pageId: doc.page_id, contentSha256: doc.content_sha256, consentSha256: doc.consent_sha256 }, token));
    if (result.status === "signed") await result.effects;
    const approval = booted.store.care_approvals!.find((a) => a.kind === "esign_copy")!;
    booted.emit.mockClear();
    await decide(booted.harness, approval.issue_id, "done", "user");
    const [mail] = sentMail(booted.emit);
    expect(mail).toMatchObject({ subject: "Signed: Proposal: SEO retainer", to: [{ email: "ada@acme.co.za", name: "Ada Lovelace" }] });
    expect(mail.text).toContain("Signed by: Ada Lovelace");
    // It carries no signing link: there is nothing left to sign.
    expect(mail.text).not.toMatch(/pibt_|#pibt/);
    await answerSend(booted.harness, mail.key, "sent");
    expect(booted.store.sign_events!.some((e) => e.kind === "copy_sent")).toBe(true);
  });

  it("a name that is not the recipient's is accepted but flagged for a person", async () => {
    const { booted, comments, token, doc, made } = await sentToAda();
    const result = await sign(booted, signBody({ pageId: doc.page_id, contentSha256: doc.content_sha256, consentSha256: doc.consent_sha256 }, token, { typedName: "Charles Babbage" }));
    if (result.status === "signed") await result.effects;
    expect(docRow(booted, made.documentId)).toMatchObject({ status: "signed", signer_name: "Charles Babbage", name_matches: false });
    const work = (await issuesWith(booted.harness, "crm:esign:"))[0]!;
    expect(saidOn(comments, work.id)).toMatch(/does not match the person we sent it to \(Ada Lovelace\)/);
  });

  it("a decline is recorded, the link dies and the work issue is told", async () => {
    const { booted, comments, token, doc, pageId } = await sentToAda();
    const result = await sign(booted, { action: "decline", pageId: doc.page_id, token, reason: "The price is too high" });
    expect(result.status).toBe("declined");
    if (result.status === "declined") await result.effects;
    expect(docRow(booted)).toMatchObject({ status: "declined", decline_reason: "The price is too high" });
    expect(booted.store.sign_tokens![0]!.revoked_at).toBeTruthy();
    expect(pages.read(pageId)).toContain('data-state="declined"');
    expect(pages.read(pageId)).not.toContain("Monthly SEO work");
    const work = (await issuesWith(booted.harness, "crm:esign:"))[0]!;
    expect(saidOn(comments, work.id)).toMatch(/declined .*The price is too high/);
    const failure = await rejected(sign(booted, signBody({ pageId: doc.page_id, contentSha256: doc.content_sha256, consentSha256: doc.consent_sha256 }, token)));
    expect(failure!.message).toMatch(/not valid/);
    expect(booted.emit.mock.calls.some((call) => call[0] === "deal.accepted")).toBe(false);
  });

  it("the worker routes the public endpoint to this handler", async () => {
    const { booted, doc } = await sentToAda();
    const plugin = (await import("../src/worker.js")).default;
    await plugin.definition.onWebhook!(signDelivery({ action: "view", pageId: doc.page_id }));
    expect(docRow(booted).status).toBe("viewed");
  });
});

describe("abuse: forged, replayed, expired and oversized requests", () => {
  const sealed = async () => {
    const out = await sentToAda();
    const body = (extra: Record<string, unknown> = {}) => signBody({ pageId: out.doc.page_id, contentSha256: out.doc.content_sha256, consentSha256: out.doc.consent_sha256 }, out.token, extra);
    return { ...out, body };
  };

  it("a token nobody made is refused with the same words as a dead one, and the attempt is counted", async () => {
    const { booted, body } = await sealed();
    const forged = `pibt_${"a".repeat(40)}`;
    const failure = await rejected(sign(booted, body({ token: forged })));
    expect(failure).toBeInstanceOf(SignRejected);
    expect(failure!.message).toBe("This link is not valid, or it is no longer open. Ask the sender for a new one.");
    expect(docRow(booted).status).toBe("sent");
    expect(booted.store.public_hits!.some((h) => h.outcome === "bad_token")).toBe(true);
    // Not a token at all, or missing: the same.
    for (const token of ["nonsense", "", 7, null, `pibt_${"A".repeat(40)}`]) expect((await rejected(sign(booted, body({ token }))))!.message).toMatch(/not valid/);
  });

  it("a token made for another document does not sign this one", async () => {
    const first = await sealed();
    const second = await makeDoc(first.booted, "company:acme", { title: "Second" });
    const other = await sendAndApprove(first.booted, second.documentId);
    const failure = await rejected(sign(first.booted, first.body({ token: other.token })));
    expect(failure!.message).toMatch(/not valid/);
    expect(docRow(first.booted, first.made.documentId).status).toBe("sent");
  });

  it("a visitor who keeps guessing is stopped", async () => {
    const { booted, body } = await sealed();
    for (let i = 0; i < 10; i += 1) await rejected(sign(booted, body({ token: `pibt_${String(i).repeat(40).replace(/[0189]/g, "a")}` })));
    const failure = await rejected(sign(booted, body()));
    expect(failure!.message).toMatch(/Too many attempts/);
    // Another visitor is not affected.
    const fine = await sign(booted, body(), { "x-real-ip": "203.0.113.77" });
    expect(fine.status).toBe("signed");
  });

  it("a document whose own expiry passed refuses a signature even when its token is still alive", async () => {
    const { booted, body, made } = await sealed();
    // The token's own expiry is untouched; only the document's date moved (a correction, a clock, a bug elsewhere).
    docRow(booted, made.documentId).expires_at = new Date(Date.now() - 1000).toISOString();
    const failure = await rejected(sign(booted, body()));
    expect(failure!.message).toMatch(/This link has expired/);
    expect(docRow(booted, made.documentId).status).toBe("expired");
    expect(docRow(booted, made.documentId).signed_at ?? null).toBeNull();
  });

  it("attempts that keep failing on one document are stopped whoever sends them, and a good signature waits an hour", async () => {
    const { booted, body, made } = await sealed();
    // Twelve refused tries, each from a different visitor so no single visitor limit is reached.
    for (let i = 0; i < 12; i += 1) {
      const failure = await rejected(sign(booted, body({ consent: false }), { "x-real-ip": `203.0.113.${100 + i}` }));
      expect(failure!.message).toMatch(/tick the box/);
    }
    const blocked = await rejected(sign(booted, body(), { "x-real-ip": "203.0.113.200" }));
    expect(blocked!.message).toMatch(/Too many attempts on this document/);
    expect(docRow(booted, made.documentId).status).toBe("sent");
    // An hour later it works again.
    const later = await sign(booted, body(), { "x-real-ip": "203.0.113.201" }, new Date(Date.now() + 61 * 60_000));
    expect(later.status).toBe("signed");
  });

  it("a signature cannot be replayed: the second one is refused and nothing changes", async () => {
    const { booted, body, made } = await sealed();
    expect((await sign(booted, body())).status).toBe("signed");
    const before = JSON.stringify(docRow(booted, made.documentId));
    const failure = await rejected(sign(booted, body({ typedName: "Someone Else" })));
    expect(failure!.message).toMatch(/not valid|already been signed/);
    expect(JSON.stringify(docRow(booted, made.documentId))).toBe(before);
    expect(booted.store.sign_events!.filter((e) => e.kind === "signed")).toHaveLength(1);
  });

  it("two requests racing for the signature: exactly one wins", async () => {
    const { booted, body, made } = await sealed();
    const results = await Promise.all([sign(booted, body({ typedName: "Ada Lovelace" })).then((r) => r.status, (e: Error) => e.message), sign(booted, body({ typedName: "Ada Lovelace" }), { "x-real-ip": "203.0.113.88" }).then((r) => r.status, (e: Error) => e.message)]);
    expect(results.filter((r) => r === "signed")).toHaveLength(1);
    expect(booted.store.sign_events!.filter((e) => e.kind === "signed")).toHaveLength(1);
    expect(docRow(booted, made.documentId).status).toBe("signed");
  });

  it("an expired link is refused, the document is marked expired and its page says so", async () => {
    const { booted, body, made, pageId } = await sealed();
    const later = new Date(Date.now() + 15 * DAY);
    const failure = await rejected(sign(booted, body(), {}, later));
    expect(failure!.message).toMatch(/not valid|expired/);
    // A link that was valid but whose document ran out of time says so, and the job tidies up.
    const run = await runEsignCare(booted.harness.ctx, CO, later);
    expect(run.expired).toBe(1);
    expect(docRow(booted, made.documentId).status).toBe("expired");
    expect(pages.read(pageId)).toContain("This link has expired");
    expect(pages.read(pageId)).not.toContain("Monthly SEO work");
    expect(booted.store.sign_events!.some((e) => e.kind === "expired")).toBe(true);
  });

  it("opening an expired document's page expires it on the spot", async () => {
    const { booted, made, doc } = await sealed();
    await sign(booted, { action: "view", pageId: doc.page_id }, {}, new Date(Date.now() + 15 * DAY));
    expect(docRow(booted, made.documentId).status).toBe("expired");
  });

  it("refuses an oversized body, one that is not JSON, an unknown action, a bad page id and an unknown page", async () => {
    const { booted, body, doc } = await sealed();
    const big = await rejected(handleSignWebhook(booted.harness.ctx, signDelivery({}, {}, JSON.stringify({ ...body(), pad: "x".repeat(5_000) })), { serverIps: SERVER_IPS }));
    expect(big!.message).toBe("The request is too large.");
    expect((await rejected(handleSignWebhook(booted.harness.ctx, { ...signDelivery({}), rawBody: "plain text", parsedBody: undefined }, { serverIps: SERVER_IPS })))!.message).toMatch(/JSON/);
    expect((await rejected(sign(booted, { action: "delete", pageId: doc.page_id })))!.message).toMatch(/not one this page sends/);
    expect((await rejected(sign(booted, { action: "view", pageId: "../../etc/passwd" })))!.message).toMatch(/not valid/);
    expect((await rejected(sign(booted, { action: "view", pageId: generatePageId() })))!.message).toMatch(/not valid/);
    expect((await rejected(handleSignWebhook(booted.harness.ctx, { ...signDelivery({ action: "view", pageId: doc.page_id }), endpointKey: "lead" }, { serverIps: SERVER_IPS })))!.message).toMatch(/Unknown endpoint/);
    expect(docRow(booted).status).toBe("sent");
  });

  it("refuses a signature that does not match what is on record, or lacks consent, a name or reading time", async () => {
    const { booted, body } = await sealed();
    const expectRefused = async (extra: Record<string, unknown>, pattern: RegExp) => expect((await rejected(sign(booted, body(extra), { "x-real-ip": `203.0.113.${Math.floor(Math.random() * 100) + 100}` })))!.message).toMatch(pattern);
    await expectRefused({ consent: false }, /tick the box/);
    await expectRefused({ consent: "true" }, /tick the box/);
    await expectRefused({ typedName: "A" }, /type your full name/);
    await expectRefused({ typedName: "12345" }, /type your full name/);
    await expectRefused({ typedName: "http://evil.example" }, /type your full name/);
    await expectRefused({ docSha256: sha256Hex("another text") }, /not the one on record/);
    await expectRefused({ consentSha256: sha256Hex("another wording") }, /wording you agreed to/);
    await expectRefused({ t: MIN_SIGN_MS - 1 }, /read the document/);
    await expectRefused({ t: "9000" }, /read the document/);
    expect(docRow(booted).status).toBe("sent");
    expect(booted.store.sign_events!.some((e) => e.kind === "signed")).toBe(false);
  });

  it("refuses a signature that comes from this server, or from nowhere, or from no browser", async () => {
    const { booted, body } = await sealed();
    expect((await rejected(sign(booted, body(), { "x-real-ip": "10.0.0.5" })))!.message).toMatch(/did not come from a web browser/);
    expect((await rejected(sign(booted, body(), { "x-real-ip": "127.0.0.1" })))!.message).toMatch(/did not come from a web browser/);
    expect((await rejected(handleSignWebhook(booted.harness.ctx, { ...signDelivery(body()), headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 Chrome" } }, { serverIps: SERVER_IPS })))!.message).toMatch(/did not come from a web browser/);
    expect((await rejected(sign(booted, body(), { "user-agent": "curl" })))!.message).toMatch(/did not come from a web browser/);
    expect(docRow(booted).status).toBe("sent");
  });

  it("a withdrawn document cannot be signed, and its page says it was withdrawn", async () => {
    const { booted, body, made, pageId } = await sealed();
    await tool(booted.harness, "void-sign-document", { documentId: made.documentId, reason: "Wrong price, will resend" });
    expect(docRow(booted, made.documentId).status).toBe("void");
    expect((await rejected(sign(booted, body())))!.message).toMatch(/not valid/);
    expect(pages.read(pageId)).toContain("no longer open");
    expect(pages.read(pageId)).not.toContain("Monthly SEO work");
  });
});

describe("the audit trail is tamper evident", () => {
  async function signed() {
    const out = await sentToAda();
    const result = await sign(out.booted, signBody({ pageId: out.doc.page_id, contentSha256: out.doc.content_sha256, consentSha256: out.doc.consent_sha256 }, out.token));
    if (result.status === "signed") await result.effects;
    return out;
  }

  it("changing the text of a signed document is found", async () => {
    const { booted, made } = await signed();
    docRow(booted, made.documentId).content = docRow(booted, made.documentId).content.replace("R 4,500.00", "R 450.00");
    const checked = await tool<Record<string, any>>(booted.harness, "verify-sign-document", { documentId: made.documentId });
    expect(checked.ok).toBe(false);
    expect(checked.problems.join(" ")).toMatch(/text of the document does not match/);
  });

  it("changing a row of the trail breaks the chain from that row on", async () => {
    const { booted, made } = await signed();
    const row = booted.store.sign_events!.find((e) => e.kind === "signed")!;
    row.detail = { ...row.detail, typedName: "Someone Else" };
    const checked = await tool<Record<string, any>>(booted.harness, "verify-sign-document", { documentId: made.documentId });
    expect(checked.ok).toBe(false);
    expect(checked.problems.join(" ")).toMatch(/Row \d+ \(signed\) was changed after it was written/);
  });

  it("removing a row, or reordering them, is found", async () => {
    const { booted, made } = await signed();
    booted.store.sign_events = booted.store.sign_events!.filter((e) => e.kind !== "viewed" && e.kind !== "link_issued");
    const checked = await tool<Record<string, any>>(booted.harness, "verify-sign-document", { documentId: made.documentId });
    expect(checked.ok).toBe(false);
    expect(checked.problems.join(" ")).toMatch(/a row is missing/);
  });

  it("a signed copy that was edited is found", async () => {
    const { booted, made } = await signed();
    docRow(booted, made.documentId).signed_copy_md = docRow(booted, made.documentId).signed_copy_md.replace("Ada Lovelace", "Ada L");
    const checked = await tool<Record<string, any>>(booted.harness, "verify-sign-document", { documentId: made.documentId });
    expect(checked.ok).toBe(false);
    expect(checked.problems.join(" ")).toMatch(/signed copy does not match/);
  });

  it("the Cockpit shows a failed check as red, and a clean one as ok", async () => {
    const { booted, made } = await signed();
    const clean = await esignHealth(booted.harness.ctx, CO);
    expect(clean.find((c) => c.key === "esign:integrity")).toBeUndefined();
    docRow(booted, made.documentId).content = "tampered";
    const bad = await esignHealth(booted.harness.ctx, CO);
    expect(bad.find((c) => c.key === "esign:integrity")).toMatchObject({ status: "bad" });
  });

  it("a signature whose trail was not finished (the worker stopped) is finished by the care job, flagged late", async () => {
    const out = await sentToAda();
    const { booted, doc, token } = out;
    // The status change happened, then nothing: no trail, no signed copy, no follow-up.
    const row = docRow(booted, doc.id);
    Object.assign(row, { status: "signed", signed_at: new Date(Date.now() - 600_000).toISOString(), signer_name: "Ada Lovelace", signer_ip_hash: "a".repeat(32), signer_user_agent: "Mozilla/5.0", name_matches: true });
    expect(token).toBeTruthy();
    const run = await runEsignCare(booted.harness.ctx, CO);
    expect(run.effects).toBe(1);
    const events = booted.store.sign_events!.filter((e) => e.kind === "signed" || e.kind === "consent_given");
    expect(events.map((e) => e.detail.late)).toEqual([true, true]);
    expect(docRow(booted, doc.id)).toMatchObject({ audit_head: events[1]!.hash });
    expect(docRow(booted, doc.id).effects_done_at).toBeTruthy();
    expect(await tool(booted.harness, "verify-sign-document", { documentId: doc.id })).toMatchObject({ ok: true });
  });
});

describe("reminders and the work issue", () => {
  it("a reminder is drafted after three days for approval, with a fresh link; nothing is sent by itself", async () => {
    const { booted, made, doc } = await sentToAda();
    const early = await runEsignCare(booted.harness.ctx, CO, new Date(Date.now() + 2 * DAY));
    expect(early.reminders).toBe(0);
    const run = await runEsignCare(booted.harness.ctx, CO, new Date(Date.now() + (ESIGN_REMIND_AFTER_DAYS + 0.1) * DAY));
    expect(run.reminders).toBe(1);
    const reminder = booted.store.care_approvals!.find((a) => a.kind === "esign_reminder")!;
    expect(reminder.payload.draft.subject).toBe("Reminder: please sign Proposal: SEO retainer");
    expect(reminder.payload.draft.text).toContain("{{signing_link}}");
    booted.emit.mockClear();
    expect(sentMail(booted.emit)).toHaveLength(0);
    // Not a second draft while the first waits.
    expect((await runEsignCare(booted.harness.ctx, CO, new Date(Date.now() + 4 * DAY))).reminders).toBe(0);
    await decide(booted.harness, reminder.issue_id, "done", "user");
    const [mail] = sentMail(booted.emit);
    const fresh = linkIn(mail.text);
    expect(fresh.pageId).toBe(doc.page_id);
    expect(booted.store.sign_tokens).toHaveLength(2);
    expect(booted.store.sign_tokens!.every((t) => t.expires_at)).toBe(true);
    await answerSend(booted.harness, mail.key, "sent");
    expect(docRow(booted, made.documentId).reminders).toBe(1);
    // Both links work until the document expires.
    expect(booted.store.sign_events!.some((e) => e.kind === "reminder_sent")).toBe(true);
  });

  it("a reminder approved after the document ran out is refused: no dead link is made or sent", async () => {
    const { booted, made } = await sentToAda();
    await runEsignCare(booted.harness.ctx, CO, new Date(Date.now() + 4 * DAY));
    const reminder = booted.store.care_approvals!.find((a) => a.kind === "esign_reminder")!;
    // The document's time ran out while the reminder waited for a person.
    docRow(booted, made.documentId).expires_at = new Date(Date.now() - 1000).toISOString();
    booted.emit.mockClear();
    await decide(booted.harness, reminder.issue_id, "done", "user");
    expect(sentMail(booted.emit)).toHaveLength(0);
    expect(booted.store.sign_tokens).toHaveLength(1);
    expect(booted.store.care_approvals!.find((a) => a.id === reminder.id)).toMatchObject({ status: "failed" });
    expect(booted.store.care_approvals!.find((a) => a.id === reminder.id)!.error).toMatch(/already expired, so there is nothing to sign/);
    expect(booted.store.outbox!.filter((row) => row.key === `crm:msg:${reminder.id}`)).toEqual([]);
  });

  it("a reply stops the reminders and tells the work issue", async () => {
    const { booted, made, doc, mail } = await sentToAda();
    await runEsignCare(booted.harness.ctx, CO, new Date(Date.now() + 4 * DAY));
    const reminder = booted.store.care_approvals!.find((a) => a.kind === "esign_reminder")!;
    expect(reminder.status).toBe("open");
    await booted.harness.emit("plugin.partnersinbiz.mailbox.mail.received", { key: "mail:m1", messageId: "m1", threadId: "t1", from: { email: "ada@acme.co.za", name: "Ada" }, subject: "Re: Please read and sign", snippet: "One question", receivedAt: new Date().toISOString(), replyTo: { plugin: "partnersinbiz.crm", kind: "client_message", id: booted.store.care_approvals!.find((a) => a.kind === "esign_request")!.id } }, { companyId: CO });
    expect(docRow(booted, made.documentId).next_reminder_at).toBeNull();
    expect(booted.store.care_approvals!.find((a) => a.kind === "esign_reminder")!.status).toBe("refused");
    expect(booted.store.sign_events!.some((e) => e.kind === "replied")).toBe(true);
    expect(mail.key).toBeTruthy();
    expect(doc.status).toBe("sent");
  });

  it("after two reminders with no signature the Account Manager gets an issue to reach the client another way", async () => {
    const { booted, made } = await sentToAda({ validDays: 30 });
    for (let round = 1; round <= MAX_ESIGN_REMINDERS; round += 1) {
      await runEsignCare(booted.harness.ctx, CO, new Date(Date.now() + (round * 4) * DAY));
      const reminder = booted.store.care_approvals!.filter((a) => a.kind === "esign_reminder").at(-1)!;
      booted.emit.mockClear();
      await decide(booted.harness, reminder.issue_id, "done", "user");
      await answerSend(booted.harness, sentMail(booted.emit)[0].key, "sent");
    }
    expect(docRow(booted, made.documentId).reminders).toBe(MAX_ESIGN_REMINDERS);
    const run = await runEsignCare(booted.harness.ctx, CO, new Date(Date.now() + 12 * DAY));
    expect(run.escalated).toBe(1);
    const stale = (await issuesWith(booted.harness, "crm:esign-stale:"))[0]!;
    expect(stale.title).toBe("Acme Plumbing has not signed: Proposal: SEO retainer");
    expect(stale.assigneeAgentId).toBe("am-1");
    // Once only.
    expect((await runEsignCare(booted.harness.ctx, CO, new Date(Date.now() + 13 * DAY))).escalated).toBe(0);
  });

  it("closing the work issue before the document is finished is reopened with what is missing; a signature lets it close", async () => {
    const { booted, made, doc, token } = await sentToAda();
    const work = (await issuesWith(booted.harness, "crm:esign:"))[0]!;
    const open = await esignIssueResolved(booted.harness.ctx, CO, work.originId!);
    expect(open).toMatchObject({ done: false });
    expect((open as { missing: string[] }).missing[0]).toMatch(/Leave the issue open until it is signed, declined or withdrawn/);
    // As the host would do it: an agent marks it done, the CRM's done-check puts it back.
    const reopened = await decide(booted.harness, work.id, "done", "agent");
    expect(reopened.status).not.toBe("done");
    const result = await sign(booted, signBody({ pageId: doc.page_id, contentSha256: doc.content_sha256, consentSha256: doc.consent_sha256 }, token));
    if (result.status === "signed") await result.effects;
    expect(await esignIssueResolved(booted.harness.ctx, CO, work.originId!)).toEqual({ done: true });
    expect(made.documentId).toBeTruthy();
  });

  it("withdrawing a document withdraws the emails still waiting and kills the links", async () => {
    const { booted, made } = await sentToAda();
    await runEsignCare(booted.harness.ctx, CO, new Date(Date.now() + 4 * DAY));
    const reminder = booted.store.care_approvals!.find((a) => a.kind === "esign_reminder")!;
    const out = await tool<Record<string, any>>(booted.harness, "void-sign-document", { documentId: made.documentId, reason: "The client changed the scope" });
    expect(out).toMatchObject({ status: "void", emailsWithdrawn: 1 });
    expect(booted.store.care_approvals!.find((a) => a.id === reminder.id)!.status).toBe("refused");
    expect(booted.store.sign_tokens!.every((t) => t.revoked_at)).toBe(true);
    await expect(tool(booted.harness, "void-sign-document", { documentId: made.documentId, reason: "ok ok ok" })).resolves.toMatchObject({ note: "It was already withdrawn." });
    await expect(tool(booted.harness, "void-sign-document", { documentId: made.documentId, reason: "x" })).rejects.toThrow(/reason is required/);
  });

  it("a signed document cannot be withdrawn", async () => {
    const { booted, made, doc, token } = await sentToAda();
    const result = await sign(booted, signBody({ pageId: doc.page_id, contentSha256: doc.content_sha256, consentSha256: doc.consent_sha256 }, token));
    if (result.status === "signed") await result.effects;
    await expect(tool(booted.harness, "void-sign-document", { documentId: made.documentId, reason: "Changed our minds" })).rejects.toThrow(/signed document cannot be withdrawn/);
  });
});

describe("the pages are files: a deploy removes them and the care job writes them again", () => {
  it("a page name can never look like a cached asset to the host", () => {
    for (let i = 0; i < 2_000; i += 1) expect(HOST_HASHED_NAME.test(pageFileName(generatePageId())), "page name").toBe(false);
    expect(HOST_HASHED_NAME.test("index-a1b2c3d4.js")).toBe(true);
  });

  it("is rewritten from the records when the file is gone, or shows another state than the record", async () => {
    const { booted, pageId, doc } = await sentToAda();
    const { rmSync } = await import("node:fs");
    rmSync(`${pages.dir}/${pageId}.html`);
    expect(pages.has(pageId)).toBe(false);
    const result = await syncAllPages(booted.harness.ctx);
    expect(result.written).toBe(1);
    expect(pages.read(pageId)).toContain('data-state="open"');
    // Nothing to do the second time.
    expect((await syncAllPages(booted.harness.ctx)).written).toBe(0);
    // The record moved on without the file (a document whose time ran out): the sweep notices.
    docRow(booted, doc.id).expires_at = new Date(Date.now() - 1000).toISOString();
    expect((await syncAllPages(booted.harness.ctx)).written).toBe(1);
    expect(pages.read(pageId)).toContain('data-state="expired"');
  });

  it("removes the page of a document that was never sent, and one nobody has a record of", async () => {
    const { booted, made } = await sentToAda();
    const orphan = generatePageId();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${pages.dir}/${orphan}.html`, "<html></html>");
    docRow(booted, made.documentId).status = "draft";
    const result = await syncAllPages(booted.harness.ctx);
    expect(result.removed).toBe(2);
    expect(pages.all()).toEqual([]);
  });

  it("a folder that cannot be written is a failed send, said plainly, not a lost document", async () => {
    const booted = await bootCare();
    await enableFor(booted);
    const made = await makeDoc(booted, "company:acme");
    const sent = await tool<Record<string, any>>(booted.harness, "send-for-signature", { documentId: made.documentId });
    configurePagesDir(null);
    booted.emit.mockClear();
    await decide(booted.harness, sent.approvalIssueId, "done", "user");
    expect(sentMail(booted.emit)).toHaveLength(0);
    expect(docRow(booted).status).toBe("draft");
    const approval = booted.store.care_approvals!.find((a) => a.kind === "esign_request")!;
    expect(approval.status).toBe("failed");
    expect(approval.error).toMatch(/nowhere to publish the signing page/);
    expect(booted.store.sign_tokens![0]!.revoked_at).toBeTruthy();
    // The Cockpit says so too once something is out for signature.
    configurePagesDir(pages.dir);
  });
});

describe("a page stays online between the approval and the Mailbox's confirmation", () => {
  it("the care job and the start-up sweep keep the page of a document whose email was approved but not yet confirmed, and the link still signs", async () => {
    const booted = await bootCare();
    await enableFor(booted);
    const made = await makeDoc(booted, "company:acme");
    const out = await sendAndApprove(booted, made.documentId, { answer: false });
    // The link was made at the approval; the status moves to sent only when the Mailbox answers.
    expect(docRow(booted).status).toBe("awaiting_approval");
    expect(docRow(booted).expires_at).toBeTruthy();
    expect(pages.has(out.pageId)).toBe(true);
    const sweep = await syncAllPages(booted.harness.ctx);
    expect(sweep).toMatchObject({ removed: 0, failed: 0 });
    expect(pages.read(out.pageId)).toContain('data-state="open"');
    await runClientCareJob(booted.harness.ctx, new Date());
    expect(pages.read(out.pageId)).toContain('data-state="open"');
    // A deploy wiped the folder in this window: the sweep writes it again, open.
    const { rmSync } = await import("node:fs");
    rmSync(`${pages.dir}/${out.pageId}.html`);
    expect((await syncAllPages(booted.harness.ctx)).written).toBe(1);
    expect(pages.read(out.pageId)).toContain('data-state="open"');
    // The client opens the link in this window and can sign it.
    const doc = docRow(booted);
    const view = await sign(booted, { action: "view", pageId: doc.page_id });
    expect(view.status).toBe("viewed");
    const result = await sign(booted, signBody({ pageId: doc.page_id, contentSha256: doc.content_sha256, consentSha256: doc.consent_sha256 }, out.token));
    expect(result.status).toBe("signed");
  });

  it("when the Mailbox then answers the page is still there, written again from the record", async () => {
    const booted = await bootCare();
    await enableFor(booted);
    const made = await makeDoc(booted, "company:acme");
    const out = await sendAndApprove(booted, made.documentId, { answer: false });
    const { rmSync } = await import("node:fs");
    rmSync(`${pages.dir}/${out.pageId}.html`);
    await answerSend(booted.harness, out.mail.key, "sent");
    expect(docRow(booted).status).toBe("sent");
    expect(pages.read(out.pageId)).toContain('data-state="open"');
  });

  it("a document still waiting for the person has no page, and one past its expiry shows the expired note", async () => {
    const booted = await bootCare();
    await enableFor(booted);
    const made = await makeDoc(booted, "company:acme");
    await tool(booted.harness, "send-for-signature", { documentId: made.documentId });
    expect(docRow(booted)).toMatchObject({ status: "awaiting_approval", expires_at: null });
    expect(pages.all()).toEqual([]);
    expect((await syncAllPages(booted.harness.ctx)).written).toBe(0);
    expect(pages.all()).toEqual([]);
  });

  it("a company with more documents than one sweep reads never loses a page it did not read", async () => {
    const { booted, pageId } = await sentToAda();
    const { SYNC_DOCS_PER_COMPANY } = await import("../src/esign-sync.js");
    // Enough other documents that the sweep's read is full: it cannot tell which pages belong to nobody, so it removes none.
    const template = docRow(booted);
    for (let i = 0; i < SYNC_DOCS_PER_COMPANY; i += 1) booted.store.sign_documents!.push({ ...template, id: `filler-${i}`, page_id: generatePageId(), status: "draft", created_at: new Date(Date.now() + (i + 1) * 1000).toISOString() });
    const orphan = generatePageId();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${pages.dir}/${orphan}.html`, "<html></html>");
    const result = await syncAllPages(booted.harness.ctx);
    expect(pages.has(orphan)).toBe(true);
    expect(pages.has(pageId)).toBe(true);
    expect(result.removed).toBeGreaterThanOrEqual(0);
  });
});

describe("the status line", () => {
  it("says where each state is in plain words", () => {
    const base = { recipientName: "Ada", sentAt: "2026-10-01T10:00:00Z", viewCount: 0, lastViewedAt: null, expiresAt: "2026-10-15T10:00:00Z", signedAt: null, signerName: null, declinedAt: null, declineReason: null, expiredAt: null, voidedAt: null, voidReason: null, reminders: 0 };
    expect(statusLine({ ...base, status: "draft" })).toBe("Draft: not sent. Nothing has gone to the client.");
    expect(statusLine({ ...base, status: "awaiting_approval" })).toMatch(/Waiting for a person to approve/);
    expect(statusLine({ ...base, status: "sent" })).toBe("Sent to Ada on 1 Oct 2026, not opened yet. Link works until 15 Oct 2026.");
    expect(statusLine({ ...base, status: "viewed", viewCount: 1, lastViewedAt: "2026-10-02T10:00:00Z", reminders: 2 })).toBe("Opened 1 time, last on 2 Oct 2026. Not signed yet. Link works until 15 Oct 2026. 2 reminders sent.");
    expect(statusLine({ ...base, status: "signed", signedAt: "2026-10-03T10:00:00Z", signerName: "Ada Lovelace" })).toBe("Signed by Ada Lovelace on 3 Oct 2026, 12:00 (South African time).");
    expect(statusLine({ ...base, status: "declined", declinedAt: "2026-10-03T10:00:00Z", declineReason: "Too dear" })).toBe("Declined on 3 Oct 2026: Too dear.");
    expect(statusLine({ ...base, status: "expired", expiredAt: "2026-10-15T10:00:00Z" })).toMatch(/^Expired on 15 Oct 2026 without a signature/);
    expect(statusLine({ ...base, status: "void", voidedAt: "2026-10-03T10:00:00Z", voidReason: "Wrong price" })).toBe("Withdrawn on 3 Oct 2026: Wrong price.");
  });
});

describe("what the lists show", () => {
  it("lists a client's documents with their status and whether e-sign is on, and hides other clients from a caller who cannot see them", async () => {
    const { booted } = await sentToAda();
    const list = await tool<Record<string, any>>(booted.harness, "list-sign-documents", { client: "company:acme" });
    expect(list).toMatchObject({ count: 1, esign: { allowed: true, canary: false, turnedOnBy: "user:local-board" } });
    expect(list.documents[0]).toMatchObject({ title: "Proposal: SEO retainer", status: "sent", to: "Ada Lovelace <ada@acme.co.za>" });
    expect((await tool<Record<string, any>>(booted.harness, "list-sign-documents", { status: "signed" })).count).toBe(0);
    await expect(tool(booted.harness, "list-sign-documents", { status: "weird" })).rejects.toThrow(/status must be/);
    const templates = await tool<Record<string, any>>(booted.harness, "sign-templates", { includeText: true });
    expect(templates.notice).toMatch(/not legal advice/);
    expect(templates.templates.map((t: { key: string }) => t.key)).toEqual(["proposal", "quote", "service-agreement"]);
    expect(templates.templates[0].source).toContain("{{scope}}");
  });

  it("a person's page action returns the same as the tool, and the board is the only door to turn it on", async () => {
    const { booted } = await sentToAda();
    const viaPage = await booted.harness.performAction<Record<string, any>>("crm.list-sign-documents", { client: "company:acme" }, { companyId: CO, actor: BOARD });
    expect(viaPage.count).toBe(1);
    expect(sha256Hex("x")).toHaveLength(64);
    expect(tokenHash("a")).toHaveLength(64);
  });
});
