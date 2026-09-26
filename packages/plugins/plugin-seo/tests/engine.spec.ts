import { describe, expect, it } from "vitest";
import { taskIssueDescription, taskIssueTitle, rootIssueTitle, blockComment, withClientPrefix } from "../src/engine/copy.js";
import { completionBlocker } from "../src/engine/guards.js";
import {
  auditCapturePlan,
  decideAssignee,
  keywordStatusForPosition,
  needsSignoff,
  nextSprintStatus,
  proposalAllowance,
  scheduledAuditDays,
  selectDueTasks,
  sprintClock,
  taskStatusFromIssue,
  weekForDay,
} from "../src/engine/sprint.js";
import { addDays, asDate, daysBetween, localDate, localDateOf, localHour } from "../src/engine/time.js";
import { dueDayFor, OUTRANK_90 } from "../src/templates/outrank-90.js";

describe("time", () => {
  it("uses the SAST calendar across the UTC midnight boundary", () => {
    const utcLate = new Date("2026-09-25T22:30:00Z"); // 00:30 SAST on the 26th
    expect(localDate(utcLate, "Africa/Johannesburg")).toBe("2026-09-26");
    expect(localDate(utcLate, "UTC")).toBe("2026-09-25");
    expect(localHour(utcLate, "Africa/Johannesburg")).toBe(0);
    expect(localHour(new Date("2026-09-26T04:00:00Z"), "Africa/Johannesburg")).toBe(6);
    expect(localDate(new Date("2026-09-26T21:59:00Z"), "Africa/Johannesburg")).toBe("2026-09-26");
  });

  it("does date arithmetic on calendar days", () => {
    expect(daysBetween("2026-09-01", "2026-09-26")).toBe(25);
    expect(daysBetween("2026-09-26", "2026-09-23")).toBe(-3);
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(asDate("2026-09-26T10:00:00.000Z")).toBe("2026-09-26");
    expect(localDateOf("2026-09-25T23:00:00Z", "Africa/Johannesburg")).toBe("2026-09-26");
  });
});

describe("sprint clock", () => {
  it("maps days to weeks, phases and statuses", () => {
    const at = (day: number) => sprintClock("2026-06-01", addDays("2026-06-01", day));
    expect(at(-3)).toMatchObject({ day: -3, week: 0, phase: 0, runningStatus: "pre_launch" });
    expect(at(0)).toMatchObject({ day: 0, week: 0, phase: 0, runningStatus: "pre_launch" });
    expect(at(1)).toMatchObject({ week: 1, phase: 1, runningStatus: "active" });
    expect(at(7)).toMatchObject({ week: 1, phase: 1 });
    expect(at(8)).toMatchObject({ week: 2, phase: 1 });
    expect(at(28)).toMatchObject({ week: 4, phase: 1 });
    expect(at(29)).toMatchObject({ week: 5, phase: 2 });
    expect(at(71)).toMatchObject({ week: 11, phase: 3 });
    expect(at(90)).toMatchObject({ week: 13, phase: 3, runningStatus: "active" });
    expect(at(91)).toMatchObject({ week: 13, runningStatus: "active" });
    expect(at(92)).toMatchObject({ week: 14, phase: 4, runningStatus: "compounding" });
    expect(weekForDay(0)).toBe(0);
  });

  it("keeps paused and archived sprints where they are", () => {
    const clock = sprintClock("2026-06-01", "2026-07-01");
    expect(nextSprintStatus("paused", clock)).toBe("paused");
    expect(nextSprintStatus("archived", clock)).toBe("archived");
    expect(nextSprintStatus("pre_launch", clock)).toBe("active");
  });

  it("selects due tasks without issues", () => {
    const tasks = OUTRANK_90.tasks.map((t, i) => ({ id: String(i), key: t.templateKey, status: "not_started" as const, issueId: null, dueDay: dueDayFor(t.week, t.dueDay) }));
    const keys = (day: number) => selectDueTasks(tasks, day).map((t) => t.key);
    expect(keys(-5)).toHaveLength(7);
    expect(keys(0)).toHaveLength(7);
    expect(keys(1)).toHaveLength(14);
    expect(keys(85)).not.toContain("w13-audit-metrics");
    expect(keys(90)).toContain("w13-audit-metrics");
    expect(keys(90)).toHaveLength(42);
    const withIssue = tasks.map((t) => (t.key === "w0-schema" ? { ...t, issueId: "iss" } : t.key === "w0-meta-tags" ? { ...t, status: "done" as never } : t));
    expect(selectDueTasks(withIssue, 0).map((t) => t.key)).toHaveLength(5);
  });
});

