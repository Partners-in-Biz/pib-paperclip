/**
 * `propose-skill-change` against a real Postgres (Q10-4, Q2-4): the diff is applied to
 * the skill's real text or refused, the improvement is recorded in the ledger with
 * the number it should move (and never twice), and the pull request package comes
 * back. Also the skill-policy action and the capability the eval harness needs.
 * The diff rules and the PR text are tested in skill-change-model.spec.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { NAMESPACE } from "../src/namespace.js";
import { ownSkills } from "../src/evals.js";
import { diffHash } from "../src/skill-change-model.js";
import { saveTeam } from "../src/roles.js";
import { COMPANY, OTHER_COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const OP = "aaaaaaaa-0000-4000-8000-0000000000a1";
const COACH = "c0ac4000-0000-4000-8000-000000000001";
const NOW = "2026-10-04T10:00:00.000Z";
const run = { agentId: COACH, runId: "r1", companyId: A, projectId: "p1" };
const userCtx = { companyId: A, actor: { type: "user", userId: "user-owner" } };

type ToolResult = { content: string; data: Record<string, any>; error?: string };

const reviewer = ownSkills().find((s) => s.slug === "pib-reviewer")!;
const operator = ownSkills().find((s) => s.slug === "pib-operator")!;
const ANCHOR = reviewer.markdown.split("\n").find((l) => l.startsWith("## Which approvals reach you"))!;
/** A small, valid change: one added line after a heading that appears once. */
const ADD = (line = "Say which approvals you did not see."): string => ["--- a/SKILL.md", "+++ b/SKILL.md", "@@ @@", ` ${ANCHOR}`, `+${line}`].join("\n");
/** A line of the reviewer skill that holds a never-rule. */
const NEVER_LINE = reviewer.markdown.split("\n").find((l) => /\b(never|do not)\b/i.test(l) && l.trim().length > 20)!;

const base = { skill: "pib-reviewer", reason: "Reviewers skip approvals that never reached them", metricKey: "manual", baselineValue: 12, targetValue: 4, direction: "lower", evidence: ["PAR-901", "PAR-902"] };

