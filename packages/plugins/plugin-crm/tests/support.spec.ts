import { describe, expect, it, vi } from "vitest";
import type { SupportCase } from "../src/care-store.js";
import { applyStatus, breachResolved, caseIssueResolved, caseSla, feedbackEmail, isSupportMail, LOW_SCORE, npsOf, parseScore, runSupportSla, SLA_HOURS, slaDueDates, supportHealth } from "../src/support.js";
import { answerSend, bootCare, careSeed, CO, company, decide, issuesWith, MAILBOX, OWNER, tool, toolRaw, type Booted } from "./helpers/care.js";

const HOUR = 3_600_000;
const OPENED = new Date("2026-10-01T08:00:00.000Z");

function caseRow(extra: Partial<SupportCase> = {}): SupportCase {
  return {
    id: "c1", companyId: CO, client: { kind: "company", id: "acme" }, title: "Site is slow", summary: "", source: "manual", severity: "normal", status: "open", contactId: null, threadId: null, sourceKey: null,
    replyIssueId: null, issueId: null, ...slaDueDates("normal", OPENED), firstResponseAt: null, resolvedAt: null, firstBreachedAt: null, resolutionBreachedAt: null, escalatedAt: null, pausedAt: null,
    resolution: null, openedBy: null, createdAt: OPENED.toISOString(), ...extra,
  };
}

function supportMail(extra: Record<string, unknown> = {}, triage: Record<string, unknown> = {}): any {
  return {
    key: "mail:s-1", accountAddress: "peet@partnersinbiz.online", messageId: "s-1", threadId: "t-9", from: { email: "ada@acme.co.za", name: "Ada" }, to: [{ email: "peet@partnersinbiz.online" }],
    subject: "Our website is down", snippet: "Hi, the contact form shows an error since this morning.", receivedAt: new Date().toISOString(), attachments: [],
    triage: { category: "support", urgency: 2.7, needsReply: 0.9, phishing: 0, confidence: 0.9, clientKind: null, clientRef: null, ...triage },
    replyTo: null, ...extra,
  };
}

async function receive(booted: Booted, payload: Record<string, unknown>) {
  await booted.harness.emit(`${MAILBOX}.mail.received` as `plugin.${string}`, payload, { companyId: CO });
}

describe("support targets", () => {
  it("run from the moment a case opens, shorter for a more urgent one", () => {
    expect(SLA_HOURS).toEqual({ urgent: { firstResponse: 1, resolution: 8 }, high: { firstResponse: 4, resolution: 24 }, normal: { firstResponse: 8, resolution: 72 }, low: { firstResponse: 24, resolution: 168 } });
    expect(slaDueDates("high", OPENED)).toEqual({ firstResponseDueAt: "2026-10-01T12:00:00.000Z", resolutionDueAt: "2026-10-02T08:00:00.000Z" });
    expect(slaDueDates("normal", OPENED, { firstResponseHours: 2, resolutionHours: 10 })).toEqual({ firstResponseDueAt: "2026-10-01T10:00:00.000Z", resolutionDueAt: "2026-10-01T18:00:00.000Z" });
  });

  it("says where a case stands: ok, at risk (under a quarter of the window left), breached, met, or paused while the client owes us", () => {
    const c = caseRow();
    const at = (hours: number) => OPENED.getTime() + hours * HOUR;
    expect(caseSla(c, at(1))).toEqual({ firstResponse: "ok", resolution: "ok" });
    expect(caseSla(c, at(7)).firstResponse).toBe("at_risk");
    expect(caseSla(c, at(9)).firstResponse).toBe("breached");
    expect(caseSla(c, at(60)).resolution).toBe("at_risk");
    expect(caseSla(c, at(80)).resolution).toBe("breached");
    expect(caseSla(caseRow({ firstResponseAt: new Date(at(2)).toISOString() }), at(9)).firstResponse).toBe("met");
    expect(caseSla(caseRow({ status: "waiting_client", pausedAt: new Date(at(5)).toISOString() }), at(100)).resolution).toBe("paused");
    // A resolved case met both: a case closed without a first response counts as answered.
    expect(caseSla(caseRow({ status: "resolved", resolvedAt: new Date(at(30)).toISOString() }), at(100))).toEqual({ firstResponse: "met", resolution: "met" });
  });
});

