/**
 * How the Cockpit is wired, with the real registration (registerCockpit) on a
 * real Postgres: every job the manifest declares is registered and does its
 * work for companies with saved settings only, and the host events reach the
 * handlers (one `issue.updated` handler that does three things, one
 * `project.updated` handler).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JOBS, ORIGIN } from "../src/constants.js";
import { healthAlerts } from "../src/health.js";
import manifest from "../src/manifest.js";
import { proposeImprovement } from "../src/improvements.js";
import { setGoal } from "../src/goals.js";
import { NAMESPACE } from "../src/namespace.js";
import { saveTeam } from "../src/roles.js";
import { COMPANY, OTHER_COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const OP = "aaaaaaaa-0000-4000-8000-0000000000a1";
const DEV = "aaaaaaaa-0000-4000-8000-0000000000a2";
const NOW = "2026-10-05T04:30:00.000Z"; // a Monday
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
const SKILLS = ["plugin/partnersinbiz-cockpit/company-os"];

d("how the Cockpit is wired (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  async function make(extra: Parameters<typeof worlds.make>[0] = {}) {
    seq = 0;
    const w = await worlds.make(
      {
        savedConfigs: { [A]: { healthIssue: true } },
        prefixes: { [A]: "PAR" },
        agents: [
          { id: OP, companyId: A, name: "Olive", status: "active", role: "general" },
          { id: DEV, companyId: A, name: "Developer", status: "idle", role: "engineer", adapterConfig: { paperclipSkillSync: { desiredSkills: SKILLS } } } as never,
        ],
        ...extra,
      },
      NOW,
    );
    await saveTeam(w.env, A, { operatorAgentId: OP }, "user-owner");
    return w;
  }

  const project = async (w: Hybrid, name: string, status: string) => {
    const id = uuid();
    await w.client.query(`INSERT INTO public.projects (id, company_id, name, status) VALUES ($1, $2, $3, $4)`, [id, A, name, status]);
    return id;
  };
  const doneIssues = async (w: Hybrid, projectId: string, n: number, quietDays: number, parent: string | null = null) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const id = uuid();
      ids.push(id);
      await w.client.query(
        `INSERT INTO public.issues (id, company_id, identifier, title, status, assignee_agent_id, project_id, parent_id, completed_at, created_at, updated_at) VALUES ($1, $2, $3, $4, 'done', $5, $6, $7, $8, $9, $8)`,
        [id, A, `PAR-${seq}`, `Issue ${seq}`, DEV, projectId, parent, daysAgo(quietDays), daysAgo(quietDays + 5)],
      );
    }
    return ids;
  };
  const reviews = (w: Hybrid) => [...w.issues.values()].filter((i) => i.originKind === ORIGIN.closeout);

  describe("jobs", () => {
    it("every job the manifest declares is registered, with the schedule it is declared with, and nothing else is", async () => {
      const w = await make();
      const declared = (manifest.jobs ?? []).map((j) => j.jobKey).sort();
      expect([...w.jobs.keys()].sort()).toEqual(declared);
      const schedule = Object.fromEntries((manifest.jobs ?? []).map((j) => [j.jobKey, j.schedule]));
      expect(schedule).toMatchObject({
        [JOBS.closeoutSweep]: "20 4 * * *",
        [JOBS.improvementsRecheck]: "40 4 * * *",
        [JOBS.credentialsCheck]: "50 3 * * *",
        [JOBS.businessReview]: "30 4 * * 1", // Mondays, before the Weekly retro
      });
    });

    it("closeout-sweep opens a review for a project that went quiet, for a company with saved settings only", async () => {
      const w = await make({ savedConfigs: { [A]: { healthIssue: true } } });
      const p = await project(w, "Launch", "in_progress");
      await doneIssues(w, p, 4, 6);
      await w.jobs.get(JOBS.closeoutSweep)!();
      expect(reviews(w)).toHaveLength(1);
      expect(reviews(w)[0]!.companyId).toBe(A);
      // a second company with the same work, but nothing saved for it, is left alone
      const other = await make({ savedConfigs: {} });
      await other.client.query(`INSERT INTO public.projects (id, company_id, name, status) VALUES ($1, $2, 'Other', 'in_progress')`, [uuid(), OTHER_COMPANY]);
      await other.jobs.get(JOBS.closeoutSweep)!();
      expect(reviews(other)).toHaveLength(0);
    });

    it("improvements-recheck measures what is due and writes the verdict; what is not due yet is left alone", async () => {
      const w = await make();
      const runs = (status: string, n: number) =>
        w.client.query(
          `INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, finished_at, usage_json) SELECT gen_random_uuid(), $1, $2, $3, $4::timestamptz - (g || ' minutes')::interval, $4::timestamptz - (g || ' minutes')::interval, '{}'::jsonb FROM generate_series(1, $5::int) g`,
          [A, DEV, status, daysAgo(1), n],
        );
      await runs("succeeded", 7);
      await runs("failed", 3);
      const due = await proposeImprovement(w.env, A, { title: "Fewer failures", metricKey: "company:fail_rate", targetValue: 10, recheckInDays: 3 }, { agentId: OP, userId: null });
      const later = await proposeImprovement(w.env, A, { title: "Not yet", metricKey: "company:fail_rate", targetValue: 5, recheckInDays: 60 }, { agentId: OP, userId: null });
      expect(due.improvement.baselineValue).toBe(30);
      w.clock.set(daysAgo(-4)); // four days on: the first is due
      await w.client.query("DELETE FROM public.heartbeat_runs");
      await runs("succeeded", 19);
      await runs("failed", 1);
      await w.jobs.get(JOBS.improvementsRecheck)!();
      const rows = (await w.client.query(`SELECT id, status, outcome, result_value FROM ${NAMESPACE}.improvements ORDER BY title`)).rows as Array<Record<string, any>>;
      expect(rows.find((r) => r.id === due.improvement.id)).toMatchObject({ status: "resolved", outcome: "improved" });
      expect(Number(rows.find((r) => r.id === due.improvement.id)!.result_value)).toBe(5);
      expect(rows.find((r) => r.id === later.improvement.id)).toMatchObject({ status: "open", outcome: null });
    });

    it("business-review opens one issue for the Operator on Monday, and not another for the same week", async () => {
      const w = await make({ goals: true });
      await setGoal(w.env, A, { title: "10 posts a month", metricKey: "manual", targetValue: 10, direction: "higher", baselineValue: 2, period: "month" }, { agentId: null, userId: "user-owner" });
      await w.jobs.get(JOBS.businessReview)!();
      await w.jobs.get(JOBS.businessReview)!();
      const issues = [...w.issues.values()].filter((i) => i.originKind === ORIGIN.businessReview);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ assigneeAgentId: OP, companyId: A });
    });

    it("health-alerts does everything for a company in one pass: the grant question, the System health issue and the skill sweep", async () => {
      const w = await make();
      const counts = await healthAlerts(w.env);
      // Developer carries a PiB skill but cannot call the memory tools: one batched question to the owner
      const asks = (await w.client.query(`SELECT source, kind, effect FROM ${NAMESPACE}.asks`)).rows as Array<Record<string, any>>;
      expect(asks).toHaveLength(1);
      expect(asks[0]).toMatchObject({ source: "cockpit", kind: "grant" });
      expect(asks[0]!.effect.params.agentIds).toBe(DEV);
      expect(counts).toMatchObject({ asked_grant: 1 });
      expect(counts.skillsSynced).toBeDefined(); // the sweep over every company's skills ran
      expect(w.skillCalls.length).toBeGreaterThan(0);
      // the job runs it with the same result, and a second pass asks nothing new (the question is open)
      await w.jobs.get(JOBS.healthAlerts)!();
      expect((await w.client.query(`SELECT 1 FROM ${NAMESPACE}.asks`)).rows).toHaveLength(1);
    });

    it("health-alerts skips a company with no saved settings entirely", async () => {
      const w = await make({ savedConfigs: {} });
      await w.jobs.get(JOBS.healthAlerts)!();
      expect((await w.client.query(`SELECT 1 FROM ${NAMESPACE}.asks`)).rows).toHaveLength(0);
      expect([...w.issues.values()].filter((i) => i.originKind === ORIGIN.health)).toHaveLength(0);
    });
  });

  describe("host events", () => {
    it("project.updated reaches the close-out handler with the changed keys (one subscription)", async () => {
      const w = await make();
      expect(w.handlers.get("project.updated")).toHaveLength(1);
      const p = await project(w, "Portal", "completed");
      await doneIssues(w, p, 3, 1);
      await w.fire("project.updated", { companyId: A, entityId: p, entityType: "project", payload: { changedKeys: ["name"] } });
      expect(reviews(w)).toHaveLength(0);
      await w.fire("project.updated", { companyId: A, entityId: p, entityType: "project", payload: { changedKeys: ["status"] } });
      expect(reviews(w)).toHaveLength(1);
    });

    it("one issue.updated does all three things: follows an open question, reviews a closed epic, checks the done rules", async () => {
      const w = await make();
      expect(w.handlers.get("issue.updated")).toHaveLength(1);
      // an epic whose issues are all closed
      const p = await project(w, "Epic", "in_progress");
      const [root] = await doneIssues(w, p, 1, 1);
      await doneIssues(w, p, 3, 1, root!);
      // and an open question on an issue the owner has not answered, which an agent was handed back without a reply
      const fake = await w.ctx.issues.create({ companyId: A, title: "Asked", description: "", status: "in_review", assigneeUserId: "user-owner" } as never);
      await w.client.query(`INSERT INTO ${NAMESPACE}.asks (id, company_id, issue_id, question, status, kind) VALUES ('ask-1', $1, $2, 'Which logo?', 'open', 'decision')`, [A, fake.id]);
      await w.ctx.issues.update(fake.id, { assigneeAgentId: DEV, assigneeUserId: null, status: "todo" }, A);
      await w.fire("issue.updated", { companyId: A, entityType: "issue", entityId: fake.id, payload: { status: "todo" } });
      expect((await w.client.query(`SELECT status FROM ${NAMESPACE}.asks WHERE id = 'ask-1'`)).rows).toEqual([{ status: "resolved" }]);
      await w.fire("issue.updated", { companyId: A, entityType: "issue", entityId: root!, payload: { status: "done" } });
      expect(reviews(w)).toHaveLength(1);
      expect(reviews(w)[0]!.title).toContain("(epic closed)");
    });

    it("a handler that throws does not stop the next one in the same event", async () => {
      const w = await make();
      const p = await project(w, "Epic", "in_progress");
      const [root] = await doneIssues(w, p, 1, 1);
      await doneIssues(w, p, 3, 1, root!);
      // the question follower reads the asks table first: with that table gone it throws, and the close-out review must still happen
      await w.client.query(`ALTER TABLE ${NAMESPACE}.asks RENAME TO asks_gone`);
      try {
        await expect(w.fire("issue.updated", { companyId: A, entityType: "issue", entityId: root!, payload: { status: "done" } })).resolves.toBeUndefined();
        expect(reviews(w)).toHaveLength(1);
      } finally {
        await w.client.query(`ALTER TABLE ${NAMESPACE}.asks_gone RENAME TO asks`);
      }
    });
  });
});
