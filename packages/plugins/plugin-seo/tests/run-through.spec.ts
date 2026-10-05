/**
 * "Run through week N" (0.26.0): on a manual sprint the plugin starts each week itself, in order, up to a ceiling, and a task that
 * waits on a person or on the client never holds the next week back.
 */
import { describe, expect, it } from "vitest";
import { inTheAgentsHands, nextWeekToRelease, type PacingTask } from "../src/engine/pacing.js";
import type { Actor } from "../src/service/common.js";
import { advanceReleasedWeeks, setReleaseThrough } from "../src/service/sprints.js";
import { dispatch, HANDLERS, UI_ONLY_HANDLERS } from "../src/dispatch.js";
import { SEO_TOOLS } from "../src/tools.js";
import { sprintFor, world } from "./helpers/rehearsal-world.js";
import { executed, taskRow, type Row } from "./helpers/seo-host.js";

const user: Actor = { kind: "user", userId: "user-peet" };
const agent: Actor = { kind: "agent", agentId: "agent-1", runId: "run-1", responsibleUserId: "user-peet" };
const t = (week: number, extra: Partial<PacingTask> = {}): PacingTask => ({ week, status: "not_started", ...extra });

describe("which week starts next", () => {
  it("starts the lowest held week up to the ceiling when nothing earlier is with the agent", () => {
    expect(nextWeekToRelease([t(0, { status: "done" }), t(2, { held: true }), t(3, { held: true })], 3)).toBe(2);
    expect(nextWeekToRelease([t(2, { status: "done" }), t(3, { held: true }), t(4, { held: true })], 3)).toBe(3);
    expect(nextWeekToRelease([t(3, { status: "done" }), t(4, { held: true })], 3)).toBeNull();
    expect(nextWeekToRelease([t(2, { held: true })], null)).toBeNull();
  });

  it("waits while an earlier week still has work for the agent (open, in progress, due but not opened, with the Reviewer)", () => {
    const held = t(3, { held: true });
    expect(nextWeekToRelease([t(2, { status: "in_progress", issueId: "i", assigneeKind: "agent" }), held], 3)).toBeNull();
    expect(nextWeekToRelease([t(2, { issueId: "i", assigneeKind: "agent" }), held], 3)).toBeNull();
    expect(nextWeekToRelease([t(2), held], 3)).toBeNull();
    expect(nextWeekToRelease([t(2, { status: "blocked", issueId: "i", assigneeKind: "reviewer" }), held], 3)).toBe(3);
    expect(inTheAgentsHands(t(2, { status: "in_progress", issueId: "i", assigneeKind: "reviewer" }))).toBe(true);
  });

  it("is NOT held back by work waiting on a person or on the client", () => {
    const held = t(3, { held: true });
    for (const assigneeKind of ["needs_you", "client", "user"]) {
      expect(nextWeekToRelease([t(1, { status: "blocked", issueId: "i", assigneeKind }), held], 3), assigneeKind).toBe(3);
    }
    expect(nextWeekToRelease([t(1, { status: "not_started", issueId: "i", assigneeKind: "needs_you" }), held], 3)).toBe(3);
    expect(nextWeekToRelease([t(1, { status: "done" }), t(1, { status: "skipped" }), t(1, { status: "na" }), held], 3)).toBe(3);
  });
});

