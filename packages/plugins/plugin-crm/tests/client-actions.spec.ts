import { describe, expect, it, vi } from "vitest";
import { actionEmail, actionEmailProblem, actionResolved, clientActionsHealth, clientLinkProblem, DEFAULT_REMIND_AFTER_DAYS, MAX_REMINDERS, runActionReminders } from "../src/client-actions.js";
import { careWaiting } from "../src/care-jobs.js";
import { getApproval } from "../src/care-store.js";
import { answerSend, bootCare, careSeed, CO, contact, DAY, decide, issuesWith, MAILBOX, OWNER, sentMail, tool, toolRaw, type Booted } from "./helpers/care.js";

const LINK = "https://preview.partnersinbiz.online/p/acme/abc123";

async function ask(booted: Booted, extra: Record<string, unknown> = {}) {
  return tool<Record<string, any>>(booted.harness, "create-client-action", { client: "company:acme", kind: "sign_off", title: "Approve the new homepage", link: LINK, instructions: "Click Approve, or Request changes.", dueInDays: 7, ...extra });
}

/** Asks, approves as the owner and lets the Mailbox answer: the action is now waiting on the client. */
async function asked(booted: Booted, extra: Record<string, unknown> = {}) {
  const made = await ask(booted, extra);
  await decide(booted.harness, made.approvalIssueId, "done", "user");
  await answerSend(booted.harness, `crm:msg:${booted.store.care_approvals![0]!.id}`, "sent");
  return made;
}

describe("a link a client can open", () => {
  it("must be https, carry no login and not be a page on our own board", () => {
    expect(clientLinkProblem(LINK)).toBeNull();
    expect(clientLinkProblem("http://example.com/x")).toMatch(/https/);
    expect(clientLinkProblem("not a link")).toMatch(/web address/);
    expect(clientLinkProblem("https://user:pw@example.com/x")).toMatch(/login/);
    expect(clientLinkProblem("https://paperclip.partnersinbiz.online/PIB/issues/PIB-1")).toMatch(/Paperclip board/);
    expect(clientLinkProblem("https://board.example.org/x", ["https://board.example.org"])).toMatch(/Paperclip board/);
    expect(clientLinkProblem(`https://example.com/${"a".repeat(600)}`)).toMatch(/too long/);
  });
});

describe("the email a client request becomes", () => {
  it("names what to do, the exact link and the date; a reminder says it is one", () => {
    const base = { kind: "sign_off" as const, title: "the new homepage", instructions: "Click Approve.", linkUrl: LINK, linkLabel: "See the preview", dueAt: "2026-10-10T08:00:00.000Z", recipientName: "Ada Lovelace", message: null };
    const first = actionEmail({ ...base, reminder: 0 });
    expect(first.subject).toBe("Action needed: the new homepage");
    expect(first.text).toContain("Hi Ada,");
    expect(first.text.endsWith("Kind regards,\nThe team")).toBe(true);
    expect(actionEmail({ ...base, reminder: 0, brand: "Partners in Apps" }).text.endsWith("Kind regards,\nPartners in Apps")).toBe(true);
    expect(first.text).toContain(`See the preview: ${LINK}`);
    expect(first.text).toContain("by 10 Oct 2026");
    expect(first.text).toContain("Click Approve.");
    const chase = actionEmail({ ...base, reminder: 1 });
    expect(chase.subject).toBe("Reminder: the new homepage");
    expect(chase.text).toMatch(/friendly reminder/);
    expect(actionEmail({ ...base, kind: "info", reminder: 0 }).subject).toBe("Information needed: the new homepage");
    expect(actionEmail({ ...base, message: "Ada, one thing before we launch.", reminder: 0 }).text).toContain("Ada, one thing before we launch.");
  });
});

