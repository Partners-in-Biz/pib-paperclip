/**
 * Nothing that spends money runs without a recorded human approval. These tests drive `executeProposal` through every refusal and the paths that
 * run, on a real Postgres, with a mock platform that records every write it is asked for.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAccount, getProposal, listProposals, updateAccount, updateConnection, updateScope } from "../src/db.js";
import { AdsError } from "../src/domain.js";
import { executeProposal } from "../src/execute.js";
import { ProviderError } from "../src/providers/http.js";
import { recordReview, recordSignoff, sweepProposals } from "../src/proposals.js";
import { runtimeFromRaw } from "../src/runtime.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";
import { ADS_AGENT, COMPANY, NOW, OWNER, REVIEWER, UI_BASE, settings, world, type World } from "./helpers/world.js";
import { approvalsOf, CREATE, CREATE_AD_SET, CREATE_AD_CREATIVE, CREATE_AD, propose, syncedAccount } from "./helpers/scenario.js";

const available = await embeddedAvailable();
let pg: Pg;
beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);
afterAll(async () => {
  if (available) await pg.stop();
});

const agent = { agentId: ADS_AGENT };

/** Proposes, has the Reviewer pass it, and has the owner approve it on the page. Returns the proposal and the owner's approval id. */
async function approved(w: World, input: Record<string, unknown>, options: { overCapAck?: boolean } = {}) {
  const p = await propose(w, input);
  await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass" });
  const { approvalId } = await recordSignoff(w.rt(), { proposalId: p.id, userId: OWNER, role: "owner", decision: "approved", overCapAck: options.overCapAck === true, via: "page" });
  return { id: p.id, approvalId };
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AdsError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected the change to be refused, but it ran");
}

