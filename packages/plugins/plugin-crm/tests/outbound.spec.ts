import { describe, expect, it } from "vitest";
import { handleCareSendResult, settleStuckMessages } from "../src/care-approvals.js";
import { approvalDescription, checkRecipients, RecipientRefused, repairApprovalIssues } from "../src/outbound.js";
import { approvalsByStatus } from "../src/care-store.js";
import { answerSend, bootCare, CO, decide, issuesWith, OWNER, sentMail, tool } from "./helpers/care.js";

const draft = { to: [{ email: "ada@acme.co.za", name: "Ada Lovelace" }], subject: "Action needed: logo", text: "Hi Ada,\n\nPlease send your logo." };

describe("what an approval shows", () => {
  it("is the exact email and what approving does, and is cut short only when very long", () => {
    const text = approvalDescription({ intro: ["Why this is being sent."], draft }, "Approve by marking done.");
    expect(text).toContain("Why this is being sent.");
    expect(text).toContain("**To:** Ada Lovelace <ada@acme.co.za>");
    expect(text).toContain("**Subject:** Action needed: logo");
    expect(text).toContain("Please send your logo.");
    expect(text.endsWith("Approve by marking done.")).toBe(true);
    const long = approvalDescription({ intro: [], draft: { ...draft, text: "x".repeat(20_000) } }, "Approve.");
    expect(long.length).toBeLessThanOrEqual(9_100);
    expect(long).toMatch(/shortened|the full email is stored/);
    expect(approvalDescription({ intro: ["Only text."] }, "Decide.")).toBe("Only text.\n\nDecide.");
  });
});

describe("who an email may go to", () => {
  it("refuses a bounced address, an empty list and something that is not an address; an opt-out only blocks feedback asks", async () => {
    const { harness, store } = await bootCare();
    await expect(checkRecipients(harness.ctx, CO, "client_action", { ...draft, to: [] })).rejects.toThrow(RecipientRefused);
    await expect(checkRecipients(harness.ctx, CO, "client_action", { ...draft, to: [{ email: "not-an-address" }] })).rejects.toThrow(/not an email address/);
    await expect(checkRecipients(harness.ctx, CO, "client_action", draft)).resolves.toBeUndefined();
    store.contacts!.find((row) => row.id === "ada")!.email_status = "unsubscribed";
    await expect(checkRecipients(harness.ctx, CO, "client_action", draft)).resolves.toBeUndefined();
    await expect(checkRecipients(harness.ctx, CO, "client_report", draft)).resolves.toBeUndefined();
    await expect(checkRecipients(harness.ctx, CO, "feedback_request", draft)).rejects.toThrow(/opted out/);
    store.contacts!.find((row) => row.id === "ada")!.email_status = "bounced";
    await expect(checkRecipients(harness.ctx, CO, "client_action", draft)).rejects.toThrow(/bounced/);
    // Another company's contact with the same address does not count.
    store.contacts!.find((row) => row.id === "ada")!.company_id = "co-2";
    await expect(checkRecipients(harness.ctx, CO, "client_action", draft)).resolves.toBeUndefined();
  });
});

describe("an approval that lost its issue", () => {
  it("gets one from the care job, once, and the person can then decide it", async () => {
    const booted = await bootCare();
    const { harness, store } = booted;
    const made = await tool<Record<string, any>>(harness, "create-client-action", { client: "company:acme", kind: "info", title: "Send your logo" });
    // The host refused the issue at the time: the approval row has none.
    store.care_approvals![0]!.issue_id = null;
    const open = await approvalsByStatus(harness.ctx, CO, "open");
    expect(await repairApprovalIssues(harness.ctx, CO, open)).toBe(1);
    const approval = store.care_approvals![0]!;
    expect(approval.issue_id).toBeTruthy();
    const issue = (await harness.ctx.issues.get(approval.issue_id, CO))!;
    expect(issue.title).toBe("Approve email to Acme Plumbing: Send your logo");
    expect(issue.assigneeUserId).toBe(OWNER);
    expect(issue.description).toContain("**To:** Ada Lovelace <ada@acme.co.za>");
    expect(await repairApprovalIssues(harness.ctx, CO, await approvalsByStatus(harness.ctx, CO, "open"))).toBe(0);
    await decide(harness, approval.issue_id, "done", "user");
    expect(sentMail(booted.emit)).toHaveLength(1);
    expect(made.actionId).toBeTruthy();
  });
});

