/**
 * PAR-14492: a question that only asks the owner to merge a GitHub PR is
 * settled by the hourly check once GitHub says the PR is merged.
 */
import { describe, expect, it } from "vitest";
import { allMerged, isUnblockIssue, mergeAskPrs, mergedWakeReason, prRefsIn, prStateFrom } from "../src/pr-merge-model.js";
import { reconcileMergedPrAsks } from "../src/pr-merge.js";
import { createEnv, registerCockpit } from "../src/register.js";
import { saveTeam } from "../src/roles.js";
import { fakeCtx, fixedClock } from "./helpers/fake-ctx.js";

const A = "company-a";
const RUN = { agentId: "seo", runId: "run-1", companyId: A, projectId: "p1" };
const PR = "https://github.com/Partners-in-Biz/lumen/pull/126";
const SHA = "be07eca1234567890abcdef1234567890abcdef1";

const MERGE_ASK = {
  question: "Merge Lumen release PR #126 (development to main) so production goes live?",
  why: "The SEO page sits on development; Lumen production deploys from main only.",
  kind: "decision",
  options: ["Merge PR #126", "Wait for now"],
  links: [{ label: "Lumen PR #126", href: PR }],
  steps: ["Open Lumen PR #126", "Check CI is green, click Merge"],
};

type FakeRes = { status: number; body?: unknown };

function setup(prs: Record<string, FakeRes> = {}) {
  const fake = fakeCtx({
    savedConfigs: { [A]: { healthIssue: true, credentialChecks: { github: "test-token" } } },
    prefixes: { [A]: "PIB" },
    agents: [
      { id: "op", companyId: A, name: "Olive", status: "active" },
      { id: "seo", companyId: A, name: "Sam", status: "active" },
    ],
  });
  const clock = fixedClock("2026-11-25T10:00:00.000Z");
  const env = createEnv(fake.ctx, clock.now);
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  env.fetchImpl = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, auth: init?.headers?.authorization });
    const res = prs[url] ?? { status: 404 };
    return { status: res.status, json: async () => res.body ?? {} };
  }) as unknown as typeof fetch;
  registerCockpit(fake.ctx, env);
  return { ...fake, env, clock, calls, prs };
}

const api = (n = 126) => `https://api.github.com/repos/Partners-in-Biz/lumen/pulls/${n}`;
const merged = { status: 200, body: { state: "closed", merged: true, merge_commit_sha: SHA, merged_at: "2026-11-24T18:25:00Z", merged_by: { login: "ren-bot" } } };
const open = { status: 200, body: { state: "open", merged: false } };

async function asked(s: ReturnType<typeof setup>, params: Record<string, unknown> = MERGE_ASK, issue: Record<string, unknown> = {}) {
  await saveTeam(s.env, A, { operatorAgentId: "op" }, "user-1");
  const created = await s.ctx.issues.create({ companyId: A, title: "SEO W3 · Write the main use-case page", description: "", status: "in_progress", assigneeAgentId: "seo", ...issue } as never);
  const result = (await s.tools.get("ask-owner")!({ issueId: created.id, ...params }, RUN)) as { data: Record<string, unknown>; error?: string };
  expect(result.error).toBeUndefined();
  expect(s.issues.get(created.id)).toMatchObject({ assigneeUserId: "user-1", status: "in_review" });
  s.wakeups.length = 0;
  s.wakeReasons.length = 0;
  return created;
}

