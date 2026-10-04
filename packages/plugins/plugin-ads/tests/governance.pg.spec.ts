/**
 * Governed spend: every campaign or budget change is a proposal with the numbers, an issue that goes to the Reviewer and then a person, and the
 * client's own yes where the scope asks. These tests prove the loop and its refusals on a real Postgres with the SDK's in-memory host.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { evaluateCompany, resolveStaleAlerts } from "../src/evaluate.js";
import { getProposal, listAlerts, listProposals, updateProposal } from "../src/db.js";
import { AdsError } from "../src/domain.js";
import { cancelProposal, createProposal, markDoneManually, recordClientRequest, recordReview, recordSignoff, reviseProposal, sweepProposals } from "../src/proposals.js";
import { proposalDetail } from "../src/records.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";
import { ADS_AGENT, AM_AGENT, COMPANY, NOW, OPERATOR, OWNER, REVIEWER, world, type World } from "./helpers/world.js";
import { approvalsOf, closeIssueAs, CREATE, person, propose, syncedAccount } from "./helpers/scenario.js";

const available = await embeddedAvailable();
let pg: Pg;
beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);
afterAll(async () => {
  if (available) await pg.stop();
});

const issueOf = async (w: World, id: string | null) => (await w.issues()).find((i) => i.id === id)!;

describe.skipIf(!available)("proposing a change", () => {
  let w: World;
  let accountId: string;
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    ({ accountId } = await syncedAccount(w));
  });

  it("opens one approval issue for the Reviewer first, with the numbers, the cap lines and what runs", async () => {
    const p = await propose(w, CREATE(accountId));
    expect(p).toMatchObject({ kind: "create_campaign", status: "in_review", review_state: "pending", cap_state: "within", requires_signoffs: ["owner"], origin: "agent" });
    expect(p.content_hash).toMatch(/^[0-9a-f]{40}$/);
    const issue = await issueOf(w, p.approval_issue_id);
    expect(issue).toMatchObject({ status: "todo", assigneeAgentId: REVIEWER, originId: `ads-approval:${p.id}` });
    expect(issue.title).toMatch(/^Approve new campaign: New campaign "Spring leads"/);
    for (const text of ["Spring leads", "ZAR 50.00", "created **paused**", "Budget cap for 2026-10: ZAR 5,000.00", "Within the cap", "record-ad-review", "Mark this issue **done** to approve", p.id]) expect(issue.description, text).toContain(text);
    // Nothing happened in any ad platform.
    expect(w.mock.writes).toEqual([]);
  });

  it("goes straight to the owner when the company has no Reviewer", async () => {
    await pg.reset();
    const solo = await world(pg, { roles: { reviewer: false } });
    const acct = await syncedAccount(solo);
    const p = await propose(solo, CREATE(acct.accountId));
    expect(p.review_state).toBe("not_required");
    expect(await issueOf(solo, p.approval_issue_id)).toMatchObject({ assigneeUserId: OWNER });
  });

  it("works out what a change adds to the month and says when it goes over the cap", async () => {
    // committed: 60 000 spent + 20 000/day x 16 days + 20 000 today = 400 000; cap 500 000
    const ok = await propose(w, CREATE(accountId, { dailyBudgetMinor: 5000 }));
    expect(ok.impact).toMatchObject({ capMinor: 500_000, spentMinor: 60_000, projectedBeforeMinor: 400_000, addedThisMonthMinor: 85_000, state: "within" });
    const over = await propose(w, CREATE(accountId, { name: "Big one", dailyBudgetMinor: 6000 }));
    expect(over.cap_state).toBe("exceeds");
    expect((await issueOf(w, over.approval_issue_id)).description).toContain("goes over the cap by ZAR 20.00");
  });

  it("refuses what cannot be a proposal, with a reason", async () => {
    const bad = async (input: Record<string, unknown>, re: RegExp) => expect(createProposal(w.rt(), { agentId: ADS_AGENT }, { scopeKey: "own", ...input })).rejects.toThrow(re);
    await bad({ kind: "explode" }, /kind must be one of/);
    await bad({ kind: "create_campaign", accountId: "nope", name: "Abc", dailyBudgetMinor: 100 }, /not found or is not active/);
    await bad({ kind: "create_campaign", accountId, name: "Abc" }, /dailyBudgetMinor is required/);
    await bad({ kind: "create_campaign", accountId, name: "Abc", dailyBudgetMinor: 0 }, /more than zero/);
    await bad({ kind: "create_campaign", accountId, name: "Abc", dailyBudgetMinor: 150.5 }, /whole number of minor units/);
    await bad({ kind: "create_campaign", accountId, name: "Abc", dailyBudgetMinor: 100, objective: "WORLD_DOMINATION" }, /objective must be one of/);
    await bad({ kind: "create_campaign", accountId, name: "Abc", dailyBudgetMinor: 100, startDate: "2026-10-20", endDate: "2026-10-10" }, /endDate is before startDate/);
    await bad({ kind: "change_budget", accountId, campaignExternalId: "c1", newDailyBudgetMinor: 10_000 }, /already has/);
    await bad({ kind: "change_budget", accountId, campaignExternalId: "ghost", newDailyBudgetMinor: 100 }, /not known/);
    await bad({ kind: "pause_campaign", targets: [{ accountId, campaignExternalId: "c2" }] }, /already paused/);
    await bad({ kind: "pause_campaign" }, /targets is required/);
    await bad({ kind: "creative_check", creative: {} }, /creative is required/);
    await expect(createProposal(w.rt(), { agentId: ADS_AGENT }, { kind: "create_campaign", scopeKey: "company:nobody", accountId, name: "Abc", dailyBudgetMinor: 100 })).rejects.toThrow(/no ad account registered yet/);
    await expect(createProposal(w.rt(), { agentId: ADS_AGENT }, { kind: "create_campaign", scopeKey: "everyone" })).rejects.toThrow(/scopeKey must be/);
    expect(await listProposals(w.ctx, COMPANY)).toEqual([]);
  });

  it("a budget change names the campaign's current budget, and a pause lists every campaign", async () => {
    const change = await propose(w, { kind: "change_budget", scopeKey: "own", accountId, campaignExternalId: "c1", newDailyBudgetMinor: 15_000, reason: "Returns are 3x" });
    expect(change.payload).toMatchObject({ currentDailyBudgetMinor: 10_000, newDailyBudgetMinor: 15_000, campaignName: "Campaign c1" });
    expect(change.impact).toMatchObject({ addedThisMonthMinor: 5000 * 16 + 5000 });
    const pause = await propose(w, { kind: "pause_campaign", scopeKey: "own", targets: [{ accountId, campaignExternalId: "c1" }, { accountId, campaignExternalId: "c3" }], reason: "Over budget" });
    expect(pause.title).toBe("Pause 2 campaigns");
    expect(pause.cap_state).toBe("within");
    expect((pause.payload.targets as unknown[]).length).toBe(2);
    expect(pause.requires_signoffs).toEqual(["owner"]);
  });
});

describe.skipIf(!available)("the ad copy check", () => {
  let w: World;
  let accountId: string;
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    ({ accountId } = await syncedAccount(w));
  });

  it("copy that uses a banned word cannot go to review: no issue opens, and the fix brings it in", async () => {
    const { updateScope } = await import("../src/db.js");
    await updateScope(w.ctx, COMPANY, "own", { bannedWords: ["cheap"] });
    const first = await createProposal(w.rt(), { agentId: ADS_AGENT }, CREATE(accountId, { creative: { headline: "Cheap leads for you", primaryText: "Fresh coffee", landingUrl: "https://acme.test" } }));
    expect(first).toMatchObject({ status: "needs_changes", issueId: null });
    expect(first.needsChanges[0]).toMatchObject({ level: "blocker", where: "headline" });
    expect(await w.issues()).toEqual([]);
    const revised = await reviseProposal(w.rt(), { agentId: ADS_AGENT }, first.proposalId, { creative: { headline: "Fresh leads for you" } });
    expect(revised.status).toBe("in_review");
    expect(revised.issueId).toEqual(expect.any(String));
    expect((await w.issues()).filter((i) => i.originId?.startsWith("ads-approval:"))).toHaveLength(1);
  });

  it("warnings go to the Reviewer inside the issue, not as a refusal", async () => {
    const p = await propose(w, CREATE(accountId, { creative: { headline: "Guaranteed results", landingUrl: "https://acme.test" } }));
    expect(p.status).toBe("in_review");
    expect((await issueOf(w, p.approval_issue_id)).description).toMatch(/Warning.*guarantee/is);
  });

  it("a copy-only proposal is cleared by a person and changes nothing", async () => {
    const p = await propose(w, { kind: "creative_check", scopeKey: "own", platform: "meta", creative: { headline: "Fresh coffee", landingUrl: "https://acme.test" } });
    expect(p.kind).toBe("creative_check");
    await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass" });
    const done = await recordSignoff(w.rt(), { proposalId: p.id, userId: OWNER, role: "owner", decision: "approved", via: "page" });
    expect(done.proposal.status).toBe("cleared");
    expect(w.mock.writes).toEqual([]);
    expect((await w.issues()).filter((i) => i.originId?.startsWith("ads-run:"))).toEqual([]);
  });
});

describe.skipIf(!available)("the Reviewer, then a person", () => {
  let w: World;
  let accountId: string;
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    ({ accountId } = await syncedAccount(w));
  });

  it("a Reviewer's pass hands the issue to the person who decides; changes hand it back to the ads agent", async () => {
    const p = await propose(w, CREATE(accountId));
    await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass", notes: "Numbers match." });
    expect(await getProposal(w.ctx, COMPANY, p.id)).toMatchObject({ review_state: "pass", review_hash: p.content_hash, status: "in_review" });
    expect(await issueOf(w, p.approval_issue_id)).toMatchObject({ assigneeUserId: OWNER, assigneeAgentId: null });
    expect(w.comments(p.approval_issue_id!).join("\n")).toContain("Reviewer: PASS");

    const q = await propose(w, CREATE(accountId, { name: "Second one" }));
    await expect(recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: q.id, verdict: "changes" })).rejects.toThrow(/Say what has to change/);
    await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: q.id, verdict: "changes", notes: "Landing page is missing." });
    expect(await getProposal(w.ctx, COMPANY, q.id)).toMatchObject({ status: "needs_changes", review_state: "changes", review_notes: "Landing page is missing." });
    expect(await issueOf(w, q.approval_issue_id)).toMatchObject({ assigneeAgentId: ADS_AGENT });
    // A person cannot approve what the Reviewer sent back.
    await expect(recordSignoff(w.rt(), { proposalId: q.id, userId: OWNER, role: "owner", decision: "approved", via: "page" })).rejects.toThrow(/needs changes first/);
    // The revision goes to the Reviewer again and the old verdict is gone.
    await reviseProposal(w.rt(), { agentId: ADS_AGENT }, q.id, { creative: { headline: "Fresh", landingUrl: "https://acme.test" } });
    expect(await getProposal(w.ctx, COMPANY, q.id)).toMatchObject({ status: "in_review", review_state: "pending", review_hash: null });
    expect(await issueOf(w, q.approval_issue_id)).toMatchObject({ assigneeAgentId: REVIEWER });
  });

  it("a person approving the issue (marking it done) is the owner's yes, and opens the task to run it", async () => {
    const p = await propose(w, CREATE(accountId));
    await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass" });
    await closeIssueAs(w, p.approval_issue_id!, "done", person);
    const after = (await getProposal(w.ctx, COMPANY, p.id))!;
    expect(after.status).toBe("approved");
    const [approval] = await approvalsOf(w, p.id);
    expect(approval).toMatchObject({ role: "owner", decision: "approved", decided_by: `user:${OWNER}`, content_hash: p.content_hash, over_cap_ack: false });
    expect(Date.parse(approval!.expires_at!) - NOW.getTime()).toBe(72 * 3_600_000);
    const run = (await w.issues()).find((i) => i.originId === `ads-run:${p.id}`)!;
    expect(run).toMatchObject({ assigneeAgentId: ADS_AGENT, status: "todo" });
    expect(run.description).toContain("execute-ad-change");
    expect(run.description).toContain(approval!.id);
    const detail = await proposalDetail(w.rt(), p.id);
    expect(detail.approvalId).toBe(approval!.id);
  });

  it("an AGENT closing the approval issue (even the Reviewer) approves nothing: it is reopened for a person", async () => {
    const p = await propose(w, CREATE(accountId));
    await closeIssueAs(w, p.approval_issue_id!, "done", { type: "agent", id: REVIEWER });
    expect(await approvalsOf(w, p.id)).toEqual([]);
    expect((await getProposal(w.ctx, COMPANY, p.id))!.status).toBe("in_review");
    expect(await issueOf(w, p.approval_issue_id)).toMatchObject({ status: "todo", assigneeUserId: OWNER, assigneeAgentId: null });
    expect(w.comments(p.approval_issue_id!).join("\n")).toMatch(/Only a person can decide it/);
    // Same for the ads agent that asked, and for cancelling.
    await closeIssueAs(w, p.approval_issue_id!, "cancelled", { type: "agent", id: ADS_AGENT });
    expect((await getProposal(w.ctx, COMPANY, p.id))!.status).toBe("in_review");
  });

  it("a person cancelling the issue refuses the change: nothing runs and the issue stays cancelled", async () => {
    const p = await propose(w, CREATE(accountId));
    await closeIssueAs(w, p.approval_issue_id!, "cancelled", person);
    expect(await getProposal(w.ctx, COMPANY, p.id)).toMatchObject({ status: "rejected" });
    expect((await approvalsOf(w, p.id))[0]).toMatchObject({ decision: "rejected" });
    expect(await issueOf(w, p.approval_issue_id)).toMatchObject({ status: "cancelled" });
    expect(w.mock.writes).toEqual([]);
  });

  it("a person approving before the Reviewer finishes waives the review, on record", async () => {
    const p = await propose(w, CREATE(accountId));
    await recordSignoff(w.rt(), { proposalId: p.id, userId: OWNER, role: "owner", decision: "approved", via: "page" });
    expect(await getProposal(w.ctx, COMPANY, p.id)).toMatchObject({ status: "approved", review_state: "waived", review_by: `user:${OWNER}` });
  });

  it("only a signed-in person can record a yes", async () => {
    const p = await propose(w, CREATE(accountId));
    await expect(recordSignoff(w.rt(), { proposalId: p.id, userId: null, role: "owner", decision: "approved", via: "page" })).rejects.toThrow(/signed-in person/);
    expect(await approvalsOf(w, p.id)).toEqual([]);
  });

  it("an approval is for exactly these numbers: revising cancels every earlier yes and the Reviewer looks again", async () => {
    const p = await propose(w, CREATE(accountId));
    await recordSignoff(w.rt(), { proposalId: p.id, userId: OWNER, role: "owner", decision: "approved", via: "page" });
    const [old] = await approvalsOf(w, p.id);
    expect((await getProposal(w.ctx, COMPANY, p.id))!.status).toBe("approved");
    await reviseProposal(w.rt(), { agentId: ADS_AGENT }, p.id, { dailyBudgetMinor: 4000 });
    const after = (await getProposal(w.ctx, COMPANY, p.id))!;
    expect(after.content_hash).not.toBe(p.content_hash);
    expect(after).toMatchObject({ status: "in_review", review_state: "pending" });
    expect(old!.content_hash).toBe(p.content_hash);
    // The old yes does not make it approved again.
    const { proposal } = await recordSignoff(w.rt(), { proposalId: p.id, userId: OWNER, role: "owner", decision: "approved", via: "page" });
    expect(proposal.status).toBe("approved");
    expect((await approvalsOf(w, p.id)).filter((a) => a.content_hash === after.content_hash)).toHaveLength(1);
    // A revision that changes nothing keeps the yes; changing even the reason does not (the approver read it).
    await reviseProposal(w.rt(), { agentId: ADS_AGENT }, p.id, { dailyBudgetMinor: 4000 });
    expect((await getProposal(w.ctx, COMPANY, p.id))!.status).toBe("approved");
    await reviseProposal(w.rt(), { agentId: ADS_AGENT }, p.id, { reason: "A different reason" });
    expect((await getProposal(w.ctx, COMPANY, p.id))!.status).toBe("in_review");
  });

  it("an approval lapses after 72 hours and sends the proposal back to waiting; undecided proposals expire after 7 days", async () => {
    const p = await propose(w, CREATE(accountId));
    await recordSignoff(w.rt(), { proposalId: p.id, userId: OWNER, role: "owner", decision: "approved", via: "page" });
    const later = new Date(NOW.getTime() + 73 * 3_600_000);
    expect(await sweepProposals(w.rt(undefined, later))).toMatchObject({ lapsed: 1, expired: 0 });
    expect((await getProposal(w.ctx, COMPANY, p.id))!.status).toBe("in_review");
    expect(w.comments(p.approval_issue_id!).join("\n")).toMatch(/approval lapsed/);
    const muchLater = new Date(NOW.getTime() + 8 * 86_400_000);
    expect(await sweepProposals(w.rt(undefined, muchLater))).toMatchObject({ expired: 1 });
    expect((await getProposal(w.ctx, COMPANY, p.id))!.status).toBe("expired");
    expect(await issueOf(w, p.approval_issue_id)).toMatchObject({ status: "cancelled" });
    await expect(recordSignoff(w.rt(undefined, muchLater), { proposalId: p.id, userId: OWNER, role: "owner", decision: "approved", via: "page" })).rejects.toThrow(/expired/);
  });

  it("can be cancelled by the agent that asked, which closes its issue", async () => {
    const p = await propose(w, CREATE(accountId));
    await cancelProposal(w.rt(), { agentId: ADS_AGENT }, p.id, "No longer needed");
    expect(await getProposal(w.ctx, COMPANY, p.id)).toMatchObject({ status: "cancelled" });
    expect(await issueOf(w, p.approval_issue_id)).toMatchObject({ status: "cancelled" });
    await expect(cancelProposal(w.rt(), { agentId: ADS_AGENT }, p.id, null)).rejects.toThrow(/cannot be cancelled/);
  });

  it("a person can say a change was made by hand once it is approved, which closes the task", async () => {
    const p = await propose(w, CREATE(accountId));
    await expect(markDoneManually(w.rt(), { proposalId: p.id, userId: OWNER })).rejects.toThrow(/Only an approved change/);
    await recordSignoff(w.rt(), { proposalId: p.id, userId: OWNER, role: "owner", decision: "approved", via: "page" });
    await expect(markDoneManually(w.rt(), { proposalId: p.id, userId: null })).rejects.toThrow(/signed-in person/);
    await markDoneManually(w.rt(), { proposalId: p.id, userId: OWNER, note: "Did it in Ads Manager" });
    expect(await getProposal(w.ctx, COMPANY, p.id)).toMatchObject({ status: "executed", execution: { manual: true } });
    expect((await w.issues()).find((i) => i.originId === `ads-run:${p.id}`)).toMatchObject({ status: "done" });
  });
});

describe.skipIf(!available)("the plugin's own writes come back as events (the live host delivers them)", () => {
  let w: World;
  let accountId: string;
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    ({ accountId } = await syncedAccount(w));
  });

  /** What the live host does after the plugin closes an issue: an `issue.updated` by actor `plugin`, delivered to the plugin itself. */
  const echoOfOwnClose = (id: string) => w.harness.emit("issue.updated", { status: "done" }, { companyId: COMPANY, entityId: id, entityType: "issue", actorType: "plugin", actorId: "plugin-installation-id" });

  it("an approval a person gave on the issue stays decided: the plugin's own close is not an agent closing it", async () => {
    const p = await propose(w, CREATE(accountId));
    await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass" });
    await closeIssueAs(w, p.approval_issue_id!, "done", person);
    await echoOfOwnClose(p.approval_issue_id!);
    expect((await getProposal(w.ctx, COMPANY, p.id))!.status).toBe("approved");
    expect(await issueOf(w, p.approval_issue_id)).toMatchObject({ status: "done" });
    expect(await approvalsOf(w, p.id)).toHaveLength(1);
    expect(w.comments(p.approval_issue_id!).join("\n")).not.toMatch(/An agent closed this approval/);
  });

  it("the same when the person approves on the Ads page", async () => {
    const p = await propose(w, CREATE(accountId));
    await recordSignoff(w.rt(), { proposalId: p.id, userId: OWNER, role: "owner", decision: "approved", via: "page" });
    await echoOfOwnClose(p.approval_issue_id!);
    await echoOfOwnClose(p.approval_issue_id!);
    expect((await getProposal(w.ctx, COMPANY, p.id))!.status).toBe("approved");
    expect(await issueOf(w, p.approval_issue_id)).toMatchObject({ status: "done" });
    expect(await approvalsOf(w, p.id)).toHaveLength(1);
    expect(w.comments(p.approval_issue_id!).join("\n")).not.toMatch(/An agent closed this approval/);
    // And the run task was opened once, for the ads agent.
    expect((await w.issues()).filter((i) => i.originId === `ads-run:${p.id}`)).toHaveLength(1);
  });

  it("a copy-only proposal that a person cleared stays closed too", async () => {
    const p = await propose(w, { kind: "creative_check", scopeKey: "own", platform: "meta", creative: { headline: "Fresh coffee", landingUrl: "https://acme.test" } });
    await recordSignoff(w.rt(), { proposalId: p.id, userId: OWNER, role: "owner", decision: "approved", via: "page" });
    await echoOfOwnClose(p.approval_issue_id!);
    expect(await issueOf(w, p.approval_issue_id)).toMatchObject({ status: "done" });
    expect(await approvalsOf(w, p.id)).toHaveLength(1);
  });

  it("a refusal is not reopened either, and an AGENT closing the issue is still reopened for a person", async () => {
    const p = await propose(w, CREATE(accountId));
    await closeIssueAs(w, p.approval_issue_id!, "cancelled", person);
    expect(await issueOf(w, p.approval_issue_id)).toMatchObject({ status: "cancelled" });
    const q = await propose(w, CREATE(accountId, { name: "Second one" }));
    await closeIssueAs(w, q.approval_issue_id!, "done", { type: "agent", id: ADS_AGENT });
    expect(await issueOf(w, q.approval_issue_id)).toMatchObject({ status: "todo", assigneeUserId: OWNER });
    expect(w.comments(q.approval_issue_id!).join("\n")).toMatch(/An agent closed this approval/);
  });
});

