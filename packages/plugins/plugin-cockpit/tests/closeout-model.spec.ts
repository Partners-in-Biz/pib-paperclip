import { describe, expect, it } from "vitest";
import { CLOSEOUT, closeoutContent, humanWorkSql, isEvergreen, planProject, planTree, type ProjectFacts, type TreeFacts } from "../src/closeout-model.js";
import { emptyAggregate } from "../src/measure-model.js";

const NOW = new Date("2026-10-03T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const project = (extra: Partial<ProjectFacts> = {}): ProjectFacts => ({
  projectId: "p1",
  name: "Website rebuild",
  status: "in_progress",
  total: 6,
  open: 0,
  done: 5,
  cancelled: 1,
  firstCreated: daysAgo(20),
  lastCreated: daysAgo(10),
  lastUpdated: daysAgo(5),
  lastCompleted: daysAgo(5),
  ...extra,
});

describe("what counts as evergreen", () => {
  it("is work with many issues or spread over many weeks", () => {
    expect(isEvergreen(project())).toBe(false);
    expect(isEvergreen(project({ total: CLOSEOUT.evergreenIssues }))).toBe(true);
    expect(isEvergreen(project({ firstCreated: daysAgo(60), lastCreated: daysAgo(10) }))).toBe(true); // 50 days of new issues
    expect(isEvergreen(project({ firstCreated: daysAgo(40), lastCreated: daysAgo(0) }))).toBe(false); // 40 days: still a project
  });
});

describe("a finished project (final review)", () => {
  it("needs every issue closed, at least three of them, a quiet spell, and one done", () => {
    expect(planProject(project(), NOW, null)).toMatchObject({ kind: "final", periodKey: `final:${daysAgo(5).slice(0, 10)}` });
    expect(planProject(project({ open: 1, done: 4 }), NOW, null)).toBeNull();
    expect(planProject(project({ total: 2, done: 2, cancelled: 0 }), NOW, null)).toBeNull();
    expect(planProject(project({ done: 0, cancelled: 6 }), NOW, null)).toBeNull(); // everything cancelled is not a finished piece of work
    expect(planProject(project({ lastUpdated: daysAgo(1) }), NOW, null)).toBeNull(); // between waves: not yet
    expect(planProject(project({ lastCreated: daysAgo(1) }), NOW, null)).toBeNull();
  });

  it("the quiet days are the caller's to set, and the reason says how long", () => {
    const plan = planProject(project({ lastUpdated: daysAgo(1.5) }), NOW, null, { quietDays: 1 });
    expect(plan?.kind).toBe("final");
    expect(plan?.reason).toBe("Every one of its 6 issues is done or cancelled and nothing has changed for 1 days.");
  });

  it("is not reviewed after the fact when it finished long ago", () => {
    expect(planProject(project({ lastCompleted: daysAgo(100), lastUpdated: daysAgo(100), lastCreated: daysAgo(110), firstCreated: daysAgo(120) }), NOW, null)).toBeNull();
  });

  it("a project set to completed is reviewed whatever its issues look like", () => {
    const open = project({ status: "completed", open: 2, done: 3, cancelled: 1 });
    expect(planProject(open, NOW, null)).toMatchObject({ kind: "final", reason: "The project was marked completed (3 issues done, 1 cancelled)." });
    expect(planProject(project({ open: 2, done: 3, cancelled: 1 }), NOW, null, { explicitlyCompleted: true })?.kind).toBe("final");
    expect(planProject(project({ status: "completed", total: 0, done: 0, cancelled: 0 }), NOW, null)).toBeNull();
  });
});

describe("an evergreen project (milestone review)", () => {
  const evergreen = (extra: Partial<ProjectFacts> = {}) => project({ total: 97, done: 90, cancelled: 4, open: 3, ...extra });

  it("is never reviewed as finished, and needs a baseline before it counts", () => {
    expect(planProject(evergreen({ open: 0, done: 93, cancelled: 4 }), NOW, null)).toBeNull();
    const base = { at: daysAgo(10), closed: 90 };
    expect(planProject(evergreen({ done: 94 }), NOW, base)).toBeNull(); // 4 closed since
  });

  it("opens one every 40 closed issues, never sooner than 14 days after the last review", () => {
    const base = { at: daysAgo(15), closed: 50 };
    const plan = planProject(evergreen({ done: 90, cancelled: 4 }), NOW, base)!;
    expect(plan).toMatchObject({ kind: "milestone", periodKey: `milestone:${NOW.toISOString().slice(0, 10)}` });
    expect(plan.reason).toBe("44 issues were closed in the 15 days since the last review (one every 40 closed issues, at most once in 14 days).");
    expect(planProject(evergreen({ done: 88, cancelled: 1 }), NOW, base)).toBeNull(); // 39 since
    // plenty closed, but the last review is too recent: Hunt and Gun closing 90 issues in five days must not ask for a review every day
    expect(planProject(evergreen({ done: 90, cancelled: 4 }), NOW, { at: daysAgo(3), closed: 20 })).toBeNull();
    expect(planProject(evergreen({ done: 90, cancelled: 4 }), NOW, { at: daysAgo(13), closed: 20 })).toBeNull();
    expect(planProject(evergreen({ done: 90, cancelled: 4 }), NOW, { at: daysAgo(14), closed: 20 })?.kind).toBe("milestone");
  });

  it("or after a month with at least five closed", () => {
    expect(planProject(evergreen({ done: 93, cancelled: 4 }), NOW, { at: daysAgo(31), closed: 92 })?.reason).toBe("31 days since the last review, with 5 issues closed.");
    expect(planProject(evergreen({ done: 93, cancelled: 4 }), NOW, { at: daysAgo(31), closed: 94 })).toBeNull(); // only 3
    expect(planProject(evergreen({ done: 93, cancelled: 4 }), NOW, { at: daysAgo(29), closed: 92 })).toBeNull(); // not yet a month
  });

  it("closed issues that disappeared never count backwards", () => {
    expect(planProject(evergreen(), NOW, { at: daysAgo(40), closed: 500 })).toBeNull();
  });
});