describe("merged-PR rules", () => {
  it("finds GitHub PR links once each, in order", () => {
    expect(prRefsIn([`see ${PR} and ${PR}/files`, "https://github.com/acme/site.git/pull/7", "PR #9 without a link", null]).map((p) => p.key)).toEqual(["partners-in-biz/lumen#126", "acme/site#7"]);
  });

  it("only a plain merge decision with a PR link counts", () => {
    const base = { kind: "decision", question: MERGE_ASK.question, why: null, steps: [], links: MERGE_ASK.links, hasEffect: false, hardStop: null };
    expect(mergeAskPrs(base)).toEqual({ prs: [expect.objectContaining({ key: "partners-in-biz/lumen#126", number: 126 })] });
    // A client production merge is still a merge ask: once merged, the question is moot.
    expect("prs" in mergeAskPrs({ ...base, hardStop: "client-production" })).toBe(true);
    expect(mergeAskPrs({ ...base, kind: "grant" })).toEqual({ skip: "not_decision" });
    expect(mergeAskPrs({ ...base, hardStop: "logins" })).toEqual({ skip: "hard_stop" });
    expect(mergeAskPrs({ ...base, hardStop: "money" })).toEqual({ skip: "hard_stop" });
    expect(mergeAskPrs({ ...base, hasEffect: true })).toEqual({ skip: "effect" });
    expect(mergeAskPrs({ ...base, question: "May we put the PWA change (PR #14) live on the site?" })).toEqual({ skip: "not_merge_ask" });
    expect(mergeAskPrs({ ...base, links: [] })).toEqual({ skip: "no_pr" });
  });

  it("reads GitHub's PR state and needs every PR merged", () => {
    expect(prStateFrom(merged.body)).toEqual({ state: "merged", sha: SHA, mergedAt: "2026-11-24T18:25:00.000Z", mergedBy: "ren-bot" });
    expect(prStateFrom({ state: "open", merged: false })).toEqual({ state: "open" });
    expect(prStateFrom({ state: "closed", merged: false })).toEqual({ state: "closed" });
    const [a, b] = prRefsIn([PR, "https://github.com/Partners-in-Biz/lumen/pull/129"]);
    const states = new Map([[a!.key, prStateFrom(merged.body)], [b!.key, prStateFrom(open.body)]]);
    expect(allMerged([a!, b!], states)).toBeNull();
    expect(allMerged([a!], states)).toEqual([{ pr: a, sha: SHA, mergedAt: "2026-11-24T18:25:00.000Z", mergedBy: "ren-bot" }]);
    expect(mergedWakeReason("PIB-1", [{ pr: a!, sha: SHA }])).toContain("partners-in-biz/lumen#126 (be07eca)");
    expect(isUnblockIssue({ title: "Unblock: PIB-4 SEO page", description: "" })).toBe(true);
    expect(isUnblockIssue({ title: "SEO page", description: "" })).toBe(false);
  });
});