describe("the Mailbox's answers", () => {
  async function approved() {
    const booted = await bootCare();
    const made = await tool<Record<string, any>>(booted.harness, "create-client-action", { client: "company:acme", kind: "info", title: "Send your logo" });
    await decide(booted.harness, made.approvalIssueId, "done", "user");
    return { booted, key: `crm:msg:${booted.store.care_approvals![0]!.id}` };
  }

  it("a failure that will go away is retried: nothing is settled and the error is noted", async () => {
    const { booted, key } = await approved();
    await answerSend(booted.harness, key, "failed", { permanent: false, error: "Gmail rate limit" });
    expect(booted.store.care_approvals![0]!.status).toBe("approved");
    expect(booted.store.outbox![0]).toMatchObject({ status: "pending", last_error: "Gmail rate limit" });
  });

  it("an answer for a key that is not ours, or from another plugin, is ignored", async () => {
    const { booted } = await approved();
    expect(await handleCareSendResult(booted.harness.ctx, { key: "crm:msg:unknown", status: "sent", context: { plugin: "partnersinbiz.crm", kind: "client_message", id: "x" } })).toBe("ignored");
    await booted.harness.emit("plugin.partnersinbiz.mailbox.mail.send.result", { key: booted.store.outbox![0]!.key, status: "sent", context: { plugin: "partnersinbiz.billing", kind: "invoice", id: "i" } }, { companyId: CO });
    expect(booted.store.care_approvals![0]!.status).toBe("approved");
    // A sequence email's answer is not ours.
    await booted.harness.emit("plugin.partnersinbiz.mailbox.mail.send.result", { key: "crm:seq:e1:1", status: "sent", context: { plugin: "partnersinbiz.crm", kind: "sequence_step", id: "e1" } }, { companyId: CO });
    expect(booted.store.care_approvals![0]!.status).toBe("approved");
  });

  it("the care job settles an email the Mailbox answered but we never heard about, and one it gave up on", async () => {
    const { booted, key } = await approved();
    const { harness, store } = booted;
    expect(await settleStuckMessages(harness.ctx, CO)).toBe(0);
    store.outbox![0]!.status = "done";
    store.outbox![0]!.result = { key, status: "sent", messageId: "gm-9", threadId: "gt-9", sentAt: new Date().toISOString() };
    expect(await settleStuckMessages(harness.ctx, CO)).toBe(1);
    expect(store.care_approvals![0]).toMatchObject({ status: "sent" });
    expect(store.client_actions![0]!.status).toBe("waiting");

    const second = await tool<Record<string, any>>(harness, "create-client-action", { client: "company:acme", kind: "grant", title: "Give us access" });
    await decide(harness, second.approvalIssueId, "done", "user");
    const secondKey = store.outbox!.find((row) => row.key !== key)!.key;
    const row = store.outbox!.find((r) => r.key === secondKey)!;
    row.status = "failed";
    row.last_error = "No answer from the receiving plugin";
    expect(await settleStuckMessages(harness.ctx, CO)).toBe(1);
    const failed = store.care_approvals!.find((a) => a.send_key === secondKey)!;
    expect(failed).toMatchObject({ status: "failed", error: "No answer from the receiving plugin" });
    expect(await issuesWith(harness, "crm:msg-failed:")).toHaveLength(1);
    expect(await settleStuckMessages(harness.ctx, CO)).toBe(0);
  });
});