describe.skipIf(!available)("running an approved change", () => {
  let w: World;
  let accountId: string;
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    ({ accountId } = await syncedAccount(w));
  });

  it("creates the campaign PAUSED, records what ran, uses the approval up and closes the run task", async () => {
    const { id, approvalId } = await approved(w, CREATE(accountId));
    const run = (await w.issues()).find((i) => i.originId === `ads-run:${id}`)!;
    const result = await executeProposal(w.rt(), agent, { proposalId: id, approvalId });
    expect(result).toMatchObject({ status: "executed", results: [{ ok: true, what: 'Created "Spring leads" (paused)' }] });
    expect(w.mock.writes).toEqual([{ op: "create", accountExternalId: "ext-1", campaignExternalId: expect.any(String), name: "Spring leads", objective: "OUTCOME_LEADS", dailyBudgetMinor: 5000, status: "paused" }]);
    const after = (await getProposal(w.ctx, COMPANY, id))!;
    expect(after).toMatchObject({ status: "executed", error: null });
    expect(after.execution).toMatchObject({ approvalId, by: `agent:${ADS_AGENT}` });
    expect((await approvalsOf(w, id))[0]!.consumed_at).toEqual(expect.any(String));
    expect((await w.issues()).find((i) => i.id === run.id)).toMatchObject({ status: "done" });
    // The new campaign shows up after the follow-up read, paused, and is not switched on by the same change.
    expect(w.mock.campaigns["ext-1"]!.find((c) => c.name === "Spring leads")).toMatchObject({ status: "paused" });
    // The approval cannot run it again.
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: id, approvalId }))).toMatchObject({ code: "not_approved" });
    expect(w.mock.writes).toHaveLength(1);
  });

  it("changes a budget, pauses and resumes: each is one platform call with the numbers that were approved", async () => {
    const budget = await approved(w, { kind: "change_budget", scopeKey: "own", accountId, campaignExternalId: "c1", newDailyBudgetMinor: 11_000, reason: "Returns are 3x" });
    expect(await executeProposal(w.rt(), agent, { proposalId: budget.id, approvalId: budget.approvalId })).toMatchObject({ status: "executed" });
    expect(w.mock.writes.at(-1)).toEqual({ op: "budget", accountExternalId: "ext-1", campaignExternalId: "c1", dailyBudgetMinor: 11_000 });

    const pause = await approved(w, { kind: "pause_campaign", scopeKey: "own", targets: [{ accountId, campaignExternalId: "c1" }, { accountId, campaignExternalId: "c3" }], reason: "Over budget" });
    const paused = await executeProposal(w.rt(), agent, { proposalId: pause.id, approvalId: pause.approvalId });
    expect(paused.results.map((r) => r.what)).toEqual(['Paused "Campaign c1"', 'Paused "Campaign c3"']);
    expect(w.mock.writes.slice(-2).map((x) => [x.op, x.campaignExternalId, x.status])).toEqual([["status", "c1", "paused"], ["status", "c3", "paused"]]);

    const resume = await approved(w, { kind: "resume_campaign", scopeKey: "own", targets: [{ accountId, campaignExternalId: "c2" }], reason: "Sale starts" });
    await executeProposal(w.rt(), agent, { proposalId: resume.id, approvalId: resume.approvalId });
    expect(w.mock.writes.at(-1)).toMatchObject({ op: "status", campaignExternalId: "c2", status: "active" });
  });

  it("a person can run it from the page with their own approval", async () => {
    const { id, approvalId } = await approved(w, { kind: "pause_campaign", scopeKey: "own", targets: [{ accountId, campaignExternalId: "c1" }], reason: "x" });
    const result = await executeProposal(w.rt(), { userId: OWNER }, { proposalId: id, approvalId });
    expect(result.status).toBe("executed");
    expect((await getProposal(w.ctx, COMPANY, id))!.execution).toMatchObject({ by: `user:${OWNER}` });
  });

  it("only one of two simultaneous calls runs: the approval is used once", async () => {
    const { id, approvalId } = await approved(w, CREATE(accountId));
    const outcomes = await Promise.allSettled([executeProposal(w.rt(), agent, { proposalId: id, approvalId }), executeProposal(w.rt(), agent, { proposalId: id, approvalId })]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);
    expect(w.mock.writes).toHaveLength(1);
  });

  it("a platform failure is recorded, the approval stays used and nothing is retried by itself", async () => {
    const { id, approvalId } = await approved(w, CREATE(accountId));
    w.mock.failNext.create = new ProviderError("Meta: (#100) Invalid parameter (HTTP 400)", { status: 400 });
    const result = await executeProposal(w.rt(), agent, { proposalId: id, approvalId });
    expect(result).toMatchObject({ status: "failed", results: [{ ok: false, error: expect.stringContaining("Invalid parameter") }] });
    expect(await getProposal(w.ctx, COMPANY, id)).toMatchObject({ status: "failed", error: expect.stringContaining("Invalid parameter") });
    expect(w.mock.writes).toEqual([]);
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: id, approvalId }))).toMatchObject({ code: "not_approved" });
    expect((await w.issues()).find((i) => i.originId === `ads-run:${id}`)).toMatchObject({ status: "done" });
    expect(w.comments((await getProposal(w.ctx, COMPANY, id))!.approval_issue_id!).join("\n")).toContain("Did not complete");
  });

  it("stops at the first failure of several and says which part ran", async () => {
    const { id, approvalId } = await approved(w, { kind: "pause_campaign", scopeKey: "own", targets: [{ accountId, campaignExternalId: "c1" }, { accountId, campaignExternalId: "c3" }], reason: "x" });
    let calls = 0;
    const original = w.mock.setCampaignStatus.bind(w.mock);
    w.mock.setCampaignStatus = async (...args: Parameters<typeof original>) => {
      calls += 1;
      if (calls === 2) throw new ProviderError("Rate limit (HTTP 429)", { retryable: true, status: 429 });
      return original(...args);
    };
    const result = await executeProposal(w.rt(), agent, { proposalId: id, approvalId });
    expect(result.status).toBe("failed");
    expect(result.results.map((r) => r.ok)).toEqual([true, false]);
    expect(w.mock.writes).toHaveLength(1);
  });

  it("a platform that rejects the sign-in during a change flags the connection for a person", async () => {
    const { id, approvalId } = await approved(w, CREATE(accountId));
    w.mock.failNext.create = new ProviderError("Invalid OAuth access token", { tokenInvalid: true, status: 401 });
    await executeProposal(w.rt(), agent, { proposalId: id, approvalId });
    expect((await w.issues()).filter((i) => i.originId?.startsWith("ads-reconnect:"))).toHaveLength(1);
  });
});