d("propose-skill-change (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  async function make() {
    const w = await worlds.make(
      {
        prefixes: { [A]: "PAR" },
        agents: [
          { id: OP, companyId: A, name: "Olive", status: "active", role: "general" },
          { id: COACH, companyId: A, name: "Reflection Coach", status: "idle", role: "general" },
        ],
      },
      NOW,
    );
    await saveTeam(w.env, A, { operatorAgentId: OP }, "user-owner");
    w.skillCalls.length = 0; // saving the team syncs skills: what the test checks is what comes after
    return w;
  }

  const propose = async (w: Hybrid, params: Record<string, unknown>): Promise<ToolResult> => (await w.tools.get("propose-skill-change")!({ ...base, diff: ADD(), ...params }, run)) as ToolResult;
  const ledger = async (w: Hybrid) => (await w.client.query(`SELECT * FROM ${NAMESPACE}.improvements ORDER BY created_at`)).rows as Array<Record<string, any>>;

  it("applies the diff to the shipped text, records the improvement with its number and returns the pull request", async () => {
    const w = await make();
    const out = await propose(w, { sourceIssueId: "PAR-77" });
    expect(out.error, out.content).toBeUndefined();
    const data = out.data;
    expect(data.verified).toBe(true);
    expect(data.review).toMatchObject({ allowed: true, needsOwner: false, added: 1, removed: 0, before: reviewer.markdown.length, after: reviewer.markdown.length + "Say which approvals you did not see.".length + 1 });
    expect(data.hash.before).toBe(reviewer.hash);
    expect(data.hash.after).not.toBe(reviewer.hash);
    const pr = data.package;
    expect(pr).toMatchObject({ base: "development" });
    expect(pr.branch).toBe(`skill/pib-reviewer/20261004-${diffHash(ADD())}`);
    expect(pr.title).toContain("Skill pib-reviewer: Reviewers skip approvals");
    expect(pr.body).toContain("Say which approvals you did not see.");
    expect(pr.body).toContain("PAR-901");
    expect(pr.body).toContain("Proposal: PAR-77");
    expect(pr.steps.join("\n")).toMatch(/eval|gate/i);
    expect(pr.files.join("\n")).toContain("skills.ts");
    // Ledger: one open entry, measured again in 28 days, against the number it should move.
    const rows = await ledger(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ company_id: A, kind: "skill", target_ref: "pib-reviewer", metric_key: "manual", direction: "lower", status: "open", source_ref: `skillchange:pib-reviewer:${diffHash(ADD())}`, created_by_agent_id: COACH });
    expect(Number(rows[0]!.baseline_value)).toBe(12);
    expect(Number(rows[0]!.target_value)).toBe(4);
    expect(new Date(rows[0]!.recheck_at).toISOString().slice(0, 10)).toBe("2026-11-01");
    expect(data.improvement).toMatchObject({ id: rows[0]!.id, deduped: false });
    expect(out.content).toContain(`Prepared the pull request: branch ${pr.branch} into development.`);
    expect(out.content).toContain("The diff applies (1 lines added, 0 removed;");
    // Nothing was changed anywhere else: the proposal does not edit a skill, a file or an agent.
    expect(w.skillCalls).toEqual([]);
  });

  it("the same proposal is recorded once; a different one is a second entry", async () => {
    const w = await make();
    await propose(w, {});
    const again = await propose(w, {});
    expect(again.data.improvement.deduped).toBe(true);
    expect(again.data.next.join(" ")).toContain("was already proposed");
    expect(await ledger(w)).toHaveLength(1);
    // Whitespace at the end of a line is not a different change.
    expect((await propose(w, { diff: `${ADD()}   \n` })).data.improvement.deduped).toBe(true);
    const other = await propose(w, { diff: ADD("Say which approvals you saw late.") });
    expect(other.data.improvement.deduped).toBe(false);
    expect(await ledger(w)).toHaveLength(2);
  });

  it("refuses a diff that does not apply, and records nothing", async () => {
    const w = await make();
    const bad = await propose(w, { diff: ["@@ @@", " ## A heading the skill does not have", "+x"].join("\n") });
    expect(bad.error).toContain("Hunk 1 does not apply");
    expect((await propose(w, { diff: "just prose, no hunks" })).error).toContain("The diff has no hunks");
    expect(await ledger(w)).toEqual([]);
  });

  it("refuses a change that takes a skill over its character budget, one that grows it too fast, and one with a secret", async () => {
    const w = await make();
    // The Operator's SKILL.md is within 200 characters of its test budget: a paragraph does not fit.
    const anchor = operator.markdown.split("\n").find((l) => l.startsWith("## Never"))!;
    const paragraph = Array.from({ length: 6 }, (_, i) => `+Line ${i}: a rule that costs every run tokens, ${"x".repeat(60)}`).join("\n");
    const over = await propose(w, { skill: "pib-operator", diff: ["@@ @@", ` ${anchor}`, paragraph].join("\n") });
    expect(over.error).toContain("over its 18950 budget");
    const big = Array.from({ length: 30 }, (_, i) => `+Rule ${i}: ${"y".repeat(70)}`).join("\n");
    const fast = await propose(w, { diff: ["@@ @@", ` ${ANCHOR}`, big].join("\n") });
    expect(fast.error).toContain("one change may add at most");
    const secret = await propose(w, { diff: ADD("Use the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 for the call.") });
    expect(secret.error).toContain("looks like it holds a secret");
    expect(await ledger(w)).toEqual([]);
  });

  it("allows a change that drops a never-rule but says it needs the owner's yes first", async () => {
    const w = await make();
    const out = await propose(w, { diff: ["@@ @@", `-${NEVER_LINE}`, "+This line was reworded to be softer."].join("\n") });
    expect(out.error, out.content).toBeUndefined();
    expect(out.data.review.needsOwner).toBe(true);
    expect(out.data.next.join(" ")).toContain("drops a \"never\" rule");
    expect(out.data.next.join(" ")).toContain("ask-owner");
    expect(out.data.package.body).toContain("OWNER:");
    expect(out.content).toContain("It drops a never-rule: ask the owner first.");
    expect(await ledger(w)).toHaveLength(1);
  });

  it("names the file when the skill has no such file, and checks a reference file against its own budget", async () => {
    const w = await make();
    expect((await propose(w, { skill: "pib-operator", file: "references/nope.md", diff: ADD() })).error).toContain("has no file references/nope.md");
    const health = operator.files.find((f) => f.path === "references/health-checks.md")!;
    const first = health.content.split("\n")[0]!;
    const ok = await propose(w, { skill: "pib-operator", file: "references/health-checks.md", diff: ["@@ @@", ` ${first}`, "+A line for the reference."].join("\n") });
    expect(ok.error, ok.content).toBeUndefined();
    expect(ok.data.review.budget).toBe(8000);
    expect(ok.data.hash.before).toBe(operator.hash);
    expect(ok.data.hash.after).not.toBe(operator.hash);
  });

  it("a skill the Cockpit does not ship is still proposed and measured, but says it was not checked", async () => {
    const w = await make();
    const out = await propose(w, { skill: "pib-crm", diff: ["@@ -1,1 +1,2 @@", " # CRM", "+A line."].join("\n") });
    expect(out.error, out.content).toBeUndefined();
    expect(out.data).toMatchObject({ verified: false, review: null, hash: null });
    expect(out.data.next.join(" ")).toContain("does not ship this skill");
    expect(out.data.package.body).toContain("Not checked here");
    expect(await ledger(w)).toHaveLength(1);
  });

  it("needs a number to move: a missing metric, or one the Cockpit cannot read, is refused and nothing is recorded", async () => {
    const w = await make();
    expect((await propose(w, { metricKey: undefined })).error).toContain("needs skill, diff, reason and metricKey");
    expect((await propose(w, { reason: "" })).error).toContain("needs skill, diff, reason and metricKey");
    expect((await propose(w, { metricKey: "company:made_up" })).error).toContain("is not a metric key");
    expect((await propose(w, { metricKey: "manual", baselineValue: undefined })).error).toContain("A manual metric needs baselineValue");
    expect((await propose(w, { targetValue: 20 })).error).toContain("does not point the right way");
    expect(await ledger(w)).toEqual([]);
  });

  it("is scoped to the company of the agent that asked", async () => {
    const w = await make();
    await propose(w, {});
    const rows = await ledger(w);
    expect(rows.map((r) => r.company_id)).toEqual([A]);
    const other = (await w.tools.get("propose-skill-change")!({ ...base, diff: ADD() }, { ...run, companyId: OTHER_COMPANY })) as ToolResult;
    expect(other.error, other.content).toBeUndefined();
    expect((await ledger(w)).map((r) => r.company_id).sort()).toEqual([A, OTHER_COMPANY].sort());
    expect(other.data.improvement.deduped).toBe(false);
  });
});

