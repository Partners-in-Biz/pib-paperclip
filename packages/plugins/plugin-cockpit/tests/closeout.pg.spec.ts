/**
 * Close-out reviews (Q2-1) against a real Postgres for the host's projects,
 * issues and runs and the Cockpit's own table, with the fake host for issues
 * the Cockpit opens: the three ways in (project completed, epic closed, the
 * daily sweep), one review per piece of work and period, a cap per sweep, and
 * what the issue carries.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORIGIN, ORIGIN_ID } from "../src/constants.js";
import { cockpitDoneRules } from "../src/done-checks.js";
import { closeoutSweep, onIssueClosed, onProjectUpdated, openCloseoutNow, readCursors, readTreeFacts, sweepCompany } from "../src/closeout.js";
import { CLOSEOUT } from "../src/closeout-model.js";
import { runOpsTool } from "../src/ops-tools.js";
import { NAMESPACE } from "../src/namespace.js";
import { saveTeam } from "../src/roles.js";
import { COMPANY, OTHER_COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const OP = "aaaaaaaa-0000-4000-8000-0000000000a1";
const DEV = "aaaaaaaa-0000-4000-8000-0000000000a2";
const NOW = "2026-10-03T12:00:00.000Z";
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

d("close-out reviews (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  async function make() {
    seq = 0;
    const w = await worlds.make({
      savedConfigs: { [A]: { healthIssue: true } },
      prefixes: { [A]: "PAR" },
      agents: [
        { id: OP, companyId: A, name: "Olive", status: "active", role: "general" },
        { id: DEV, companyId: A, name: "Developer", status: "idle", role: "engineer", adapterConfig: { paperclipSkillSync: { desiredSkills: ["plugin/partnersinbiz-cockpit/company-os", "developer"] } } } as never,
      ],
    });
    await saveTeam(w.env, A, { operatorAgentId: OP }, "user-owner");
    return w;
  }

  const project = (w: Hybrid, name: string, status = "in_progress", company = A) => {
    const id = uuid();
    return w.client.query(`INSERT INTO public.projects (id, company_id, name, status) VALUES ($1, $2, $3, $4)`, [id, company, name, status]).then(() => id);
  };

  /** n issues in a project, all with the given status, created and last touched `touchedDaysAgo` days ago. */
  async function issues(w: Hybrid, projectId: string, n: number, status: string, touchedDaysAgo: number, extra: { parent?: string | null; createdDaysAgo?: number; agent?: string; origin?: string } = {}): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const id = uuid();
      ids.push(id);
      await w.client.query(
        `INSERT INTO public.issues (id, company_id, identifier, title, status, assignee_agent_id, project_id, parent_id, completed_at, created_at, updated_at, origin_kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [id, A, `PAR-${seq}`, `Issue ${seq}`, status, extra.agent ?? DEV, projectId, extra.parent ?? null, status === "done" ? daysAgo(touchedDaysAgo) : null, daysAgo(extra.createdDaysAgo ?? touchedDaysAgo + 2), daysAgo(touchedDaysAgo), extra.origin ?? "manual"],
      );
    }
    return ids;
  }

  const run = (w: Hybrid, issueId: string, usd: number, status = "succeeded", extra: { wake?: string; days?: number } = {}) =>
    w.client.query(
      `INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, finished_at, context_snapshot, usage_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
      [uuid(), A, DEV, status, daysAgo(extra.days ?? 6), new Date(Date.parse(daysAgo(extra.days ?? 6)) + 120_000).toISOString(), JSON.stringify({ issueId, ...(extra.wake ? { wakeReason: extra.wake } : {}) }), JSON.stringify({ costUsd: usd, inputTokens: 1000 })],
    );

  const reviewIssues = (w: Hybrid) => [...w.issues.values()].filter((i) => i.originKind === ORIGIN.closeout);

  describe("the daily sweep", () => {
    it("opens ONE review for a finished project, with the numbers gathered, assigned to the Operator", async () => {
      const w = await make();
      const p = await project(w, "Website rebuild");
      const ids = await issues(w, p, 5, "done", 5);
      await issues(w, p, 1, "cancelled", 6);
      await run(w, ids[0]!, 3.5);
      await run(w, ids[1]!, 2, "failed");
      await run(w, ids[1]!, 1, "succeeded", { wake: "issue_reopened_via_comment" });
      const result = await sweepCompany(w.env, A);
      expect(result).toMatchObject({ opened: 1, failed: 0 });
      const [issue] = reviewIssues(w);
      expect(issue!.title).toBe("Close-out review: Website rebuild (finished)");
      expect(issue).toMatchObject({ assigneeAgentId: OP, status: "todo", originKind: ORIGIN.closeout, originId: `${ORIGIN_ID.closeout}project:${p}:final:${daysAgo(5).slice(0, 10)}` });
      expect(w.wakeups).toContain(issue!.id);
      const text = issue!.description;
      expect(text).toContain("**The Website rebuild project**: finished. Every one of its 6 issues is done or cancelled");
      expect(text).toContain("| Issues | 6: 5 done, 1 cancelled |");
      expect(text).toContain("| Runs | 3: 2 succeeded, 1 failed, 0 cancelled |");
      expect(text).toContain("1 reopened by a comment");
      expect(text).toContain("| Notional spend | $6.50, $1.30 per finished issue");
      expect(text).toContain("- Developer: $6.50, 3 runs (1 failed); skills company-os, developer");
      expect(text).toContain("`PATCH /api/projects/" + p + "`");
      // reviewed once: the next sweep and a second event add nothing
      expect(await sweepCompany(w.env, A)).toMatchObject({ opened: 0 });
      expect(reviewIssues(w)).toHaveLength(1);
    });

    it("leaves work between waves alone: open issues, a recent touch, too few issues, long ago", async () => {
      const w = await make();
      const open = await project(w, "Still going");
      await issues(w, open, 4, "done", 5);
      await issues(w, open, 1, "in_progress", 5);
      const recent = await project(w, "Just closed");
      await issues(w, recent, 4, "done", 1);
      const small = await project(w, "Small");
      await issues(w, small, 2, "done", 6);
      const old = await project(w, "Old");
      await issues(w, old, 4, "done", 120);
      expect(await sweepCompany(w.env, A)).toMatchObject({ opened: 0 });
      expect(reviewIssues(w)).toHaveLength(0);
    });

    const plusDays = (n: number) => new Date(Date.parse(NOW) + n * 86_400_000).toISOString();

    it("counts an evergreen project from the day it is first seen, then reviews a milestone every 40 closed issues, at most once in 14 days", async () => {
      const w = await make();
      const p = await project(w, "Hunt and Gun");
      await issues(w, p, 90, "done", 3, { createdDaysAgo: 60 });
      await issues(w, p, 7, "in_progress", 1);
      // day 1: a baseline, no review (it would flood the Operator with every old client project)
      expect(await sweepCompany(w.env, A)).toMatchObject({ opened: 0, baselined: 1 });
      expect(reviewIssues(w)).toHaveLength(0);
      expect((await readCursors(w.env.ctx, A)).get(p)).toMatchObject({ closed: 90, baseline: true });
      // 40 closes the same day: enough closed issues, but a busy project does not get a review every day
      await issues(w, p, 40, "done", 0, { createdDaysAgo: 5 });
      expect(await sweepCompany(w.env, A)).toMatchObject({ opened: 0 });
      w.clock.set(plusDays(13));
      expect(await sweepCompany(w.env, A)).toMatchObject({ opened: 0 });
      // day 14: the gap has passed
      w.clock.set(plusDays(14));
      expect(await sweepCompany(w.env, A)).toMatchObject({ opened: 1 });
      const [issue] = reviewIssues(w);
      expect(issue!.title).toBe(`Close-out review: Hunt and Gun (milestone, ${plusDays(14).slice(0, 10)})`);
      expect(issue!.description).toContain("40 issues were closed in the 14 days since the last review (one every 40 closed issues, at most once in 14 days).");
      expect(issue!.description).not.toContain("Close the project in Paperclip");
      // counting restarts from this review: one short of 40 closes is not enough after any wait under a month
      expect((await readCursors(w.env.ctx, A)).get(p)).toMatchObject({ closed: 130, baseline: false });
      await issues(w, p, 39, "done", 0, { createdDaysAgo: 5 });
      w.clock.set(plusDays(40));
      expect(await sweepCompany(w.env, A)).toMatchObject({ opened: 0 });
      await issues(w, p, 1, "done", 0, { createdDaysAgo: 5 });
      expect(await sweepCompany(w.env, A)).toMatchObject({ opened: 1 });
      expect(reviewIssues(w)).toHaveLength(2);
    });

    it("also reviews a milestone after a month with at least five closed, whatever the count", async () => {
      const w = await make();
      const p = await project(w, "Agri Studies");
      await issues(w, p, 45, "done", 3, { createdDaysAgo: 60 });
      expect(await sweepCompany(w.env, A)).toMatchObject({ baselined: 1 });
      await issues(w, p, 5, "done", 0, { createdDaysAgo: 5 });
      w.clock.set(plusDays(29));
      expect(await sweepCompany(w.env, A)).toMatchObject({ opened: 0 });
      w.clock.set(plusDays(30));
      expect(await sweepCompany(w.env, A)).toMatchObject({ opened: 1 });
      expect(reviewIssues(w)[0]!.description).toContain("30 days since the last review, with 5 issues closed.");
    });

    it("never reviews housekeeping: 150 plugin operations and routine runs closed in a week open nothing, for days on end", async () => {
      const w = await make();
      // the live LLM Wiki project: every issue is a plugin operation, about 25 closed a day
      const wiki = await project(w, "LLM Wiki");
      await issues(w, wiki, 150, "done", 5, { createdDaysAgo: 6, origin: "plugin:paperclipai.plugin-llm-wiki:operation" });
      const routines = await project(w, "Routines");
      await issues(w, routines, 30, "done", 4, { createdDaysAgo: 40, origin: "routine_execution" });
      await issues(w, routines, 10, "done", 4, { createdDaysAgo: 40, origin: "task_watchdog" });
      for (let day = 0; day < 6; day += 1) {
        w.clock.set(plusDays(day * 3));
        await issues(w, wiki, 25, "done", 0, { createdDaysAgo: 1, origin: "plugin:paperclipai.plugin-llm-wiki:operation" });
        const result = await sweepCompany(w.env, A);
        expect(result).toMatchObject({ opened: 0, baselined: 0, failed: 0 });
      }
      expect(reviewIssues(w)).toHaveLength(0);
      expect(await readCursors(w.env.ctx, A)).toEqual(new Map());
      // a project explicitly set to completed that held nothing but housekeeping is not reviewed either
      await w.client.query(`UPDATE public.projects SET status = 'completed' WHERE id = $1`, [wiki]);
      expect(await onProjectUpdated(w.env, { companyId: A, entityId: wiki, entityType: "project", payload: { changedKeys: ["status"] } } as never)).toBe("ignored");
      expect(reviewIssues(w)).toHaveLength(0);
    });

    it("judges a mixed project on its real work only: the operations next to it add nothing to the count, the numbers or the cost", async () => {
      const w = await make();
      const p = await project(w, "Covalonic");
      const real = await issues(w, p, 50, "done", 3, { createdDaysAgo: 60 });
      const ops = await issues(w, p, 150, "done", 3, { createdDaysAgo: 60, origin: "plugin:paperclipai.plugin-llm-wiki:operation" });
      expect(await sweepCompany(w.env, A)).toMatchObject({ baselined: 1 });
      expect((await readCursors(w.env.ctx, A)).get(p)).toMatchObject({ closed: 50 }); // not 200
      // runs after the baseline: $4 on a real issue, $9 on an operation
      await run(w, real[0]!, 4, "succeeded", { days: 0 });
      await run(w, ops[0]!, 9, "succeeded", { days: 0 });
      // 150 more operations closed in a month: still no review
      await issues(w, p, 150, "done", 0, { createdDaysAgo: 2, origin: "plugin:paperclipai.plugin-llm-wiki:operation" });
      w.clock.set(plusDays(20));
      expect(await sweepCompany(w.env, A)).toMatchObject({ opened: 0 });
      // 40 real issues: now it is a milestone, and the review counts only the real work
      await issues(w, p, 40, "done", 0, { createdDaysAgo: 2 });
      expect(await sweepCompany(w.env, A)).toMatchObject({ opened: 1 });
      const text = reviewIssues(w)[0]!.description;
      expect(text).toContain("| Issues | 90: 90 done, 0 cancelled |");
      expect(text).toContain("| Notional spend | $4.00, $0.04 per finished issue");
      expect(text).not.toContain("$13.00");
    });

    it("opens at most three a day, oldest work first, and the rest the next day", async () => {
      const w = await make();
      for (let i = 0; i < 5; i += 1) {
        const p = await project(w, `Project ${i}`);
        await issues(w, p, 4, "done", 5 + i);
      }
      expect(await sweepCompany(w.env, A)).toMatchObject({ opened: CLOSEOUT.maxPerSweep });
      // the oldest finished (touched 9, 8, 7 days ago) came first
      expect(reviewIssues(w).map((i) => i.title)).toEqual(["Close-out review: Project 4 (finished)", "Close-out review: Project 3 (finished)", "Close-out review: Project 2 (finished)"]);
      expect(await sweepCompany(w.env, A)).toMatchObject({ opened: 2 });
      expect(reviewIssues(w)).toHaveLength(5);
    });

    it("reviews a closed epic the events missed", async () => {
      const w = await make();
      const p = await project(w, "Portal");
      const [root] = await issues(w, p, 1, "done", 2);
      await issues(w, p, 4, "done", 2, { parent: root });
      const result = await sweepCompany(w.env, A);
      expect(result.opened).toBeGreaterThanOrEqual(1);
      expect(reviewIssues(w).some((i) => i.originId?.includes(`tree:${root}:`))).toBe(true);
    });

    it("runs for every company with saved settings, not a company that has none", async () => {
      const w = await make();
      const p = await project(w, "Done thing");
      await issues(w, p, 4, "done", 5);
      const other = await project(w, "Theirs", "in_progress", OTHER_COMPANY);
      await w.client.query(`INSERT INTO public.issues (id, company_id, identifier, title, status, project_id, completed_at, created_at, updated_at) SELECT gen_random_uuid(), $1, 'X-' || g, 'x', 'done', $2, $3, $3, $3 FROM generate_series(1, 4) g`, [OTHER_COMPANY, other, daysAgo(5)]);
      const result = await closeoutSweep(w.env);
      expect(result).toMatchObject({ companies: 1, opened: 1 });
      expect(reviewIssues(w).every((i) => i.companyId === A)).toBe(true);
    });
  });

  describe("project.updated", () => {
    it("reviews a project the moment it is set to completed, and ignores every other update", async () => {
      const w = await make();
      const p = await project(w, "Launch", "completed");
      await issues(w, p, 3, "done", 1);
      await issues(w, p, 1, "in_progress", 1);
      const event = (changedKeys: unknown, companyId: string | null = A) => ({ companyId, entityId: p, entityType: "project", payload: { changedKeys } }) as never;
      expect(await onProjectUpdated(w.env, event(["name"]))).toBe("ignored");
      expect(await onProjectUpdated(w.env, event(["status"], null))).toBe("ignored");
      expect(await onProjectUpdated(w.env, event(undefined))).toBe("ignored");
      expect(await onProjectUpdated(w.env, event(["status"]))).toBe("opened");
      expect(reviewIssues(w)).toHaveLength(1);
      expect(reviewIssues(w)[0]!.description).toContain("The project was marked completed (3 issues done, 0 cancelled).");
      expect(await onProjectUpdated(w.env, event(["status"]))).toBe("exists");
      // a status change to something else is not a completion
      await w.client.query(`UPDATE public.projects SET status = 'in_progress' WHERE id = $1`, [p]);
      expect(await onProjectUpdated(w.env, event(["status"]))).toBe("ignored");
    });

    it("does nothing for a company whose team was never saved (the Cockpit does not act there)", async () => {
      const w = await worlds.make({ agents: [] });
      const p = uuid();
      await w.client.query(`INSERT INTO public.projects (id, company_id, name, status) VALUES ($1, $2, 'X', 'completed')`, [p, A]);
      await issues(w, p, 3, "done", 1);
      expect(await onProjectUpdated(w.env, { companyId: A, entityId: p, entityType: "project", payload: { changedKeys: ["status"] } } as never)).toBe("ignored");
    });
  });

  describe("an epic closes (issue.updated)", () => {
    const event = (issueId: string, status: unknown = "done") => ({ companyId: A, entityId: issueId, entityType: "issue", payload: { status } }) as never;

    it("reviews the epic when its last issue closes, whichever issue it was", async () => {
      const w = await make();
      const p = await project(w, "Portal");
      const [root] = await issues(w, p, 1, "done", 1);
      const [child] = await issues(w, p, 1, "done", 1, { parent: root });
      await issues(w, p, 1, "done", 1, { parent: child });
      const [last] = await issues(w, p, 2, "done", 1, { parent: root });
      const [open] = await issues(w, p, 1, "in_progress", 1, { parent: root });
      // one issue under the epic is still open: nothing yet
      expect(await onIssueClosed(w.env, event(last!))).toBe("ignored");
      await w.client.query(`UPDATE public.issues SET status = 'done', completed_at = $2 WHERE id = $1`, [open, daysAgo(0)]);
      expect(await onIssueClosed(w.env, event(open!))).toBe("opened");
      const [issue] = reviewIssues(w);
      expect(issue!.title).toMatch(/^Close-out review: PAR-\d+: Issue \d+ \(epic closed\)$/);
      expect(issue!.description).toContain("and the 5 issues under it are all closed");
      expect(await onIssueClosed(w.env, event(last!))).toBe("exists"); // any issue of the same tree finds the same review
    });

    it("counts only real work under an epic: housekeeping children do not make a small tree an epic, and an automated root is no epic", async () => {
      const w = await make();
      const p = await project(w, "Portal");
      const [root] = await issues(w, p, 1, "done", 1);
      const [child] = await issues(w, p, 2, "done", 1, { parent: root });
      await issues(w, p, 6, "done", 1, { parent: root, origin: "plugin:paperclipai.plugin-llm-wiki:operation" });
      expect(await readTreeFacts(w.env.ctx, A, child!)).toMatchObject({ total: 3, open: 0 }); // the root and two real children: not 9
      expect(await onIssueClosed(w.env, event(child!))).toBe("ignored");
      const [routineRoot] = await issues(w, p, 1, "done", 1, { origin: "routine_execution" });
      const [routineChild] = await issues(w, p, 5, "done", 1, { parent: routineRoot });
      expect(await readTreeFacts(w.env.ctx, A, routineChild!)).toBeNull();
      expect(await onIssueClosed(w.env, event(routineChild!))).toBe("ignored");
      expect(reviewIssues(w)).toHaveLength(0);
    });

    it("ignores a close that is not a done, a small tree and an unknown issue", async () => {
      const w = await make();
      const p = await project(w, "Small");
      const [root] = await issues(w, p, 1, "done", 1);
      const [child] = await issues(w, p, 2, "done", 1, { parent: root });
      expect(await onIssueClosed(w.env, event(child!, "in_review"))).toBe("ignored");
      expect(await onIssueClosed(w.env, event(child!, undefined))).toBe("ignored");
      expect(await onIssueClosed(w.env, event(child!))).toBe("ignored"); // 3 issues in all: not an epic
      expect(await onIssueClosed(w.env, event(uuid()))).toBe("ignored");
      expect(await readTreeFacts(w.env.ctx, A, uuid())).toBeNull();
      expect(reviewIssues(w)).toHaveLength(0);
    });
  });

  describe("by hand and in the done-check", () => {
    it("the Operator can open one for a project or an epic, once a day", async () => {
      const w = await make();
      const p = await project(w, "Something");
      const [root] = await issues(w, p, 1, "in_progress", 1);
      await issues(w, p, 2, "done", 1, { parent: root });
      const run = { agentId: OP, runId: "r", companyId: A, projectId: "" };
      const first = (await runOpsTool(w.env, "open-closeout-review", { projectId: p }, run)) as { content: string; error?: string };
      expect(first.error).toBeUndefined();
      expect(first.content).toContain("Opened the close-out review");
      const again = (await runOpsTool(w.env, "open-closeout-review", { projectId: p }, run)) as { content: string };
      expect(again.content).toContain("already opened today");
      const epic = await openCloseoutNow(w.env, A, { issueId: root! });
      expect(epic).toMatchObject({ action: "opened", kind: "tree" });
      expect(reviewIssues(w).map((i) => i.title)).toEqual(expect.arrayContaining(["Close-out review: Something (milestone, 2026-10-03)"]));
      expect(((await runOpsTool(w.env, "open-closeout-review", {}, run)) as { error?: string }).error).toBe("Pass projectId or issueId.");
      expect(((await runOpsTool(w.env, "open-closeout-review", { projectId: uuid() }, run)) as { error?: string }).error).toContain("not found in this company");
    });

    it("takes what an agent actually has: an issue identifier such as PAR-12, a project's exact name, and says so plainly when it is neither (never a database error)", async () => {
      const w = await make();
      const p = await project(w, "Something");
      const [root] = await issues(w, p, 1, "in_progress", 1);
      await issues(w, p, 2, "done", 1, { parent: root });
      const run = { agentId: OP, runId: "r", companyId: A, projectId: "" };
      const call = (params: Record<string, unknown>) => runOpsTool(w.env, "open-closeout-review", params, run) as Promise<{ content: string; error?: string }>;
      const identifier = ((await w.client.query(`SELECT identifier FROM public.issues WHERE id = $1`, [root])).rows[0] as { identifier: string }).identifier;
      const byIdentifier = await call({ issueId: identifier.toLowerCase() });
      expect(byIdentifier.error).toBeUndefined();
      expect(byIdentifier.content).toContain("Opened the close-out review");
      expect(reviewIssues(w).at(-1)!.originId).toContain(`tree:${root}:`);
      const byName = await call({ projectId: "something" });
      expect(byName.error).toBeUndefined();
      expect(byName.content).toContain("Opened the close-out review");
      expect(reviewIssues(w).at(-1)!.title).toContain("Something (milestone");
      expect((await call({ issueId: "PAR-99999" })).error).toContain("not found in this company");
      expect((await call({ projectId: "No such project" })).error).toContain("not found in this company");
      // a name two projects share asks for the id instead of guessing
      await project(w, "Twin");
      await project(w, "Twin");
      expect((await call({ projectId: "Twin" })).error).toContain('Two projects are named "Twin"');
      // a project of pure housekeeping holds no real work to review
      const wiki = await project(w, "LLM Wiki");
      await issues(w, wiki, 5, "done", 1, { origin: "plugin:paperclipai.plugin-llm-wiki:operation" });
      expect((await call({ projectId: wiki })).error).toContain("no issues of real work");
      // another company's project is not found by name either
      const other = await project(w, "Theirs", "in_progress", OTHER_COMPANY);
      expect((await call({ projectId: "Theirs" })).error).toContain("not found in this company");
      expect((await call({ projectId: other })).error).toContain("not found in this company");
    });

    it("an agent that closes the review with its checklist unticked sees it reopened", async () => {
      const w = await make();
      const p = await project(w, "Website");
      await issues(w, p, 4, "done", 5);
      await sweepCompany(w.env, A);
      const issue = reviewIssues(w)[0]!;
      const rule = cockpitDoneRules(w.env).find((r) => issue.originId!.startsWith(r.originPrefix))!;
      expect(rule.label).toBe("Close-out review");
      const result = await rule.check({ id: issue.id, companyId: A, identifier: "PAR-99", title: issue.title, originId: issue.originId ?? null, assigneeAgentId: OP, createdAt: null }, w.ctx);
      expect(result.done).toBe(false);
      expect(result.missing?.join("\n")).toContain("Not ticked: Read the evidence.");
      expect(NAMESPACE).toContain("cockpit");
    });
  });
});