describe.skipIf(!available)("every way a change is refused, and the approval is not wasted", () => {
  let w: World;
  let accountId: string;
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    ({ accountId } = await syncedAccount(w));
  });

  it("not approved yet, or no approval id at all", async () => {
    const p = await propose(w, CREATE(accountId));
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: p.id, approvalId: "whatever" }))).toMatchObject({ code: "not_approved" });
    const { id } = await approved(w, CREATE(accountId, { name: "Second" }));
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: id, approvalId: "" }))).toMatchObject({ code: "no_approval" });
    expect(w.mock.writes).toEqual([]);
  });

  it("an approval id that is not an approval of this proposal, or not a person's owner yes", async () => {
    const one = await approved(w, CREATE(accountId, { name: "One" }));
    const two = await approved(w, CREATE(accountId, { name: "Two", dailyBudgetMinor: 4000 }));
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: one.id, approvalId: two.approvalId }))).toMatchObject({ code: "bad_approval" });
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: one.id, approvalId: "00000000-0000-0000-0000-000000000000" }))).toMatchObject({ code: "bad_approval" });
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: "no-such-proposal", approvalId: one.approvalId }).catch((e) => Promise.reject(e instanceof AdsError ? Object.assign(e, { code: "missing" }) : e)))).toMatchObject({ code: "missing" });
    // Unused after the refusals: the right id still runs.
    expect((await executeProposal(w.rt(), agent, { proposalId: one.id, approvalId: one.approvalId })).status).toBe("executed");
    expect(w.mock.writes).toHaveLength(1);
  });

  it("an approval older than 72 hours, and numbers that changed after the yes", async () => {
    const { id, approvalId } = await approved(w, CREATE(accountId));
    const late = new Date(NOW.getTime() + 73 * 3_600_000);
    expect(await refusal(executeProposal(w.rt(undefined, late), agent, { proposalId: id, approvalId }))).toMatchObject({ code: "approval_expired" });
    // Simulate the numbers changing underneath an approved proposal (a write that bypassed the service): the hash no longer matches.
    await pg.client.query(`UPDATE ${w.ctx.db.namespace}.proposals SET content_hash = 'changed' WHERE id = $1`, [id]);
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: id, approvalId }))).toMatchObject({ code: "approval_stale" });
    expect(w.mock.writes).toEqual([]);
  });

  it("a sign-off that is still missing, and a Reviewer check that does not stand", async () => {
    await pg.reset();
    const c = await world(pg);
    await c.harness.emit("plugin.partnersinbiz.crm.company.upserted", { id: "acme", name: "Acme Ltd", domain: null, lifecycle: null, updatedAt: "2026-10-01T00:00:00Z" }, { companyId: COMPANY });
    const acct = await syncedAccount(c, { scope: "company:acme", externalId: "ext-acme", signoffs: "owner_client" });
    const p = await propose(c, CREATE(acct.accountId, { scopeKey: "company:acme" }));
    await recordReview(c.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass" });
    const { approvalId } = await recordSignoff(c.rt(), { proposalId: p.id, userId: OWNER, role: "owner", decision: "approved", via: "page" });
    expect(await refusal(executeProposal(c.rt(), agent, { proposalId: p.id, approvalId }))).toMatchObject({ code: "not_approved" });
    await recordSignoff(c.rt(), { proposalId: p.id, userId: OWNER, role: "client", decision: "approved", note: "Jo replied: yes please go ahead", via: "page" });
    await pg.client.query(`UPDATE ${c.ctx.db.namespace}.proposals SET review_state = 'pending' WHERE id = $1`, [p.id]);
    expect(await refusal(executeProposal(c.rt(), agent, { proposalId: p.id, approvalId }))).toMatchObject({ code: "review_missing" });
    await pg.client.query(`UPDATE ${c.ctx.db.namespace}.proposals SET review_state = 'pass' WHERE id = $1`, [p.id]);
    expect((await executeProposal(c.rt(), agent, { proposalId: p.id, approvalId })).status).toBe("executed");
  });

  it("changes switched off for the company, or for the scope", async () => {
    const { id, approvalId } = await approved(w, CREATE(accountId));
    const off = runtimeFromRaw(w.ctx, COMPANY, settings({ writes: { enabled: false } }), { provider: () => w.mock, now: () => NOW }, UI_BASE);
    expect(await refusal(executeProposal(off, agent, { proposalId: id, approvalId }))).toMatchObject({ code: "writes_off", message: expect.stringContaining("plugin settings") });
    await updateScope(w.ctx, COMPANY, "own", { allowWrites: false, allowWritesBy: `user:${OWNER}` });
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: id, approvalId }))).toMatchObject({ code: "writes_off", message: expect.stringContaining("for this scope") });
    expect(w.mock.writes).toEqual([]);
    await updateScope(w.ctx, COMPANY, "own", { allowWrites: true, allowWritesBy: `user:${OWNER}` });
    expect((await executeProposal(w.rt(), agent, { proposalId: id, approvalId })).status).toBe("executed");
  });

  it("a read-only connection, a connection that needs signing in, an account that is gone", async () => {
    const { id, approvalId } = await approved(w, CREATE(accountId));
    const account = (await getAccount(w.ctx, COMPANY, accountId))!;
    await updateConnection(w.ctx, COMPANY, account.connection_id!, { canWrite: false });
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: id, approvalId }))).toMatchObject({ code: "read_only_connection" });
    await updateConnection(w.ctx, COMPANY, account.connection_id!, { canWrite: true, status: "needs_reconnect" });
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: id, approvalId }))).toMatchObject({ code: "connection_down" });
    await updateConnection(w.ctx, COMPANY, account.connection_id!, { status: "connected" });
    await updateAccount(w.ctx, COMPANY, accountId, { status: "disabled" });
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: id, approvalId }))).toMatchObject({ code: "account_gone" });
    expect(w.mock.writes).toEqual([]);
  });

  it("a change that adds spend needs a cap to be checked against", async () => {
    const { id, approvalId } = await approved(w, CREATE(accountId));
    await updateScope(w.ctx, COMPANY, "own", { monthlyCapMinor: null });
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: id, approvalId }))).toMatchObject({ code: "no_cap" });
    // A pause adds no spend, so it needs no cap.
    const pause = await approved(w, { kind: "pause_campaign", scopeKey: "own", targets: [{ accountId, campaignExternalId: "c1" }], reason: "x" });
    expect((await executeProposal(w.rt(), agent, { proposalId: pause.id, approvalId: pause.approvalId })).status).toBe("executed");
  });

  it("the cap is checked again when it runs: spend that rose since the yes can push it over, unless the approver accepted that", async () => {
    // 5 000/day for a campaign fits (85 000 of 100 000 headroom). Then the cap is lowered before it runs.
    const { id, approvalId } = await approved(w, CREATE(accountId));
    await updateScope(w.ctx, COMPANY, "own", { monthlyCapMinor: 450_000 });
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: id, approvalId }))).toMatchObject({ code: "over_cap" });
    expect(w.mock.writes).toEqual([]);
    // The same numbers approved with "over the cap" accepted run.
    await updateScope(w.ctx, COMPANY, "own", { monthlyCapMinor: 500_000 });
    const big = await approved(w, CREATE(accountId, { name: "Big", dailyBudgetMinor: 8000 }), { overCapAck: true });
    expect((await executeProposal(w.rt(), agent, { proposalId: big.id, approvalId: big.approvalId })).status).toBe("executed");
  });

  it("a budget change against a budget that moved since is a new proposal; a campaign that already exists is not created twice", async () => {
    const change = await approved(w, { kind: "change_budget", scopeKey: "own", accountId, campaignExternalId: "c1", newDailyBudgetMinor: 12_000, reason: "x" });
    await pg.client.query(`UPDATE ${w.ctx.db.namespace}.campaigns SET daily_budget_minor = 9000 WHERE external_id = 'c1'`);
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: change.id, approvalId: change.approvalId }))).toMatchObject({ code: "stale" });
    const dup = await approved(w, CREATE(accountId, { name: "Campaign c1" }));
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: dup.id, approvalId: dup.approvalId }))).toMatchObject({ code: "duplicate" });
    expect(w.mock.writes).toEqual([]);
  });

  it("a resume is refused when the campaign's budget is not the one that was checked and approved", async () => {
    const resume = await approved(w, { kind: "resume_campaign", scopeKey: "own", targets: [{ accountId, campaignExternalId: "c2" }], reason: "Sale starts" });
    // Somebody raised the budget in the platform (and the sync saw it) after the yes: the cap was checked against 5000, not 20000.
    await pg.client.query(`UPDATE ${w.ctx.db.namespace}.campaigns SET daily_budget_minor = 20000 WHERE external_id = 'c2'`);
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: resume.id, approvalId: resume.approvalId }))).toMatchObject({ code: "stale", message: expect.stringContaining("Campaign c2") });
    expect(w.mock.writes).toEqual([]);
    expect((await getProposal(w.ctx, COMPANY, resume.id))!.status).toBe("approved");
    await pg.client.query(`UPDATE ${w.ctx.db.namespace}.campaigns SET daily_budget_minor = 5000 WHERE external_id = 'c2'`);
    expect((await executeProposal(w.rt(), agent, { proposalId: resume.id, approvalId: resume.approvalId })).status).toBe("executed");
  });

  it("a run that was cut off (claimed, never finished) is closed as failed by the hourly sweep, loudly, and never retried", async () => {
    const { id, approvalId } = await approved(w, CREATE(accountId));
    const fresh = await approved(w, CREATE(accountId, { name: "Fresh run" }));
    const setAge = (proposalId: string, ms: number) => pg.client.query(`UPDATE ${w.ctx.db.namespace}.proposals SET status = 'executing', updated_at = $2 WHERE id = $1`, [proposalId, new Date(NOW.getTime() - ms).toISOString()]);
    await setAge(id, 3 * 3_600_000);
    await setAge(fresh.id, 10 * 60_000);
    expect(await sweepProposals(w.rt())).toMatchObject({ interrupted: 1 });
    const after = (await getProposal(w.ctx, COMPANY, id))!;
    expect(after).toMatchObject({ status: "failed", execution: { interrupted: true } });
    expect(after.error).toMatch(/cut off.*may or may not have happened/s);
    expect((await getProposal(w.ctx, COMPANY, fresh.id))!.status).toBe("executing");
    expect((await w.issues()).find((i) => i.originId === `ads-run:${id}`)).toMatchObject({ status: "done" });
    expect(w.comments(after.approval_issue_id!).join("\n")).toMatch(/Run cut off/);
    const audited = (await pg.client.query(`SELECT subject FROM ${w.ctx.db.namespace}.audit WHERE action = 'write.interrupted'`)).rows as Array<{ subject: string }>;
    expect(audited).toEqual([{ subject: id }]);
    // Nothing ran, and the used-up approval cannot be used to try again.
    expect(w.mock.writes).toEqual([]);
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: id, approvalId }))).toMatchObject({ code: "not_approved" });
    // A second sweep finds nothing more to close.
    expect(await sweepProposals(w.rt())).toMatchObject({ interrupted: 0 });
  });

  it("ad copy is only checked: there is nothing to run", async () => {
    const p = await propose(w, { kind: "creative_check", scopeKey: "own", platform: "meta", creative: { headline: "Fresh coffee", landingUrl: "https://acme.test" } });
    await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: p.id, verdict: "pass" });
    const { approvalId } = await recordSignoff(w.rt(), { proposalId: p.id, userId: OWNER, role: "owner", decision: "approved", via: "page" });
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: p.id, approvalId }))).toMatchObject({ code: "nothing_to_run" });
  });

  it("every refusal is in the audit trail, with a reason and no secret", async () => {
    const { id, approvalId } = await approved(w, CREATE(accountId));
    await updateScope(w.ctx, COMPANY, "own", { allowWrites: false, allowWritesBy: `user:${OWNER}` });
    await refusal(executeProposal(w.rt(), agent, { proposalId: id, approvalId }));
    const rows = (await pg.client.query(`SELECT actor, action, detail FROM ${w.ctx.db.namespace}.audit WHERE action = 'write.refused'`)).rows as Array<{ actor: string; action: string; detail: { code: string; reason: string } }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: `agent:${ADS_AGENT}`, detail: { code: "writes_off" } });
    expect(JSON.stringify(rows)).not.toMatch(/token|secret|password/i);
  });
});