describe("moving a case along", () => {
  it("allows the real transitions and refuses the rest", () => {
    const now = new Date(OPENED.getTime() + HOUR);
    expect(applyStatus(caseRow({ status: "new" }), "open", now, null).status).toBe("open");
    expect(() => applyStatus(caseRow({ status: "new" }), "closed", now, null)).toThrow(/cannot go to closed/);
    expect(() => applyStatus(caseRow({ status: "closed" }), "open", now, null)).toThrow(/open a new case/);
    expect(applyStatus(caseRow({ status: "open" }), "open", now, null).status).toBe("open");
  });

  it("resolving needs what resolved it, and counts as the first response too", () => {
    const now = new Date(OPENED.getTime() + 3 * HOUR);
    expect(() => applyStatus(caseRow(), "resolved", now, "")).toThrow(/what resolved it/);
    const done = applyStatus(caseRow(), "resolved", now, "Cleared the cache and the contact form works again.");
    expect(done).toMatchObject({ status: "resolved", resolvedAt: now.toISOString(), firstResponseAt: now.toISOString() });
    expect(applyStatus(done, "open", now, null)).toMatchObject({ status: "open", resolvedAt: null });
  });

  it("waiting on the client pauses the resolution clock and gives the waiting time back", () => {
    const paused = applyStatus(caseRow(), "waiting_client", new Date(OPENED.getTime() + 2 * HOUR), null);
    expect(paused.pausedAt).toBe("2026-10-01T10:00:00.000Z");
    const back = applyStatus(paused, "open", new Date(OPENED.getTime() + 12 * HOUR), null);
    expect(back.pausedAt).toBeNull();
    expect(Date.parse(back.resolutionDueAt) - Date.parse(paused.resolutionDueAt)).toBe(10 * HOUR);
  });
});

describe("a support mail becomes a case", () => {
  it("only mail the Mailbox sorted as support, and not phishing or no-reply noise", () => {
    expect(isSupportMail(supportMail())).toBe(true);
    expect(isSupportMail(supportMail({}, { category: "lead" }))).toBe(false);
    expect(isSupportMail(supportMail({}, { phishing: 0.95 }))).toBe(false);
    expect(isSupportMail(supportMail({}, { needsReply: 0.1 }))).toBe(false);
    expect(isSupportMail(supportMail({}, { needsReply: null }))).toBe(true);
  });

  it("opens one case for a customer's request, high when urgent, wrapping the Reply-needed issue instead of opening its own", async () => {
    const booted = await bootCare();
    await receive(booted, supportMail());
    const [row] = booted.store.support_cases!;
    expect(row).toMatchObject({ client_kind: "company", client_ref: "acme", contact_id: "ada", source: "mail", severity: "high", status: "new", thread_id: "t-9", source_key: "mail:s-1", issue_id: null, title: "Our website is down" });
    expect(row!.summary).toContain("contact form shows an error");
    expect(Date.parse(row!.first_response_due_at) - Date.now()).toBeGreaterThan(3.9 * HOUR);
    expect(await issuesWith(booted.harness, "crm:support-case:")).toHaveLength(0);
    // The same mail twice, and a second message on the same thread, never open a second case.
    await receive(booted, supportMail());
    await receive(booted, supportMail({ messageId: "s-2", key: "mail:s-2" }));
    expect(booted.store.support_cases).toHaveLength(1);
  });

  it("opens none for a lead's question, an unknown sender, or another kind of mail", async () => {
    const store = careSeed();
    store.companies = store.companies!.map((row) => (row.id === "acme" ? { ...row, lifecycle: "prospect" } : row));
    const booted = await bootCare({ store });
    await receive(booted, supportMail());
    await receive(booted, supportMail({ messageId: "s-3", key: "mail:s-3", threadId: "t-3", from: { email: "nobody@stranger.test", name: "N" } }));
    await receive(booted, supportMail({ messageId: "s-4", key: "mail:s-4", threadId: "t-4" }, { category: "newsletter" }));
    expect(booted.store.support_cases ?? []).toHaveLength(0);
  });

  it("a sole trader's support mail is a case on their own record", async () => {
    const store = careSeed();
    const booted = await bootCare({ store });
    await receive(booted, supportMail({ messageId: "s-5", key: "mail:s-5", threadId: "t-5", from: { email: "sipho@solo.test", name: "Sipho" } }));
    expect(booted.store.support_cases![0]).toMatchObject({ client_kind: "contact", client_ref: "solo" });
  });

  it("a new message on a resolved case reopens it with fresh targets", async () => {
    const booted = await bootCare();
    await receive(booted, supportMail());
    const id = booted.store.support_cases![0]!.id;
    await tool(booted.harness, "update-support-case", { caseId: id, status: "resolved", resolution: "Restarted the form handler." });
    expect(booted.store.support_cases![0]!.status).toBe("resolved");
    await receive(booted, supportMail({ messageId: "s-6", key: "mail:s-6" }));
    expect(booted.store.support_cases).toHaveLength(1);
    expect(booted.store.support_cases![0]).toMatchObject({ status: "open", resolved_at: null, first_response_at: null });
  });

  it("the Mailbox's Reply-needed issue being done on the thread is the first response", async () => {
    const booted = await bootCare();
    await receive(booted, supportMail());
    expect(booted.store.support_cases![0]!.first_response_at ?? null).toBeNull();
    booted.harness.seed({ issues: [{ id: "reply-1", companyId: CO, title: "Reply needed: Our website is down", status: "todo", originKind: "plugin:partnersinbiz.mailbox", originId: "mailbox:reply:acct-1:t-9", createdAt: new Date() } as never] });
    await booted.harness.emit("issue.updated", {}, { companyId: CO, entityId: "reply-1", actorType: "agent", actorId: "am-1" });
    // Linked while it is still open, but not yet answered.
    expect(booted.store.support_cases![0]).toMatchObject({ reply_issue_id: "reply-1" });
    expect(booted.store.support_cases![0]!.first_response_at ?? null).toBeNull();
    booted.harness.seed({ issues: [{ id: "reply-1", companyId: CO, title: "Reply needed: Our website is down", status: "done", originKind: "plugin:partnersinbiz.mailbox", originId: "mailbox:reply:acct-1:t-9", createdAt: new Date() } as never] });
    await booted.harness.emit("issue.updated", {}, { companyId: CO, entityId: "reply-1", actorType: "agent", actorId: "am-1" });
    expect(booted.store.support_cases![0]).toMatchObject({ status: "open" });
    expect(booted.store.support_cases![0]!.first_response_at).toBeTruthy();
  });
});

