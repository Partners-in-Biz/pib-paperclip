/**
 * ask-owner: the agent asks, the issue goes to the owner (in review), the
 * owner's reply hands it back and wakes the agent with the answer.
 */
import { describe, expect, it } from "vitest";
import { askComment, AskError, answerText, askTone, askWaitingItem, parseAskInput, prefixed, safeHref, staleAsks, wakeReason } from "../src/ask-model.js";
import { NO_OWNER_MESSAGE, onAskComment, onAskIssueUpdated, openAskViews, reconcileAsks } from "../src/asks.js";
import { companyBrief, waitingFrom } from "../src/brief.js";
import { ownSnapshot, staleAsksCheck } from "../src/own.js";
import { createEnv, registerCockpit } from "../src/register.js";
import { saveTeam } from "../src/roles.js";
import { fakeCtx, fixedClock } from "./helpers/fake-ctx.js";

const A = "company-a";
const RUN = { agentId: "seo", runId: "run-1", companyId: A, projectId: "p1" };

function setup(now = "2026-09-26T10:00:00.000Z") {
  const fake = fakeCtx({
    savedConfigs: { [A]: { healthIssue: true } },
    prefixes: { [A]: "PIB" },
    agents: [
      { id: "op", companyId: A, name: "Olive", status: "active" },
      { id: "seo", companyId: A, name: "Sam", status: "active" },
    ],
  });
  const clock = fixedClock(now);
  const env = createEnv(fake.ctx, clock.now);
  registerCockpit(fake.ctx, env);
  return { ...fake, env, clock };
}

async function issueFor(s: ReturnType<typeof setup>, patch: Record<string, unknown> = {}) {
  return s.ctx.issues.create({ companyId: A, title: "Connect Northwind's Search Console", description: "", status: "in_progress", assigneeAgentId: "seo", ...patch } as never);
}

const ask = (s: ReturnType<typeof setup>, params: Record<string, unknown>, run = RUN) =>
  s.tools.get("ask-owner")!(params, run) as Promise<{ content: string; data: Record<string, any>; error?: string }>;

const QUESTION = {
  question: "Can you give our Search Console account access to Northwind's site?",
  why: "The SEO sprint's audit and indexing wait on it.",
  kind: "grant",
  options: ["Add seo@partnersinbiz.online as a full user", "Ask Northwind to do it"],
  links: [{ label: "Search Console users", href: "https://search.google.com/search-console/users" }, { label: "The sprint", href: "/seo?client=company:nw" }],
  steps: ["Open Search Console → Settings → Users and permissions.", "Add seo@partnersinbiz.online as Full."],
  client: "company:nw",
  dueBy: "2026-10-01",
};

describe("ask-owner input", () => {
  it("checks every field and says what to fix", () => {
    expect(parseAskInput({ issueId: "PIB-1", question: " Pay it? ", why: "Money", kind: "money" })).toMatchObject({ question: "Pay it?", kind: "money", options: [], links: [], steps: [], client: null, dueBy: null });
    const fails = (raw: Record<string, unknown>) => {
      try {
        parseAskInput(raw);
        return null;
      } catch (error) {
        expect(error).toBeInstanceOf(AskError);
        return (error as Error).message;
      }
    };
    expect(fails({ question: "x", why: "y" })).toMatch(/issueId is required/);
    expect(fails({ issueId: "PIB-1", why: "y" })).toMatch(/question is required/);
    expect(fails({ issueId: "PIB-1", question: "x".repeat(601), why: "y" })).toMatch(/under 600/);
    expect(fails({ issueId: "PIB-1", question: "x" })).toMatch(/why is required/);
    expect(fails({ issueId: "PIB-1", question: "x", why: "y".repeat(301) })).toMatch(/under 300/);
    expect(fails({ issueId: "PIB-1", question: "x", why: "y", kind: "urgent" })).toMatch(/kind must be one of decision, grant, money, legal, info/);
    expect(fails({ issueId: "PIB-1", question: "x", why: "y", options: ["a", "b", "c", "d", "e", "f"] })).toMatch(/at most 5/);
    expect(fails({ issueId: "PIB-1", question: "x", why: "y", links: [{ label: "x", href: "javascript:alert(1)" }] })).toMatch(/Paperclip path/);
    expect(fails({ issueId: "PIB-1", question: "x", why: "y", steps: Array.from({ length: 9 }, (_, i) => `step ${i}`) })).toMatch(/at most 8/);
    expect(fails({ issueId: "PIB-1", question: "x", why: "y", client: "Northwind" })).toMatch(/company:<crm id>/);
    expect(fails({ issueId: "PIB-1", question: "x", why: "y", dueBy: "next week" })).toMatch(/YYYY-MM-DD/);
    expect(parseAskInput({ issueId: "PIB-1", question: "x", why: "y" }).kind).toBe("decision");
  });

  it("builds a clear comment and short answers", () => {
    const body = askComment({ ask: parseAskInput({ issueId: "PIB-1", ...QUESTION }), agentName: "Sam", from: "Planner", clientLabel: "Northwind (company:nw)", prefix: "PIB" });
    expect(body).toContain("**Question for the owner** · from Planner · One-time grant · for Northwind (company:nw) · needed by 2026-10-01");
    expect(body).toContain("1. **Add seo@partnersinbiz.online as a full user** (recommended)");
    expect(body).toContain("2. Ask Northwind to do it");
    expect(body).toContain("**Why it matters:** The SEO sprint's audit and indexing wait on it.");
    expect(body).toContain("1. Open Search Console → Settings → Users and permissions.");
    expect(body).toContain("[Search Console users](https://search.google.com/search-console/users) · [The sprint](/PIB/seo?client=company:nw)");
    expect(body).toContain("The issue then goes back to Sam");
    expect(prefixed("/PIB/issues/PIB-3", "PIB")).toBe("/PIB/issues/PIB-3");
    expect(safeHref("//evil.com")).toBeNull();
    expect(answerText("2", ["A", "B"])).toBe("Option 2: B");
    expect(answerText("Yes, add it", ["A"])).toBe("Yes, add it");
    expect(wakeReason({ identifier: "PIB-4", answer: "1", options: ["Add it", "No"] })).toBe('The owner answered your question on PIB-4: "Option 1: Add it". Read the reply on the issue and carry on.');
    expect(wakeReason({ identifier: null, answer: "x".repeat(500), options: [] }).length).toBeLessThan(420);
    expect(askTone("money")).toBe("bad");
    expect(askTone("legal")).toBe("bad");
    expect(askTone("grant")).toBe("warn");
  });
});