describe.skipIf(!available)("running an approved ad set", () => {
  let w: World;
  let accountId: string;
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    ({ accountId } = await syncedAccount(w, { platform: "meta", connectionPlatform: "mock" }));
  });

  it("is refused without an approval, and with only the owner's yes when the client must also sign off", async () => {
    const p = await propose(w, CREATE_AD_SET(accountId));
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: p.id, approvalId: "whatever" }))).toMatchObject({ code: "not_approved" });
    await pg.reset();
    const c = await world(pg);
    await c.harness.emit("plugin.partnersinbiz.crm.company.upserted", { id: "acme", name: "Acme Ltd", domain: null, lifecycle: null, updatedAt: "2026-10-01T00:00:00Z" }, { companyId: COMPANY });
    const acct = await syncedAccount(c, { scope: "company:acme", externalId: "ext-acme", signoffs: "owner_client", platform: "meta", connectionPlatform: "mock" });
    const q = await propose(c, CREATE_AD_SET(acct.accountId, { scopeKey: "company:acme" }));
    await recordReview(c.rt(), { agentId: REVIEWER }, { proposalId: q.id, verdict: "pass" });
    const { approvalId } = await recordSignoff(c.rt(), { proposalId: q.id, userId: OWNER, role: "owner", decision: "approved", via: "page" });
    expect(await refusal(executeProposal(c.rt(), agent, { proposalId: q.id, approvalId }))).toMatchObject({ code: "not_approved" });
    expect(c.mock.writes).toEqual([]);
  });

  it("creates the ad set PAUSED with the approved lifetime budget, once, and the approval is used up", async () => {
    const { id, approvalId } = await approved(w, CREATE_AD_SET(accountId));
    expect(await executeProposal(w.rt(), agent, { proposalId: id, approvalId })).toMatchObject({ status: "executed", results: [{ ok: true, externalId: expect.any(String) }] });
    expect(w.mock.writes).toEqual([{ op: "create_adset", accountExternalId: "ext-1", campaignExternalId: "c1", name: "Q4 audiences", lifetimeBudgetMinor: 10_000, status: "paused" }]);
    expect((await approvalsOf(w, id))[0]!.consumed_at).toEqual(expect.any(String));
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: id, approvalId }))).toMatchObject({ code: "not_approved" });
    expect(w.mock.writes).toHaveLength(1);
  });

  it("is refused when the numbers changed after the yes, and the lifetime budget counts against the cap", async () => {
    const changed = await approved(w, CREATE_AD_SET(accountId));
    await pg.client.query(`UPDATE ${w.ctx.db.namespace}.proposals SET content_hash = 'changed' WHERE id = $1`, [changed.id]);
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: changed.id, approvalId: changed.approvalId }))).toMatchObject({ code: "approval_stale" });
    // The lifetime budget counts against the month's cap: a yes without "over the cap" ticked is refused, and nothing runs.
    const big = await propose(w, CREATE_AD_SET(accountId, { name: "Big", lifetimeBudgetMinor: 400_000 }));
    await recordReview(w.rt(), { agentId: REVIEWER }, { proposalId: big.id, verdict: "pass" });
    await expect(recordSignoff(w.rt(), { proposalId: big.id, userId: OWNER, role: "owner", decision: "approved", via: "page" })).rejects.toThrow(/over the month's cap/);
    expect(w.mock.writes).toEqual([]);
  });
});