describe("asking a client: nothing is sent until a person approves", () => {
  it("the email is signed with the sending company's own name", async () => {
    const booted = await bootCare();
    booted.harness.seed({ companies: [{ id: CO, issuePrefix: "PIB", name: "Partners in Apps" } as never] });
    await ask(booted);
    expect(booted.store.care_approvals![0]!.payload.draft.text).toMatch(/Kind regards,\nPartners in Apps$/);
    expect(booted.store.care_approvals![0]!.payload.draft.text).not.toContain("Partners in Biz");
  });

  it("records the request and opens an approval that shows the exact email, for the owner", async () => {
    const booted = await bootCare();
    const { harness, store, emit } = booted;
    const made = await ask(booted);
    expect(made).toMatchObject({ status: "draft", to: "Ada Lovelace <ada@acme.co.za>" });
    expect(store.client_actions).toHaveLength(1);
    expect(store.client_actions![0]).toMatchObject({ status: "draft", kind: "sign_off", to_email: "ada@acme.co.za", link_url: LINK, remind_after_days: DEFAULT_REMIND_AFTER_DAYS });
    const issue = (await harness.ctx.issues.get(made.approvalIssueId, CO))!;
    expect(issue).toMatchObject({ title: "Approve email to Acme Plumbing: Approve the new homepage", assigneeUserId: OWNER, originId: `crm:approval:${store.care_approvals![0]!.id}` });
    expect(issue.description).toContain(`**To:** Ada Lovelace <ada@acme.co.za>`);
    expect(issue.description).toContain("**Subject:** Action needed: Approve the new homepage");
    expect(issue.description).toContain(LINK);
    expect(issue.description).toContain("marking this issue **done**");
    expect(sentMail(emit)).toHaveLength(0);
    expect(store.outbox).toHaveLength(0);
    // The client's timeline says it is waiting for approval.
    expect(store.activities!.some((a) => a.kind === "care_event" && /Waiting for approval/.test(a.body))).toBe(true);
    // The system's own bookkeeping is not work a person did: no follow-up check counts it.
    expect(store.activities!.some((a) => a.kind === "note" || a.kind === "email_sent")).toBe(false);
  });

  it("asking the same thing twice is one request: no second email is drafted, until the first is finished", async () => {
    const booted = await bootCare();
    const first = await ask(booted);
    const second = await ask(booted, { title: "approve the NEW homepage" });
    expect(second).toMatchObject({ created: false, actionId: first.actionId, status: "draft", approvalIssueId: first.approvalIssueId });
    expect(second.note).toMatch(/already has an open request/);
    expect(booted.store.client_actions).toHaveLength(1);
    expect(booted.store.care_approvals).toHaveLength(1);
    await tool(booted.harness, "update-client-action", { actionId: first.actionId, status: "cancelled" });
    const third = await ask(booted);
    expect(third).toMatchObject({ created: true });
    expect(booted.store.client_actions).toHaveLength(2);
    // A different title is a different request.
    expect((await ask(booted, { title: "Approve the pricing page" })).created).toBe(true);
  });

  it("goes to the Reviewer first when the company reviews outward work, with what to check", async () => {
    const booted = await bootCare({ reviewer: true });
    const made = await ask(booted);
    const issue = (await booted.harness.ctx.issues.get(made.approvalIssueId, CO))!;
    expect(issue.assigneeAgentId).toBe("rev-1");
    expect(issue.description).toMatch(/The link opens the right page/);
  });

  it("an agent that closes the approval does not send it: the issue is reopened for the person", async () => {
    const booted = await bootCare();
    const made = await ask(booted);
    const reopened = await decide(booted.harness, made.approvalIssueId, "done", "agent");
    expect(reopened.status).toBe("todo");
    expect(booted.store.care_approvals![0]!.status).toBe("open");
    expect(booted.store.outbox).toHaveLength(0);
  });

  it("a person's done queues the email in the Mailbox, personal, not marketing; the Mailbox's answer starts the wait", async () => {
    const booted = await bootCare();
    const { harness, store, emit } = booted;
    const made = await ask(booted);
    await decide(harness, made.approvalIssueId, "done", "user");
    const [mail] = sentMail(emit);
    expect(mail).toMatchObject({
      key: `crm:msg:${store.care_approvals![0]!.id}`,
      to: [{ email: "ada@acme.co.za", name: "Ada Lovelace" }],
      subject: "Action needed: Approve the new homepage",
      marketing: false,
      context: { plugin: "partnersinbiz.crm", kind: "client_message", clientKind: "company", clientRef: "acme" },
    });
    expect(mail.text).toContain(LINK);
    expect(store.care_approvals![0]).toMatchObject({ status: "approved", decided_by: `user:${OWNER}` });
    expect(store.client_actions![0]!.status).toBe("draft");

    await answerSend(harness, mail.key, "sent");
    expect(store.care_approvals![0]!.status).toBe("sent");
    expect(store.client_actions![0]).toMatchObject({ status: "waiting" });
    expect(store.client_actions![0]!.next_reminder_at).toBeTruthy();
    expect(Date.parse(store.client_actions![0]!.next_reminder_at) - Date.now()).toBeGreaterThan(2.9 * DAY);
    expect(store.activities!.some((a) => a.kind === "care_event" && a.meta?.what === "email_sent" && /Request sent to the client: Approve the new homepage/.test(a.body))).toBe(true);
    // The same answer twice changes nothing (events are at-most-once, so the Mailbox may repeat it).
    await answerSend(harness, mail.key, "sent");
    expect(store.activities!.filter((a) => /Request sent/.test(a.body))).toHaveLength(1);
  });

  it("cancelling refuses it: nothing is sent and the request is cancelled", async () => {
    const booted = await bootCare();
    const made = await ask(booted);
    await decide(booted.harness, made.approvalIssueId, "cancelled", "user");
    expect(booted.store.outbox).toHaveLength(0);
    expect(booted.store.care_approvals![0]!.status).toBe("refused");
    expect(booted.store.client_actions![0]).toMatchObject({ status: "cancelled" });
  });

  it("refuses a link the client cannot open, a stranger's address and a contact of another client", async () => {
    const booted = await bootCare();
    const refused = async (extra: Record<string, unknown>) => (await toolRaw(booted.harness, "create-client-action", { client: "company:acme", kind: "grant", title: "Give us access", ...extra })).error ?? "";
    expect(await refused({ link: "http://acme.co.za/login" })).toMatch(/https/);
    expect(await refused({ link: "https://paperclip.partnersinbiz.online/PIB/issues/x" })).toMatch(/Paperclip board/);
    expect(await refused({ toEmail: "stranger@evil.test" })).toMatch(/not on any of this client's people/);
    expect(await refused({ contactId: "contact:grace" })).toMatch(/not one of this client's people/);
    expect(await refused({ kind: "sign" })).toMatch(/kind must be one of/);
    expect(await refused({ remindAfterDays: 30 })).toMatch(/remindAfterDays/);
    expect(await refused({ dueInDays: 500 })).toMatch(/dueInDays/);
    expect(booted.store.client_actions ?? []).toHaveLength(0);
    expect(booted.store.care_approvals ?? []).toHaveLength(0);
  });

  it("a client with no contact that has an email gets nothing drafted", async () => {
    const store = careSeed({ contact_companies: [] });
    const booted = await bootCare({ store });
    expect((await toolRaw(booted.harness, "create-client-action", { client: "company:acme", kind: "info", title: "Send your logo" })).error).toMatch(/no contact with an email address/);
  });

  it("an address that bounced after the draft is not emailed: the approval fails, says why, and the Account Manager gets an issue", async () => {
    const booted = await bootCare();
    const made = await ask(booted);
    booted.store.contacts!.find((row) => row.id === "ada")!.email_status = "bounced";
    await decide(booted.harness, made.approvalIssueId, "done", "user");
    expect(booted.store.outbox).toHaveLength(0);
    expect(booted.store.care_approvals![0]).toMatchObject({ status: "failed" });
    expect(booted.store.care_approvals![0]!.error).toMatch(/bounced/);
    const [failed] = await issuesWith(booted.harness, "crm:msg-failed:");
    expect(failed).toMatchObject({ assigneeAgentId: "am-1" });
    expect(failed!.title).toMatch(/Email to a client not sent/);
    // The request never went out, so it is cancelled: the issue says "ask again", and that has to work (see "does not loop" below).
    expect(booted.store.client_actions![0]!.status).toBe("cancelled");
  });

  it("an email the Mailbox gave up on fails the approval and hands it to the Account Manager", async () => {
    const booted = await bootCare();
    const made = await ask(booted);
    await decide(booted.harness, made.approvalIssueId, "done", "user");
    await answerSend(booted.harness, `crm:msg:${booted.store.care_approvals![0]!.id}`, "failed", { permanent: true, error: "No Gmail account is connected" });
    expect(booted.store.care_approvals![0]).toMatchObject({ status: "failed", error: "No Gmail account is connected" });
    expect(await issuesWith(booted.harness, "crm:msg-failed:")).toHaveLength(1);
    expect(booted.store.client_actions![0]!.status).toBe("cancelled");
  });

  it("a canary client's request is a dry run: the action waits, nothing is queued", async () => {
    const booted = await bootCare();
    const canary = await tool<Record<string, any>>(booted.harness, "create-canary-client", {});
    const made = await tool<Record<string, any>>(booted.harness, "create-client-action", { client: canary.client, kind: "info", title: "Send the canary logo" });
    await decide(booted.harness, made.approvalIssueId, "done", "user");
    expect(booted.store.outbox).toHaveLength(0);
    expect(booted.store.care_approvals![0]!.status).toBe("dry_run");
    expect(booted.store.client_actions![0]).toMatchObject({ status: "waiting" });
    expect(booted.store.activities!.some((a) => /canary dry run/.test(a.body))).toBe(true);
  });
});

describe("waiting on the client", () => {
  it("drafts a reminder after the interval, for approval, once; approving it sends it and counts it", async () => {
    const booted = await bootCare();
    const { harness, store, emit } = booted;
    await asked(booted);
    const action = store.client_actions![0]!;
    // Too early: nothing.
    expect(await runActionReminders(harness.ctx, CO, new Date(Date.now() + 2 * DAY))).toEqual({ drafted: 0, escalated: 0 });
    const later = new Date(Date.now() + 4 * DAY);
    expect(await runActionReminders(harness.ctx, CO, later)).toEqual({ drafted: 1, escalated: 0 });
    expect(await runActionReminders(harness.ctx, CO, later)).toEqual({ drafted: 0, escalated: 0 });
    const reminder = store.care_approvals!.find((row) => row.kind === "client_reminder")!;
    expect(reminder.payload.draft.subject).toBe("Reminder: Approve the new homepage");
    expect(reminder.payload.draft.text).toContain(LINK);
    // Signed with the company's own name (the harness company is "PiB"), like the first email.
    expect(reminder.payload.draft.text).toMatch(/Kind regards,\nPiB$/);
    const issue = (await harness.ctx.issues.get(reminder.issue_id, CO))!;
    expect(issue.title).toBe("Approve reminder to Acme Plumbing: Approve the new homepage");
    expect(issue.description).toMatch(/reminder 1 of 2/);
    expect(sentMail(emit)).toHaveLength(1);

    await decide(harness, reminder.issue_id, "done", "user");
    await answerSend(harness, `crm:msg:${reminder.id}`, "sent");
    expect(sentMail(emit)).toHaveLength(2);
    expect(store.client_actions![0]).toMatchObject({ reminders: 1, status: "waiting" });
    expect(Date.parse(store.client_actions![0]!.next_reminder_at)).toBeGreaterThan(Date.now() + 2.9 * DAY);
    expect(action.id).toBe(store.client_actions![0]!.id);
  });

  it("after two reminders the Account Manager gets an issue to reach the client another way, once, and closing it needs the outcome recorded", async () => {
    const booted = await bootCare();
    const { harness, store } = booted;
    await asked(booted);
    let clock = Date.now();
    for (let round = 1; round <= MAX_REMINDERS; round += 1) {
      clock += 4 * DAY;
      expect((await runActionReminders(harness.ctx, CO, new Date(clock))).drafted).toBe(1);
      const reminder = store.care_approvals!.filter((row) => row.kind === "client_reminder")[round - 1]!;
      await decide(harness, reminder.issue_id, "done", "user");
      await answerSend(harness, `crm:msg:${reminder.id}`, "sent");
    }
    expect(store.client_actions![0]!.reminders).toBe(MAX_REMINDERS);
    clock += 4 * DAY;
    expect(await runActionReminders(harness.ctx, CO, new Date(clock))).toEqual({ drafted: 0, escalated: 1 });
    expect(await runActionReminders(harness.ctx, CO, new Date(clock + DAY))).toEqual({ drafted: 0, escalated: 0 });
    const [stale] = await issuesWith(harness, "crm:client-action-stale:");
    expect(stale).toMatchObject({ assigneeAgentId: "am-1" });
    expect(stale!.title).toMatch(/Acme Plumbing has not answered: Approve the new homepage/);
    expect(stale!.description).toMatch(/after 2 reminders/);

    const open = await actionResolved(harness.ctx, CO, stale!.originId!);
    expect(open).toMatchObject({ done: false });
    await tool(harness, "update-client-action", { actionId: store.client_actions![0]!.id, status: "done", answer: "Ada approved by phone." });
    expect(await actionResolved(harness.ctx, CO, stale!.originId!)).toEqual({ done: true });
    const health = await clientActionsHealth(harness.ctx, CO);
    expect(health.status).toBe("ok");
  });

  it("refusing a reminder waits another interval without chasing", async () => {
    const booted = await bootCare();
    const { harness, store } = booted;
    await asked(booted);
    await runActionReminders(harness.ctx, CO, new Date(Date.now() + 4 * DAY));
    const reminder = store.care_approvals!.find((row) => row.kind === "client_reminder")!;
    await decide(harness, reminder.issue_id, "cancelled", "user");
    expect(store.client_actions![0]).toMatchObject({ reminders: 0, status: "waiting" });
    expect(Date.parse(store.client_actions![0]!.next_reminder_at)).toBeGreaterThan(Date.now() + 2.9 * DAY);
    // Not due again until the new interval has passed; the refused attempt does not count as a reminder.
    expect((await runActionReminders(harness.ctx, CO, new Date(Date.now() + 2 * DAY))).drafted).toBe(0);
    expect((await runActionReminders(harness.ctx, CO, new Date(Date.now() + 3.5 * DAY))).drafted).toBe(1);
    expect(store.care_approvals!.filter((row) => row.kind === "client_reminder").map((row) => row.status)).toEqual(["refused", "open"]);
  });

  it("a reply from the client stops the reminders and puts the answer in front of someone", async () => {
    const booted = await bootCare();
    const { harness, store } = booted;
    await asked(booted);
    const approval = store.care_approvals![0]!;
    await harness.emit(`${MAILBOX}.mail.received` as `plugin.${string}`, {
      key: "mail:c-1", accountAddress: "peet@partnersinbiz.online", messageId: "c-1", threadId: "gt-1", from: { email: "ada@acme.co.za", name: "Ada" }, to: [{ email: "peet@partnersinbiz.online" }],
      subject: "Re: Action needed", snippet: "Looks good, go ahead.", receivedAt: new Date().toISOString(), attachments: [],
      triage: { category: "reply", urgency: null, needsReply: null, phishing: null, confidence: null },
      replyTo: { plugin: "partnersinbiz.crm", kind: "client_message", id: approval.id, clientKind: "company", clientRef: "acme" },
    }, { companyId: CO });
    expect(store.client_actions![0]).toMatchObject({ status: "replied", next_reminder_at: null });
    expect((await runActionReminders(harness.ctx, CO, new Date(Date.now() + 10 * DAY))).drafted).toBe(0);
    const waiting = await careWaiting(harness.ctx, CO);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.title).toBe("Read the client's answer: Approve the new homepage");
    expect((await tool<Record<string, any>>(harness, "list-client-actions", {})).waitingOnClient).toBe(1);

    const done = await tool<Record<string, any>>(harness, "update-client-action", { actionId: store.client_actions![0]!.id, status: "done", answer: "Approved by email." });
    expect(done).toMatchObject({ status: "done" });
    expect(store.client_actions![0]).toMatchObject({ status: "done", answer: "Approved by email." });
    expect(store.activities!.some((a) => /The client did what we asked: Approve the new homepage\. Approved by email\./.test(a.body))).toBe(true);
  });

  it("a request still waiting for approval can be cancelled (its approval is closed) but not marked done", async () => {
    const booted = await bootCare();
    const made = await ask(booted);
    const actionId = booted.store.client_actions![0]!.id;
    expect((await toolRaw(booted.harness, "update-client-action", { actionId, status: "done" })).error).toMatch(/has not been asked yet/);
    await tool(booted.harness, "update-client-action", { actionId, status: "cancelled" });
    expect(booted.store.client_actions![0]!.status).toBe("cancelled");
    expect(booted.store.care_approvals![0]!.status).toBe("refused");
    expect((await booted.harness.ctx.issues.get(made.approvalIssueId, CO))!.status).toBe("cancelled");
    // The plugin's own cancel is not mistaken for an agent closing the approval.
    expect(booted.store.outbox).toHaveLength(0);
    expect((await toolRaw(booted.harness, "update-client-action", { actionId, status: "done" })).error).toMatch(/already cancelled/);
  });

  it("is listed, and a late or unanswered request shows as a warning, never a failure", async () => {
    const booted = await bootCare();
    await asked(booted);
    const listed = await tool<Record<string, any>>(booted.harness, "list-client-actions", { client: "company:acme" });
    expect(listed).toMatchObject({ count: 1, waitingOnClient: 1 });
    expect(listed.actions[0]).toMatchObject({ title: "Approve the new homepage", status: "waiting", link: LINK, waitingDays: 0, reminders: 0 });
    expect((await clientActionsHealth(booted.harness.ctx, CO)).status).toBe("ok");
    booted.store.client_actions![0]!.due_at = new Date(Date.now() - DAY).toISOString();
    const late = await clientActionsHealth(booted.harness.ctx, CO);
    expect(late).toMatchObject({ key: "client-actions", status: "warn" });
    expect(late.detail).toMatch(/Approve the new homepage/);
  });

  it("a sole trader is a client too: the email goes to them", async () => {
    const store = careSeed();
    store.contacts = [...store.contacts!, contact("pat", "Pat Plumber", { emails: ["pat@solo.test"], lifecycle: "customer" })];
    const booted = await bootCare({ store });
    const made = await tool<Record<string, any>>(booted.harness, "create-client-action", { client: "contact:pat", kind: "grant", title: "Give us access to Search Console" });
    expect(made.to).toBe("Pat Plumber <pat@solo.test>");
  });
});

/** A request the client was asked, with a reminder drafted and waiting for a person. */
async function withOpenReminder(booted: Booted) {
  await asked(booted);
  await runActionReminders(booted.harness.ctx, CO, new Date(Date.now() + 4 * DAY));
  const reminder = booted.store.care_approvals!.find((row) => row.kind === "client_reminder")!;
  expect(reminder.status).toBe("open");
  return reminder;
}

function clientReply(booted: Booted, approvalId: string) {
  return booted.harness.emit(`${MAILBOX}.mail.received` as `plugin.${string}`, {
    key: `mail:reply-${approvalId}`, accountAddress: "peet@partnersinbiz.online", messageId: `r-${approvalId}`, threadId: "gt-1", from: { email: "ada@acme.co.za", name: "Ada" }, to: [{ email: "peet@partnersinbiz.online" }],
    subject: "Re: Action needed", snippet: "Looks good, go ahead.", receivedAt: new Date().toISOString(), attachments: [],
    triage: { category: "reply", urgency: null, needsReply: null, phishing: null, confidence: null },
    replyTo: { plugin: "partnersinbiz.crm", kind: "client_message", id: approvalId, clientKind: "company", clientRef: "acme" },
  }, { companyId: CO });
}

describe("a reminder that is no longer wanted is never sent", () => {
  it("the client replies while a reminder waits for approval: the reminder is withdrawn, and approving it anyway sends nothing", async () => {
    const booted = await bootCare();
    const { harness, store, emit } = booted;
    const comments = vi.spyOn(harness.ctx.issues, "createComment");
    const reminder = await withOpenReminder(booted);
    const request = store.care_approvals!.find((row) => row.kind === "client_action")!;
    expect(sentMail(emit)).toHaveLength(1);

    await clientReply(booted, request.id);
    expect(store.client_actions![0]).toMatchObject({ status: "replied", next_reminder_at: null });
    expect(store.care_approvals!.find((row) => row.id === reminder.id)).toMatchObject({ status: "refused", decided_by: "system:client-replied" });
    const issue = (await harness.ctx.issues.get(reminder.issue_id, CO))!;
    expect(issue.status).toBe("cancelled");
    expect(comments).toHaveBeenCalledWith(reminder.issue_id, expect.stringMatching(/Withdrawn, nothing was sent: The client has already replied/), CO);

    // A person who still marks the cancelled approval done sends nothing.
    await decide(harness, reminder.issue_id, "done", "user");
    expect(sentMail(emit)).toHaveLength(1);
    expect(store.outbox).toHaveLength(1);
    expect(store.care_approvals!.find((row) => row.id === reminder.id)!.status).toBe("refused");
  });

  it("the reviewer's reproduction: the request is marked done while a reminder waits, then a person approves the reminder: no second mail, approval closed", async () => {
    const booted = await bootCare();
    const { harness, store, emit } = booted;
    const reminder = await withOpenReminder(booted);
    await tool(harness, "update-client-action", { actionId: store.client_actions![0]!.id, status: "done", answer: "Ada approved by phone." });
    expect(store.care_approvals!.find((row) => row.id === reminder.id)).toMatchObject({ status: "refused", decided_by: "system:action-done" });
    expect((await harness.ctx.issues.get(reminder.issue_id, CO))!.status).toBe("cancelled");
    await decide(harness, reminder.issue_id, "done", "user");
    expect(sentMail(emit)).toHaveLength(1);
    expect(store.outbox).toHaveLength(1);
    expect(store.care_approvals!.filter((row) => row.status === "open")).toHaveLength(0);
  });

  it("cancelling the request while a reminder waits withdraws the reminder too", async () => {
    const booted = await bootCare();
    const { harness, store, emit } = booted;
    const reminder = await withOpenReminder(booted);
    await tool(harness, "update-client-action", { actionId: store.client_actions![0]!.id, status: "cancelled" });
    expect(store.care_approvals!.find((row) => row.id === reminder.id)).toMatchObject({ status: "refused", decided_by: "system:action-cancelled" });
    await decide(harness, reminder.issue_id, "done", "user");
    expect(sentMail(emit)).toHaveLength(1);
  });

  it("a reminder for a request that is still waiting is not touched by an unrelated request being finished", async () => {
    const booted = await bootCare();
    const { harness, store, emit } = booted;
    const reminder = await withOpenReminder(booted);
    const other = await ask(booted, { title: "Send your logo", kind: "info", link: undefined });
    await tool(harness, "update-client-action", { actionId: other.actionId, status: "cancelled" });
    expect(store.care_approvals!.find((row) => row.subject_id === other.actionId)!.status).toBe("refused");
    expect(store.care_approvals!.find((row) => row.id === reminder.id)!.status).toBe("open");
    await decide(harness, reminder.issue_id, "done", "user");
    expect(sentMail(emit)).toHaveLength(2);
    expect(store.care_approvals!.find((row) => row.id === reminder.id)!.status).toBe("approved");
  });

  it("safety net for a race: the request moved on without the approval being closed, so a person's done still sends nothing and says why", async () => {
    for (const [status, why] of [["done", /already did what this email asks/], ["replied", /already replied/], ["cancelled", /was cancelled/]] as const) {
      const booted = await bootCare();
      const { harness, store, emit } = booted;
      const comments = vi.spyOn(harness.ctx.issues, "createComment");
      const reminder = await withOpenReminder(booted);
      // The request changes behind the plugin's back (a race: the person's click was already on its way).
      store.client_actions![0]!.status = status;
      await decide(harness, reminder.issue_id, "done", "user");
      expect(sentMail(emit), status).toHaveLength(1);
      const row = store.care_approvals!.find((r) => r.id === reminder.id)!;
      expect(row, status).toMatchObject({ status: "refused", decided_by: "system:action-closed" });
      expect(row.error, status).toMatch(why);
      expect(comments, status).toHaveBeenCalledWith(reminder.issue_id, expect.stringMatching(/Not sent: .*Nothing went to the client/), CO);
    }
  });

  it("safety net: a first email whose request was cancelled meanwhile is not sent either, and a missing request stops it", async () => {
    const booted = await bootCare();
    const { harness, store, emit } = booted;
    const made = await ask(booted);
    store.client_actions![0]!.status = "cancelled";
    await decide(harness, made.approvalIssueId, "done", "user");
    expect(sentMail(emit)).toHaveLength(0);
    expect(store.care_approvals![0]).toMatchObject({ status: "refused", decided_by: "system:action-closed" });
    expect(store.care_approvals![0]!.error).toMatch(/was cancelled/);

    const approval = (await getApproval(harness.ctx, CO, store.care_approvals![0]!.id))!;
    expect(await actionEmailProblem(harness.ctx, { ...approval, subjectId: "gone" })).toMatch(/no longer exists/);
    expect(await actionEmailProblem(harness.ctx, { ...approval, kind: "client_report" })).toBeNull();
  });

  it("refusing a reminder after the request moved on (a race) does not start a new reminder clock on a request that is no longer waiting", async () => {
    const booted = await bootCare();
    const { harness, store } = booted;
    const reminder = await withOpenReminder(booted);
    store.client_actions![0]!.status = "replied";
    store.client_actions![0]!.next_reminder_at = null;
    await decide(harness, reminder.issue_id, "cancelled", "user");
    expect(store.care_approvals!.find((row) => row.id === reminder.id)!.status).toBe("refused");
    expect(store.client_actions![0]).toMatchObject({ status: "replied", next_reminder_at: null });
  });

  it("an email whose request is in the right state is sent as before", async () => {
    const booted = await bootCare();
    const { harness, emit } = booted;
    const made = await ask(booted);
    expect(await actionEmailProblem(harness.ctx, (await getApproval(harness.ctx, CO, booted.store.care_approvals![0]!.id))!)).toBeNull();
    await decide(harness, made.approvalIssueId, "done", "user");
    expect(sentMail(emit)).toHaveLength(1);
  });
});

describe("a reminder that cannot be sent does not loop", () => {
  it("a failed reminder waits the interval again and counts toward the limit, so two failures end in an issue, not a third draft", async () => {
    const booted = await bootCare();
    const { harness, store } = booted;
    await asked(booted);
    for (let round = 1; round <= MAX_REMINDERS; round += 1) {
      // The hooks stamp the next reminder from the real clock, so "later" is measured from the real clock here too.
      expect((await runActionReminders(harness.ctx, CO, new Date(Date.now() + 4 * DAY))).drafted).toBe(1);
      const reminder = store.care_approvals!.filter((row) => row.kind === "client_reminder")[round - 1]!;
      // It was drafted because it was due, so the stamp is in the past while the approval waits. A failure must not leave it there.
      store.client_actions![0]!.next_reminder_at = new Date(Date.now() - DAY).toISOString();
      await decide(harness, reminder.issue_id, "done", "user");
      await answerSend(harness, `crm:msg:${reminder.id}`, "failed", { permanent: true, error: "No Gmail account is connected" });
      expect(store.care_approvals!.find((row) => row.id === reminder.id)!.status).toBe("failed");
      // Not drafted again an hour later: the next one is a full interval away.
      expect((await runActionReminders(harness.ctx, CO, new Date(Date.now() + 3_600_000))).drafted).toBe(0);
    }
    expect(store.client_actions![0]).toMatchObject({ status: "waiting", reminders: 0 });
    expect(await runActionReminders(harness.ctx, CO, new Date(Date.now() + 4 * DAY))).toEqual({ drafted: 0, escalated: 1 });
    expect(store.care_approvals!.filter((row) => row.kind === "client_reminder")).toHaveLength(MAX_REMINDERS);
    expect(await issuesWith(harness, "crm:client-action-stale:")).toHaveLength(1);
  });

  it("a request whose email failed is cancelled, so asking again with the same title drafts a new email (it is not 'already open' for ever)", async () => {
    const booted = await bootCare();
    const { harness, store } = booted;
    const made = await ask(booted);
    await decide(harness, made.approvalIssueId, "done", "user");
    await answerSend(harness, `crm:msg:${store.care_approvals![0]!.id}`, "failed", { permanent: true, error: "No Gmail account is connected" });
    expect(store.care_approvals![0]!.status).toBe("failed");
    expect(store.client_actions![0]).toMatchObject({ status: "cancelled" });
    expect(store.client_actions![0]!.answer).toMatch(/could not be sent/);
    const [failed] = await issuesWith(harness, "crm:msg-failed:");
    expect(failed!.description).toMatch(/ask again/);
    const again = await ask(booted);
    expect(again).toMatchObject({ created: true });
    expect(store.client_actions).toHaveLength(2);
    expect(store.care_approvals).toHaveLength(2);
  });

  it("an address that bounced after the draft cancels the request too, so it can be asked again after fixing the address", async () => {
    const booted = await bootCare();
    const made = await ask(booted);
    booted.store.contacts!.find((row) => row.id === "ada")!.email_status = "bounced";
    await decide(booted.harness, made.approvalIssueId, "done", "user");
    expect(booted.store.client_actions![0]!.status).toBe("cancelled");
    booted.store.contacts!.find((row) => row.id === "ada")!.email_status = "ok";
    expect((await ask(booted)).created).toBe(true);
  });
});