describe.skipIf(!available)("only the Reviewer's verdict counts as a review", () => {
  let w: World;
  let accountId: string;
  const rows = async (action: string) => (await pg.client.query(`SELECT actor, detail FROM ${w.ctx.db.namespace}.audit WHERE action = $1`, [action])).rows as Array<{ actor: string; detail: { code: string } }>;
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    ({ accountId } = await syncedAccount(w));
  });

  it("the ads agent that asked for the change cannot record a pass or changes on it", async () => {
    const p = await propose(w, CREATE(accountId));
    await expect(recordReview(w.rt(), { agentId: ADS_AGENT }, { proposalId: p.id, verdict: "pass" })).rejects.toMatchObject({ code: "not_reviewer" });
    await expect(recordReview(w.rt(), { agentId: ADS_AGENT }, { proposalId: p.id, verdict: "changes", notes: "I want to stop this" })).rejects.toMatchObject({ code: "not_reviewer" });
    await expect(recordReview(w.rt(), { agentId: OPERATOR }, { proposalId: p.id, verdict: "pass" })).rejects.toThrow(/Only the company's Reviewer/);
    expect(await getProposal(w.ctx, COMPANY, p.id)).toMatchObject({ review_state: "pending", review_by: null, review_hash: null, status: "in_review" });
    expect(await issueOf(w, p.approval_issue_id)).toMatchObject({ assigneeAgentId: REVIEWER });
    expect((await rows("review.refused")).map((r) => [r.actor, r.detail.code])).toEqual([[`agent:${ADS_AGENT}`, "not_reviewer"], [`agent:${ADS_AGENT}`, "not_reviewer"], [`agent:${OPERATOR}`, "not_reviewer"]]);
  });

  it("a person does not record a review either: they approve or refuse", async () => {
    const p = await propose(w, CREATE(accountId));
    await expect(recordReview(w.rt(), { userId: OWNER }, { proposalId: p.id, verdict: "pass" })).rejects.toThrow(/Only the Reviewer agent/);
    await expect(recordReview(w.rt(), {}, { proposalId: p.id, verdict: "pass" })).rejects.toThrow(/Only the Reviewer agent/);
    expect((await getProposal(w.ctx, COMPANY, p.id))!.review_state).toBe("pending");
  });

  it("the proposer cannot launder a Reviewer's changes: its own pass is refused, and revising nothing leaves the proposal sent back", async () => {
    const p = await propose(w, CREATE(accountId));
    await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "changes", notes: "Landing page is missing." });
    await expect(recordReview(w.rt(), { agentId: ADS_AGENT }, { proposalId: p.id, verdict: "pass", notes: "Looks fine to me" })).rejects.toMatchObject({ code: "not_reviewer" });
    const again = await reviseProposal(w.rt(), { agentId: ADS_AGENT }, p.id, {});
    expect(again).toMatchObject({ status: "needs_changes", needsChanges: [{ level: "reviewer", text: "Landing page is missing." }] });
    expect(again.next).toMatch(/Reviewer's request for changes still stands/);
    const after = (await getProposal(w.ctx, COMPANY, p.id))!;
    expect(after).toMatchObject({ status: "needs_changes", review_state: "changes", review_by: `agent:${REVIEWER}`, review_notes: "Landing page is missing." });
    expect(w.comments(p.approval_issue_id!).join("\n")).toMatch(/request for changes still stands/);
    // A person cannot approve it, and nothing can run.
    await expect(recordSignoff(w.rt(), { proposalId: p.id, userId: OWNER, role: "owner", decision: "approved", via: "page" })).rejects.toThrow(/needs changes first/);
    expect(await approvalsOf(w, p.id)).toEqual([]);
  });

  it("the Reviewer can pass what it sent back; that brings the proposal back to a person, not the proposer", async () => {
    const p = await propose(w, CREATE(accountId));
    await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "changes", notes: "Check the budget." });
    const passed = await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass", notes: "Budget is right after all." });
    expect(passed).toMatchObject({ status: "in_review", review_state: "pass", review_by: `agent:${REVIEWER}`, review_hash: p.content_hash });
    expect(await issueOf(w, p.approval_issue_id)).toMatchObject({ assigneeUserId: OWNER });
    const { proposal } = await recordSignoff(w.rt(), { proposalId: p.id, userId: OWNER, role: "owner", decision: "approved", via: "page" });
    expect(proposal.status).toBe("approved");
  });

  it("a Reviewer pass does not lift copy blockers", async () => {
    const { updateScope } = await import("../src/db.js");
    await updateScope(w.ctx, COMPANY, "own", { bannedWords: ["cheap"] });
    const first = await createProposal(w.rt(), { agentId: ADS_AGENT }, CREATE(accountId, { creative: { headline: "Cheap leads for you", primaryText: "Fresh coffee", landingUrl: "https://acme.test" } }));
    expect(first.status).toBe("needs_changes");
    expect(first.issueId).toBeNull();
    await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: first.proposalId, verdict: "pass" });
    expect((await getProposal(w.ctx, COMPANY, first.proposalId))!.status).toBe("needs_changes");
  });

  it("the Reviewer cannot review a change it asked for itself", async () => {
    const p = await propose(w, CREATE(accountId), { agentId: REVIEWER });
    await expect(recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass" })).rejects.toMatchObject({ code: "own_proposal" });
    expect((await rows("review.refused")).map((r) => r.detail.code)).toEqual(["own_proposal"]);
    expect((await getProposal(w.ctx, COMPANY, p.id))!.review_state).not.toBe("pass");
  });

  it("a company with no Reviewer has no review to record; a person decides", async () => {
    await pg.reset();
    const solo = await world(pg, { roles: { reviewer: false } });
    const acct = await syncedAccount(solo);
    const p = await propose(solo, CREATE(acct.accountId));
    expect(p.review_state).toBe("not_required");
    await expect(recordReview(solo.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass" })).rejects.toMatchObject({ code: "no_reviewer" });
    await expect(recordReview(solo.rt(), { agentId: ADS_AGENT }, { proposalId: p.id, verdict: "changes", notes: "x" })).rejects.toMatchObject({ code: "no_reviewer" });
    expect(await getProposal(solo.ctx, COMPANY, p.id)).toMatchObject({ review_state: "not_required", status: "in_review" });
    const { proposal } = await recordSignoff(solo.rt(), { proposalId: p.id, userId: OWNER, role: "owner", decision: "approved", via: "page" });
    expect(proposal.status).toBe("approved");
  });
});

describe.skipIf(!available)("a change that goes over the month's cap", () => {
  let w: World;
  let accountId: string;
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    ({ accountId } = await syncedAccount(w));
  });

  it("cannot be approved by closing the issue; the person must tick 'over the cap' on the page", async () => {
    const p = await propose(w, CREATE(accountId, { dailyBudgetMinor: 8000 }));
    expect(p.cap_state).toBe("exceeds");
    await closeIssueAs(w, p.approval_issue_id!, "done", person);
    expect(await approvalsOf(w, p.id)).toEqual([]);
    expect(await issueOf(w, p.approval_issue_id)).toMatchObject({ status: "todo" });
    expect(w.comments(p.approval_issue_id!).join("\n")).toMatch(/Not approved yet: This goes over the month's cap/);
    await expect(recordSignoff(w.rt(), { proposalId: p.id, userId: OWNER, role: "owner", decision: "approved", via: "page" })).rejects.toMatchObject({ code: "over_cap" });
    const ok = await recordSignoff(w.rt(), { proposalId: p.id, userId: OWNER, role: "owner", decision: "approved", overCapAck: true, via: "page" });
    expect(ok.proposal.status).toBe("approved");
    expect((await approvalsOf(w, p.id))[0]).toMatchObject({ over_cap_ack: true });
  });
});