describe("asking the owner", () => {
  it("posts the question, hands the issue to the owner in review, and shows it first in Waiting on you", async () => {
    const s = setup();
    await saveTeam(s.env, A, { operatorAgentId: "op" }, "user-1");
    const issue = await issueFor(s);
    const result = await ask(s, { issueId: issue.identifier, ...QUESTION });
    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({ status: "asked", issueId: issue.id, identifier: issue.identifier, handedToOwner: true, href: `/PIB/issues/${issue.identifier}` });
    expect(result.content).toContain("is with the owner now (in review)");
    // The issue is in the owner's inbox: assigned to them, in review, off the agent.
    expect(s.issues.get(issue.id)).toMatchObject({ assigneeUserId: "user-1", assigneeAgentId: null, status: "in_review" });
    const comment = s.comments.find((c) => c.issueId === issue.id)!;
    expect(comment).toMatchObject({ authorAgentId: "seo" });
    expect(comment.body).toContain("Can you give our Search Console account access");
    // Stored, and first in every waiting list (before the same issue as "assigned to you").
    expect(s.store.asks).toHaveLength(1);
    const views = await openAskViews(s.env, A);
    expect(views[0]).toMatchObject({ kind: "grant", askedBy: "Sam", askedByAgentId: "seo", question: QUESTION.question, dueBy: "2026-10-01", clientRef: "company:nw" });
    const brief = await companyBrief(s.env, A);
    expect(brief.waiting[0]).toMatchObject({ title: QUESTION.question, kind: "grant", href: `/PIB/issues/${issue.identifier}`, question: { askKind: "grant", askedBy: "Sam" } });
    expect(brief.waiting.filter((w) => w.issueId === issue.id)).toHaveLength(1);
    expect(brief.asks).toEqual([expect.objectContaining({ question: QUESTION.question, askedBy: "Sam", ageDays: 0, href: `/PIB/issues/${issue.identifier}` })]);
    expect(brief.today).toMatch(/^1 thing waits on you/);
  });

  it("asking again on the same issue updates the one open question", async () => {
    const s = setup();
    await saveTeam(s.env, A, {}, "user-1");
    const issue = await issueFor(s);
    await ask(s, { issueId: issue.id, ...QUESTION });
    s.clock.set("2026-09-27T10:00:00.000Z");
    const again = await ask(s, { issueId: issue.id, ...QUESTION, question: "Which email should get Search Console access?", kind: "info", options: [] });
    expect(again.data.status).toBe("updated");
    expect(s.store.asks).toHaveLength(1);
    expect(s.store.asks![0]).toMatchObject({ question: "Which email should get Search Console access?", kind: "info", asked_count: 2, asked_at: "2026-09-26T10:00:00.000Z" });
    expect(s.comments.filter((c) => c.issueId === issue.id).at(-1)!.body).toContain("Question for the owner (updated)");
  });

  it("refuses closed issues, missing issues and callers that are not agents", async () => {
    const s = setup();
    await saveTeam(s.env, A, {}, "user-1");
    const done = await issueFor(s, { status: "done" });
    expect((await ask(s, { issueId: done.id, ...QUESTION })).error).toMatch(/is closed/);
    expect((await ask(s, { issueId: "PIB-404", ...QUESTION })).error).toMatch(/was not found/);
    expect((await ask(s, { issueId: done.id, ...QUESTION }, { ...RUN, agentId: undefined as never })).error).toMatch(/Only an agent/);
    expect((await ask(s, {})).data).toEqual({ ok: false, error: expect.stringMatching(/issueId is required/) });
  });

  it("with no owner set: a clear error for the agent and a health warning to choose one", async () => {
    const s = setup();
    const issue = await issueFor(s);
    const result = await ask(s, { issueId: issue.id, ...QUESTION });
    expect(result.error).toBe(NO_OWNER_MESSAGE);
    expect(result.error).toMatch(/Say on the issue exactly what you need/);
    expect(s.issues.get(issue.id)).toMatchObject({ assigneeAgentId: "seo", status: "in_progress" });
    const owner = (await ownSnapshot(s.env, A)).health.find((h) => h.key === "owner")!;
    expect(owner).toMatchObject({ status: "warn", href: "/setup?section=team#team-owner", fix: "Choose who gets the daily brief in Setup → Team." });
    expect(owner.detail).toMatch(/Agents asked 1 question this week that could not reach anyone/);
    await saveTeam(s.env, A, {}, "user-1");
    expect((await ownSnapshot(s.env, A)).health.find((h) => h.key === "owner")).toBeUndefined();
  });
});