describe("the hourly merged-PR check", () => {
  it("an open PR changes nothing", async () => {
    const s = setup({ [api()]: open });
    const issue = await asked(s);
    const commentsBefore = s.comments.length;
    expect(await reconcileMergedPrAsks(s.env, A)).toMatchObject({ checked: 1, waiting: 1, handedBack: 0, closed: 0 });
    expect(s.calls).toEqual([{ url: api(), auth: "Bearer test-token" }]);
    expect(s.store.asks![0]).toMatchObject({ status: "open" });
    expect(s.issues.get(issue.id)).toMatchObject({ assigneeUserId: "user-1", status: "in_review" });
    expect(s.comments.length).toBe(commentsBefore);
    expect(s.wakeups).toEqual([]);
  });

  it("an unreadable PR (private repo, no access) changes nothing", async () => {
    const s = setup({});
    const issue = await asked(s);
    expect(await reconcileMergedPrAsks(s.env, A)).toMatchObject({ unknown: 1, handedBack: 0 });
    expect(s.issues.get(issue.id)).toMatchObject({ assigneeUserId: "user-1", status: "in_review" });
  });

  it("a merged PR: factual comment, ask closed, issue back to the agent (todo) and woken; a second run does nothing", async () => {
    const s = setup({ [api()]: merged });
    const issue = await asked(s);
    expect(await reconcileMergedPrAsks(s.env, A)).toMatchObject({ checked: 1, handedBack: 1 });
    expect(s.store.asks![0]).toMatchObject({ status: "answered", default_policy: "pr-merged", answered_by_user_id: null });
    expect(String(s.store.asks![0].answer)).toContain("partners-in-biz/lumen#126 (be07eca) at 2026-11-24T18:25:00.000Z");
    expect(s.issues.get(issue.id)).toMatchObject({ assigneeAgentId: "seo", assigneeUserId: null, status: "todo" });
    const comment = s.comments.find((c) => c.issueId === issue.id && String(c.body).startsWith("**PR merged"))!;
    expect(comment.body).toContain("merged at 2026-11-24T18:25:00.000Z by ren-bot, merge commit `be07eca12345`");
    expect(comment.body).toContain("goes back to the agent");
    expect(s.wakeReasons).toEqual([{ issueId: issue.id, reason: expect.stringContaining("is merged: partners-in-biz/lumen#126 (be07eca)") }]);

    expect(await reconcileMergedPrAsks(s.env, A)).toMatchObject({ checked: 0, handedBack: 0 });
    expect(s.wakeups).toHaveLength(1);
  });

  it("a merged PR on an Unblock issue closes it and wakes the issue it blocked", async () => {
    const s = setup({ [api()]: merged });
    const stuck = await s.ctx.issues.create({ companyId: A, title: "SEO W3 page", description: "", status: "blocked", assigneeAgentId: "seo" } as never);
    const unblock = await asked(s, MERGE_ASK, { title: "Unblock: PIB-1 SEO W3 page", assigneeAgentId: "op" });
    s.ctx.issues.relations.get = (async (id: string) =>
      id === unblock.id
        ? { blockedBy: [], blocks: [{ id: stuck.id, identifier: stuck.identifier, status: "blocked", assigneeAgentId: "seo" }] }
        : { blockedBy: [{ id: unblock.id, status: s.issues.get(unblock.id)!.status }], blocks: [] }) as never;
    expect(await reconcileMergedPrAsks(s.env, A)).toMatchObject({ closed: 1, woken: 1 });
    expect(s.issues.get(unblock.id)).toMatchObject({ status: "done" });
    expect(s.store.asks![0]).toMatchObject({ status: "resolved", default_policy: "pr-merged" });
    expect(s.comments.find((c) => c.issueId === unblock.id && String(c.body).startsWith("**PR merged"))!.body).toContain("This Unblock issue only waited on that merge");
    expect(s.wakeReasons).toEqual([{ issueId: stuck.id, reason: expect.stringContaining("the PR it waited on is merged") }]);
  });

  it("a question that is not a merge ask is never read or touched, even with a merged PR link", async () => {
    const s = setup({ [api()]: merged });
    const grant = await asked(s, { ...MERGE_ASK, kind: "grant", question: "Merge PR #126 and store the Vercel token in Paperclip Secrets?" });
    const live = await asked(s, { ...MERGE_ASK, question: "May we put PR #126 live on the client site?" });
    expect(await reconcileMergedPrAsks(s.env, A)).toMatchObject({ checked: 0 });
    expect(s.calls).toEqual([]);
    for (const issue of [grant, live]) expect(s.issues.get(issue.id)).toMatchObject({ assigneeUserId: "user-1", status: "in_review" });
    expect(s.store.asks!.every((a) => a.status === "open")).toBe(true);
  });

  it("does nothing once the owner has already taken the issue elsewhere", async () => {
    const s = setup({ [api()]: merged });
    const issue = await asked(s);
    await s.ctx.issues.update(issue.id, { status: "in_progress" } as never, A);
    expect(await reconcileMergedPrAsks(s.env, A)).toMatchObject({ handedBack: 0, closed: 0 });
    expect(s.store.asks![0]).toMatchObject({ status: "open" });
  });

  it("runs in the hourly health job", async () => {
    const s = setup({ [api()]: merged });
    const issue = await asked(s);
    await s.jobs.get("health-alerts")!();
    expect(s.issues.get(issue.id)).toMatchObject({ assigneeAgentId: "seo", status: "todo" });
  });
});