describe("the plugin starts the weeks", () => {
  const sprint = (extra: Row = {}) => sprintFor("real", { root_issue_id: "root-1", pacing: "manual", release_through: 3, status: "active", ...extra });
  const rows = (w: number, n: number, extra: Row = {}) => Array.from({ length: n }, (_, i) => taskRow({ id: `w${w}-${i}`, sprint_id: "sp-real", template_key: `w${w}-t${i}`, week: w, due_day: w * 7, ...extra }));

  it("starts week 2 when weeks 0 and 1 are finished or parked, then week 3 once week 2 is out of the agent's hands, and never past the ceiling", async () => {
    const tasks = [
      ...rows(0, 2, { status: "done" }),
      taskRow({ id: "wait", sprint_id: "sp-real", template_key: "w1-wait", week: 1, status: "blocked", assignee_kind: "needs_you", issue_id: "iss-9" }),
      ...rows(2, 2),
      ...rows(3, 2),
      ...rows(4, 2),
    ];
    const w = world({ sprints: [sprint()], tasks });
    expect(await advanceReleasedWeeks(w.env, { companyId: "co-1", sprintId: "sp-real" })).toBe(1);
    expect(w.store.tasks.filter((x) => x.week === 2).every((x) => x.released_at != null)).toBe(true);
    expect(w.store.tasks.filter((x) => x.week === 3).every((x) => x.released_at == null)).toBe(true);
    // Week 2 is now with the agent: week 3 waits.
    expect(await advanceReleasedWeeks(w.env, { companyId: "co-1", sprintId: "sp-real" })).toBe(0);
    // Week 2 finishes: week 3 starts, week 4 (past the ceiling) never does.
    for (const x of w.store.tasks.filter((x) => x.week === 2)) Object.assign(x, { status: "done" });
    expect(await advanceReleasedWeeks(w.env, { companyId: "co-1", sprintId: "sp-real" })).toBe(1);
    expect(w.store.tasks.filter((x) => x.week === 3).every((x) => x.released_at != null)).toBe(true);
    for (const x of w.store.tasks.filter((x) => x.week === 3)) Object.assign(x, { status: "done" });
    expect(await advanceReleasedWeeks(w.env, { companyId: "co-1", sprintId: "sp-real" })).toBe(0);
    expect(w.store.tasks.filter((x) => x.week === 4).every((x) => x.released_at == null)).toBe(true);
    expect(w.comments.some((c) => /Week 2 started \(run through week 3\)/.test(c.body))).toBe(true);
  });

  it("does nothing for a sprint without a ceiling, an automatic sprint, or a paused one (the controls)", async () => {
    for (const extra of [{ release_through: null }, { pacing: "auto" }, { status: "paused" }]) {
      const w = world({ sprints: [sprint(extra)], tasks: rows(2, 2) });
      expect(await advanceReleasedWeeks(w.env, { companyId: "co-1", sprintId: "sp-real" })).toBe(0);
      expect(w.store.tasks.every((x) => x.released_at == null)).toBe(true);
    }
  });

  it("the job finds the sprints itself", async () => {
    const w = world({ sprints: [sprint()], tasks: rows(2, 1), routes: [[/WHERE status = 'active' AND pacing = 'manual' AND release_through IS NOT NULL/, () => [{ id: "sp-real", company_id: "co-1" }]]] });
    expect(await advanceReleasedWeeks(w.env)).toBe(1);
  });
});

describe("set-release-through", () => {
  it("is page-only and person-only; it switches the sprint to manual pacing and starts the first week at once", async () => {
    expect(UI_ONLY_HANDLERS["set-release-through"]).toBeTypeOf("function");
    expect(HANDLERS["set-release-through"]).toBeUndefined();
    expect(SEO_TOOLS.some((x) => x.name === "set-release-through")).toBe(false);
    const w = world({ sprints: [sprintFor("real", { root_issue_id: "root-1", status: "active" })], tasks: Array.from({ length: 2 }, (_, i) => taskRow({ id: `w2-${i}`, sprint_id: "sp-real", template_key: `w2-t${i}`, week: 2, due_day: 14 })) });
    await expect(setReleaseThrough(w.env, "co-1", agent, { sprintId: "sp-real", week: 3 })).rejects.toThrow(/signed-in person/);
    await expect(dispatch(w.env, "co-1", agent, "set-release-through", { sprintId: "sp-real", week: 3 })).rejects.toThrow(/signed-in person/);
    const result = await setReleaseThrough(w.env, "co-1", user, { sprintId: "sp-real", week: 3 });
    expect(result).toMatchObject({ releaseThrough: 3, weekStarted: true });
    expect(w.sprintRow("sp-real")).toMatchObject({ pacing: "manual", release_through: 3 });
    expect(w.store.tasks.every((x) => x.released_at != null)).toBe(true);
    // Clearing it leaves pacing as it is and starts nothing.
    expect(await setReleaseThrough(w.env, "co-1", user, { sprintId: "sp-real" })).toMatchObject({ releaseThrough: null, weekStarted: false });
    expect(executed(w, /UPDATE plugin_seo_8099f8879a\.sprints SET release_through = NULL/)).toHaveLength(1);
  });
});