d("the skill-policy plan (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  const make = async (coach: boolean) => {
    const w = await worlds.make(
      {
        agents: [
          { id: OP, companyId: A, name: "Olive", status: "active", role: "general" },
          ...(coach ? [{ id: COACH, companyId: A, name: "Reflection Coach", status: "idle", role: "general" }] : []),
          { id: "aaaaaaaa-0000-4000-8000-0000000000ee", companyId: A, name: "Old Coach", status: "terminated", role: "general" },
        ],
      },
      NOW,
    );
    await saveTeam(w.env, A, { operatorAgentId: OP }, "user-owner");
    w.skillCalls.length = 0; // saving the team syncs skills: what the test checks is what comes after
    return w;
  };

  it("is for a board user: it gives the exact PUT body and applies nothing", async () => {
    const w = await make(true);
    const grantsBefore = JSON.stringify([...w.grants]);
    const keys = ["plugin/partnersinbiz.cockpit/pib-operator"];
    const plan = (await w.actions.get("cockpit.skill-policy-plan")!({ managedSkillKeys: keys, expectedRevision: 2 }, userCtx)) as { body: { expectedRevision: number; rules: Array<{ id: string; subject: unknown }> }; coach: { id: string; name: string } | null; apply: string; notes: string[] };
    expect(plan.body.expectedRevision).toBe(2);
    expect(plan.body.rules.map((r) => r.id)).toEqual(["no-edits-to-plugin-skills", "operator-test-copies", "coach-may-change-its-own-skills", "agents-may-test-skills", "agents-may-not-change-skills"]);
    expect(plan.body.rules[0]!.subject).toEqual({ type: "agents", agentIds: [COACH, OP] });
    expect(plan.coach).toEqual({ id: COACH, name: "Reflection Coach" });
    expect(plan.apply).toContain(`PUT /api/companies/${A}/skill-policy`);
    expect(plan.apply).toContain("a board action");
    expect(w.skillCalls).toEqual([]);
    expect(JSON.stringify([...w.grants])).toBe(grantsBefore);
  });

  it("says what is missing when there is no coach yet, and refuses an agent", async () => {
    const w = await make(false);
    const plan = (await w.actions.get("cockpit.skill-policy-plan")!({}, userCtx)) as { body: { rules: Array<{ id: string }> }; coach: unknown; notes: string[] };
    expect(plan.coach).toBeNull();
    expect(plan.body.rules.map((r) => r.id)).toEqual(["operator-test-copies", "agents-may-test-skills", "agents-may-not-change-skills"]);
    expect(plan.notes.join(" ")).toContain("No Reflection Coach is provisioned yet");
    await expect(w.actions.get("cockpit.skill-policy-plan")!({}, { companyId: A, actor: { type: "agent", agentId: OP } })).rejects.toThrow(/board user/i);
  });
});

describe("what the eval harness needs from the host", () => {
  it("declares the one new capability, to read the harness task's output document, and not the write", () => {
    expect(manifest.capabilities).toContain("issue.documents.read");
    expect(manifest.capabilities).not.toContain("issue.documents.write");
  });
});
