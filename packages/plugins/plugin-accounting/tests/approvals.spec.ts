/**
 * Accounting 0.4: ledger approvals route through the kit (never unassigned, audit Q5-6) and the Reviewer's
 * pass comes first (audit Q5-7). Real Postgres behind the host SQL guard; skipped when the monorepo's
 * embedded-postgres is not installed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as db from "../src/db.js";
import { NAMESPACE } from "../src/namespace.js";
import { ensureBook } from "../src/service/books.js";
import { cockpitSnapshot, resetCockpitThrottle } from "../src/service/cockpit.js";
import { approveDraft, onDraftIssue, requestDraftApproval, saveDraft } from "../src/service/journals.js";
import { approveReconciliation, prepareReconciliation, requestReconciliationApproval } from "../src/service/reconcile.js";
import { ledgerReviewerBrief, recordReview, reviewKindFromTool, REVIEW_KINDS, stalledReviews } from "../src/service/review.js";
import { saveBankAccount } from "../src/service/bank.js";
import { approveVatReturn, prepareVatReturn, requestVatApproval } from "../src/service/vat.js";
import { isRetiredApprovalIssue, onIssueUpdated } from "../src/worker.js";
import { pgAvailable, startPgCtx, type PgCtx } from "./helpers/pg-ctx.js";

const CO = "co-review";
const user = { kind: "user" as const, userId: "user-owner" };
const bookkeeper = { kind: "agent" as const, agentId: "agent-books", runId: "run-b", userId: null };
const reviewer = { kind: "agent" as const, agentId: "agent-rev", runId: "run-r", userId: null };

const ROLES = {
  operatorAgentId: "agent-op",
  operatorStatus: "active",
  reviewerAgentId: "agent-rev",
  reviewerStatus: "active",
  ownerUserId: "user-owner",
  reviewOutward: true,
  team: { bookkeeper: { agentId: "agent-books", status: "active" } },
};

const LINES = [{ accountCode: "6100", debitMinor: 5_000_00 }, { accountCode: "2300", creditMinor: 5_000_00 }];

describe("review brief and kinds", () => {
  it("names the tool, the kind and the id, and who the issue goes to on a pass", () => {
    const text = ledgerReviewerBrief({ reviewerAgentId: "r", approverUserId: "u-9", escalationAgentId: null, via: "reviewer", ownerSource: "roles", notes: [] }, { kind: "reconciliation", subjectId: "rec-1", what: "the reconciliation" });
    expect(text).toContain("partnersinbiz.accounting:record-review");
    expect(text).toContain("kind `reconciliation`");
    expect(text).toContain("id `rec-1`");
    expect(text).toContain("user `u-9`");
    expect(text).toContain("Do not approve");
  });

  it("maps the tool's kind names and refuses an unknown one", () => {
    expect(reviewKindFromTool("journal")).toBe("draft");
    expect(reviewKindFromTool("vat201")).toBe("vat");
    expect(() => reviewKindFromTool("invoice")).toThrow(/kind is journal/);
    expect(Object.values(REVIEW_KINDS).map((k) => k.tool)).toEqual(["journal", "reconciliation", "vat201"]);
  });
});

describe.skipIf(!pgAvailable)("ledger approvals on real Postgres", () => {
  let h: PgCtx;

  beforeAll(async () => {
    h = await startPgCtx();
    h.configs.set(CO, { legalName: "Review Co", vatNumber: "4123456789", vatCategory: "B", financialYearEndMonth: 2 });
    await ensureBook(h.ctx, CO);
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  async function pendingDraft(memo: string, actor = bookkeeper) {
    const draft = await saveDraft(h.ctx, CO, { date: "2026-09-21", memo, lines: LINES }, actor);
    return requestDraftApproval(h.ctx, CO, draft.id, actor);
  }

  it("opens a manual journal with the Reviewer, records the review and waits for the owner", async () => {
    h.setRoles(CO, ROLES);
    const draft = await pendingDraft("Accrue audit fee");
    const issue = h.issues.get(draft.approvalIssueId!)!;
    expect(issue.assigneeAgentId).toBe("agent-rev");
    expect(issue.assigneeUserId).toBeNull();
    expect(issue.description).toContain("Reviewer: check before the owner approves");
    expect(issue.description).toContain(`id \`${draft.id}\``);
    expect(h.wakeups).toContain(issue.id);
    expect(await db.getReview(h.ctx.db, CO, "draft", draft.id)).toMatchObject({ state: "pending", issueId: issue.id, preparedBy: { kind: "agent", agentId: "agent-books" } });
    // The Cockpit's Needs-you list does not offer it to the owner while the Reviewer holds it.
    resetCockpitThrottle();
    expect((await cockpitSnapshot(h.ctx, CO)).waiting.map((w) => w.issueId)).not.toContain(issue.id);

    // The page does not offer the owner's click before the pass.
    await expect(approveDraft(h.ctx, CO, draft.id, user)).rejects.toMatchObject({ code: "review_pending", message: expect.stringMatching(/has not passed this manual journal yet/) });
    expect((await db.getDraft(h.ctx.db, CO, draft.id))!.status).toBe("pending_approval");

    // Only the Reviewer records it: not the preparer, not a stranger, not a person.
    await expect(recordReview(h.ctx, CO, bookkeeper, { kind: "journal", id: draft.id, verdict: "pass" })).rejects.toThrow(/prepared this yourself/);
    await expect(recordReview(h.ctx, CO, { kind: "agent", agentId: "agent-x", runId: "r", userId: null }, { kind: "journal", id: draft.id, verdict: "pass" })).rejects.toThrow(/Only the Reviewer/);
    await expect(recordReview(h.ctx, CO, user, { kind: "journal", id: draft.id, verdict: "pass" })).rejects.toThrow(/Only the Reviewer agent/);

    const passed = await recordReview(h.ctx, CO, reviewer, { kind: "journal", id: draft.id, verdict: "pass", findings: "Accounts and memo are right." });
    expect(passed).toMatchObject({ state: "passed", verdict: "pass" });
    expect(issue.assigneeAgentId).toBeNull();
    expect(issue.assigneeUserId).toBe("user-owner");
    expect(h.comments.some((c) => c.issueId === issue.id && c.body.includes("Reviewer pass") && c.body.includes("Accounts and memo are right."))).toBe(true);
    resetCockpitThrottle();
    expect((await cockpitSnapshot(h.ctx, CO)).waiting.map((w) => w.issueId)).toContain(issue.id);

    const posted = await approveDraft(h.ctx, CO, draft.id, user);
    expect(posted.journal!.kind).toBe("manual");
    expect(await db.getReview(h.ctx.db, CO, "draft", draft.id)).toMatchObject({ state: "passed" });
  });

  it("sends a journal back with findings: the request is withdrawn and the Bookkeeper has the issue", async () => {
    h.setRoles(CO, ROLES);
    const draft = await pendingDraft("Reclass hosting");
    const issue = h.issues.get(draft.approvalIssueId!)!;
    await expect(recordReview(h.ctx, CO, reviewer, { kind: "journal", id: draft.id, verdict: "changes_needed" })).rejects.toThrow(/Say what has to change/);
    const sent = await recordReview(h.ctx, CO, reviewer, { kind: "journal", id: draft.id, verdict: "changes_needed", findings: "Hosting is 6290, not 6100." });
    expect(sent.state).toBe("changes_needed");
    expect(await db.getDraft(h.ctx.db, CO, draft.id)).toMatchObject({ status: "cancelled", error: expect.stringContaining("Hosting is 6290") });
    expect(issue.assigneeAgentId).toBe("agent-books");
    expect(issue.status).toBe("todo");
    expect(h.comments.some((c) => c.issueId === issue.id && c.body.includes("changes needed") && c.body.includes("create-manual-journal"))).toBe(true);
    expect(h.wakeups.filter((w) => w === issue.id).length).toBeGreaterThanOrEqual(1);
    // Nothing is left to review, and a pass cannot revive it.
    await expect(recordReview(h.ctx, CO, reviewer, { kind: "journal", id: draft.id, verdict: "pass" })).rejects.toThrow(/cancelled, so there is nothing to review/);
  });

  it("lets the owner approve without the pass, on purpose and on the record", async () => {
    h.setRoles(CO, ROLES);
    const viaPage = await pendingDraft("Owner knows best");
    await expect(approveDraft(h.ctx, CO, viaPage.id, user, "page")).rejects.toMatchObject({ code: "review_pending" });
    const { journal } = await approveDraft(h.ctx, CO, viaPage.id, user, "page", { overrideReview: true });
    expect(journal!.memo).toBe("Owner knows best");
    expect(await db.getReview(h.ctx.db, CO, "draft", viaPage.id)).toMatchObject({ state: "waived", waivedBy: "user-owner" });
    expect(h.comments.some((c) => c.issueId === viaPage.approvalIssueId && /Approved without a recorded Reviewer pass.*user-owner/.test(c.body))).toBe(true);

    // Marking the issue done is the click itself: it goes ahead and is flagged.
    const viaIssue = await pendingDraft("Done by issue");
    h.issues.get(viaIssue.approvalIssueId!)!.status = "done";
    await onDraftIssue(h.ctx, CO, viaIssue, "done", { type: "user", id: "user-owner" });
    expect((await db.getDraft(h.ctx.db, CO, viaIssue.id))!.status).toBe("posted");
    expect(await db.getReview(h.ctx.db, CO, "draft", viaIssue.id)).toMatchObject({ state: "waived" });
    expect(h.comments.some((c) => c.issueId === viaIssue.approvalIssueId && c.body.includes("by marking this issue done"))).toBe(true);
  });

  it("goes straight to the owner when there is no Reviewer, or when the ledger review is switched off", async () => {
    h.setRoles(CO, { ...ROLES, reviewerAgentId: null, reviewerStatus: null });
    const none = await pendingDraft("No reviewer staffed");
    expect(h.issues.get(none.approvalIssueId!)).toMatchObject({ assigneeUserId: "user-owner", assigneeAgentId: null });
    expect(await db.getReview(h.ctx.db, CO, "draft", none.id)).toMatchObject({ state: "not_required" });
    await expect(approveDraft(h.ctx, CO, none.id, user)).resolves.toMatchObject({ draft: { status: "posted" } });

    h.setRoles(CO, ROLES);
    h.configs.set(CO, { ...h.configs.get(CO), reviewLedger: false });
    const off = await pendingDraft("Review switched off");
    expect(h.issues.get(off.approvalIssueId!)).toMatchObject({ assigneeUserId: "user-owner", assigneeAgentId: null });
    expect(await db.getReview(h.ctx.db, CO, "draft", off.id)).toMatchObject({ state: "not_required" });
    h.configs.set(CO, { legalName: "Review Co", vatNumber: "4123456789", vatCategory: "B", financialYearEndMonth: 2 });
  });

  it("a paused Reviewer never holds an approval: it goes to the owner", async () => {
    h.setRoles(CO, { ...ROLES, reviewerStatus: "paused" });
    const draft = await pendingDraft("Reviewer paused");
    expect(h.issues.get(draft.approvalIssueId!)).toMatchObject({ assigneeUserId: "user-owner", assigneeAgentId: null });
  });

  it("Q5-6: with the roles copy frozen or missing, an agent's approval still finds the host's default owner, else says so", async () => {
    const stuck = "co-stuck";
    h.configs.set(stuck, { legalName: "Stuck Co", vatCategory: "none" });
    await ensureBook(h.ctx, stuck);
    // The copy broadcast on day one: no owner, no Reviewer (what every plugin held for five days).
    h.setRoles(stuck, { operatorAgentId: null, reviewerAgentId: null, ownerUserId: null, reviewOutward: false });
    h.companies.set(stuck, { defaultResponsibleUserId: "user-default" });
    const draft = await saveDraft(h.ctx, stuck, { date: "2026-09-21", memo: "Agent made this", lines: LINES }, bookkeeper);
    const withDefault = await requestDraftApproval(h.ctx, stuck, draft.id, bookkeeper);
    expect(h.issues.get(withDefault.approvalIssueId!)!.assigneeUserId).toBe("user-default");

    // Nobody at all: the issue opens unassigned and says why, and the worker logs it.
    const lost = "co-lost";
    h.configs.set(lost, { legalName: "Lost Co", vatCategory: "none" });
    await ensureBook(h.ctx, lost);
    const d2 = await saveDraft(h.ctx, lost, { date: "2026-09-21", memo: "Nobody to ask", lines: LINES }, bookkeeper);
    const nobody = await requestDraftApproval(h.ctx, lost, d2.id, bookkeeper);
    const issue = h.issues.get(nobody.approvalIssueId!)!;
    expect(issue.assigneeUserId).toBeNull();
    expect(issue.assigneeAgentId).toBeNull();
    expect(issue.description).toContain("Unrouted");
    expect(h.warnings).toContain("Approval opened without a person to decide it");
    // A person who asks is a last resort approver.
    const d3 = await saveDraft(h.ctx, lost, { date: "2026-09-21", memo: "Asked from the page", lines: LINES }, user);
    expect(h.issues.get((await requestDraftApproval(h.ctx, lost, d3.id, user)).approvalIssueId!)!.assigneeUserId).toBe("user-owner");
  });

  it("reconciliations and the VAT201 get the same pass, and a send-back opens a fresh request", async () => {
    h.setRoles(CO, ROLES);
    const bank = await saveBankAccount(h.ctx, CO, { name: "Main account" });
    await prepareReconciliation(h.ctx, CO, bookkeeper, { bankAccountId: bank.id, periodStart: "2026-08-01", periodEnd: "2026-08-31", openingMinor: 0, closingMinor: 0 });
    const rec = (await db.listReconciliations(h.ctx.db, CO))[0]!;
    const pending = await requestReconciliationApproval(h.ctx, CO, bookkeeper, rec.id);
    const first = h.issues.get(pending.approvalIssueId!)!;
    expect(first.assigneeAgentId).toBe("agent-rev");
    expect(first.description).toContain("kind `reconciliation`");
    await expect(approveReconciliation(h.ctx, CO, user, rec.id)).rejects.toMatchObject({ code: "review_pending" });

    await recordReview(h.ctx, CO, reviewer, { kind: "reconciliation", id: rec.id, verdict: "changes_needed", findings: "Line 3 is a transfer, not an expense." });
    expect((await db.getReconciliation(h.ctx.db, CO, rec.id))!.status).toBe("draft");
    // The Bookkeeper fixes it and asks again: a new issue for the Reviewer, the old one is retired.
    const again = await requestReconciliationApproval(h.ctx, CO, bookkeeper, rec.id);
    const second = h.issues.get(again.approvalIssueId!)!;
    expect(second.id).not.toBe(first.id);
    expect(first.status).toBe("cancelled");
    expect(second.assigneeAgentId).toBe("agent-rev");
    expect(await db.getReview(h.ctx.db, CO, "reconciliation", rec.id)).toMatchObject({ state: "pending", issueId: second.id });
    await recordReview(h.ctx, CO, reviewer, { kind: "reconciliation", id: rec.id, verdict: "pass" });
    expect(second.assigneeUserId).toBe("user-owner");
    expect((await approveReconciliation(h.ctx, CO, user, rec.id)).status).toBe("locked");

    const { vatReturn } = await prepareVatReturn(h.ctx, CO, bookkeeper, { periodStart: "2026-07-01", periodEnd: "2026-08-31" });
    const vat = await requestVatApproval(h.ctx, CO, bookkeeper, vatReturn.id);
    expect(h.issues.get(vat.approvalIssueId!)).toMatchObject({ assigneeAgentId: "agent-rev" });
    expect(h.issues.get(vat.approvalIssueId!)!.description).toContain("kind `vat201`");
    await expect(approveVatReturn(h.ctx, CO, user, vatReturn.id)).rejects.toMatchObject({ code: "review_pending" });
    await recordReview(h.ctx, CO, reviewer, { kind: "vat201", id: vatReturn.id, verdict: "pass" });
    expect((await approveVatReturn(h.ctx, CO, user, vatReturn.id)).status).toBe("locked");
  });

  /** The host's `issue.updated` for one approval issue, as the plugin's handler receives it. */
  const issueEvent = (issueId: string, actorType: "user" | "agent" | "plugin", actorId: string) =>
    ({ eventType: "issue.updated", companyId: CO, entityId: issueId, entityType: "issue", actorType, actorId, occurredAt: new Date().toISOString(), payload: {} }) as never;

  it("a re-request after a send-back survives the old issue's events: the plugin's own cancel and an agent closing it (reconciliation)", async () => {
    h.setRoles(CO, ROLES);
    const bank = await saveBankAccount(h.ctx, CO, { name: "Stale events account" });
    await prepareReconciliation(h.ctx, CO, bookkeeper, { bankAccountId: bank.id, periodStart: "2026-03-01", periodEnd: "2026-03-31", openingMinor: 0, closingMinor: 0 });
    const rec = (await db.reconciliationByPeriod(h.ctx.db, CO, bank.id, "2026-03-01", "2026-03-31"))!;
    const first = h.issues.get((await requestReconciliationApproval(h.ctx, CO, bookkeeper, rec.id)).approvalIssueId!)!;
    await recordReview(h.ctx, CO, reviewer, { kind: "reconciliation", id: rec.id, verdict: "changes_needed", findings: "Line 2 is a transfer." });
    // The old issue is cancelled only once the row points at the new one (the cancel is announced as an event).
    const rowAtCancel: Array<string | null> = [];
    const update = h.ctx.issues.update;
    h.ctx.issues.update = async (id: string, patch: { status?: string }, ...rest: unknown[]) => {
      if (id === first.id && patch.status === "cancelled") rowAtCancel.push((await db.getReconciliation(h.ctx.db, CO, rec.id))!.approvalIssueId);
      return (update as (...args: unknown[]) => Promise<unknown>)(id, patch, ...rest);
    };
    const second = h.issues.get((await requestReconciliationApproval(h.ctx, CO, bookkeeper, rec.id)).approvalIssueId!)!;
    h.ctx.issues.update = update;
    expect(rowAtCancel).toEqual([second.id]);
    expect(second.id).not.toBe(first.id);
    expect(first.status).toBe("cancelled");
    // Both issues carry the same originId: only the row's approvalIssueId tells them apart.
    expect(first.originId).toBe(second.originId);
    expect(isRetiredApprovalIssue((await db.getReconciliation(h.ctx.db, CO, rec.id))!, first.id)).toBe(true);
    expect(isRetiredApprovalIssue((await db.getReconciliation(h.ctx.db, CO, rec.id))!, second.id)).toBe(false);

    // 1. The host announces the plugin's own cancel of the old issue.
    await onIssueUpdated(h.ctx, issueEvent(first.id, "plugin", "partnersinbiz.accounting"));
    expect(await db.getReconciliation(h.ctx.db, CO, rec.id)).toMatchObject({ status: "pending_approval", approvalIssueId: second.id });
    // 2. The Bookkeeper, told to "close this issue", closes the old one (already cancelled).
    first.status = "done";
    await onIssueUpdated(h.ctx, issueEvent(first.id, "agent", "agent-books"));
    expect(await db.getReconciliation(h.ctx.db, CO, rec.id)).toMatchObject({ status: "pending_approval", approvalIssueId: second.id });
    // The new request is still with the Reviewer: nothing was reset and nothing was handed to the owner.
    expect(second).toMatchObject({ assigneeAgentId: "agent-rev", assigneeUserId: null });
    expect(second.status).not.toBe("done");
    expect(await db.getReview(h.ctx.db, CO, "reconciliation", rec.id)).toMatchObject({ state: "pending", issueId: second.id });

    // The Reviewer can still review it, and the owner's click on the NEW issue is not swallowed by the guard.
    await recordReview(h.ctx, CO, reviewer, { kind: "reconciliation", id: rec.id, verdict: "pass" });
    second.status = "done";
    await onIssueUpdated(h.ctx, issueEvent(second.id, "user", "user-owner"));
    expect((await db.getReconciliation(h.ctx.db, CO, rec.id))!.status).toBe("locked");
  });

  it("the same for a VAT201: a stale cancel or agent-done on the old issue leaves the new request pending with the Reviewer", async () => {
    h.setRoles(CO, ROLES);
    const { vatReturn } = await prepareVatReturn(h.ctx, CO, bookkeeper, { periodStart: "2026-01-01", periodEnd: "2026-02-28" });
    const first = h.issues.get((await requestVatApproval(h.ctx, CO, bookkeeper, vatReturn.id)).approvalIssueId!)!;
    await recordReview(h.ctx, CO, reviewer, { kind: "vat201", id: vatReturn.id, verdict: "changes_needed", findings: "Box 15 needs a reason." });
    expect((await db.getVatReturn(h.ctx.db, CO, vatReturn.id))!.status).toBe("draft");
    const second = h.issues.get((await requestVatApproval(h.ctx, CO, bookkeeper, vatReturn.id)).approvalIssueId!)!;
    expect(first.status).toBe("cancelled");

    await onIssueUpdated(h.ctx, issueEvent(first.id, "plugin", "partnersinbiz.accounting"));
    first.status = "done";
    await onIssueUpdated(h.ctx, issueEvent(first.id, "agent", "agent-books"));
    // A person closing the retired issue is no approval either.
    await onIssueUpdated(h.ctx, issueEvent(first.id, "user", "user-owner"));
    expect(await db.getVatReturn(h.ctx.db, CO, vatReturn.id)).toMatchObject({ status: "pending_approval", approvalIssueId: second.id });
    expect(second).toMatchObject({ assigneeAgentId: "agent-rev", assigneeUserId: null });
    expect(await db.getReview(h.ctx.db, CO, "vat", vatReturn.id)).toMatchObject({ state: "pending", issueId: second.id });
    await recordReview(h.ctx, CO, reviewer, { kind: "vat201", id: vatReturn.id, verdict: "pass" });
    expect((await approveVatReturn(h.ctx, CO, user, vatReturn.id)).status).toBe("locked");
  });

  it("an approval that fails leaves no 'approved without the Reviewer' record; the flag appears only when it went ahead", async () => {
    h.setRoles(CO, ROLES);
    // A journal asked for before its VAT period locks: the Reviewer has not answered, and the period locks first.
    const draft = await saveDraft(h.ctx, CO, { date: "2026-04-10", memo: "Journal into a period that locks", lines: LINES }, bookkeeper);
    const pending = await requestDraftApproval(h.ctx, CO, draft.id, bookkeeper);
    const issueId = pending.approvalIssueId!;
    const { vatReturn } = await prepareVatReturn(h.ctx, CO, bookkeeper, { periodStart: "2026-03-01", periodEnd: "2026-04-30" });
    await requestVatApproval(h.ctx, CO, bookkeeper, vatReturn.id);
    await recordReview(h.ctx, CO, reviewer, { kind: "vat201", id: vatReturn.id, verdict: "pass" });
    await approveVatReturn(h.ctx, CO, user, vatReturn.id);

    await expect(approveDraft(h.ctx, CO, draft.id, user, "page", { overrideReview: true })).rejects.toMatchObject({ code: "vat_locked" });
    expect(await db.getReview(h.ctx.db, CO, "draft", draft.id)).toMatchObject({ state: "pending", waivedBy: null });
    expect(h.comments.filter((c) => c.issueId === issueId && c.body.includes("Approved without a recorded Reviewer pass"))).toEqual([]);

    // The same approval going ahead (a date in an open period) is flagged, after it posted.
    const open = await pendingDraft("Goes ahead without the pass");
    await approveDraft(h.ctx, CO, open.id, user, "page", { overrideReview: true });
    expect(await db.getReview(h.ctx.db, CO, "draft", open.id)).toMatchObject({ state: "waived", waivedBy: "user-owner" });
    expect(h.comments.filter((c) => c.issueId === open.approvalIssueId && c.body.includes("Approved without a recorded Reviewer pass"))).toHaveLength(1);
  });

  it("warns when the Reviewer has sat on an approval for over a day", async () => {
    h.setRoles(CO, ROLES);
    const draft = await pendingDraft("Slow reviewer");
    expect(await stalledReviews(h.ctx, CO)).toEqual([]);
    await h.q(`UPDATE ${NAMESPACE}.approval_reviews SET requested_at = now() - interval '30 hours' WHERE company_id = $1 AND subject_id = $2`, [CO, draft.id]);
    expect((await stalledReviews(h.ctx, CO)).map((r) => r.subjectId)).toEqual([draft.id]);
    resetCockpitThrottle();
    const snap = await cockpitSnapshot(h.ctx, CO);
    expect(snap.health.find((c) => c.key === "review_stalled")).toMatchObject({ status: "warn", href: `/issues/${draft.approvalIssueId}` });
  });

  it("reports a stale roles copy in the Cockpit health", async () => {
    const stale = "co-stale";
    h.configs.set(stale, { legalName: "Stale Co", vatCategory: "none" });
    await ensureBook(h.ctx, stale);
    h.setRoles(stale, { ...ROLES, ownerUserId: null, receivedAt: new Date(Date.now() - 10 * 3_600_000).toISOString() });
    resetCockpitThrottle();
    const snap = await cockpitSnapshot(h.ctx, stale);
    expect(snap.health.find((c) => c.key === "roles:copy")).toMatchObject({ status: "warn", detail: expect.stringMatching(/no owner is set.*10 h old/) });
  });
});