describe.skipIf(!available)("running ad creatives and ads", () => {
  let w: World;
  let accountId: string;
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    ({ accountId } = await syncedAccount(w, { platform: "meta", connectionPlatform: "mock" }));
  });

  it("creates the ad creative and uses the approval once", async () => {
    const { id, approvalId } = await approved(w, CREATE_AD_CREATIVE(accountId));
    const result = await executeProposal(w.rt(), agent, { proposalId: id, approvalId });
    expect(result).toMatchObject({ status: "executed", results: [{ ok: true, what: expect.stringContaining("Created creative") }] });
    expect(w.mock.writes).toEqual([{ op: "create_ad_creative", accountExternalId: "ext-1", name: "Q4 creative", pageId: "1234567890", imageHash: "abc123hash", videoId: null, link: "https://example.com/offer", headline: "Q4 Sale", body: "Get 30% off this October.", cta: "LEARN_MORE" }]);
    expect((await approvalsOf(w, id))[0]!.consumed_at).toEqual(expect.any(String));
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: id, approvalId }))).toMatchObject({ code: "not_approved" });
    expect(w.mock.writes).toHaveLength(1);
  });

  it("copies the executed creative to Drive, and a Drive failure does not fail the run", async () => {
    const saves: Array<{ kind: string; subfolder?: string }> = [];
    const { id, approvalId } = await approved(w, CREATE_AD_CREATIVE(accountId));
    const failing = async (_ctx: unknown, opts: { kind: string; subfolder?: string }) => { saves.push(opts); throw new Error("drive down"); };
    const result = await executeProposal({ ...w.rt(), driveSave: failing as never }, agent, { proposalId: id, approvalId });
    expect(result).toMatchObject({ status: "executed" });
    expect(saves).toEqual([expect.objectContaining({ kind: "ads", subfolder: "02 Assets" })]);
  });

  it("creates the ad from an ad set and creative", async () => {
    const { id, approvalId } = await approved(w, CREATE_AD(accountId));
    const result = await executeProposal(w.rt(), agent, { proposalId: id, approvalId });
    expect(result).toMatchObject({ status: "executed", results: [{ ok: true, what: expect.stringContaining("Created \"Q4 ad\" (paused)") }] });
    expect(w.mock.writes).toEqual([{ op: "create_ad", accountExternalId: "ext-1", name: "Q4 ad", adSetExternalId: "as1", creativeExternalId: "cr1", status: "paused" }]);
    expect((await approvalsOf(w, id))[0]!.consumed_at).toEqual(expect.any(String));
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: id, approvalId }))).toMatchObject({ code: "not_approved" });
    expect(w.mock.writes).toHaveLength(1);
  });

  it("rejects an ad creative proposal on a Google account", async () => {
    const google = await syncedAccount(w, { externalId: "ext-google", platform: "google", connectionPlatform: "mock" });
    expect(await refusal(propose(w, CREATE_AD_CREATIVE(google.accountId)))).toMatchObject({ message: expect.stringContaining("Ad creatives are only supported on Meta") });
  });

  it("rejects an ad proposal on a Google account", async () => {
    const google = await syncedAccount(w, { externalId: "ext-google", platform: "google", connectionPlatform: "mock" });
    expect(await refusal(propose(w, CREATE_AD(google.accountId)))).toMatchObject({ message: expect.stringContaining("Ads are only supported on Meta") });
  });

  it("validates creative input: exactly one of image or video, non-https link, headline and body lengths", async () => {
    expect(await refusal(propose(w, CREATE_AD_CREATIVE(accountId, { imageHash: "hash", videoId: "vid123" })))).toMatchObject({ message: expect.stringContaining("exactly one") });
    expect(await refusal(propose(w, CREATE_AD_CREATIVE(accountId, { imageHash: null, videoId: null })))).toMatchObject({ message: expect.stringContaining("exactly one") });
    expect(await refusal(propose(w, CREATE_AD_CREATIVE(accountId, { link: "http://insecure.com" })))).toMatchObject({ message: expect.stringContaining("https") });
    expect(await refusal(propose(w, CREATE_AD_CREATIVE(accountId, { headline: "" })))).toMatchObject({ message: expect.stringContaining("headline") });
  });

  it("validates ad input: non-empty ad set and creative ids, rejects status other than PAUSED", async () => {
    expect(await refusal(propose(w, CREATE_AD(accountId, { adSetExternalId: "" })))).toMatchObject({ message: expect.stringContaining("adSetExternalId") });
    expect(await refusal(propose(w, CREATE_AD(accountId, { creativeExternalId: "" })))).toMatchObject({ message: expect.stringContaining("creativeExternalId") });
    expect(await refusal(propose(w, CREATE_AD(accountId, { status: "ACTIVE" })))).toMatchObject({ message: expect.stringContaining("PAUSED") });
  });

  it("rejects budget fields on create_ad", async () => {
    expect(await refusal(propose(w, CREATE_AD(accountId, { dailyBudgetMinor: 5000 })))).toMatchObject({ message: expect.stringMatching(/budget/i) });
  });
});