describe("the owner's reply", () => {
  async function asked() {
    const s = setup();
    await saveTeam(s.env, A, { operatorAgentId: "op" }, "user-1");
    const issue = await issueFor(s);
    await ask(s, { issueId: issue.id, ...QUESTION });
    s.wakeups.length = 0;
    return { ...s, issue };
  }

  it("records the answer, hands the issue back to the agent (todo) and wakes it with the answer", async () => {
    const s = await asked();
    const commentId = s.userComment(s.issue.id, "1", "user-1");
    await s.fire("issue.comment.created", { companyId: A, entityType: "issue", entityId: s.issue.id, actorType: "user", actorId: "user-1", payload: { commentId } });
    expect(s.store.asks![0]).toMatchObject({ status: "answered", answer: "1", answer_comment_id: commentId, answered_by_user_id: "user-1" });
    expect(s.issues.get(s.issue.id)).toMatchObject({ assigneeAgentId: "seo", assigneeUserId: null, status: "todo" });
    expect(s.wakeReasons).toEqual([{ issueId: s.issue.id, reason: `The owner answered your question on ${s.issue.identifier}: "Option 1: Add seo@partnersinbiz.online as a full user". Read the reply on the issue and carry on.` }]);
    expect(s.comments.at(-1)!.body).toBe("Answer recorded. Handed back to **Sam**, who carries on.");
    expect(await openAskViews(s.env, A)).toEqual([]);
    // The line shows in what the agents did.
    expect((await ownSnapshot(s.env, A)).activity[0]!.text).toContain(`The owner answered Sam's question on ${s.issue.identifier}`);
    // The same event again changes nothing.
    await s.fire("issue.comment.created", { companyId: A, entityType: "issue", entityId: s.issue.id, actorType: "user", actorId: "user-1", payload: { commentId } });
    expect(s.wakeups).toHaveLength(1);
  });

  it("a reply that also closes the issue keeps the answer and never reopens it", async () => {
    const s = await asked();
    await s.ctx.issues.update(s.issue.id, { status: "done" } as never, A);
    const commentId = s.userComment(s.issue.id, "Sorted it myself, thanks.", "user-1");
    expect(await onAskComment(s.env, { companyId: A, entityType: "issue", entityId: s.issue.id, actorType: "user", actorId: "user-1", payload: { commentId } })).toBe("answered");
    expect(s.store.asks![0]).toMatchObject({ status: "resolved", answer: "Sorted it myself, thanks." });
    expect(s.issues.get(s.issue.id)).toMatchObject({ status: "done" });
    expect(s.wakeups).toHaveLength(0);
  });

  it("ignores agents' and plugins' comments", async () => {
    const s = await asked();
    s.comments.push({ id: "c-agent", issueId: s.issue.id, body: "Still waiting.", companyId: A, authorAgentId: "seo", createdAt: new Date().toISOString() });
    expect(await onAskComment(s.env, { companyId: A, entityType: "issue", entityId: s.issue.id, actorType: "agent", actorId: "seo", payload: { commentId: "c-agent" } })).toBe("ignored");
    expect(await onAskComment(s.env, { companyId: A, entityType: "issue", entityId: s.issue.id, actorType: "plugin", actorId: "x", payload: { commentId: "c-agent" } })).toBe("ignored");
    expect(s.store.asks![0].status).toBe("open");
  });

  it("goes to the Operator when the agent that asked is gone", async () => {
    const s = await asked();
    s.agents.find((a) => a.id === "seo")!.status = "terminated";
    const commentId = s.userComment(s.issue.id, "Yes, add it.", "user-1");
    expect(await onAskComment(s.env, { companyId: A, entityType: "issue", entityId: s.issue.id, actorType: "user", actorId: "user-1", payload: { commentId } })).toBe("answered");
    expect(s.issues.get(s.issue.id)).toMatchObject({ assigneeAgentId: "op", status: "todo" });
  });

  it("closing or cancelling the issue, or handing it back without a reply, closes the question", async () => {
    const s = await asked();
    await s.ctx.issues.update(s.issue.id, { status: "done" } as never, A);
    await s.fire("issue.updated", { companyId: A, entityType: "issue", entityId: s.issue.id });
    expect(s.store.asks![0].status).toBe("resolved");

    const other = await issueFor(s);
    await ask(s, { issueId: other.id, ...QUESTION });
    await s.ctx.issues.update(other.id, { status: "cancelled" } as never, A);
    expect(await onAskIssueUpdated(s.env, { companyId: A, entityType: "issue", entityId: other.id })).toBe("cancelled");

    const third = await issueFor(s);
    await ask(s, { issueId: third.id, ...QUESTION });
    await s.ctx.issues.update(third.id, { assigneeUserId: null, assigneeAgentId: "seo", status: "todo" } as never, A);
    expect(await onAskIssueUpdated(s.env, { companyId: A, entityType: "issue", entityId: third.id })).toBe("resolved");
    // Still with the owner: stays open.
    const fourth = await issueFor(s);
    await ask(s, { issueId: fourth.id, ...QUESTION });
    expect(await onAskIssueUpdated(s.env, { companyId: A, entityType: "issue", entityId: fourth.id })).toBe("open");
  });

  it("the hourly check picks up a reply whose event was missed", async () => {
    const s = await asked();
    s.userComment(s.issue.id, "Ask Northwind to do it.", "user-1");
    expect(await reconcileAsks(s.env, A)).toEqual({ answered: 1, closed: 0, open: 0 });
    expect(s.store.asks![0]).toMatchObject({ status: "answered", answer: "Ask Northwind to do it." });
    expect(s.issues.get(s.issue.id)).toMatchObject({ assigneeAgentId: "seo", status: "todo" });
    // It runs in the hourly health job.
    const again = await issueFor(s);
    await ask(s, { issueId: again.id, ...QUESTION });
    s.userComment(again.id, "Yes.", "user-1");
    await s.jobs.get("health-alerts")!();
    expect(s.issues.get(again.id)).toMatchObject({ assigneeAgentId: "seo", status: "todo" });
  });
});

