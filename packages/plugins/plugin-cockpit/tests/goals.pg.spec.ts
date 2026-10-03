/**
 * Company goals and the weekly business review (Q10-3) against a real Postgres
 * for the Cockpit's tables, with the fake host for issues, grants, the host's
 * goals and the owner's replies: proposing, the ONE question that confirms
 * them (an ask with an effect), the numbers read from the modules' reports,
 * and the Monday review.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onAskComment } from "../src/asks.js";
import { ORIGIN, ORIGIN_ID } from "../src/constants.js";
import { cockpitDoneRules } from "../src/done-checks.js";
import { ensureGoalsAsk } from "../src/effects.js";
import { activateGoals, businessReviews, getGoal, goalCounts, goalViews, listGoals, runBusinessReview, setGoal } from "../src/goals.js";
import { runOpsTool } from "../src/ops-tools.js";
import { NAMESPACE } from "../src/namespace.js";
import { ownSetupStatus } from "../src/own.js";
import { saveTeam } from "../src/roles.js";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const OP = "aaaaaaaa-0000-4000-8000-0000000000a1";
const NOW = "2026-10-05T04:30:00.000Z"; // a Monday, 06:30 in Johannesburg
const AGENT = { agentId: OP, userId: null as string | null };
const OWNER = { agentId: null as string | null, userId: "user-owner" };

d("goals and the business review (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  async function make(options: Parameters<typeof worlds.make>[0] = {}) {
    const w = await worlds.make(
      { savedConfigs: { [A]: { healthIssue: true } }, prefixes: { [A]: "PAR" }, agents: [{ id: OP, companyId: A, name: "Olive", status: "active", role: "general" }], goals: true, ...options },
      NOW,
    );
    await saveTeam(w.env, A, { operatorAgentId: OP }, "user-owner");
    return w;
  }

  /** A module's report with one number, as the Cockpit stores it. */
  const report = (w: Hybrid, plugin: string, kpis: Array<{ key: string; label: string; raw: number; value?: string }>) =>
    w.client.query(`INSERT INTO ${NAMESPACE}.snapshots (company_id, plugin_key, kind, payload, checked_at) VALUES ($1, $2, 'cockpit', $3::jsonb, $4) ON CONFLICT (company_id, plugin_key, kind) DO UPDATE SET payload = EXCLUDED.payload`, [
      A,
      plugin,
      JSON.stringify({ plugin, title: plugin, checkedAt: NOW, kpis: kpis.map((k) => ({ ...k, value: k.value ?? String(k.raw), group: "pipeline" })), health: [], waiting: [], activity: [], quality: [] }),
      NOW,
    ]);

  const LEADS = "kpi:partnersinbiz.crm:new_leads_week";

  describe("proposing", () => {
    it("measures where the number stands now from the module's report, and the goal waits for the owner's yes", async () => {
      const w = await make();
      await report(w, "partnersinbiz.crm", [{ key: "new_leads_week", label: "New leads this week", raw: 8 }]);
      const result = await setGoal(w.env, A, { title: "30 new leads a week", metricKey: LEADS, targetValue: 30, unit: "leads" }, AGENT);
      expect(result.created).toBe(true);
      expect(result.goal).toMatchObject({ status: "proposed", baselineValue: 8, targetValue: 30, direction: "higher", period: "week", ownerAgentId: OP, proposedByAgentId: OP, confirmedByUserId: null, metricLabel: "New leads this week" });
      expect(result.message).toContain("The Cockpit asks the owner once for every proposed goal; you do not need to ask");
      expect(w.hostGoals.size).toBe(0); // nothing is mirrored to the host until it is confirmed
    });

    it("refuses what cannot work: a number nobody reports, a target already met, a bad id, too many goals", async () => {
      const w = await make();
      await expect(setGoal(w.env, A, { title: "x", metricKey: LEADS, targetValue: 5 }, AGENT)).rejects.toThrow("has not reported to the Cockpit");
      await report(w, "partnersinbiz.crm", [{ key: "new_leads_week", label: "New leads this week", raw: 12 }]);
      await expect(setGoal(w.env, A, { title: "x", metricKey: LEADS, targetValue: 10 }, AGENT)).rejects.toThrow("The target 10 is already met: the number stands at 12 and higher is better. Set a target above it.");
      await expect(setGoal(w.env, A, { title: "x", metricKey: "company:fail_rate", targetValue: 50, baselineValue: 30 }, AGENT)).rejects.toThrow("already met");
      await expect(setGoal(w.env, A, { id: "goal0000000000ff", title: "y" }, AGENT)).rejects.toThrow("was not found in this company");
      for (let i = 0; i < 12; i += 1) await setGoal(w.env, A, { title: `Goal ${i}`, metricKey: "manual", targetValue: 10 + i }, AGENT);
      await expect(setGoal(w.env, A, { title: "One too many", metricKey: "manual", targetValue: 5 }, AGENT)).rejects.toThrow("more than 12 is a wish list");
    });

    it("a lower-is-better company metric knows its own direction", async () => {
      const w = await make();
      await w.client.query(`INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at) SELECT gen_random_uuid(), $1, $2, CASE WHEN g <= 4 THEN 'failed' ELSE 'succeeded' END, $3::timestamptz - (g || ' hours')::interval FROM generate_series(1, 10) g`, [A, OP, NOW]);
      const { goal } = await setGoal(w.env, A, { title: "Fewer failed runs", metricKey: "company:fail_rate", targetValue: 10 }, AGENT);
      expect(goal).toMatchObject({ direction: "lower", baselineValue: 40 });
    });

    it("a person who sets a goal confirms it: active at once, and mirrored to the host's goals", async () => {
      const w = await make();
      const { goal } = await setGoal(w.env, A, { title: "Revenue", metricKey: "manual", targetValue: 50000, baselineValue: 20000, unit: "ZAR", period: "month" }, OWNER);
      expect(goal).toMatchObject({ status: "active", confirmedByUserId: "user-owner" });
      expect(goal.hostGoalId).toMatch(/^host-goal-\d+$/);
      expect(w.hostGoals.get(goal.hostGoalId!)).toMatchObject({ title: "Revenue", status: "active", level: "company" });
    });

    it("records this week's number for a goal measured by hand, and only for such a goal", async () => {
      const w = await make();
      const manual = (await setGoal(w.env, A, { title: "Revenue", metricKey: "manual", targetValue: 50000 }, AGENT)).goal;
      const kpi = await (async () => {
        await report(w, "partnersinbiz.crm", [{ key: "new_leads_week", label: "New leads this week", raw: 3 }]);
        return (await setGoal(w.env, A, { title: "Leads", metricKey: LEADS, targetValue: 30 }, AGENT)).goal;
      })();
      const done = await setGoal(w.env, A, { id: manual.id, value: 21000 }, AGENT);
      expect(done.message).toContain("Recorded 21000 for this week");
      expect((await getGoal(w.ctx, A, manual.id))!.lastValue).toBe(21000);
      await expect(setGoal(w.env, A, { id: kpi.id, value: 5 }, AGENT)).rejects.toThrow("read automatically");
    });

    it("changing the target of an active goal makes it a proposal again; an agent can only drop a proposal", async () => {
      const w = await make();
      const { goal } = await setGoal(w.env, A, { title: "Revenue", metricKey: "manual", targetValue: 50000 }, OWNER);
      const same = await setGoal(w.env, A, { id: goal.id, title: "Monthly revenue" }, AGENT);
      expect(same.goal).toMatchObject({ status: "active", title: "Monthly revenue" });
      expect(same.reproposed).toBe(false);
      const moved = await setGoal(w.env, A, { id: goal.id, targetValue: 80000 }, AGENT);
      expect(moved).toMatchObject({ reproposed: true });
      expect(moved.goal).toMatchObject({ status: "proposed", targetValue: 80000 });
      expect(moved.message).toContain("proposal again until the owner confirms it");
      expect(w.hostGoals.get(goal.hostGoalId!)!.status).toBe("cancelled");
      expect((await setGoal(w.env, A, { id: goal.id, drop: true }, AGENT)).goal.status).toBe("dropped");
      const active = (await setGoal(w.env, A, { title: "Keep", metricKey: "manual", targetValue: 9 }, OWNER)).goal;
      await expect(setGoal(w.env, A, { id: active.id, drop: true }, AGENT)).rejects.toThrow("dropping a confirmed goal is the owner's call");
      // the owner moving the target is the confirmation
      expect((await setGoal(w.env, A, { id: active.id, targetValue: 12 }, OWNER)).goal.status).toBe("active");
    });
  });

  describe("the one question that confirms them (an ask with an effect)", () => {
    async function proposals(w: Hybrid) {
      await setGoal(w.env, A, { title: "Revenue", metricKey: "manual", targetValue: 50000, unit: "ZAR", period: "month" }, AGENT);
      await setGoal(w.env, A, { title: "Posts out", metricKey: "manual", targetValue: 12, unit: "posts" }, AGENT);
    }
    const asks = (w: Hybrid) => w.client.query(`SELECT * FROM ${NAMESPACE}.asks WHERE company_id = $1 ORDER BY asked_at`, [A]).then((r) => r.rows as Array<Record<string, any>>);
    const reply = async (w: Hybrid, issueId: string, text: string, user = "user-owner") => {
      const commentId = w.userComment(issueId, text, user);
      return onAskComment(w.env, { companyId: A, entityId: issueId, entityType: "issue", actorType: "user", actorId: user, payload: { commentId } } as never);
    };

    it("opens ONE question for every proposal, for the owner, carrying what a yes does", async () => {
      const w = await make();
      await proposals(w);
      const result = await ensureGoalsAsk(w.env, A);
      expect(result.action).toBe("opened");
      const [ask] = await asks(w);
      expect(ask).toMatchObject({ source: "cockpit", kind: "decision", status: "open", agent_id: null, return_agent_id: OP, owner_user_id: "user-owner" });
      expect(ask!.question).toContain("Adopt these 2 goals? Posts out (12 posts per week); Revenue (50000 ZAR per month).");
      expect(JSON.parse(JSON.stringify(ask!.effect))).toMatchObject({ key: "cockpit.activate-goals" });
      const issue = w.issues.get(ask!.issue_id)!;
      expect(issue).toMatchObject({ status: "in_review", assigneeUserId: "user-owner", originKind: ORIGIN.ask });
      expect(issue.originId).toBe(`${ORIGIN_ID.ask}goals:${A}:2026-10-05`);
      const comment = w.comments.find((c) => c.issueId === issue.id)!;
      expect(comment.body).toContain("**If you say yes to the first option:** Runs cockpit.activate-goals with goalIds=goal");
      // asked once: the next hourly run adds nothing
      expect((await ensureGoalsAsk(w.env, A)).action).toBe("exists");
      expect(await asks(w)).toHaveLength(1);
    });

    it("a yes adopts them, checks it, comments what happened, closes the issue and wakes nobody", async () => {
      const w = await make();
      await proposals(w);
      await ensureGoalsAsk(w.env, A);
      const [ask] = await asks(w);
      expect(await reply(w, ask!.issue_id, "Yes")).toBe("answered");
      expect((await listGoals(w.ctx, A, ["proposed"]))).toHaveLength(0);
      const active = await listGoals(w.ctx, A, ["active"]);
      expect(active.map((g) => g.title)).toEqual(["Posts out", "Revenue"]);
      expect(active.every((g) => g.confirmedByUserId === "user-owner" && g.hostGoalId)).toBe(true);
      const after = (await asks(w))[0]!;
      expect(after).toMatchObject({ status: "answered", effect_status: "applied", answered_by_user_id: "user-owner" });
      expect(after.effect_detail).toBe("Adopted 2 goals: Posts out; Revenue.");
      expect(w.comments.some((c) => c.issueId === ask!.issue_id && c.body.startsWith("**Applied and checked:** Adopted 2 goals"))).toBe(true);
      expect(w.issues.get(ask!.issue_id)!.status).toBe("done");
      expect(w.wakeups).toEqual([]); // nothing is left for an agent to do
      expect(w.updates.some((u) => u.patch.assigneeAgentId)).toBe(false);
    });

    it("a no leaves the goals as proposals, tells the Operator, and is not asked again until a goal changes", async () => {
      const w = await make();
      await proposals(w);
      await ensureGoalsAsk(w.env, A);
      const [ask] = await asks(w);
      await reply(w, ask!.issue_id, "No: make revenue 60000");
      const after = (await asks(w))[0]!;
      expect(after).toMatchObject({ effect_status: "declined", effect_detail: "The owner declined, so nothing was changed." }); // a no applies nothing
      expect(w.issues.get(ask!.issue_id)).toMatchObject({ status: "todo", assigneeAgentId: OP });
      expect(w.wakeReasons.at(-1)!.reason).toContain("What the answer was meant to do: declined: The owner declined, so nothing was changed.");
      expect((await listGoals(w.ctx, A, ["proposed"]))).toHaveLength(2);
      expect((await ensureGoalsAsk(w.env, A)).action).toBe("none"); // already answered about these as they stand
      w.clock.set("2026-10-05T06:00:00.000Z");
      const revenue = (await listGoals(w.ctx, A, ["proposed"])).find((g) => g.title === "Revenue")!;
      await setGoal(w.env, A, { id: revenue.id, targetValue: 60000 }, AGENT);
      expect((await ensureGoalsAsk(w.env, A)).action).toBe("opened"); // the Operator changed it: ask again
    });

    it("with more than six proposals the question lists six and adopts only those; the rest are asked right after, and a goal the owner already answered about is never asked twice", async () => {
      const w = await make();
      for (let i = 1; i <= 8; i += 1) await setGoal(w.env, A, { title: `Goal ${i}`, metricKey: "manual", targetValue: 10 * i, unit: "x" }, AGENT);
      expect((await ensureGoalsAsk(w.env, A)).action).toBe("opened");
      const [first] = await asks(w);
      expect(first!.question).toMatch(/^Adopt these 6 goals\? /);
      expect(first!.question).toContain("2 more proposed goals are asked right after this one.");
      const listed = String(JSON.parse(JSON.stringify(first!.effect)).params.goalIds).split(",");
      expect(listed).toHaveLength(6);
      // while it is open nothing else is opened
      expect((await ensureGoalsAsk(w.env, A)).action).toBe("exists");
      // the owner says yes: exactly the six listed become active, the other two stay proposals
      expect(await reply(w, first!.issue_id, "Yes")).toBe("answered");
      const active = (await listGoals(w.ctx, A, ["active"])).map((g) => g.id).sort();
      expect(active).toEqual([...listed].sort());
      const left = await listGoals(w.ctx, A, ["proposed"]);
      expect(left).toHaveLength(2);
      // the next hourly run asks about the two that were not on the first question, and only those
      w.clock.set("2026-10-05T07:00:00.000Z");
      expect((await ensureGoalsAsk(w.env, A)).action).toBe("opened");
      const second = (await asks(w))[1]!;
      expect(second.question).toMatch(/^Adopt these 2 goals\? /);
      expect(String(JSON.parse(JSON.stringify(second.effect)).params.goalIds).split(",").sort()).toEqual(left.map((g) => g.id).sort());
      // a no leaves them proposed and does not bring either question back
      await reply(w, second.issue_id, "No: lower both");
      expect((await ensureGoalsAsk(w.env, A)).action).toBe("none");
    });

    it("the Setup item names every proposal the button would adopt", async () => {
      const w = await make();
      await proposals(w);
      const item = (await ownSetupStatus(w.env, A)).items.find((i) => i.key === "goals")!;
      expect(item.detail).toContain("2 waiting for your yes: Posts out (12 posts per week); Revenue (50000 ZAR per month).");
      expect(item.action).toMatchObject({ key: "goals.confirm", label: "Confirm the 2 proposed goals" });
    });

    it("an agent cannot ask for this effect itself, and the Cockpit never runs it for an agent's own comment", async () => {
      const w = await make();
      await proposals(w);
      const issue = await w.ctx.issues.create({ companyId: A, title: "Some work", description: "", status: "in_progress", assigneeAgentId: OP } as never);
      const run = { agentId: OP, runId: "r1", companyId: A, projectId: "" };
      const refused = (await w.tools.get("ask-owner")!({ issueId: issue.id, question: "Adopt the goals?", why: "x", kind: "decision", links: [{ label: "Issue", href: `/PAR/issues/${issue.identifier}` }], effect: { key: "cockpit.activate-goals", params: { goalIds: "goal000000000001" } } }, run)) as { error?: string };
      expect(refused.error).toContain("is not an effect an agent may ask for");
      await ensureGoalsAsk(w.env, A);
      const [ask] = await asks(w);
      // an agent's comment (no user behind it) answers nothing
      const commentId = w.userComment(ask!.issue_id, "yes", "user-owner");
      expect(await onAskComment(w.env, { companyId: A, entityId: ask!.issue_id, entityType: "issue", actorType: "agent", actorId: OP, payload: { commentId } } as never)).toBe("ignored");
      expect((await listGoals(w.ctx, A, ["proposed"]))).toHaveLength(2);
    });

    it("the Setup button confirms them too, and closes the open question", async () => {
      const w = await make();
      await proposals(w);
      await ensureGoalsAsk(w.env, A);
      const before = await ownSetupStatus(w.env, A);
      expect(before.items.find((i) => i.key === "goals")).toMatchObject({ status: "optional", required: false, action: { plugin: "partnersinbiz.cockpit", key: "goals.confirm", label: "Confirm the 2 proposed goals" } });
      const context = { companyId: A, actor: { type: "user", userId: "user-owner" } };
      const result = (await w.actions.get("goals.confirm")!({}, context)) as { activated: Array<{ title: string }> };
      expect(result.activated.map((g) => g.title)).toEqual(["Posts out", "Revenue"]);
      const [ask] = await asks(w);
      expect(ask!.status).toBe("resolved");
      expect(w.issues.get(ask!.issue_id)!.status).toBe("done");
      await expect(w.actions.get("goals.confirm")!({}, { companyId: A, actor: { type: "agent" } })).rejects.toThrow("Only a board user can confirm goals");
      expect((await goalCounts(w.ctx, A))).toEqual({ active: 2, proposed: 0 });
    });
  });

  describe("reading the numbers", () => {
    it("takes the number from a module's report, in whole units for money, and compares it with last week's", async () => {
      const w = await make();
      await report(w, "partnersinbiz.billing", [{ key: "received_month", label: "Received this month", raw: 1_240_000, value: "R 12,400.00" }]);
      await report(w, "partnersinbiz.crm", [{ key: "new_leads_week", label: "New leads this week", raw: 14 }]);
      const money = (await setGoal(w.env, A, { title: "Cash in", metricKey: "kpi:partnersinbiz.billing:received_month", targetValue: 50000, unit: "ZAR", period: "month" }, OWNER)).goal;
      const leads = (await setGoal(w.env, A, { title: "Leads", metricKey: LEADS, targetValue: 30 }, OWNER)).goal;
      await w.client.query(`INSERT INTO ${NAMESPACE}.goal_values (company_id, goal_id, week_key, value, at) VALUES ($1, $2, '2026-W40', 9, $3)`, [A, leads.id, NOW]);
      const views = await goalViews(w.env, A, ["active"]);
      expect(views.find((v) => v.goal.id === money.id)!.progress).toMatchObject({ current: 12_400, state: "behind" });
      const v = views.find((x) => x.goal.id === leads.id)!;
      expect(v.progress).toMatchObject({ current: 14, change: 5, state: "behind" });
      // a module that is switched off or has not reported says why, never 0
      await w.client.query(`DELETE FROM ${NAMESPACE}.snapshots WHERE plugin_key = 'partnersinbiz.crm'`);
      const gone = (await goalViews(w.env, A, ["active"])).find((x) => x.goal.id === leads.id)!;
      expect(gone.progress.state).toBe("no_data");
      expect(gone.note).toBe("partnersinbiz.crm has not reported to the Cockpit.");
    });

    it("the tools: propose with goal-set, list with the numbers a goal can use", async () => {
      const w = await make();
      await report(w, "partnersinbiz.seo", [{ key: "seo_keywords_top10", label: "Keywords in the top 10", raw: 7 }]);
      const run = { agentId: OP, runId: "r", companyId: A, projectId: "" };
      const set = (await runOpsTool(w.env, "goal-set", { title: "20 keywords in the top 10", metricKey: "kpi:partnersinbiz.seo:seo_keywords_top10", targetValue: 20, unit: "keywords" }, run)) as { content: string; error?: string; data: { goal: { id: string; status: string } } };
      expect(set.error).toBeUndefined();
      expect(set.data.goal.status).toBe("proposed");
      const list = (await runOpsTool(w.env, "goal-list", { sources: true }, run)) as { content: string; data: { goals: Array<Record<string, unknown>>; sources: { company: unknown[]; kpis: Array<{ key: string; current: number | null }> } } };
      expect(list.content).toBe("1 goal.");
      expect(list.data.goals[0]).toMatchObject({ title: "20 keywords in the top 10", current: 7, state: "behind", progressPct: 0 });
      expect(list.data.sources.company.length).toBeGreaterThan(8);
      expect(list.data.sources.kpis).toContainEqual({ key: "kpi:partnersinbiz.seo:seo_keywords_top10", label: "Keywords in the top 10", plugin: "partnersinbiz.seo", current: 7 });
      const bad = (await runOpsTool(w.env, "goal-set", { title: "x", metricKey: "nonsense", targetValue: 1 }, run)) as { error?: string };
      expect(bad.error).toContain("is not a metric key");
      expect(((await runOpsTool(w.env, "goal-list", {}, { ...run, companyId: A })) as { content: string }).content).toBe("1 goal.");
    });
  });

  describe("the Monday review", () => {
    async function activeGoals(w: Hybrid) {
      await report(w, "partnersinbiz.crm", [{ key: "new_leads_week", label: "New leads this week", raw: 12 }]);
      await report(w, "partnersinbiz.seo", [{ key: "seo_keywords_top10", label: "Keywords in the top 10", raw: 21 }]);
      const leads = (await setGoal(w.env, A, { title: "30 new leads a week", metricKey: LEADS, targetValue: 30, unit: "leads", baselineValue: 8 }, OWNER)).goal;
      const keywords = (await setGoal(w.env, A, { title: "20 keywords in the top 10", metricKey: "kpi:partnersinbiz.seo:seo_keywords_top10", targetValue: 20, baselineValue: 5 }, OWNER)).goal;
      return { leads, keywords };
    }

    it("opens ONE review for the Operator comparing actuals to targets, and records the week's numbers", async () => {
      const w = await make();
      const { leads } = await activeGoals(w);
      const result = await runBusinessReview(w.env, A);
      expect(result.action).toBe("opened");
      const issue = [...w.issues.values()].find((i) => i.originKind === ORIGIN.businessReview)!;
      expect(issue).toMatchObject({ title: "Business review: week of 2026-10-05", assigneeAgentId: OP, priority: "high", originId: `${ORIGIN_ID.businessReview}${A}:2026-W41` });
      expect(issue.description).toContain("2 active goals: 1 reached, 0 on track, 1 behind.");
      expect(issue.description).toContain("| 30 new leads a week | New leads this week (week) | 30 leads | 12 leads |");
      expect(issue.description).toContain("- [ ] **30 new leads a week** is behind");
      expect(w.wakeups).toContain(issue.id);
      const values = await w.client.query(`SELECT goal_id, value FROM ${NAMESPACE}.goal_values WHERE week_key = '2026-W41' ORDER BY value`);
      expect(values.rows.map((r) => Number((r as Record<string, unknown>).value))).toEqual([12, 21]);
      expect((await getGoal(w.ctx, A, leads.id))!.lastValue).toBe(12);
      // once a week
      expect(await runBusinessReview(w.env, A)).toMatchObject({ action: "exists", issueId: issue.id });
      expect([...w.issues.values()].filter((i) => i.originKind === ORIGIN.businessReview)).toHaveLength(1);
      // next week's review compares with this week's numbers
      w.clock.set("2026-10-12T04:30:00.000Z");
      await runBusinessReview(w.env, A);
      const next = [...w.issues.values()].filter((i) => i.originKind === ORIGIN.businessReview).at(-1)!;
      expect(next.title).toBe("Business review: week of 2026-10-12");
      expect(next.description).toContain("| 12 leads | 12 leads |"); // now, last review
    });

    it("says nothing when there are no active goals, and runs from the weekly job for companies with saved settings", async () => {
      const w = await make();
      expect(await runBusinessReview(w.env, A)).toEqual({ action: "no_goals", issueId: null });
      await activeGoals(w);
      expect(await businessReviews(w.env)).toEqual({ opened: 1 });
      expect(await businessReviews(w.env)).toEqual({ exists: 1 });
    });

    it("a one-off goal is achieved when reached and missed when its date passes first", async () => {
      const w = await make();
      await report(w, "partnersinbiz.seo", [{ key: "seo_keywords_top10", label: "Keywords in the top 10", raw: 21 }]);
      await report(w, "partnersinbiz.crm", [{ key: "new_leads_week", label: "New leads this week", raw: 12 }]);
      const reached = (await setGoal(w.env, A, { title: "Top 10 keywords", metricKey: "kpi:partnersinbiz.seo:seo_keywords_top10", targetValue: 20, baselineValue: 5, dueOn: "2026-12-31" }, OWNER)).goal;
      const late = (await setGoal(w.env, A, { title: "Leads by September", metricKey: LEADS, targetValue: 30, baselineValue: 8, dueOn: "2026-09-30" }, OWNER)).goal;
      const ongoing = (await setGoal(w.env, A, { title: "Leads every week", metricKey: LEADS, targetValue: 40, baselineValue: 8 }, OWNER)).goal;
      await runBusinessReview(w.env, A);
      expect((await getGoal(w.ctx, A, reached.id))!.status).toBe("achieved");
      expect((await getGoal(w.ctx, A, late.id))!.status).toBe("missed");
      expect((await getGoal(w.ctx, A, ongoing.id))!.status).toBe("active");
      expect(w.hostGoals.get(reached.hostGoalId!)!.status).toBe("achieved");
      expect((await goalCounts(w.ctx, A))).toEqual({ active: 2, proposed: 0 }); // an achieved goal still counts for the setup item
    });

    it("an agent that closes the review with its checklist unticked sees it reopened", async () => {
      const w = await make();
      await activeGoals(w);
      await runBusinessReview(w.env, A);
      const issue = [...w.issues.values()].find((i) => i.originKind === ORIGIN.businessReview)!;
      const rule = cockpitDoneRules(w.env).find((r) => issue.originId!.startsWith(r.originPrefix))!;
      expect(rule.label).toBe("Weekly business review");
      const result = await rule.check({ id: issue.id, companyId: A, identifier: "PAR-1", title: issue.title, originId: issue.originId ?? null, assigneeAgentId: OP, createdAt: null }, w.ctx);
      expect(result.done).toBe(false);
    });
  });

  it("host goals are optional: without the capability a goal still works", async () => {
    const w = await make({ goals: false });
    const { goal } = await setGoal(w.env, A, { title: "Revenue", metricKey: "manual", targetValue: 5 }, OWNER);
    expect(goal).toMatchObject({ status: "active", hostGoalId: null });
    const done = await activateGoals(w.env, A, null, "user-owner");
    expect(done).toEqual([]);
  });
});