describe.skipIf(!available)("a client's own yes", () => {
  let w: World;
  let accountId: string;
  const scope = "company:acme";
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    await w.harness.emit("plugin.partnersinbiz.crm.company.upserted", { id: "acme", name: "Acme Ltd", domain: null, lifecycle: "customer", updatedAt: "2026-10-01T00:00:00Z" }, { companyId: COMPANY });
    await w.harness.emit("plugin.partnersinbiz.crm.client.projects.updated", { clientKind: "company", clientRef: "acme", projectIds: ["proj-acme"], updatedAt: "2026-10-01T00:00:00Z" }, { companyId: COMPANY });
    w.harness.seed({ projects: [{ id: "proj-acme", companyId: COMPANY, name: "Acme", status: "in_progress" } as never] });
    ({ accountId } = await syncedAccount(w, { scope, externalId: "ext-acme", signoffs: "owner_client" }));
  });

  it("needs the owner AND the client; the Account Manager is asked to ask the client through the CRM, in the client's project", async () => {
    const p = await propose(w, CREATE(accountId, { scopeKey: scope }));
    expect(p.requires_signoffs).toEqual(["owner", "client"]);
    expect(await issueOf(w, p.approval_issue_id)).toMatchObject({ assigneeAgentId: REVIEWER });
    // The client is not asked until the Reviewer's check stands.
    expect((await w.issues()).filter((i) => i.originId?.startsWith("ads-client-ask:"))).toEqual([]);
    await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass" });
    const ask = (await w.issues()).find((i) => i.originId === `ads-client-ask:${p.id}`)!;
    expect(ask).toMatchObject({ assigneeAgentId: AM_AGENT, status: "todo" });
    expect(ask.description).toContain("create-client-action");
    expect(ask.description).toContain("We would like your OK before we change your ads (Acme Ltd).");
    expect(ask.description).toContain("**a person records it**");
    expect((ask as { projectId?: string }).projectId).toBe("proj-acme");
    expect((await issueOf(w, p.approval_issue_id) as { projectId?: string }).projectId).toBe("proj-acme");
  });

  it("the owner's yes alone does not approve it; the client's yes needs a person and what the client wrote", async () => {
    const p = await propose(w, CREATE(accountId, { scopeKey: scope }));
    await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass" });
    const owner = await recordSignoff(w.rt(), { proposalId: p.id, userId: OWNER, role: "owner", decision: "approved", via: "page" });
    expect(owner.proposal.status).toBe("in_review");
    expect((await proposalDetail(w.rt(), p.id)).signoffs.missing).toEqual(["client"]);
    await expect(recordSignoff(w.rt(), { proposalId: p.id, userId: OWNER, role: "client", decision: "approved", via: "page" })).rejects.toThrow(/what the client wrote/);
    await expect(recordSignoff(w.rt(), { proposalId: p.id, userId: null, role: "client", decision: "approved", note: "Jo said yes on the phone", via: "page" })).rejects.toThrow(/signed-in person/);
    const both = await recordSignoff(w.rt(), { proposalId: p.id, userId: OWNER, role: "client", decision: "approved", note: "Jo replied on 5 Oct: yes, go ahead", evidenceRef: p.id, via: "page" });
    expect(both.proposal.status).toBe("approved");
    expect((await approvalsOf(w, p.id)).find((a) => a.role === "client")).toMatchObject({ note: "Jo replied on 5 Oct: yes, go ahead" });
  });

  it("records which CRM request asked the client, and the Account Manager's close is checked against it", async () => {
    const p = await propose(w, CREATE(accountId, { scopeKey: scope }));
    await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass" });
    const ask = (await w.issues()).find((i) => i.originId === `ads-client-ask:${p.id}`)!;
    // Closing before the request is recorded is reopened by the done-check.
    await closeIssueAs(w, ask.id, "done", { type: "agent", id: AM_AGENT });
    expect(await issueOf(w, ask.id)).toMatchObject({ status: "todo" });
    expect(w.comments(ask.id).join("\n")).toContain("The client has not been asked yet");
    await recordClientRequest(w.rt(), { agentId: AM_AGENT }, p.id, "action-123");
    expect((await getProposal(w.ctx, COMPANY, p.id))!.client_action_ref).toBe("action-123");
    await closeIssueAs(w, ask.id, "done", { type: "agent", id: AM_AGENT });
    expect(await issueOf(w, ask.id)).toMatchObject({ status: "done" });
  });

  it("a pause needs only the owner: stopping spend does not wait for the client", async () => {
    const p = await propose(w, { kind: "pause_campaign", scopeKey: scope, targets: [{ accountId, campaignExternalId: "c1" }], reason: "Over budget" });
    expect(p.requires_signoffs).toEqual(["owner"]);
  });

  it("a client scope's issues open in the client's own project, never another client's", async () => {
    const p = await propose(w, CREATE(accountId, { scopeKey: scope }));
    expect(((await issueOf(w, p.approval_issue_id)) as { projectId?: string }).projectId).toBe("proj-acme");
  });
});