describe.skipIf(!available)("running approved ad groups and keywords", () => {
  let w: World;
  let accountId: string;
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    ({ accountId } = await syncedAccount(w, { platform: "google", connectionPlatform: "mock" }));
  });

  it("are refused without an approval and write nothing", async () => {
    const g = await propose(w, { kind: "create_ad_group", scopeKey: "own", accountId, campaignExternalId: "c1", name: "Brand", cpcBidMinor: 1500, reason: "Structure." });
    const k = await propose(w, { kind: "add_keywords", scopeKey: "own", accountId, adGroupExternalId: "ag-1", keywords: [{ text: "shoes", matchType: "exact" }], reason: "Terms." });
    for (const id of [g.id, k.id]) expect(await refusal(executeProposal(w.rt(), agent, { proposalId: id, approvalId: "whatever" }))).toMatchObject({ code: "not_approved" });
    expect(w.mock.writes).toEqual([]);
  });

  it("create the ad group and the keywords PAUSED, once each, and use the approval up", async () => {
    const g = await approved(w, { kind: "create_ad_group", scopeKey: "own", accountId, campaignExternalId: "c1", name: "Brand", cpcBidMinor: 1500, reason: "Structure." });
    expect(await executeProposal(w.rt(), agent, { proposalId: g.id, approvalId: g.approvalId })).toMatchObject({ status: "executed" });
    const k = await approved(w, { kind: "add_keywords", scopeKey: "own", accountId, adGroupExternalId: "ag-1", keywords: [{ text: "shoes", matchType: "exact" }], reason: "Terms." });
    expect(await executeProposal(w.rt(), agent, { proposalId: k.id, approvalId: k.approvalId })).toMatchObject({ status: "executed", results: [{ ok: true, what: expect.stringContaining("(paused)") }] });
    expect(w.mock.writes.map((x) => [x.op, x.status])).toEqual([["adGroup", "paused"], ["keywords", "paused"]]);
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: k.id, approvalId: k.approvalId }))).toMatchObject({ code: "not_approved" });
    expect(w.mock.writes).toHaveLength(2);
  });
});