describe("assignment", () => {
  const agent = { id: "agent-1", status: "idle" };
  it("sends human tasks and autopilot-off work to the owner", () => {
    expect(decideAssignee({ owner: "human", autopilotEligible: false, mode: "full", agent, ownerUserId: "u1" })).toEqual({ kind: "user", userId: "u1", reason: "human_task" });
    expect(decideAssignee({ owner: "agent", autopilotEligible: true, mode: "off", agent, ownerUserId: "u1" })).toEqual({ kind: "user", userId: "u1", reason: "autopilot_off" });
  });
  it("leaves agent tasks unassigned until the agent exists", () => {
    expect(decideAssignee({ owner: "agent", autopilotEligible: true, mode: "safe", agent: null, ownerUserId: "u1" })).toEqual({ kind: "unassigned", reason: "agent_unavailable" });
    expect(decideAssignee({ owner: "agent", autopilotEligible: true, mode: "safe", agent: { id: "a", status: "terminated" }, ownerUserId: null }).kind).toBe("unassigned");
  });
  it("assigns the agent, gates sign-off in safe mode, and wakes only runnable agents", () => {
    expect(decideAssignee({ owner: "agent", autopilotEligible: false, mode: "safe", agent, ownerUserId: "u1" })).toEqual({ kind: "agent", agentId: "agent-1", reviewGate: true, wake: true });
    expect(decideAssignee({ owner: "agent", autopilotEligible: false, mode: "full", agent, ownerUserId: "u1" })).toMatchObject({ reviewGate: false });
    expect(decideAssignee({ owner: "agent", autopilotEligible: true, mode: "safe", agent: { id: "a", status: "paused" }, ownerUserId: null })).toMatchObject({ kind: "agent", wake: false });
    expect(needsSignoff({ owner: "human", autopilotEligible: false }, "safe")).toBe(false);
  });
});

describe("issue → task status", () => {
  it("maps issue status changes onto tasks", () => {
    expect(taskStatusFromIssue("done", "in_progress")).toBe("done");
    expect(taskStatusFromIssue("done", "done")).toBeNull();
    expect(taskStatusFromIssue("cancelled", "not_started")).toBe("skipped");
    expect(taskStatusFromIssue("blocked", "in_progress")).toBe("blocked");
    expect(taskStatusFromIssue("in_progress", "not_started")).toBe("in_progress");
    expect(taskStatusFromIssue("in_review", "blocked")).toBe("in_progress");
    expect(taskStatusFromIssue("todo", "blocked")).toBe("in_progress");
    expect(taskStatusFromIssue("todo", "done")).toBe("in_progress");
    expect(taskStatusFromIssue("todo", "not_started")).toBeNull();
    expect(taskStatusFromIssue("weird", "not_started")).toBeNull();
  });
});

describe("audits, proposals and keyword status", () => {
  it("schedules day 0/30/60/90 then monthly", () => {
    expect(scheduledAuditDays(0)).toEqual([0]);
    expect(scheduledAuditDays(95)).toEqual([0, 30, 60, 90]);
    expect(scheduledAuditDays(150)).toEqual([0, 30, 60, 90, 120, 150]);
    expect(scheduledAuditDays(-2)).toEqual([]);
  });
  it("captures only the latest missing snapshot and is idempotent", () => {
    expect(auditCapturePlan(3, [])).toEqual({ capture: 0, markDone: [0] });
    expect(auditCapturePlan(3, [0])).toEqual({ capture: null, markDone: [] });
    expect(auditCapturePlan(64, [0])).toEqual({ capture: 60, markDone: [30, 60] });
  });
  it("caps proposals at 2 per week in the first 4 weeks", () => {
    expect(proposalAllowance(10, 0)).toBe(2);
    expect(proposalAllowance(10, 2)).toBe(0);
    expect(proposalAllowance(40, 2)).toBe(3);
  });
  it("buckets positions", () => {
    expect(keywordStatusForPosition(2.4)).toBe("top_3");
    expect(keywordStatusForPosition(9.9)).toBe("top_10");
    expect(keywordStatusForPosition(55)).toBe("ranking");
    expect(keywordStatusForPosition(null)).toBe("not_yet");
  });
});