describe.skipIf(!available)("budget alerts never pause anything by themselves", () => {
  let w: World;
  let accountId: string;
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
  });

  it("at 90% of the cap it opens ONE pause request for a person, and nothing is paused", async () => {
    // 60 000 spent of a 64 000 cap = 94%
    ({ accountId } = await syncedAccount(w, { cap: 64_000 }));
    const first = await evaluateCompany(w.rt());
    expect(first).toMatchObject({ pauseRequests: 1 });
    const proposals = await listProposals(w.ctx, COMPANY, {});
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: "pause_campaign", origin: "budget_90", origin_ref: "pause:own:2026-10", status: "in_review", requires_signoffs: ["owner"] });
    expect((proposals[0]!.payload.targets as Array<{ campaignExternalId: string }>).map((t) => t.campaignExternalId).sort()).toEqual(["c1", "c3"]);
    expect(w.mock.writes).toEqual([]);
    const alerts = await listAlerts(w.ctx, COMPANY, { status: "open" });
    expect(alerts.map((a) => a.kind)).toEqual(["budget_90"]);
    // A second look raises nothing new.
    const second = await evaluateCompany(w.rt());
    expect(second).toMatchObject({ alertsNew: 0, pauseRequests: 0 });
    expect(await listProposals(w.ctx, COMPANY, {})).toHaveLength(1);
    expect(accountId).toBeTruthy();
  });

  it("reaching 100% adds a note to the same request instead of a second one", async () => {
    ({ accountId } = await syncedAccount(w, { cap: 64_000 }));
    await evaluateCompany(w.rt());
    const [request] = await listProposals(w.ctx, COMPANY, {});
    // Spend overshoots: the cap is now below what was spent.
    const { updateScope } = await import("../src/db.js");
    await updateScope(w.ctx, COMPANY, "own", { monthlyCapMinor: 60_000 });
    await evaluateCompany(w.rt());
    expect(await listProposals(w.ctx, COMPANY, {})).toHaveLength(1);
    expect(w.comments(request!.approval_issue_id!).join("\n")).toMatch(/budget is now fully used/);
    expect((await listAlerts(w.ctx, COMPANY, {})).map((a) => a.kind).sort()).toEqual(["budget_100", "budget_90"]);
    // The job looks every 3 hours: the note is made once, not at every look.
    await evaluateCompany(w.rt());
    await evaluateCompany(w.rt());
    expect(w.comments(request!.approval_issue_id!).filter((c) => /fully used/.test(c))).toHaveLength(1);
  });

  describe("when the request is not acted on", () => {
    const asked = async () => (await listProposals(w.ctx, COMPANY, {})).sort((a, b) => (a.origin_ref ?? "").localeCompare(b.origin_ref ?? ""));
    const refuse = (id: string) => recordSignoff(w.rt(), { proposalId: id, userId: OWNER, role: "owner", decision: "rejected", via: "page" });

    it("a person's no is a decision, not asked again at 90%; 100% after a no is worse news and is asked once, then it is final", async () => {
      ({ accountId } = await syncedAccount(w, { cap: 64_000 }));
      await evaluateCompany(w.rt());
      const [first] = await asked();
      await refuse(first!.id);
      expect(await evaluateCompany(w.rt())).toMatchObject({ pauseRequests: 0 });
      expect(await asked()).toHaveLength(1);
      // Spend overshoots the cap: the fully spent budget must not go quiet.
      const { updateScope } = await import("../src/db.js");
      await updateScope(w.ctx, COMPANY, "own", { monthlyCapMinor: 60_000 });
      expect(await evaluateCompany(w.rt())).toMatchObject({ pauseRequests: 1 });
      const both = await asked();
      expect(both.map((p) => [p.origin, p.origin_ref, p.status])).toEqual([["budget_90", "pause:own:2026-10", "rejected"], ["budget_100", "pause:own:2026-10:2", "in_review"]]);
      await refuse(both[1]!.id);
      expect(await evaluateCompany(w.rt())).toMatchObject({ pauseRequests: 0 });
      expect(await evaluateCompany(w.rt())).toMatchObject({ pauseRequests: 0 });
      expect(await asked()).toHaveLength(2);
      expect(w.mock.writes).toEqual([]);
    });

    it("a request nobody answered expires and is asked again, three times in a month at most", async () => {
      ({ accountId } = await syncedAccount(w, { cap: 64_000 }));
      await evaluateCompany(w.rt());
      for (const round of [1, 2]) {
        const current = (await asked()).at(-1)!;
        await updateProposal(w.ctx, COMPANY, current.id, { status: "expired" });
        expect(await evaluateCompany(w.rt()), `round ${round}`).toMatchObject({ pauseRequests: 1 });
      }
      expect((await asked()).map((p) => [p.origin_ref, p.status])).toEqual([["pause:own:2026-10", "expired"], ["pause:own:2026-10:2", "expired"], ["pause:own:2026-10:3", "in_review"]]);
      await updateProposal(w.ctx, COMPANY, (await asked()).at(-1)!.id, { status: "expired" });
      expect(await evaluateCompany(w.rt())).toMatchObject({ pauseRequests: 0 });
      expect(await asked()).toHaveLength(3);
    });

    it("a pause that ran is the answer: nothing more is asked that month", async () => {
      ({ accountId } = await syncedAccount(w, { cap: 64_000 }));
      await evaluateCompany(w.rt());
      const [first] = await asked();
      await recordSignoff(w.rt(), { proposalId: first!.id, userId: OWNER, role: "owner", decision: "approved", via: "page" });
      await markDoneManually(w.rt(), { proposalId: first!.id, userId: OWNER, note: "Paused in Ads Manager" });
      expect((await asked())[0]!.status).toBe("executed");
      expect(await evaluateCompany(w.rt())).toMatchObject({ pauseRequests: 0 });
      expect(await asked()).toHaveLength(1);
    });
  });

  it("does nothing without a cap, and nothing when well inside it", async () => {
    ({ accountId } = await syncedAccount(w, { cap: null }));
    expect(await evaluateCompany(w.rt())).toMatchObject({ alertsNew: 0, pauseRequests: 0 });
    const { updateScope } = await import("../src/db.js");
    await updateScope(w.ctx, COMPANY, "own", { monthlyCapMinor: 900_000 });
    expect(await evaluateCompany(w.rt())).toMatchObject({ alertsNew: 0, pauseRequests: 0 });
  });

  it("the pause request goes to the Reviewer, then the owner; approving it does not run it while changes are off", async () => {
    ({ accountId } = await syncedAccount(w, { cap: 64_000, allowWrites: false }));
    await evaluateCompany(w.rt());
    const [request] = await listProposals(w.ctx, COMPANY, {});
    expect(await issueOf(w, request!.approval_issue_id)).toMatchObject({ assigneeAgentId: REVIEWER });
    await recordSignoff(w.rt(), { proposalId: request!.id, userId: OWNER, role: "owner", decision: "approved", via: "page" });
    const run = (await w.issues()).find((i) => i.originId === `ads-run:${request!.id}`)!;
    expect(run.description).toContain("Changes to ads are **off**");
    expect(w.mock.writes).toEqual([]);
  });
});