describe.skipIf(!available)("running approved responsive search ads", () => {
  let w: World;
  let accountId: string;
  const RSA = (id: string, patch: Record<string, unknown> = {}) => ({
    kind: "create_responsive_search_ad",
    scopeKey: "own",
    accountId: id,
    adGroupExternalId: "ag-1",
    headlines: ["Luxury shoes", "Free delivery", "Shop the sale"],
    descriptions: ["Hand made shoes for every day.", "Order today, delivered in 3 days."],
    finalUrl: "https://example.com/shoes?utm_source=google&utm_medium=cpc&utm_campaign=shoes",
    path1: "shoes",
    reason: "Search ad for the shoe range.",
    ...patch,
  });
  beforeEach(async () => {
    await pg.reset();
    w = await world(pg);
    ({ accountId } = await syncedAccount(w, { platform: "google", connectionPlatform: "mock" }));
  });

  it("refuses bad copy when the proposal is written, so the Reviewer never sees it", async () => {
    for (const [patch, message] of [
      [{ headlines: ["a".repeat(31), "b", "c"] }, /too long/],
      [{ headlines: ["a", "b"] }, /3 to 15/],
      [{ descriptions: ["only one"] }, /2 to 4/],
      [{ finalUrl: "https://example.com/shoes" }, /UTM/],
      [{ status: "ACTIVE" }, /PAUSED/],
    ] as const) {
      expect(await refusal(propose(w, RSA(accountId, patch)))).toMatchObject({ message: expect.stringMatching(message) });
    }
    expect(await listProposals(w.ctx, COMPANY, {})).toHaveLength(0);
  });

  it("reads every headline and description for the client's banned words, not just the first few", async () => {
    await updateScope(w.ctx, COMPANY, "own", { bannedWords: ["bargain"] });
    const headlines = Array.from({ length: 8 }, (_, i) => `Shoe offer ${String.fromCharCode(65 + i)}`);
    const descriptions = ["Hand made shoes for every day.", "Order today, delivered in 3 days.", "Sizes for every foot.", "Easy returns on all pairs."];
    const clean = await propose(w, RSA(accountId, { headlines, descriptions }));
    expect(clean.status).toBe("in_review");
    for (const [patch, where] of [
      [{ headlines: headlines.map((h, i) => (i === 6 ? "The bargain shoes" : h)), descriptions }, "headlines[6]"],
      [{ headlines, descriptions: descriptions.map((d, i) => (i === 3 ? "Our bargain pairs, returns free." : d)) }, "descriptions[3]"],
    ] as const) {
      const p = await propose(w, RSA(accountId, patch));
      expect(p.status).toBe("needs_changes");
      expect((p.precheck as { findings: Array<{ rule: string; where: string }> }).findings).toEqual([expect.objectContaining({ rule: "banned_word", where })]);
    }
  });

  it("is refused on a Meta account", async () => {
    const meta = await syncedAccount(w);
    expect(await refusal(propose(w, RSA(meta.accountId)))).toMatchObject({ message: expect.stringMatching(/only be created on Google/) });
  });

  it("is refused without an approval and writes nothing", async () => {
    const p = await propose(w, RSA(accountId));
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: p.id, approvalId: "whatever" }))).toMatchObject({ code: "not_approved" });
    expect(w.mock.writes).toEqual([]);
  });

  it("creates the ad PAUSED once and uses the approval up", async () => {
    const p = await approved(w, RSA(accountId));
    expect(await executeProposal(w.rt(), agent, { proposalId: p.id, approvalId: p.approvalId })).toMatchObject({ status: "executed", results: [{ ok: true, what: expect.stringContaining("(paused)") }] });
    expect(w.mock.writes).toEqual([expect.objectContaining({ op: "responsive_search_ad", status: "paused", adGroupExternalId: "ag-1", headlineCount: 3, descriptionCount: 2 })]);
    expect(await refusal(executeProposal(w.rt(), agent, { proposalId: p.id, approvalId: p.approvalId }))).toMatchObject({ code: "not_approved" });
    expect(w.mock.writes).toHaveLength(1);
  });
});
