/**
 * The measurement layer against a real Postgres with the host's SQL rules:
 * notional USD from usage_json, durations, retries, cancellations, limit
 * failures, cost per issue tree and project, spend windows and review coverage.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { measureReport, readAgentRuns, readLimitFailures, readProjectRuns, readReviewRows, readScopeRuns, readSpendWindows, readTreeRuns } from "../src/measure.js";
import { reviewCoverage } from "../src/measure-model.js";
import { COMPANY, OTHER_COMPANY, embeddedAvailable, startPg, type PgHarness } from "./helpers/pg.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const A = "aaaaaaaa-0000-4000-8000-000000000001"; // a developer
const B = "aaaaaaaa-0000-4000-8000-000000000002"; // a reviewer
const C = "aaaaaaaa-0000-4000-8000-000000000003"; // another agent

d("measurement layer (Postgres)", () => {
  let h: PgHarness;
  const NOW = new Date("2026-10-03T12:00:00.000Z");
  const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

  const run = (agentId: string, status: string, hoursAgo: number, extra: { usd?: unknown; input?: number; output?: number; secs?: number | null; code?: string | null; error?: string | null; issueId?: string | null; wake?: string | null; retryOf?: string | null; continuation?: number; company?: string } = {}) =>
    h.client.query(
      `INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, finished_at, error, error_code, context_snapshot, retry_of_run_id, usage_json, continuation_attempt)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12)`,
      [
        uuid(),
        extra.company ?? COMPANY,
        agentId,
        status,
        ago(hoursAgo),
        extra.secs === null ? null : new Date(Date.parse(ago(hoursAgo)) + (extra.secs ?? 60) * 1000).toISOString(),
        extra.error ?? null,
        extra.code ?? null,
        JSON.stringify({ ...(extra.issueId ? { issueId: extra.issueId } : {}), ...(extra.wake ? { wakeReason: extra.wake } : {}) }),
        extra.retryOf ?? null,
        JSON.stringify(extra.usd === undefined && extra.input === undefined ? {} : { costUsd: extra.usd, inputTokens: extra.input ?? 0, outputTokens: extra.output ?? 0, cachedInputTokens: 1000 }),
        extra.continuation ?? 0,
      ],
    );

  const issue = (id: string, identifier: string, extra: { status?: string; parent?: string | null; project?: string | null; agent?: string | null; completedHoursAgo?: number | null; title?: string; description?: string; company?: string; policy?: unknown; state?: unknown; createdHoursAgo?: number } = {}) =>
    h.client.query(
      `INSERT INTO public.issues (id, company_id, identifier, title, description, status, assignee_agent_id, project_id, parent_id, completed_at, execution_policy, execution_state, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13)`,
      [
        id,
        extra.company ?? COMPANY,
        identifier,
        extra.title ?? `Issue ${identifier}`,
        extra.description ?? null,
        extra.status ?? "done",
        extra.agent ?? null,
        extra.project ?? null,
        extra.parent ?? null,
        extra.completedHoursAgo == null ? null : ago(extra.completedHoursAgo),
        extra.policy ? JSON.stringify(extra.policy) : null,
        extra.state ? JSON.stringify(extra.state) : null,
        ago(extra.createdHoursAgo ?? 100),
      ],
    );

  const ISSUE = { root: "11111111-0000-4000-8000-000000000001", child: "11111111-0000-4000-8000-000000000002", grand: "11111111-0000-4000-8000-000000000003", other: "11111111-0000-4000-8000-000000000004", foreign: "11111111-0000-4000-8000-000000000005" };
  const PROJECT = "22222222-0000-4000-8000-000000000001";

  beforeAll(async () => {
    h = await startPg();
  }, 120_000);
  afterAll(async () => {
    await h?.stop();
  });
  beforeEach(async () => {
    await h.reset();
    seq = 0;
  });

  describe("per agent", () => {
    it("adds up notional USD, tokens, durations, retries, continuations, limit failures and why runs did not succeed", async () => {
      const first = uuid();
      await run(A, "succeeded", 10, { usd: 1.5, input: 1000, output: 100, secs: 60 });
      await run(A, "succeeded", 9, { usd: 2.5, input: 2000, output: 200, secs: 120 });
      await run(A, "succeeded", 8, { usd: "n/a", input: 10, output: 1, secs: 300 }); // a non-number counts as 0, never a cast error
      await run(A, "failed", 7, { usd: 0.5, input: 50, output: 5, secs: 30, code: "acpx_turn_failed", error: "ACP agent reported a terminal limit failure." });
      await run(A, "failed", 7, { secs: 30, code: "adapter_failed", error: "spawn E2BIG" });
      await run(A, "cancelled", 6, { code: "workspace_busy", secs: 1 });
      await run(A, "cancelled", 6, { code: "workspace_busy", secs: 1 });
      await run(A, "succeeded", 5, { usd: 1, secs: 60, retryOf: first });
      await run(A, "succeeded", 4, { usd: 1, secs: 60, wake: "issue_continuation_needed" });
      await run(A, "succeeded", 3, { usd: 1, secs: 60, continuation: 2 });
      await run(B, "succeeded", 2, { usd: 4, input: 5000, output: 500, secs: 90 });
      await run(A, "succeeded", 400, { usd: 99, secs: 60 }); // outside the window
      await run(A, "succeeded", 1, { usd: 77, company: OTHER_COMPANY }); // another company
      await issue(ISSUE.root, "PAR-1", { agent: A, completedHoursAgo: 5 });
      await issue(ISSUE.child, "PAR-2", { agent: A, completedHoursAgo: 4 });
      await issue(ISSUE.other, "PAR-3", { agent: B, completedHoursAgo: 3 });
      await issue(ISSUE.grand, "PAR-4", { agent: A, status: "in_progress" });

      const read = await readAgentRuns(h.ctx, COMPANY, ago(24 * 7));
      const a = read.aggregates.get(A)!;
      expect(a.runs).toBe(10);
      expect(a.succeeded).toBe(6);
      expect(a.failed).toBe(2);
      expect(a.cancelled).toBe(2);
      expect(a.retries).toBe(1);
      expect(a.continuations).toBe(2);
      expect(a.limitFailures).toBe(1);
      expect(a.usd).toBeCloseTo(1.5 + 2.5 + 0.5 + 1 + 1 + 1, 6);
      expect(a.inputTokens).toBe(3060);
      expect(a.outputTokens).toBe(306);
      expect(a.cachedInputTokens).toBeGreaterThan(0);
      expect(a.wallSec).toBeCloseTo(60 + 120 + 300 + 30 + 30 + 1 + 1 + 60 + 60 + 60, 0);
      // median and p90 of the ten durations
      expect(a.p50Sec).toBeCloseTo(60, 0);
      expect(a.p90Sec).toBeGreaterThan(a.p50Sec!);
      expect(read.aggregates.get(B)!.usd).toBeCloseTo(4, 6);
      expect(read.aggregates.size).toBe(2);
      expect(read.reasons.filter((r) => r.agentId === A && r.status === "cancelled")).toEqual([{ agentId: A, status: "cancelled", errorCode: "workspace_busy", count: 2 }]);
      expect(read.reasons.find((r) => r.agentId === A && r.errorCode === "adapter_failed")?.count).toBe(1);
      expect(read.done.get(A)).toBe(2);
      expect(read.done.get(B)).toBe(1);
    });

    it("keeps each company's numbers to itself", async () => {
      await run(A, "succeeded", 2, { usd: 5 });
      await run(A, "succeeded", 2, { usd: 50, company: OTHER_COMPANY });
      const mine = await readAgentRuns(h.ctx, COMPANY, ago(24));
      const theirs = await readAgentRuns(h.ctx, OTHER_COMPANY, ago(24));
      expect(mine.aggregates.get(A)!.usd).toBe(5);
      expect(theirs.aggregates.get(A)!.usd).toBe(50);
    });
  });

  describe("per project and issue tree", () => {
    beforeEach(async () => {
      await h.client.query(`INSERT INTO public.projects (id, company_id, name) VALUES ($1, $2, 'Hunt and Gun')`, [PROJECT, COMPANY]);
      await issue(ISSUE.root, "PAR-10", { agent: A, status: "done", completedHoursAgo: 2, project: PROJECT, title: "The epic" });
      await issue(ISSUE.child, "PAR-11", { agent: A, parent: ISSUE.root, project: PROJECT, completedHoursAgo: 3 });
      await issue(ISSUE.grand, "PAR-12", { agent: C, parent: ISSUE.child, project: PROJECT, completedHoursAgo: 4 });
      await issue(ISSUE.other, "PAR-13", { agent: C, project: null, status: "in_progress" });
      await run(A, "succeeded", 20, { issueId: ISSUE.child, usd: 3, input: 100 });
      await run(C, "failed", 19, { issueId: ISSUE.grand, usd: 1, input: 100, code: "adapter_failed" });
      await run(C, "succeeded", 18, { issueId: ISSUE.grand, usd: 2, input: 100, wake: "issue_reopened_via_comment" });
      await run(C, "succeeded", 17, { issueId: ISSUE.other, usd: 10, input: 100, wake: "issue_blockers_resolved" });
      await run(C, "succeeded", 16, { usd: 5 }); // no issue: counted for the agent, not for a project or tree
    });

    it("totals a project's runs and names it", async () => {
      const projects = await readProjectRuns(h.ctx, COMPANY, ago(24 * 7));
      const p = projects.find((x) => x.projectId === PROJECT)!;
      expect(p.name).toBe("Hunt and Gun");
      expect(p.usd).toBeCloseTo(6, 6);
      expect(p.runs).toBe(3);
      expect(p.failed).toBe(1);
      expect(p.doneIssues).toBe(3);
      expect(p.usdPerDone).toBeCloseTo(2, 6);
      // the issue with no project is its own row (project null), the run with no issue is in neither
      expect(projects.find((x) => x.projectId === null)?.usd).toBeCloseTo(10, 6);
      expect(projects[0]!.projectId).toBeNull(); // costliest first
    });

    it("rolls an issue tree up to its root: the epic and everything under it, with who worked on it", async () => {
      const trees = await readTreeRuns(h.ctx, COMPANY, ago(24 * 7));
      const epic = trees.find((t) => t.rootId === ISSUE.root)!;
      expect(epic.identifier).toBe("PAR-10");
      expect(epic.title).toBe("The epic");
      expect(epic.usd).toBeCloseTo(6, 6);
      expect(epic.runs).toBe(3);
      expect(epic.failed).toBe(1);
      expect(epic.issues).toBe(2);
      expect(epic.agents.map((a) => a.agentId)).toEqual([C, A]); // both used 3 USD: the one with more runs first
      expect(trees.find((t) => t.rootId === ISSUE.other)?.usd).toBeCloseTo(10, 6);
      expect(trees[0]!.rootId).toBe(ISSUE.other); // costliest first
      expect(trees.length).toBe(2);
    });

    it("stops at the top N trees", async () => {
      const one = await readTreeRuns(h.ctx, COMPANY, ago(24 * 7), 1);
      expect(one.map((t) => t.rootId)).toEqual([ISSUE.other]);
    });

    it("survives a parent loop (the host forbids one, but the report must not hang)", async () => {
      await h.client.query(`UPDATE public.issues SET parent_id = $1 WHERE id = $2`, [ISSUE.grand, ISSUE.root]);
      const trees = await readTreeRuns(h.ctx, COMPANY, ago(24 * 7));
      expect(trees.length).toBeGreaterThan(0);
    });

    it("measures one project and one tree for a close-out review: cost, agents, reopen wakes, blocked spells", async () => {
      await h.client.query(`UPDATE public.issues SET status = 'blocked', blocked_transition_at = $1 WHERE id = $2`, [ago(48), ISSUE.grand]);
      const project = await readScopeRuns(h.ctx, COMPANY, { kind: "project", id: PROJECT }, null, NOW);
      expect(project.total.usd).toBeCloseTo(6, 6);
      expect(project.total.runs).toBe(3);
      expect(project.reopenWakes).toBe(1);
      expect(project.agents.map((a) => a.agentId)).toEqual([C, A]);
      expect(project.agents[0]).toMatchObject({ usd: 3, runs: 2, failed: 1 });
      expect(project.issues).toMatchObject({ total: 3, done: 2, blocked: 1 });
      expect(project.issues.blockedDays).toBeCloseTo(2, 1);
      const tree = await readScopeRuns(h.ctx, COMPANY, { kind: "tree", id: ISSUE.child }, null, NOW);
      expect(tree.total.runs).toBe(3); // the child and its grandchild, not its parent
      expect(tree.issues.total).toBe(2);
      const since = await readScopeRuns(h.ctx, COMPANY, { kind: "project", id: PROJECT }, ago(18.5), NOW);
      expect(since.total.runs).toBe(1); // only the run since the cut-off
      const unblocked = await readScopeRuns(h.ctx, COMPANY, { kind: "tree", id: ISSUE.other }, null, NOW);
      expect(unblocked.unblockWakes).toBe(1);
    });

    it("never reads another company's issues into a scope", async () => {
      await issue(ISSUE.foreign, "OTH-1", { company: OTHER_COMPANY, parent: ISSUE.root, project: PROJECT });
      const tree = await readScopeRuns(h.ctx, COMPANY, { kind: "tree", id: ISSUE.root }, null, NOW);
      expect(tree.issues.total).toBe(3);
      const project = await readScopeRuns(h.ctx, COMPANY, { kind: "project", id: PROJECT }, null, NOW);
      expect(project.issues.total).toBe(3);
    });
  });

  describe("spend and limits", () => {
    it("splits notional spend into the last day, the last week and the week before, and says how much history there is", async () => {
      await run(A, "succeeded", 2, { usd: 30 });
      await run(A, "succeeded", 30, { usd: 10 }); // inside the baseline week
      await run(A, "succeeded", 100, { usd: 20 });
      await run(A, "succeeded", 250, { usd: 500 }); // 10 days ago: only counts towards history
      await run(A, "succeeded", 400, { usd: 900 }); // before the 14 day window
      const w = await readSpendWindows(h.ctx, COMPANY, NOW);
      expect(w.usd24h).toBeCloseTo(30, 6);
      expect(w.usd7d).toBeCloseTo(60, 6);
      expect(w.usdBaseline7d).toBeCloseTo(30, 6);
      expect(w.daysWithData).toBe(4);
    });

    it("counts runs that failed on the plan's limit, by agent", async () => {
      for (let i = 0; i < 3; i += 1) await run(A, "failed", 2, { code: "acpx_turn_failed", error: "ACP agent reported a terminal limit failure." });
      await run(B, "failed", 2, { code: "acpx_turn_failed", error: "You've hit your usage limit" });
      await run(B, "failed", 2, { code: "adapter_failed", error: "spawn E2BIG" });
      await run(B, "succeeded", 2, { error: "limit failure mentioned in a successful run" });
      // a throttle from some other API is not the subscription running out
      await run(B, "failed", 2, { code: "adapter_failed", error: "GitHub API rate limit exceeded for user ID 1" });
      await run(B, "failed", 2, { code: "adapter_failed", error: "429 rate limit reached, retry after 60s" });
      const l = await readLimitFailures(h.ctx, COMPANY, ago(24));
      expect(l.total).toBe(4);
      expect(l.byAgent).toEqual([{ agentId: A, count: 3 }, { agentId: B, count: 1 }]);
      expect(l.since).not.toBeNull();
    });
  });

  describe("review coverage", () => {
    const DEV = "33333333-0000-4000-8000-000000000001";
    const REV = "33333333-0000-4000-8000-000000000002";
    const id = (n: number) => `44444444-0000-4000-8000-${String(n).padStart(12, "0")}`;

    it("counts a done developer issue as reviewed by its review stage or by a linked reviewer issue, and times the review", async () => {
      // 1: approved review stage; 2: reviewer child; 3: blocks relation; 4: identifier in the reviewer's title; 5: nothing; 6: a reviewer issue naming PAR-6x only as a prefix
      const policy = { stages: [{ type: "review" }] };
      await issue(id(1), "PAR-1", { agent: DEV, completedHoursAgo: 10, policy, state: { lastDecisionOutcome: "approved" } });
      await issue(id(2), "PAR-2", { agent: DEV, completedHoursAgo: 9 });
      await issue(id(21), "PAR-21", { agent: REV, parent: id(2), completedHoursAgo: 8, createdHoursAgo: 9 });
      await issue(id(3), "PAR-3", { agent: DEV, completedHoursAgo: 8 });
      await issue(id(31), "PAR-31", { agent: REV, completedHoursAgo: 5, createdHoursAgo: 7 });
      await h.client.query(`INSERT INTO public.issue_relations (company_id, issue_id, related_issue_id, type) VALUES ($1, $2, $3, 'blocks')`, [COMPANY, id(3), id(31)]);
      await issue(id(4), "PAR-4", { agent: DEV, completedHoursAgo: 7 });
      await issue(id(41), "PAR-41", { agent: REV, title: "Review PAR-4: the thing", completedHoursAgo: 3, createdHoursAgo: 6 });
      await issue(id(5), "PAR-5", { agent: DEV, completedHoursAgo: 6 });
      await issue(id(6), "PAR-6", { agent: DEV, completedHoursAgo: 5 });
      await issue(id(61), "PAR-61", { agent: REV, title: "Review PAR-66", description: "nothing about the sixth", completedHoursAgo: 2, createdHoursAgo: 4 });
      await issue(id(7), "PAR-7", { agent: DEV, completedHoursAgo: 4, policy, state: { lastDecisionOutcome: "changes_requested" } }); // a review stage that did not approve is not a review
      await issue(id(8), "PAR-8", { agent: DEV, completedHoursAgo: 800 }); // outside the 30 day window
      await issue(id(9), "PAR-9", { agent: DEV, status: "in_progress" }); // not done
      const rows = await readReviewRows(h.ctx, COMPANY, ago(24 * 30), [DEV], [REV]);
      const byIdentifier = new Map(rows.map((r) => [r.identifier, r]));
      expect(rows.length).toBe(7);
      expect(byIdentifier.get("PAR-1")!.policyApproved).toBe(true);
      expect(byIdentifier.get("PAR-2")!.reviewIssueId).toBe(id(21));
      expect(byIdentifier.get("PAR-3")!.reviewIssueId).toBe(id(31));
      expect(byIdentifier.get("PAR-4")!.reviewIssueId).toBe(id(41));
      expect(byIdentifier.get("PAR-5")!.reviewIssueId).toBeNull();
      expect(byIdentifier.get("PAR-6")!.reviewIssueId).toBeNull(); // PAR-66 is another issue: whole words only
      expect(byIdentifier.get("PAR-7")!.policyApproved).toBe(false);
      const coverage = reviewCoverage(rows);
      expect(coverage).toMatchObject({ done: 7, reviewed: 4, byPolicy: 1, byIssue: 3 });
      expect(coverage.coverage).toBeCloseTo(4 / 7, 6);
      // review times: 1 h (PAR-21), 2 h (PAR-31), 3 h (PAR-41)
      expect(coverage.latencyP50Hours).toBe(2);
      expect(coverage.latencySamples).toBe(3);
      expect(coverage.unreviewed.map((u) => u.identifier)).toEqual(["PAR-7", "PAR-6", "PAR-5"]);
    });

    it("reads nothing when no agent is an author, and never links another company's issues", async () => {
      expect(await readReviewRows(h.ctx, COMPANY, ago(24), [], [REV])).toEqual([]);
      await issue(id(1), "PAR-1", { agent: DEV, completedHoursAgo: 1 });
      await issue(id(2), "OTH-9", { agent: REV, company: OTHER_COMPANY, parent: id(1), title: "Review PAR-1" });
      const rows = await readReviewRows(h.ctx, COMPANY, ago(24), [DEV], [REV]);
      expect(rows[0]!.reviewIssueId).toBeNull();
    });
  });

  describe("the report", () => {
    it("puts it together without failing when a part has no data", async () => {
      const env = { ctx: h.ctx, skills: { ensure: async () => [], force: async () => [] }, now: () => NOW } as never;
      (h.ctx as unknown as { agents: unknown }).agents = { list: async () => [{ id: A, name: "Developer", status: "idle" }, { id: B, name: "Code Reviewer", status: "idle" }] };
      await run(A, "succeeded", 3, { usd: 2, input: 10 });
      await issue(ISSUE.root, "PAR-1", { agent: A, completedHoursAgo: 1 });
      const report = await measureReport(env, COMPANY, { windowHours: 48 });
      expect(report.windowHours).toBe(48);
      expect(report.company.notionalUsd).toBe(2);
      expect(report.company.usdPerDay).toBe(1);
      expect(report.company.doneIssues).toBe(1);
      expect(report.company.usdPerDone).toBe(2);
      expect(report.agents[0]).toMatchObject({ agentId: A, name: "Developer", notionalUsd: 2, doneIssues: 1 });
      expect(report.reviewCoverage).toMatchObject({ done: 1, reviewed: 0 });
      expect(report.budgetMeaning).toContain("notional USD");
      expect(report.spend.usd24h).toBeCloseTo(2, 6);
    });
  });
});