describe("old questions", () => {
  it("warn in health after 3 days, and money and legal are red", async () => {
    const s = setup();
    await saveTeam(s.env, A, {}, "user-1");
    const issue = await issueFor(s);
    await ask(s, { issueId: issue.id, ...QUESTION, kind: "money" });
    expect(staleAsksCheck(await openAskViews(s.env, A), new Date("2026-09-28T10:00:00.000Z"))).toBeNull();
    s.clock.set("2026-09-30T10:00:01.000Z");
    const check = (await ownSnapshot(s.env, A)).health.find((h) => h.key === "asks")!;
    expect(check).toMatchObject({ status: "warn", title: "1 question waits on the owner for more than 3 days", since: "2026-09-26T10:00:00.000Z" });
    expect(check.detail).toContain(issue.identifier!);
    const [view] = await openAskViews(s.env, A);
    expect(staleAsks([view!], new Date("2026-09-30T10:00:01.000Z"))).toHaveLength(1);
    const item = askWaitingItem(view!);
    expect(item).toMatchObject({ kind: "money", key: `ask:${view!.id}`, href: `/issues/${issue.identifier}` });
    expect(waitingFrom({ snapshots: [], approvals: [], ownerIssues: [], setupMissing: 0, asks: [view!] })[0]!.ask).toMatchObject({ kind: "money", askedBy: "Sam" });
  });
});