describe("what counts as work", () => {
  it("leaves out routine executions, watchdog tasks and plugin housekeeping operations, and keeps everything else (also an issue with no origin)", () => {
    const sql = humanWorkSql("i");
    expect(sql).toBe("coalesce(i.origin_kind, 'manual') NOT LIKE 'plugin:%:operation' AND coalesce(i.origin_kind, 'manual') NOT IN ('routine_execution', 'task_watchdog')");
    expect(humanWorkSql("r")).toContain("coalesce(r.origin_kind, 'manual')");
  });
});

describe("a closed epic (tree review)", () => {
  const tree = (extra: Partial<TreeFacts> = {}): TreeFacts => ({ rootId: "r1", identifier: "PAR-12", title: "Launch the portal", total: 6, open: 0, rootDone: true, lastCompleted: daysAgo(1), ...extra });

  it("is an epic whose root is done and everything under it is closed", () => {
    expect(planTree(tree(), NOW)).toMatchObject({ kind: "tree", periodKey: `tree:${daysAgo(1).slice(0, 10)}`, reason: "PAR-12 and the 5 issues under it are all closed." });
    expect(planTree(tree({ open: 1 }), NOW)).toBeNull();
    expect(planTree(tree({ rootDone: false }), NOW)).toBeNull();
    expect(planTree(tree({ total: CLOSEOUT.treeMinDescendants }), NOW)).toBeNull(); // 2 under it: too small to be an epic
    expect(planTree(tree({ total: CLOSEOUT.treeMinDescendants + 1 }), NOW)).not.toBeNull();
    expect(planTree(tree({ lastCompleted: daysAgo(90) }), NOW)).toBeNull();
  });
});

describe("the review issue", () => {
  const input = () => ({
    kind: "final" as const,
    scopeName: "Website rebuild (finished)",
    scopeLabel: "The Website rebuild project",
    reason: "Every one of its 6 issues is done or cancelled and nothing has changed for 3 days.",
    fromLabel: "since the work began",
    total: { ...emptyAggregate(), runs: 40, succeeded: 30, failed: 8, cancelled: 2, retries: 6, continuations: 4, limitFailures: 1, usd: 52.4, inputTokens: 1_200_000, outputTokens: 90_000, cachedInputTokens: 9_000_000, wallSec: 7200, p50Sec: 150, p90Sec: 640, issues: 6 },
    agents: [{ agentId: "a1", name: "Developer", usd: 40, runs: 25, failed: 6, skills: ["developer", "pib-company-os"] }, { agentId: "a2", name: null, usd: 12.4, runs: 15, failed: 2, skills: [] }],
    issues: { total: 6, done: 5, cancelled: 1, blocked: 1, blockedDays: 2.5 },
    reopenWakes: 3,
    unblockWakes: 2,
    closedPerDay: 0.6,
    prefix: "PAR",
    projectId: "11111111-0000-4000-8000-000000000001",
  });

  it("carries the numbers, who worked on it and a checklist the done-check can read", () => {
    const { title, description } = closeoutContent(input());
    expect(title).toBe("Close-out review: Website rebuild (finished)");
    expect(description).toContain("**The Website rebuild project**: finished. Every one of its 6 issues is done or cancelled");
    for (const text of [
      "| Issues | 6: 5 done, 1 cancelled, 1 blocked now |",
      "| Runs | 40: 30 succeeded, 8 failed, 2 cancelled |",
      "| Retries and continuations | 6 retries, 4 continuation wakes, 3 reopened by a comment |",
      "2.5 days across 1 issue blocked now; 2 spells ended when a blocker resolved",
      "| Time | 2 agent hours; a run takes 3 min typically, 11 min at the slow end |",
      "| Tokens | 1.2M in, 90k out, 9M read from cache |",
      "| Notional spend | $52, $10 per finished issue; 0.6 issues closed a day |",
      "| Plan limit | 1 run failed on the subscription limit |",
      "- Developer: $40, 25 runs (6 failed); skills developer, pib-company-os",
      "- An agent: $12, 15 runs (2 failed)",
    ]) expect(description, text).toContain(text);
    expect(description).toContain("- [ ] **Decide what to change.**");
    expect(description).toContain("improvement-propose");
    expect(description).toContain("- [ ] **Close the project in Paperclip.**");
    expect(description).toContain("PATCH /api/projects/11111111-0000-4000-8000-000000000001");
    expect(description.trimEnd().split("\n").at(-1)).toMatch(/^- \[ \] \*\*Close this issue\*\*/);
    expect(description).not.toMatch(/\n\n\n/);
  });

  it("does not offer to complete a project for an epic or a milestone, and leaves out empty rows", () => {
    const milestone = closeoutContent({ ...input(), kind: "milestone", projectId: null, total: { ...emptyAggregate(), runs: 3 }, issues: { total: 3, done: 3, cancelled: 0, blocked: 0, blockedDays: 0 }, agents: [], closedPerDay: null });
    expect(milestone.description).not.toContain("Close the project in Paperclip");
    expect(milestone.description).not.toContain("Plan limit");
    expect(milestone.description).toContain("- No run is linked to these issues.");
    expect(milestone.description).toContain("nothing blocked now");
    expect(milestone.description).toContain("**The Website rebuild project**: milestone.");
  });
});