describe("completion guards", () => {
  const facts = { activeKeywords: 12, keywordsWithoutIntent: 0, priorityKeywords: 5, directoriesNotStarted: 0, latestSnapshotDay: 90 };
  it("refuses status-only completion of directory submissions", () => {
    expect(completionBlocker("directory-submission", { ...facts, directoriesNotStarted: 4 })).toMatch(/4 directory/);
    expect(completionBlocker("directory-submission", facts)).toBeNull();
  });
  it("checks keyword and audit work", () => {
    expect(completionBlocker("keyword-record", { ...facts, activeKeywords: 2 })).toMatch(/Only 2/);
    expect(completionBlocker("keyword-bucket", { ...facts, keywordsWithoutIntent: 3 })).toMatch(/3 active/);
    expect(completionBlocker("keyword-prioritize", { ...facts, priorityKeywords: 0 })).toMatch(/priority/);
    expect(completionBlocker("audit-snapshot", { ...facts, latestSnapshotDay: 60 })).toMatch(/day-90/);
    expect(completionBlocker("robots-check", { ...facts, activeKeywords: 0 })).toBeNull();
  });
});

describe("issue copy", () => {
  const sprint = { id: "s1", siteName: "Acme", siteUrl: "https://acme.co.za", clientName: "Acme Ltd", autopilotMode: "safe" as const, notes: "WordPress admin in 1Password" };
  const task = { id: "t1", title: "Check robots.txt — nothing blocking crawlers", week: 1, phase: 1, focus: "Tech Audit", taskType: "robots-check", owner: "agent" as const, autopilotEligible: true, playbookKey: "w1-robots-check", source: "template" };
  it("builds titles", () => {
    expect(rootIssueTitle(sprint)).toBe("SEO sprint: Acme (Acme Ltd)");
    // Client sprints: the client's name leads unless the title already has it.
    expect(taskIssueTitle(task, sprint)).toBe("[Acme Ltd] SEO W1 · Check robots.txt — nothing blocking crawlers — Acme");
    expect(taskIssueTitle(task, { siteName: "Acme Ltd", clientName: "Acme Ltd" })).toBe("SEO W1 · Check robots.txt — nothing blocking crawlers — Acme Ltd");
    expect(rootIssueTitle({ siteName: "Acme Ltd", clientName: "Acme Ltd" })).toBe("SEO sprint: Acme Ltd");
    // Own sprints carry no client.
    expect(taskIssueTitle(task, { siteName: "PiB", clientName: null })).toBe("SEO W1 · Check robots.txt — nothing blocking crawlers — PiB");
    expect(withClientPrefix("[Acme Ltd] x", "acme ltd")).toBe("[Acme Ltd] x");
    expect(taskIssueTitle({ ...task, title: "x".repeat(300) }, sprint)).toMatch(/^\[Acme Ltd\] SEO W1 · x+…$/);
  });
  it("puts the playbook, tools, definition of done and closing call in the description", () => {
    const text = taskIssueDescription(task, sprint, { assignment: { kind: "agent", agentId: "a", reviewGate: false, wake: true } });
    expect(text).toContain("## Goal");
    expect(text).toContain("`partnersinbiz.seo:check-robots`");
    expect(text).toContain("## Definition of done");
    expect(text).toContain("partnersinbiz.seo:complete-task");
    expect(text).toContain("taskId: `t1`");
    expect(text).toContain("WordPress admin in 1Password");
    const gated = taskIssueDescription({ ...task, autopilotEligible: false }, sprint, { assignment: { kind: "agent", agentId: "a", reviewGate: true, wake: true } });
    expect(gated).toContain("Needs sign-off");
    const human = taskIssueDescription({ ...task, owner: "human" }, sprint, { assignment: { kind: "user", userId: "u", reason: "human_task" } });
    expect(human).toContain("Mark this issue **done**");
  });
  it("writes a precise hand-off comment", () => {
    const text = blockComment({ reason: "Need DNS access", humanAsk: "Add the TXT record", review: false, links: ["https://x"] });
    expect(text).toContain("Blocked — needs a person");
    expect(text).toContain("Add the TXT record");
    expect(blockComment({ reason: "Draft ready", humanAsk: "Approve", review: true })).toContain("sign-off");
  });
});