describe.skipIf(!available)("anomaly alerts", () => {
  let w: World;
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
  });

  it("raises a spend spike once, with an issue for the ads agent, and a repeat look adds nothing", async () => {
    const acct = await syncedAccount(w);
    // Today's spend is 4x the usual.
    w.mock.insightRows["ext-1"] = [...w.mock.insightRows["ext-1"]!, { campaignExternalId: "c1", campaignName: "Campaign c1", day: "2026-10-15", spendMinor: 40_000, impressions: 3000, clicks: 100, conversions: 2, valueMinor: 0 }];
    const { syncAccount } = await import("../src/sync.js");
    const { getAccount } = await import("../src/db.js");
    await syncAccount(w.rt(), (await getAccount(w.ctx, COMPANY, acct.accountId))!);
    const first = await evaluateCompany(w.rt());
    expect(first).toMatchObject({ alertsNew: 1, issuesOpened: 1 });
    const [alert] = await listAlerts(w.ctx, COMPANY, { status: "open" });
    expect(alert).toMatchObject({ kind: "spend_spike", severity: "warn", campaign_external_id: "c1" });
    const issue = (await w.issues()).find((i) => i.originId === `ads-alert:${alert!.id}`)!;
    expect(issue).toMatchObject({ assigneeAgentId: ADS_AGENT, status: "todo" });
    expect(issue.description).toContain("acknowledge-ad-alert");
    expect(await evaluateCompany(w.rt())).toMatchObject({ alertsNew: 0, issuesOpened: 0 });
    expect((await w.issues()).filter((i) => i.originId?.startsWith("ads-alert:"))).toHaveLength(1);
  });

  it("an alert issue closed by the agent without a note is reopened; with the alert acknowledged it stays closed", async () => {
    const acct = await syncedAccount(w);
    w.mock.insightRows["ext-1"] = [...w.mock.insightRows["ext-1"]!, { campaignExternalId: "c1", campaignName: "Campaign c1", day: "2026-10-15", spendMinor: 40_000, impressions: 3000, clicks: 100, conversions: 2, valueMinor: 0 }];
    const { syncAccount } = await import("../src/sync.js");
    const { getAccount } = await import("../src/db.js");
    await syncAccount(w.rt(), (await getAccount(w.ctx, COMPANY, acct.accountId))!);
    await evaluateCompany(w.rt());
    const [alert] = await listAlerts(w.ctx, COMPANY, { status: "open" });
    const issue = (await w.issues()).find((i) => i.originId === `ads-alert:${alert!.id}`)!;
    await closeIssueAs(w, issue.id, "done", { type: "agent", id: ADS_AGENT });
    expect(await issueOf(w, issue.id)).toMatchObject({ status: "todo" });
    expect(w.comments(issue.id).join("\n")).toContain("The alert is still open");
    const { acknowledgeAlert } = await import("../src/evaluate.js");
    await acknowledgeAlert(w.rt(), { agentId: ADS_AGENT }, alert!.id, "Expected: the client launched a sale");
    await closeIssueAs(w, issue.id, "done", { type: "agent", id: ADS_AGENT });
    expect(await issueOf(w, issue.id)).toMatchObject({ status: "done" });
  });

  it("flags a campaign that stopped delivering, and cost per result over the scope's target", async () => {
    const acct = await syncedAccount(w, { spend: 8000 });
    const { updateScope, getAccount } = await import("../src/db.js");
    const { syncAccount } = await import("../src/sync.js");
    await updateScope(w.ctx, COMPANY, "own", { targetCpaMinor: 1000 });
    // Yesterday the platform shows nothing for c1: it was delivering until the day before.
    w.mock.insightRows["ext-1"] = w.mock.insightRows["ext-1"]!.filter((r) => !(r.campaignExternalId === "c1" && r.day === "2026-10-14"));
    await syncAccount(w.rt(), (await getAccount(w.ctx, COMPANY, acct.accountId))!);
    const result = await evaluateCompany(w.rt());
    // c1: 6 days x 8000 = 48 000 for 18 results = 2 666 each, against a target of 1 000
    const kinds = (await listAlerts(w.ctx, COMPANY, {})).map((a) => `${a.kind}:${a.campaign_external_id}`).sort();
    expect(kinds).toContain("cpa_over_target:c1");
    expect(kinds).toContain("zero_delivery:c1");
    expect(kinds).not.toContain("zero_delivery:c3");
    expect(result.alertsNew).toBeGreaterThan(0);
  });

  it("caps how many alert issues it opens, but still records every alert", async () => {
    await syncedAccount(w);
    const { insertAlert, setAlertIssue } = await import("../src/db.js");
    for (let i = 0; i < 8; i += 1) {
      const id = await insertAlert(w.ctx, COMPANY, { scopeKey: "own", accountId: null, campaignExternalId: null, kind: "sync_failed", severity: "warn", dedupeKey: `seed:${i}`, title: "t", body: "b", detail: {} });
      await setAlertIssue(w.ctx, COMPANY, id, `issue-${i}`);
    }
    const { updateScope } = await import("../src/db.js");
    await updateScope(w.ctx, COMPANY, "own", { targetCpaMinor: 1000 });
    const before = (await w.issues()).length;
    const result = await evaluateCompany(w.rt());
    expect(result.alertsNew).toBeGreaterThan(0);
    expect(result.issuesOpened).toBe(0);
    expect((await w.issues()).length).toBe(before);
  });

  it("resolves alerts nobody saw again for a week", async () => {
    await syncedAccount(w);
    const { insertAlert } = await import("../src/db.js");
    const id = await insertAlert(w.ctx, COMPANY, { scopeKey: "own", accountId: null, campaignExternalId: null, kind: "spend_spike", severity: "warn", dedupeKey: "old", title: "t", body: "b", detail: {} });
    await pg.client.query(`UPDATE ${w.ctx.db.namespace}.alerts SET last_seen_at = $1 WHERE id = $2`, [new Date(NOW.getTime() - 9 * 86_400_000).toISOString(), id]);
    expect(await resolveStaleAlerts(w.rt())).toBe(1);
    expect((await listAlerts(w.ctx, COMPANY, { status: "resolved" })).map((a) => a.id)).toEqual([id]);
  });
});

describe.skipIf(!available)("who gets the work when roles are missing", () => {
  it("falls back to the Operator and then the owner, never an unassigned approval", async () => {
    await pg.reset();
    const noReviewer = await world(pg, { roles: { reviewer: false } });
    const a = await syncedAccount(noReviewer);
    const p = await propose(noReviewer, CREATE(a.accountId));
    expect((await noReviewer.issues()).find((i) => i.id === p.approval_issue_id)).toMatchObject({ assigneeUserId: OWNER });
    await pg.reset();
    const nobody = await world(pg, { roles: { reviewer: false, owner: false } });
    const b = await syncedAccount(nobody);
    const q = await propose(nobody, CREATE(b.accountId));
    const issue = (await nobody.issues()).find((i) => i.id === q.approval_issue_id)!;
    expect(issue.assigneeAgentId).toBe(OPERATOR);
    expect(issue.description).toMatch(/No approver found/);
  });
});

describe("the proposal error type", () => {
  it("carries a code the page and tools can act on", () => {
    expect(new AdsError("x", "over_cap").code).toBe("over_cap");
    expect(updateProposal).toBeTypeOf("function");
  });
});
