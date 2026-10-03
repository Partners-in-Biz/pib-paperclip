/**
 * The checks the Cockpit adds to its own snapshot (checks.ts), against a real
 * Postgres for the Cockpit's tables and the host's core tables, and the fake
 * host for agents, grants and issues: role drift, run profile, grants,
 * approvals, the Needs-you backlog, measurement alerts, owner confirmations,
 * credentials, improvements and goals.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEMORY_TOOLS_GRANT, PLUGIN_TOOLS_GRANT, repairUnroutedApprovals } from "@partnersinbiz/pib-plugin-kit";
import { extraChecks, forgetChecks } from "../src/checks.js";
import { ensureGrantAsk } from "../src/effects.js";
import { NAMESPACE } from "../src/namespace.js";
import { ownSnapshot } from "../src/own.js";
import { saveTeam } from "../src/roles.js";
import { confirmAttestation } from "../src/security.js";
import { COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { fakeCtx } from "./helpers/fake-ctx.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const OP = "aaaaaaaa-0000-4000-8000-0000000000a1";
const DEV = "aaaaaaaa-0000-4000-8000-0000000000a2";
const NOW = "2026-10-03T12:00:00.000Z";
const SKILLS = ["plugin/partnersinbiz-cockpit/operator", "plugin/partnersinbiz-cockpit/company-os", "paperclipai/paperclip/paperclip"];
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

d("the Cockpit's extra checks (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  const hoursAgo = (n: number) => new Date(Date.parse(NOW) - n * 3_600_000).toISOString();

  async function make(options: Parameters<typeof fakeCtx>[0] = {}) {
    seq = 0;
    const w = await worlds.make({
      savedConfigs: { [A]: { healthIssue: true } },
      prefixes: { [A]: "PAR" },
      agents: [
        { id: OP, companyId: A, name: "Olive", status: "active", role: "general", adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-5-5", timeoutSec: 3600, paperclipSkillSync: { desiredSkills: SKILLS } } } as never,
        { id: DEV, companyId: A, name: "Developer", status: "idle", role: "engineer", adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-5-5", timeoutSec: 3600 } } as never,
      ],
      ...options,
    });
    await saveTeam(w.env, A, { operatorAgentId: OP }, "user-owner");
    return w;
  }

  const keys = (checks: Array<{ key: string }>) => checks.map((c) => c.key);
  const fresh = (w: Hybrid) => extraChecks(w.env, A, { fresh: true });

  describe("agents and their access", () => {
    it("names a staffed agent that lacks its skills, and clears when they are attached (Q9-8)", async () => {
      const w = await make();
      (w.agents[0] as { adapterConfig: unknown }).adapterConfig = { model: "claude-sonnet-5-5", timeoutSec: 3600 };
      const checks = (await fresh(w)).health;
      const drift = checks.find((c) => c.key === "roles:drift")!;
      expect(drift).toMatchObject({ status: "warn", title: "Agents missing skills or tool access" });
      expect(drift.detail).toContain("Olive (Operator) lacks skill plugin/partnersinbiz-cockpit/operator");
      expect(drift.fix).toContain("Fix skills");
      (w.agents[0] as { adapterConfig: unknown }).adapterConfig = { model: "claude-sonnet-5-5", timeoutSec: 3600, paperclipSkillSync: { desiredSkills: SKILLS } };
      expect(keys((await fresh(w)).health)).not.toContain("roles:drift");
    });

    it("flags a claude_local agent with no model or timeout, and says it is a board action (Q8-7)", async () => {
      const w = await make();
      (w.agents[1] as { adapterConfig: unknown }).adapterConfig = {};
      const check = (await fresh(w)).health.find((c) => c.key === "agents:run-profile")!;
      expect(check).toMatchObject({ status: "warn", title: "Agents with no run profile" });
      expect(check.detail).toContain("Developer: no model pinned");
      expect(check.fix).toContain("full adapterConfig");
      (w.agents[1] as { adapterConfig: unknown }).adapterConfig = { model: "claude-sonnet-5-5", timeoutSec: 3600 };
      expect(keys((await fresh(w)).health)).not.toContain("agents:run-profile");
    });

    it("finds agents that carry PiB skills but cannot use memory, and offers the narrow grant first (Q9-6)", async () => {
      const w = await make();
      (w.agents[1] as { adapterConfig: unknown }).adapterConfig = { model: "m", timeoutSec: 60, paperclipSkillSync: { desiredSkills: ["plugin/partnersinbiz-cockpit/company-os"] } };
      const result = await fresh(w);
      const check = result.health.find((c) => c.key === "grants:plugin-tools")!;
      expect(check.title).toBe("Agents that cannot use company memory");
      expect(check.detail).toContain("Developer");
      expect(check.fix).toContain("narrowest grant");
      const item = result.waiting.find((x) => x.key === "grants:plugin-tools")!;
      expect(item).toMatchObject({ kind: "grant", title: "Let 1 agent use company memory" });
      expect(item.why).toContain("memory-only grant");
      // a memory-only grant satisfies it
      w.grants.set(DEV, [{ permissionKey: MEMORY_TOOLS_GRANT.permissionKey, scope: MEMORY_TOOLS_GRANT.scope }]);
      expect(keys((await fresh(w)).health)).not.toContain("grants:plugin-tools");
    });

    it("does not list the grant twice once the Cockpit's own question for it is open", async () => {
      const w = await make();
      (w.agents[1] as { adapterConfig: unknown }).adapterConfig = { model: "m", timeoutSec: 60, paperclipSkillSync: { desiredSkills: ["plugin/partnersinbiz-cockpit/company-os"] } };
      expect((await fresh(w)).waiting.map((x) => x.key)).toContain("grants:plugin-tools");
      expect((await ensureGrantAsk(w.env, A)).action).toBe("opened");
      const after = await fresh(w);
      expect(after.waiting.map((x) => x.key)).not.toContain("grants:plugin-tools");
      expect(keys(after.health)).toContain("grants:plugin-tools"); // the warning stays until the grant exists
    });

    it("does not list the same agents again the moment the owner has answered no: a no holds for the cooldown, then the question is asked again", async () => {
      const w = await make();
      (w.agents[1] as { adapterConfig: unknown }).adapterConfig = { model: "m", timeoutSec: 60, paperclipSkillSync: { desiredSkills: ["plugin/partnersinbiz-cockpit/company-os"] } };
      await ensureGrantAsk(w.env, A);
      // the owner answered no: the question is closed and nothing was granted
      await w.client.query(`UPDATE ${NAMESPACE}.asks SET status = 'answered', closed_at = $1 WHERE company_id = $2 AND source = 'cockpit'`, [NOW, A]);
      const after = await fresh(w);
      expect(after.waiting.map((x) => x.key)).not.toContain("grants:plugin-tools");
      expect(keys(after.health)).toContain("grants:plugin-tools"); // the health warning is the fact, and stays
      // a new agent that cannot use memory was never asked about: it is listed
      w.agents.push({ id: "bbbbbbbb-0000-4000-8000-000000000001", companyId: A, name: "Penny", status: "active", role: "general", adapterType: "claude_local", adapterConfig: { model: "m", timeoutSec: 60, paperclipSkillSync: { desiredSkills: ["plugin/partnersinbiz-cockpit/company-os"] } } } as never);
      const withNew = (await fresh(w)).waiting.find((x) => x.key === "grants:plugin-tools")!;
      expect(withNew.title).toBe("Let 1 agent use company memory");
      expect(withNew.why).toContain("Penny");
      expect(withNew.why).not.toContain("Developer");
      // 14 days later the first agent is open to a new question again
      w.clock.set("2026-10-18T12:00:00.000Z");
      expect((await fresh(w)).waiting.find((x) => x.key === "grants:plugin-tools")!.title).toBe("Let 2 agents use company memory");
    });
  });

  describe("approvals and blocked work (RC5)", () => {
    it("is red for an approval nobody was assigned, and the hourly repair hands it to the owner", async () => {
      const w = await make();
      const issue = await w.ctx.issues.create({ companyId: A, title: "Approve email sending: Spring sequence", description: "", status: "todo", originKind: "plugin:partnersinbiz.crm" } as never);
      w.issues.get(issue.id)!.createdAt = hoursAgo(5);
      const bad = (await fresh(w)).health.find((c) => c.key === "approvals:unrouted")!;
      expect(bad).toMatchObject({ status: "bad", title: "Approvals with nobody to decide them" });
      expect(bad.detail).toContain("Approve email sending: Spring sequence");
      const result = await repairUnroutedApprovals(w.ctx, A, { now: Date.parse(NOW) });
      expect(result.repaired).toEqual([issue.id]);
      expect(w.issues.get(issue.id)!.assigneeUserId).toBe("user-owner");
      expect(keys((await fresh(w)).health)).not.toContain("approvals:unrouted");
    });

    it("lists unrouted approvals and blocked issues with no way out in the Needs-you list", async () => {
      const w = await make();
      const approval = await w.ctx.issues.create({ companyId: A, title: "Review: spring post", description: "", status: "todo", originKind: "plugin:partnersinbiz.social" } as never);
      w.issues.get(approval.id)!.createdAt = hoursAgo(3);
      const blockedId = uuid();
      w.issues.set(blockedId, { id: blockedId, companyId: A, title: "Stuck thing", description: "", status: "blocked", assigneeAgentId: DEV, identifier: "PAR-9", createdAt: hoursAgo(80), updatedAt: hoursAgo(48) });
      const waiting = (await fresh(w)).waiting;
      expect(waiting.find((x) => x.key === `approval:${approval.id}`)).toMatchObject({ title: "Review: spring post", kind: "review" });
      expect(waiting.find((x) => x.key === `blocked:${blockedId}`)).toMatchObject({ title: "PAR-9: Stuck thing", kind: "judgement", href: "/PAR/issues/PAR-9" });
      // a blocker that is still open is a way out: it leaves the list
      const blocker = uuid();
      await w.client.query(`INSERT INTO public.issues (id, company_id, identifier, title, status) VALUES ($1, $2, 'PAR-8', 'Blocker', 'in_progress'), ($3, $2, 'PAR-9', 'Stuck thing', 'blocked')`, [blocker, A, blockedId]);
      await w.client.query(`INSERT INTO public.issue_relations (company_id, issue_id, related_issue_id, type) VALUES ($1, $2, $3, 'blocks')`, [A, blocker, blockedId]);
      expect((await fresh(w)).waiting.map((x) => x.key)).not.toContain(`blocked:${blockedId}`);
    });
  });

  describe("what waits on the owner (critic: the Needs-you backlog)", () => {
    const ask = (id: string, issueId: string, askedHoursAgo: number, extra: Record<string, unknown> = {}) =>
      `INSERT INTO ${NAMESPACE}.asks (id, company_id, issue_id, issue_identifier, question, why, kind, status, asked_at, updated_at) VALUES ('${id}', '${A}', '${issueId}', '${extra.identifier ?? id}', 'Q ${id}', 'w', 'decision', 'open', '${hoursAgo(askedHoursAgo)}', '${hoursAgo(askedHoursAgo)}')`;

    it("is quiet for a few fresh items, warns at ten, and goes red when the oldest is a week old", async () => {
      const w = await make();
      for (let i = 0; i < 3; i += 1) await w.client.query(ask(`q${i}`, uuid(), 5));
      expect(keys((await fresh(w)).health)).not.toContain("backlog:needs-you");
      for (let i = 3; i < 10; i += 1) await w.client.query(ask(`q${i}`, uuid(), 5));
      const ten = (await fresh(w)).health.find((c) => c.key === "backlog:needs-you")!;
      expect(ten).toMatchObject({ status: "warn", title: "10 things wait on the owner" });
      expect(ten.detail).toContain("10 questions");
      await w.client.query(`UPDATE ${NAMESPACE}.asks SET asked_at = '${hoursAgo(24 * 8)}' WHERE id = 'q0'`);
      const old = (await fresh(w)).health.find((c) => c.key === "backlog:needs-you")!;
      expect(old.status).toBe("bad");
      expect(old.title).toBe("10 things wait on the owner, the oldest for 8 days");
    });

    it("counts an issue once however many ways it waits, and counts the owner's own issues and pending approvals", async () => {
      const w = await make({ approvals: [{ id: "ap1", companyId: A, status: "pending", createdAt: hoursAgo(100) }] });
      const issueId = uuid();
      await w.client.query(`INSERT INTO public.issues (id, company_id, identifier, title, status, assignee_user_id, updated_at) VALUES ($1, $2, 'PAR-5', 'Owner thing', 'in_review', 'user-owner', $3)`, [issueId, A, hoursAgo(80)]);
      await w.client.query(ask("qa", issueId, 80)); // the same issue is an ask and assigned to the owner
      const check = (await fresh(w)).health.find((c) => c.key === "backlog:needs-you");
      // 1 issue + 1 approval = 2 things, the oldest 4 days: warn on age
      expect(check).toMatchObject({ status: "warn", title: "2 things wait on the owner, the oldest for 4 days" });
    });

    it("says when questions to the owner were asked more than three days ago and nobody touched the issue since", async () => {
      const w = await make();
      const handled = uuid();
      const forgotten = uuid();
      await w.client.query(`INSERT INTO public.issues (id, company_id, identifier, title, status, updated_at) VALUES ($1, $2, 'PAR-1', 'Forgotten', 'in_review', $3), ($4, $2, 'PAR-2', 'Chased', 'in_review', $5)`, [forgotten, A, hoursAgo(24 * 5), handled, hoursAgo(10)]);
      await w.client.query(ask("old1", forgotten, 24 * 5, { identifier: "PAR-1" }));
      await w.client.query(ask("old2", handled, 24 * 5, { identifier: "PAR-2" }));
      const check = (await fresh(w)).health.find((c) => c.key === "asks:unhandled")!;
      expect(check).toMatchObject({ status: "warn", title: "1 question to the owner has gone unhandled for 3 days", href: "/issues/PAR-1" });
      expect(check.detail).toContain("nobody answered, chased or escalated it");
    });
  });

  describe("measurement alerts (Q8-3, Q8-8, Q9-12)", () => {
    const run = (status: string, hours: number, usd: number, extra: { error?: string; code?: string } = {}) =>
      `INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, finished_at, error, error_code, usage_json) VALUES ('${uuid()}', '${A}', '${DEV}', '${status}', '${hoursAgo(hours)}', '${hoursAgo(hours - 0.01)}', ${extra.error ? `'${extra.error}'` : "NULL"}, ${extra.code ? `'${extra.code}'` : "NULL"}, '{"costUsd": ${usd}}')`;

    it("flags a day of spend far above the usual and puts the week's notional spend on the page", async () => {
      const w = await make();
      for (const h of [30, 54, 78, 102, 126, 150, 174]) await w.client.query(run("succeeded", h, 10));
      await w.client.query(run("succeeded", 2, 180));
      const result = await fresh(w);
      const check = result.health.find((c) => c.key === "spend:anomaly")!;
      expect(check.title).toBe("Notional AI spend is 18 times the usual");
      const kpi = result.kpis.find((k) => k.key === "ai_spend_7d")!;
      expect(kpi).toMatchObject({ label: "AI spend, 7 days (notional)", group: "delivery", raw: 240 });
      expect(kpi.value).toBe("$240");
      expect(kpi.hint).toContain("Not billed");
    });

    it("honours a daily cap from the settings", async () => {
      const w = await make({ savedConfigs: { [A]: { healthIssue: true, notionalDailyUsd: 50 } } });
      await w.client.query(run("succeeded", 2, 60));
      expect(keys((await fresh(w)).health)).toContain("spend:daily-cap");
    });

    it("goes red when the plan's limit takes runs down", async () => {
      const w = await make();
      for (let i = 0; i < 6; i += 1) await w.client.query(run("failed", 3, 0, { error: 'ACP agent reported a terminal limit failure.', code: "acpx_turn_failed" }));
      const check = (await fresh(w)).health.find((c) => c.key === "limit-failures")!;
      expect(check).toMatchObject({ status: "bad", title: "6 runs failed on the subscription limit in 24 hours" });
      expect(check.detail).toContain("Developer (6)");
    });

    it("warns when most finished code work was not reviewed", async () => {
      const w = await make();
      for (let i = 0; i < 10; i += 1) {
        await w.client.query(`INSERT INTO public.issues (id, company_id, identifier, title, status, assignee_agent_id, completed_at) VALUES ('${uuid()}', '${A}', 'PAR-${100 + i}', 'Done thing', 'done', '${DEV}', '${hoursAgo(10 + i)}')`);
      }
      const result = await fresh(w);
      expect(result.health.find((c) => c.key === "review:coverage")).toMatchObject({ status: "warn", title: "Only 0% of finished code work was reviewed" });
      expect(result.kpis.find((k) => k.key === "review_coverage")).toMatchObject({ value: "0%", tone: "warn" });
    });
  });

  describe("confirmations and the register (critic)", () => {
    it("asks for each owner confirmation until it is given, and again when it lapses", async () => {
      const w = await make();
      const warns = (await fresh(w)).health.filter((c) => c.key.startsWith("attest:"));
      expect(warns.map((c) => c.key)).toEqual(["attest:signup_closed", "attest:backup_key_custody", "attest:second_admin", "attest:mac_backup"]);
      expect(warns.every((c) => c.status === "warn")).toBe(true);
      for (const key of ["signup_closed", "backup_key_custody", "second_admin", "mac_backup"]) await confirmAttestation(w.env, A, key, "user-owner");
      expect((await fresh(w)).health.filter((c) => c.key.startsWith("attest:"))).toEqual([]);
      w.clock.set("2027-05-01T12:00:00.000Z"); // 180+ days later
      expect((await fresh(w)).health.filter((c) => c.key.startsWith("attest:")).map((c) => c.detail)[0]).toContain("more than 180 days ago");
    });

    it("says a company with one owner or admin is a single point of failure, unless a deputy is confirmed", async () => {
      const one = await make({ members: [{ principalType: "user", status: "active", membershipRole: "owner" }, { principalType: "user", status: "active", membershipRole: "viewer" }] });
      const check = (await fresh(one)).health.find((c) => c.key === "access:single-admin")!;
      expect(check).toMatchObject({ status: "warn", title: "Only one person can administer this company" });
      expect(check.detail).toContain("cannot see the instance-level admins or the server's SSH keys");
      const two = await make({ members: [{ principalType: "user", status: "active", membershipRole: "owner" }, { principalType: "user", status: "active", membershipRole: "admin" }] });
      expect(keys((await fresh(two)).health)).not.toContain("access:single-admin");
      await confirmAttestation(one.env, A, "second_admin", "user-owner");
      expect(keys((await fresh(one)).health)).not.toContain("access:single-admin");
      // members that cannot be read say nothing: the confirmation is all there is
      const blind = await make();
      expect(keys((await fresh(blind)).health)).not.toContain("access:single-admin");
    });

    it("a deputy confirmation that has lapsed (180 days) no longer excuses the single-admin warning", async () => {
      const one = await make({ members: [{ principalType: "user", status: "active", membershipRole: "owner" }] });
      await confirmAttestation(one.env, A, "second_admin", "user-owner");
      expect(keys((await fresh(one)).health)).not.toContain("access:single-admin");
      one.clock.set("2027-03-30T12:00:00.000Z"); // a few days short of 180: still excused
      expect(keys((await fresh(one)).health)).not.toContain("access:single-admin");
      one.clock.set("2027-05-01T12:00:00.000Z"); // more than 180 days
      const keysLater = keys((await fresh(one)).health);
      expect(keysLater).toContain("attest:second_admin");
      expect(keysLater).toContain("access:single-admin");
    });

    it("warns 30 days before a credential expires, goes red at 7, and names where to rotate it", async () => {
      const w = await make();
      await w.client.query(`INSERT INTO ${NAMESPACE}.credentials (id, company_id, name, system, expires_at, rotate_how, rotate_href) VALUES ('c1', '${A}', 'GitHub token', 'GitHub', '2026-10-20T00:00:00Z', 'Create a new token', 'https://github.com/settings/personal-access-tokens'), ('c2', '${A}', 'Resend key', 'Resend', '2026-10-08T00:00:00Z', NULL, NULL), ('c3', '${A}', 'Far one', 'X', '2027-06-01T00:00:00Z', NULL, NULL)`);
      const checks = (await fresh(w)).health.filter((c) => c.key.startsWith("credential:"));
      expect(checks.map((c) => [c.key, c.status])).toEqual([["credential:c1:expiry", "warn"], ["credential:c2:expiry", "bad"]]);
      expect(checks[0]!.title).toBe("GitHub token expires in 16 days");
      expect(checks[0]!.href).toBe("https://github.com/settings/personal-access-tokens");
    });
  });

  describe("self-improvement and goals (Q2-3, Q10-3)", () => {
    it("warns about an improvement past its re-check date and shows the open count on the page", async () => {
      const w = await make();
      await w.client.query(`INSERT INTO ${NAMESPACE}.improvements (id, company_id, title, kind, metric_key, direction, baseline_value, recheck_at, status) VALUES ('i1', '${A}', 'Tighten X', 'skill', 'manual', 'lower', 12, '${hoursAgo(24 * 5)}', 'open'), ('i2', '${A}', 'Later', 'skill', 'manual', 'lower', 12, '${new Date(Date.parse(NOW) + 7 * 86_400_000).toISOString()}', 'open')`);
      const result = await fresh(w);
      expect(result.health.find((c) => c.key === "improvements:overdue")).toMatchObject({ status: "warn", title: "1 improvement past the re-check date" });
      expect(result.kpis.find((k) => k.key === "improvements_open")).toMatchObject({ value: "2", tone: "warn" });
    });

    it("shows how many goals are on track", async () => {
      const w = await make();
      await w.client.query(`INSERT INTO ${NAMESPACE}.goals (id, company_id, title, metric_key, direction, target_value, baseline_value, period, status, last_value) VALUES ('goal000000000001', '${A}', 'Leads', 'manual', 'higher', 10, 2, 'week', 'active', 9), ('goal000000000002', '${A}', 'Posts', 'manual', 'higher', 10, 0, 'week', 'active', 2)`);
      const kpi = (await fresh(w)).kpis.find((k) => k.key === "goals_on_track")!;
      expect(kpi).toMatchObject({ value: "1 of 2", tone: "warn", group: "other" });
    });
  });

  describe("how it runs", () => {
    it("is cached for ten minutes per company and can be refreshed", async () => {
      const w = await make();
      const first = await extraChecks(w.env, A);
      expect(await extraChecks(w.env, A)).toBe(first);
      w.clock.set("2026-10-03T12:09:00.000Z");
      expect(await extraChecks(w.env, A)).toBe(first);
      w.clock.set("2026-10-03T12:11:00.000Z");
      expect(await extraChecks(w.env, A)).not.toBe(first);
      const again = await extraChecks(w.env, A);
      forgetChecks(w.env, A);
      expect(await extraChecks(w.env, A)).not.toBe(again);
    });

    it("one check that cannot read its data does not take the others down", async () => {
      const w = await make();
      (w.ctx as unknown as { authorization: unknown }).authorization = { grants: { list: async () => { throw new Error("grants unreadable"); }, set: async () => [] } };
      const result = await fresh(w);
      expect(keys(result.health)).toContain("attest:signup_closed"); // later checks still ran
      expect(keys(result.health)).not.toContain("roles:drift");
    });

    it("reaches the Cockpit's own snapshot: health, KPIs, quality and waiting", async () => {
      const w = await make();
      const snapshot = await ownSnapshot(w.env, A);
      expect(keys(snapshot.health)).toContain("attest:signup_closed");
      expect(snapshot.kpis.map((k) => k.key)).toContain("ai_spend_7d");
      expect(snapshot.quality.map((q) => q.key)).toContain("memory_feedback_signal");
    });

    it("uses the kit's grant constants it was written against", () => {
      expect(PLUGIN_TOOLS_GRANT.scope).toEqual({ providerType: "paperclip_plugin" });
      expect(MEMORY_TOOLS_GRANT.scope.toolNames).toContain("partnersinbiz.cockpit:memory-recall");
    });
  });

  describe("the 0.5.0 jobs report when they stop working", () => {
    const JOBS: Array<[string, string, string]> = [
      ["closeout-sweep", "closeout_reviews", "Daily close-out reviews"],
      ["improvements-recheck", "improvements", "Daily improvements re-check"],
      ["credentials-check", "credentials", "Daily credentials check"],
      ["business-review", "goals", "Weekly business review"],
    ];

    it.each(JOBS)("%s: healthy before it has run, and a job that fails for every company it tried is bad on the health check (a failing job would otherwise leave its register empty or its reviews unopened, unseen)", async (job, table, title) => {
      const w = await make();
      const health = async () => (await ownSnapshot(w.env, A)).health.find((c) => c.key === `job:${job}`);
      expect(await health()).toMatchObject({ status: "ok", title, detail: "Has not run yet." });
      await w.jobs.get(job)!(); // a normal run: fine
      expect(await health()).toMatchObject({ status: "ok" });
      // the table the job works on is gone (renamed away, and put back afterwards for the next test): the job fails for its only company and must say so
      await w.client.query(`ALTER TABLE ${NAMESPACE}.${table} RENAME TO ${table}_gone`);
      try {
        await expect(w.jobs.get(job)!()).rejects.toThrow(/failed for its company/);
        await expect(w.jobs.get(job)!()).rejects.toThrow();
        await expect(w.jobs.get(job)!()).rejects.toThrow();
        expect(await health()).toMatchObject({ status: "bad", title });
      } finally {
        await w.client.query(`ALTER TABLE ${NAMESPACE}.${table}_gone RENAME TO ${table}`);
      }
    });
  });
});