describe("open-support-case and update-support-case", () => {
  it("a case that did not come by mail opens a work issue for the Account Manager, in the client's project, with both targets", async () => {
    const store = careSeed({ client_projects: [{ id: "cp1", company_id: CO, client_kind: "company", client_ref: "acme", project_id: "proj-acme", created_at: "2026-09-01T00:00:00Z" }] });
    const booted = await bootCare({ store });
    const made = await tool<Record<string, any>>(booted.harness, "open-support-case", { client: "company:acme", title: "Quote form emails go to spam", summary: "Ada says the confirmation never arrives.", severity: "high", source: "manual" });
    expect(made).toMatchObject({ created: true, severity: "high", status: "new", sla: { firstResponse: "ok", resolution: "ok" } });
    const [issue] = await issuesWith(booted.harness, "crm:support-case:");
    expect(issue).toMatchObject({ id: made.issueId, assigneeAgentId: "am-1", projectId: "proj-acme", priority: "high" });
    expect(issue!.title).toBe("Support (high): Acme Plumbing: Quote form emails go to spam");
    expect(issue!.description).toContain("**First response due:**");
    expect(issue!.description).toContain("**Done when** the case is resolved or closed");
  });

  it("a mail case opens no issue, a thread has one open case, and a contact must be the client's", async () => {
    const booted = await bootCare();
    const first = await tool<Record<string, any>>(booted.harness, "open-support-case", { client: "company:acme", title: "Printer", source: "mail", threadId: "t-77", messageId: "m-77", contactId: "contact:ada" });
    expect(first).toMatchObject({ created: true, issueId: null });
    const again = await tool<Record<string, any>>(booted.harness, "open-support-case", { client: "company:acme", title: "Printer again", source: "mail", threadId: "t-77" });
    expect(again).toMatchObject({ created: false, note: "This thread already has an open case.", caseId: first.caseId });
    expect((await toolRaw(booted.harness, "open-support-case", { client: "company:acme", title: "x", contactId: "contact:grace" })).error).toMatch(/not one of this client's people/);
    expect((await toolRaw(booted.harness, "open-support-case", { client: "company:acme", title: "x", severity: "terrible" })).error).toMatch(/severity must be one of/);
    expect((await toolRaw(booted.harness, "open-support-case", { client: "company:acme", title: "x", firstResponseHours: 0 })).error).toMatch(/between 0.25 and 1440/);
  });

  it("raising the severity tightens the targets, lowering never gives time back, waiting_client pauses", async () => {
    const booted = await bootCare();
    const made = await tool<Record<string, any>>(booted.harness, "open-support-case", { client: "company:acme", title: "Slow site", severity: "low" });
    const before = booted.store.support_cases![0]!.first_response_due_at;
    await tool(booted.harness, "update-support-case", { caseId: made.caseId, severity: "urgent" });
    const tightened = booted.store.support_cases![0]!.first_response_due_at;
    expect(Date.parse(tightened)).toBeLessThan(Date.parse(before));
    await tool(booted.harness, "update-support-case", { caseId: made.caseId, severity: "low" });
    expect(booted.store.support_cases![0]!.first_response_due_at).toBe(tightened);
    await tool(booted.harness, "update-support-case", { caseId: made.caseId, firstResponse: true, status: "open", note: "Called Ada." });
    expect(booted.store.support_cases![0]).toMatchObject({ status: "open" });
    expect(booted.store.support_cases![0]!.first_response_at).toBeTruthy();
    const paused = await tool<Record<string, any>>(booted.harness, "update-support-case", { caseId: made.caseId, status: "waiting_client" });
    expect(paused.sla.resolution).toBe("paused");
    expect(booted.store.activities!.some((a) => /Support case "Slow site": status open to waiting_client/.test(a.body))).toBe(true);
    expect((await toolRaw(booted.harness, "update-support-case", { caseId: made.caseId, status: "resolved" })).error).toMatch(/what resolved it/);
  });

  it("lists cases with where they stand, open by default, breached on request", async () => {
    const booted = await bootCare();
    await tool(booted.harness, "open-support-case", { client: "company:acme", title: "A" });
    const second = await tool<Record<string, any>>(booted.harness, "open-support-case", { client: "company:acme", title: "B" });
    await tool(booted.harness, "update-support-case", { caseId: second.caseId, status: "resolved", resolution: "Fixed the DNS record." });
    expect((await tool<Record<string, any>>(booted.harness, "list-support-cases", {})).cases.map((c: any) => c.title)).toEqual(["A"]);
    expect((await tool<Record<string, any>>(booted.harness, "list-support-cases", { status: "all" })).count).toBe(2);
    booted.store.support_cases![0]!.first_response_due_at = new Date(Date.now() - HOUR).toISOString();
    expect((await tool<Record<string, any>>(booted.harness, "list-support-cases", { status: "breached" })).cases.map((c: any) => c.title)).toEqual(["A"]);
  });
});

describe("the SLA job", () => {
  it("flags a missed first response once, with an issue for the Account Manager, and the Cockpit goes red until it is answered", async () => {
    const booted = await bootCare();
    const made = await tool<Record<string, any>>(booted.harness, "open-support-case", { client: "company:acme", title: "Emails bounce", severity: "urgent" });
    expect((await supportHealth(booted.harness.ctx, CO)).status).toBe("ok");
    const later = new Date(Date.now() + 2 * HOUR);
    expect(await runSupportSla(booted.harness.ctx, CO, later)).toEqual({ firstBreaches: 1, resolutionBreaches: 0 });
    expect(await runSupportSla(booted.harness.ctx, CO, later)).toEqual({ firstBreaches: 0, resolutionBreaches: 0 });
    const [breach] = await issuesWith(booted.harness, "crm:support-breach:");
    expect(breach).toMatchObject({ originId: `crm:support-breach:${made.caseId}:first`, assigneeAgentId: "am-1", priority: "high" });
    expect(breach!.title).toMatch(/^SLA breached \(first response\): Acme Plumbing: Emails bounce/);
    expect(booted.store.support_cases![0]!.first_breached_at).toBeTruthy();
    const red = await supportHealth(booted.harness.ctx, CO, later.getTime());
    expect(red).toMatchObject({ key: "support:sla", status: "bad" });
    expect(red.detail).toMatch(/Emails bounce/);

    // Closing the breach issue needs the first response recorded.
    const open = await breachResolved(booted.harness.ctx, CO, breach!.originId!);
    expect(open).toMatchObject({ done: false });
    await tool(booted.harness, "update-support-case", { caseId: made.caseId, firstResponse: true });
    expect(await breachResolved(booted.harness.ctx, CO, breach!.originId!)).toEqual({ done: true });
  });

  it("flags a missed resolution too, but not while the case waits on the client", async () => {
    const booted = await bootCare();
    const made = await tool<Record<string, any>>(booted.harness, "open-support-case", { client: "company:acme", title: "Migrate mailboxes", severity: "high" });
    await tool(booted.harness, "update-support-case", { caseId: made.caseId, firstResponse: true });
    await tool(booted.harness, "update-support-case", { caseId: made.caseId, status: "waiting_client" });
    const later = new Date(Date.now() + 30 * HOUR);
    expect(await runSupportSla(booted.harness.ctx, CO, later)).toEqual({ firstBreaches: 0, resolutionBreaches: 0 });
    await tool(booted.harness, "update-support-case", { caseId: made.caseId, status: "open" });
    // The waiting time was given back: still inside the target at 30 h when only seconds were waited, so make it late.
    booted.store.support_cases![0]!.resolution_due_at = new Date(Date.now() - HOUR).toISOString();
    expect(await runSupportSla(booted.harness.ctx, CO, new Date())).toEqual({ firstBreaches: 0, resolutionBreaches: 1 });
    expect(await issuesWith(booted.harness, "crm:support-breach:")).toHaveLength(1);
  });

  it("a case that is about to breach is amber, a closed one is never flagged", async () => {
    const booted = await bootCare();
    const made = await tool<Record<string, any>>(booted.harness, "open-support-case", { client: "company:acme", title: "Question", severity: "normal" });
    const soon = Date.now() + 7 * HOUR;
    expect((await supportHealth(booted.harness.ctx, CO, soon)).status).toBe("warn");
    await tool(booted.harness, "update-support-case", { caseId: made.caseId, status: "resolved", resolution: "Answered on the phone." });
    expect(await runSupportSla(booted.harness.ctx, CO, new Date(Date.now() + 200 * HOUR))).toEqual({ firstBreaches: 0, resolutionBreaches: 0 });
    expect((await supportHealth(booted.harness.ctx, CO, Date.now() + 200 * HOUR)).status).toBe("ok");
  });

  it("closing a case issue needs the case resolved", async () => {
    const booted = await bootCare();
    const made = await tool<Record<string, any>>(booted.harness, "open-support-case", { client: "company:acme", title: "Logo", source: "portal" });
    const [issue] = await issuesWith(booted.harness, "crm:support-case:");
    expect(await caseIssueResolved(booted.harness.ctx, CO, issue!.originId!)).toMatchObject({ done: false });
    await tool(booted.harness, "update-support-case", { caseId: made.caseId, status: "resolved", resolution: "Sent the logo files again." });
    expect(await caseIssueResolved(booted.harness.ctx, CO, issue!.originId!)).toEqual({ done: true });
  });
});

describe("NPS and CSAT", () => {
  it("reads a score from the start of a reply, within the scale, with the rest as the comment", () => {
    expect(parseScore("9 - great service", "nps")).toEqual({ score: 9, comment: "great service" });
    expect(parseScore("10", "nps")).toEqual({ score: 10, comment: "" });
    expect(parseScore("0! terrible", "nps")).toEqual({ score: 0, comment: "terrible" });
    expect(parseScore("8/10, you were quick\nthanks", "nps")).toEqual({ score: 8, comment: "you were quick thanks" });
    expect(parseScore("11", "nps")).toBeNull();
    expect(parseScore("4 out of 5 happy", "csat")).toEqual({ score: 4, comment: "happy" });
    expect(parseScore("6", "csat")).toBeNull();
    expect(parseScore("0", "csat")).toBeNull();
    expect(parseScore("Hi, thanks for asking", "nps")).toBeNull();
    expect(parseScore("5 out of 10", "csat")).toBeNull();
  });

  it("works out NPS from the answers: promoters 9-10 minus detractors 0-6", () => {
    expect(npsOf([])).toBeNull();
    const row = (score: number) => ({ kind: "nps" as const, status: "answered" as const, score });
    expect(npsOf([row(10), row(9), row(8), row(3)])).toEqual({ nps: 25, answers: 4, promoters: 2, passives: 1, detractors: 1 });
    expect(npsOf([{ kind: "csat" as const, status: "answered" as const, score: 5 }])).toBeNull();
  });

  it("asks for NPS through an approval, never by itself, and not twice in 90 days", async () => {
    const booted = await bootCare();
    const made = await tool<Record<string, any>>(booted.harness, "request-feedback", { client: "company:acme", kind: "nps" });
    expect(made.to).toBe("Ada Lovelace <ada@acme.co.za>");
    const issue = (await booted.harness.ctx.issues.get(made.approvalIssueId, CO))!;
    expect(issue.title).toBe("Approve NPS request to Acme Plumbing");
    expect(issue.assigneeUserId).toBe(OWNER);
    expect(issue.description).toContain("on a scale of 0 to 10");
    // Signed with the company's own name (the harness company is "PiB"), not a fixed brand.
    expect(booted.store.care_approvals![0]!.payload.draft.text).toMatch(/recommend PiB to a friend[\s\S]*Thank you,\nPiB$/);
    expect(booted.store.outbox).toHaveLength(0);
    expect((await toolRaw(booted.harness, "request-feedback", { client: "company:acme", kind: "nps" })).error).toMatch(/already asked for NPS/);
    await decide(booted.harness, made.approvalIssueId, "done", "user");
    await answerSend(booted.harness, `crm:msg:${booted.store.care_approvals![0]!.id}`, "sent");
    expect(booted.store.client_feedback![0]).toMatchObject({ status: "requested", kind: "nps" });
    expect(booted.store.client_feedback![0]!.requested_at).toBeTruthy();
    expect((await toolRaw(booted.harness, "request-feedback", { client: "company:acme", kind: "nps" })).error).toMatch(/already asked for NPS/);
  });

  it("a request whose email could not be sent stops counting as asked, so it can be asked again (a stuck draft blocked the person for ever)", async () => {
    const booted = await bootCare();
    const made = await tool<Record<string, any>>(booted.harness, "request-feedback", { client: "company:acme", kind: "nps" });
    expect((await toolRaw(booted.harness, "request-feedback", { client: "company:acme", kind: "nps" })).error).toMatch(/already asked for NPS/);
    await decide(booted.harness, made.approvalIssueId, "done", "user");
    await answerSend(booted.harness, `crm:msg:${booted.store.care_approvals![0]!.id}`, "failed", { permanent: true, error: "No Gmail account is connected" });
    expect(booted.store.care_approvals![0]).toMatchObject({ status: "failed" });
    expect(booted.store.client_feedback![0]).toMatchObject({ status: "declined" });
    const again = await tool<Record<string, any>>(booted.harness, "request-feedback", { client: "company:acme", kind: "nps" });
    expect(again.feedbackId).not.toBe(made.feedbackId);
    expect(booted.store.client_feedback).toHaveLength(2);
  });

  it("a person who opted out is not asked, and CSAT is about one case", async () => {
    const booted = await bootCare();
    expect((await toolRaw(booted.harness, "request-feedback", { client: "company:acme", kind: "csat" })).error).toMatch(/about one case/);
    const made = await tool<Record<string, any>>(booted.harness, "open-support-case", { client: "company:acme", title: "Form" });
    await tool(booted.harness, "update-support-case", { caseId: made.caseId, status: "resolved", resolution: "Fixed the form handler." });
    const csat = await tool<Record<string, any>>(booted.harness, "request-feedback", { client: "company:acme", kind: "csat", caseId: made.caseId });
    expect((await booted.harness.ctx.issues.get(csat.approvalIssueId, CO))!.description).toContain('"Form"');
    expect((await toolRaw(booted.harness, "request-feedback", { client: "company:acme", kind: "csat", caseId: made.caseId })).error).toMatch(/already has a CSAT request/);
    booted.store.contacts!.find((row) => row.id === "ada")!.email_status = "unsubscribed";
    expect((await toolRaw(booted.harness, "request-feedback", { client: "company:acme", kind: "nps" })).error).toMatch(/opted out/);
  });

  it("a reply that starts with a number is recorded, and a low score opens an issue for the Account Manager", async () => {
    const booted = await bootCare();
    const made = await tool<Record<string, any>>(booted.harness, "request-feedback", { client: "company:acme", kind: "nps" });
    await decide(booted.harness, made.approvalIssueId, "done", "user");
    const approvalId = booted.store.care_approvals![0]!.id;
    await answerSend(booted.harness, `crm:msg:${approvalId}`, "sent");
    await receive(booted, supportMail({ messageId: "f-1", key: "mail:f-1", threadId: "gt-1", snippet: "3 - the site has been slow all month", subject: "Re: One quick question" }, { category: "reply" }));
    // The reply names our email by its context: that is how it is matched, not by guessing.
    expect(booted.store.client_feedback![0]).toMatchObject({ status: "requested" });
    await booted.harness.emit(`${MAILBOX}.mail.received` as `plugin.${string}`, { ...supportMail({ messageId: "f-2", key: "mail:f-2", threadId: "gt-1", snippet: "3 - the site has been slow all month", subject: "Re: One quick question" }, { category: "reply" }), replyTo: { plugin: "partnersinbiz.crm", kind: "client_message", id: approvalId, clientKind: "company", clientRef: "acme" } }, { companyId: CO });
    expect(booted.store.client_feedback![0]).toMatchObject({ status: "answered", score: 3, comment: "the site has been slow all month" });
    const [low] = await issuesWith(booted.harness, "crm:feedback-low:");
    expect(low).toMatchObject({ assigneeAgentId: "am-1", priority: "high" });
    expect(low!.title).toBe("Unhappy client: Acme Plumbing scored 3");
    expect(booted.store.activities!.some((a) => /NPS answer from the client: 3 of 10 \(email reply\)/.test(a.body))).toBe(true);
    expect(LOW_SCORE).toEqual({ nps: 6, csat: 2 });
  });

  it("a score the client gave another way is recorded by hand; a good one opens nothing", async () => {
    const booted = await bootCare();
    const good = await tool<Record<string, any>>(booted.harness, "record-feedback", { client: "company:acme", kind: "nps", score: 10, comment: "Told me on the phone." });
    expect(good).toMatchObject({ kind: "nps", score: 10, lowScoreIssue: false });
    expect(await issuesWith(booted.harness, "crm:feedback-low:")).toHaveLength(0);
    expect((await toolRaw(booted.harness, "record-feedback", { client: "company:acme", kind: "csat", score: 9 })).error).toMatch(/whole number from 1 to 5/);
    expect((await toolRaw(booted.harness, "record-feedback", { feedbackId: booted.store.client_feedback![0]!.id, score: 8 })).error).toMatch(/already recorded/);
    const bad = await tool<Record<string, any>>(booted.harness, "record-feedback", { client: "company:acme", kind: "csat", score: 2 });
    expect(bad.lowScoreIssue).toBe(true);
  });

  it("says what is asked, plainly", () => {
    expect(feedbackEmail("nps", "Ada Lovelace", null).text).toMatch(/Hi Ada,[\s\S]*0 to 10/);
    expect(feedbackEmail("nps", "Ada Lovelace", null, "Partners in Apps").text).toMatch(/recommend Partners in Apps to a friend[\s\S]*Thank you,\nPartners in Apps$/);
    expect(feedbackEmail("csat", "Ada Lovelace", "Form", "Dune Digital").text).toMatch(/Thank you,\nDune Digital$/);
    expect(feedbackEmail("nps", "Ada Lovelace", null).text).toMatch(/recommend us to a friend[\s\S]*Thank you,\nThe team$/);
    expect(feedbackEmail("nps", "Ada Lovelace", null, "Partners in Apps").text).not.toContain("Partners in Biz");
    expect(feedbackEmail("csat", "Ada Lovelace", "Form").text).toMatch(/"Form"[\s\S]*1 \(very unhappy\) to 5/);
  });
});

describe("move-support-case", () => {
  /** Acme (customer) has a case with an issue, a timeline and a feedback row; Hunt and Third are customers, Globex is not. */
  async function setup() {
    const store = careSeed();
    store.companies!.push(company("hunt", "Hunt and Gun", { lifecycle: "customer" }), company("third", "Third Co", { lifecycle: "customer" }));
    const booted = await bootCare({ store });
    const made = await tool<Record<string, any>>(booted.harness, "open-support-case", { client: "company:acme", title: "Seller login", severity: "high" });
    await tool(booted.harness, "update-support-case", { caseId: made.caseId, note: "Asked for a screenshot." });
    (booted.store.client_feedback ??= []).push({ id: "fb-1", company_id: CO, client_kind: "company", client_ref: "acme", kind: "csat", case_id: made.caseId, status: "draft" });
    const comments = vi.spyOn(booted.harness.ctx.issues, "createComment");
    return { booted, id: made.caseId as string, comments };
  }
  const row = (b: Booted) => b.store.support_cases![0]!;
  const trail = (b: Booted, id: string) => b.store.activities!.filter((a) => String(a.source_key ?? "").startsWith(`care:case:${id}:`));
  const moveEvents = (b: Booted, id: string) => trail(b, id).filter((a) => String(a.source_key).startsWith(`care:case:${id}:moved:`));
  const params = (id: string, extra: Record<string, unknown> = {}) => ({ caseId: id, client: "company:hunt", reason: "Mis-filed: a Hunt and Gun seller replied", ...extra });
  /** Runs `hook` once, just before the first statement whose SQL matches `pattern` (after `skip` earlier matches). */
  function before(b: Booted, pattern: RegExp, hook: () => void, skip = 0) {
    const db = b.harness.ctx.db;
    const real = db.execute.bind(db);
    let seen = 0;
    return vi.spyOn(db, "execute").mockImplementation(async (sql: string, p?: unknown[]) => {
      if (pattern.test(sql) && seen++ === skip) hook();
      return real(sql, p);
    });
  }

  it("re-files the case, its timeline and its feedback; everything else on the case stays", async () => {
    const { booted, id, comments } = await setup();
    const was = { ...row(booted) };
    const out = await tool<Record<string, any>>(booted.harness, "move-support-case", params(id));
    expect(out).toMatchObject({ moved: true, from: "company:acme", to: "company:hunt", toName: "Hunt and Gun" });
    const { client_ref, updated_at, ...rest } = row(booted);
    expect(client_ref).toBe("hunt");
    const { client_ref: _r, updated_at: _u, ...wasRest } = was;
    expect(rest).toEqual(wasRest);
    expect(trail(booted, id).filter((a) => a.record_id === "acme")).toEqual([]);
    expect(booted.store.client_feedback!.filter((f) => f.client_ref === "acme")).toEqual([]);
    expect(moveEvents(booted, id)).toHaveLength(1);
    expect(moveEvents(booted, id)[0]).toMatchObject({ record_id: "hunt", kind: "care_event" });
    expect((await tool<Record<string, any>>(booted.harness, "list-support-cases", { client: "company:acme", status: "all" })).count).toBe(0);
    expect((await tool<Record<string, any>>(booted.harness, "list-support-cases", { client: "company:hunt", status: "all" })).count).toBe(1);
    expect(comments).toHaveBeenCalledWith(was.issue_id, expect.stringMatching(/re-filed from Acme Plumbing to Hunt and Gun: Mis-filed/), CO);
  });

  it("moves an answered case and a resolved case as they are", async () => {
    const { booted, id } = await setup();
    await tool(booted.harness, "update-support-case", { caseId: id, firstResponse: true });
    await tool(booted.harness, "move-support-case", params(id));
    expect(row(booted)).toMatchObject({ client_ref: "hunt", status: "open" });
    expect(row(booted).first_response_at).toBeTruthy();
    await tool(booted.harness, "update-support-case", { caseId: id, status: "resolved", resolution: "Reset the seller's password." });
    await tool(booted.harness, "move-support-case", params(id, { client: "company:acme" }));
    expect(row(booted)).toMatchObject({ client_ref: "acme", status: "resolved" });
  });

  it("is a no-op when the case is already there", async () => {
    const { booted, id, comments } = await setup();
    const activities = booted.store.activities!.length;
    const out = await tool<Record<string, any>>(booted.harness, "move-support-case", params(id, { client: "company:acme" }));
    expect(out).toMatchObject({ moved: false });
    expect(out.note).toMatch(/Already filed under Acme Plumbing/);
    expect(booted.store.activities!.length).toBe(activities);
    expect(comments).not.toHaveBeenCalled();
  });

  it("refuses a target that is not a visible customer company, a source not visible, and an empty reason, writing nothing", async () => {
    const { booted, id } = await setup();
    const executes = vi.spyOn(booted.harness.ctx.db, "execute");
    const refuse = async (extra: Record<string, unknown>, error: RegExp, caseId = id) => expect((await toolRaw(booted.harness, "move-support-case", params(caseId, extra))).error).toMatch(error);
    await refuse({ client: "contact:ada" }, /must be company:<id>/);
    await refuse({ client: "company:nope" }, /not found or is not visible/);
    await refuse({ client: "company:globex" }, /Globex is not a customer/);
    await refuse({ client: "company:foreign" }, /not found or is not visible/);
    await refuse({ reason: "  " }, /reason is required/);
    booted.store.support_cases!.push({ ...row(booted), id: "c-foreign", client_ref: "foreign", source_key: null });
    await refuse({}, /not found or is not visible/, "c-foreign");
    expect(executes).not.toHaveBeenCalled();
    expect(row(booted).client_ref).toBe("acme");
  });

  it("a move that stops before the case row moved is finished by the same call", async () => {
    const { booted, id } = await setup();
    const spy = before(booted, /UPDATE \S+client_feedback/, () => { throw new Error("connection reset"); });
    expect((await toolRaw(booted.harness, "move-support-case", params(id))).error).toMatch(/still filed under Acme Plumbing.*Re-run the same call/);
    expect(row(booted).client_ref).toBe("acme");
    spy.mockRestore();
    await tool(booted.harness, "move-support-case", params(id));
    expect(row(booted).client_ref).toBe("hunt");
    expect(trail(booted, id).filter((a) => a.record_id === "acme")).toEqual([]);
    expect(booted.store.client_feedback!.every((f) => f.client_ref === "hunt")).toBe(true);
    expect(moveEvents(booted, id)).toHaveLength(1);
  });

  it("a move that stops after the case row moved is repaired by the same call, event included", async () => {
    const { booted, id } = await setup();
    // The sweep after the case row moved fails, with a reopen row just written under the old client, and the move event is lost.
    const spy = before(booted, /UPDATE \S+activities/, () => {
      booted.store.activities!.push({ id: "late", company_id: CO, record_type: "company", record_id: "acme", kind: "care_event", body: "late", source_key: `care:case:${id}:reopened:m-2` });
      throw new Error("connection reset");
    }, 1);
    expect((await toolRaw(booted.harness, "move-support-case", params(id))).error).toMatch(/moved to Hunt and Gun.*Re-run the same call/);
    expect(row(booted).client_ref).toBe("hunt");
    spy.mockRestore();
    booted.store.activities = booted.store.activities!.filter((a) => !String(a.source_key).includes(":moved:"));
    const out = await tool<Record<string, any>>(booted.harness, "move-support-case", params(id));
    expect(out.note).toMatch(/Finished the trail/);
    expect(trail(booted, id).filter((a) => a.record_id === "acme")).toEqual([]);
    expect(moveEvents(booted, id)).toHaveLength(1);
  });

  it("sweeps a reopen row the mail path wrote under the old client while the move ran", async () => {
    const { booted, id } = await setup();
    before(booted, /UPDATE \S+support_cases/, () => {
      booted.store.activities!.push({ id: "reopen", company_id: CO, record_type: "company", record_id: "acme", kind: "care_event", body: "reopened", source_key: `care:case:${id}:reopened:m-9` });
    });
    await tool(booted.harness, "move-support-case", params(id));
    expect(booted.store.activities!.find((a) => a.id === "reopen")).toMatchObject({ record_id: "hunt" });
  });

  it("loses to a concurrent move to a third client and writes nothing further", async () => {
    const { booted, id, comments } = await setup();
    let after = -1;
    const spy = before(booted, /UPDATE \S+support_cases/, () => {
      row(booted).client_ref = "third";
      after = (booted.harness.ctx.db.execute as any).mock.calls.length;
    });
    expect((await toolRaw(booted.harness, "move-support-case", params(id))).error).toMatch(/now filed under company:third.*another change moved it/);
    expect(row(booted).client_ref).toBe("third");
    expect(spy.mock.calls.length).toBe(after);
    expect(moveEvents(booted, id)).toEqual([]);
    expect(comments).not.toHaveBeenCalled();
  });

  it("a failed issue comment is a warning and the move stands; a case with no issue gets no comment", async () => {
    const { booted, id, comments } = await setup();
    comments.mockRejectedValueOnce(new Error("issue locked"));
    const out = await tool<Record<string, any>>(booted.harness, "move-support-case", params(id));
    expect(out.warning).toMatch(/comment on its issue failed \(issue locked\)/);
    expect(row(booted).client_ref).toBe("hunt");
    comments.mockClear();
    row(booted).issue_id = null;
    await tool(booted.harness, "move-support-case", params(id, { client: "company:acme" }));
    expect(row(booted).client_ref).toBe("acme");
    expect(comments).not.toHaveBeenCalled();
  });
});
