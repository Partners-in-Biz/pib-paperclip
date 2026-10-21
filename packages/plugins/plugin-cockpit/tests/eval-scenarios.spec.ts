/**
 * The seed golden scenarios (Q5-3, Q2-11, Q10-5) tested as data: a scenario is only
 * worth running if it can pass AND fail, names real tools with real parameters, and
 * is fair (the skill it tests actually tells an agent what the answer needs). The
 * model's own rules are tested in eval-model.spec.ts.
 */
import { describe, expect, it } from "vitest";
import { evalPrompt, gradeAnswer, scenarioHash, type Scenario } from "../src/eval-model.js";
import { cockpitToolNames, RESULTS_FILE, SCENARIO_FILES, scenariosFor, scenarioSkills } from "../src/eval-scenarios.js";
import { ownSkills } from "../src/evals.js";
import { AGENT_EVALS } from "../src/eval-scenarios.js";

type ToolDecl = { name: string; parametersSchema?: { properties?: Record<string, unknown> } };
const PLUGINS = ["crm", "billing", "social", "seo", "campaigns", "mailbox", "accounting"] as const;
const tools = new Map<string, ToolDecl>();
for (const plugin of PLUGINS) {
  const manifest = (await import(`../../plugin-${plugin}/src/manifest.ts`)).default as { id: string; tools?: ToolDecl[] };
  for (const t of manifest.tools ?? []) tools.set(`${manifest.id}:${t.name}`, t);
}
const cockpit = (await import("../src/manifest.js")).default as { id: string; tools?: ToolDecl[] };
for (const t of cockpit.tools ?? []) tools.set(`${cockpit.id}:${t.name}`, t);

const all: Array<{ skill: string; s: Scenario }> = SCENARIO_FILES.flatMap((f) => f.scenarios.map((s) => ({ skill: f.skill, s })));
const planOf = (answer: { plan: unknown[]; summary?: string }) => `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``;

describe("the seed scenarios", () => {
  it("cover the Operator, the Reviewer, the manual and the Acceptance skill", () => {
    expect(scenarioSkills().sort()).toEqual(["pib-acceptance", "pib-company-os", "pib-operator", "pib-reviewer"]);
    expect(all.length).toBeGreaterThanOrEqual(12);
  });

  it("include the situations the audit found: a block with no way out, a failing routine, a grant ask, a reviewer bypass", () => {
    const ids = all.map((a) => a.s.id);
    for (const id of ["blocked-no-way-out", "routine-failed-plugin-bug", "delegation-ask-with-effect", "memory-grant-already-asked", "late-review-of-outward-approval", "look-at-the-page-you-changed"]) expect(ids).toContain(id);
  });

  it("each cites where it comes from, and each id is unique across the files", () => {
    for (const { skill, s } of all) expect(s.source.length, `${skill}/${s.id}`).toBeGreaterThan(20);
    expect(new Set(all.map((a) => `${a.skill}/${a.s.id}`)).size).toBe(all.length);
  });

  it("each can pass and each can fail: its own right answer passes and its own wrong answer fails", () => {
    for (const { skill, s } of all) {
      expect(s.examples, `${skill}/${s.id} has no examples`).toBeDefined();
      const pass = gradeAnswer(s, planOf(s.examples!.pass));
      expect(pass.passed, `${skill}/${s.id} right answer: ${pass.checks.filter((c) => !c.ok).map((c) => c.detail).join("; ")}`).toBe(true);
      const fail = gradeAnswer(s, planOf(s.examples!.fail));
      expect(fail.passed, `${skill}/${s.id} wrong answer passed`).toBe(false);
      // A wrong answer is wrong for a reason a check names, not because it is malformed.
      expect(fail.checks.some((c) => !c.ok && !c.detail.includes("no JSON plan")), `${skill}/${s.id}`).toBe(true);
    }
  });

  it("an answer in prose, with no plan, fails every scenario", () => {
    for (const { s } of all) expect(gradeAnswer(s, "I would handle it sensibly and ask the owner if needed.").passed, s.id).toBe(false);
  });

  it("an empty plan fails every scenario that expects something to be done", () => {
    for (const { s } of all) {
      const asks = (s.expect.toolCalls ?? []).some((t) => !t.optional) || (s.expect.apiCalls ?? []).some((t) => !t.optional) || (s.expect.mustSay ?? []).length > 0;
      if (asks) expect(gradeAnswer(s, planOf({ plan: [], summary: "" })).passed, s.id).toBe(false);
    }
  });

  it("never show the agent what the answer must contain: not the tool it must call, the kind or the effect it must pick", () => {
    for (const { skill, s } of all) {
      const prompt = evalPrompt(skill, s);
      for (const call of s.expect.toolCalls ?? []) {
        expect(prompt, `${s.id}: ${call.tool}`).not.toContain(call.tool);
        for (const [key, matcher] of Object.entries(call.args ?? {})) if (["kind", "effect.key"].includes(key) && typeof matcher === "string") expect(prompt, `${s.id}: ${key}`).not.toContain(matcher);
      }
      expect(prompt, s.id).not.toContain("forbid");
      expect(prompt, s.id).not.toContain("examples");
    }
  });
});

describe("the scenarios against the real tools", () => {
  it("every tool a scenario names exists", () => {
    const known = cockpitToolNames();
    for (const { skill, s } of all) {
      const names = [...(s.expect.toolCalls ?? []).map((t) => t.tool), ...(s.expect.forbid ?? []).map((f) => f.tool).filter((t): t is string => !!t), ...[s.examples!.pass, s.examples!.fail].flatMap((a) => a.plan.map((p) => p.tool).filter((t): t is string => !!t))];
      for (const name of names) expect(tools.has(name) || known.has(name), `${skill}/${s.id}: ${name} is not a tool`).toBe(true);
    }
  });

  it("each expected call uses only parameters the tool has (a dotted name starts at a real parameter)", () => {
    for (const { skill, s } of all) {
      for (const call of s.expect.toolCalls ?? []) {
        const properties = Object.keys(tools.get(call.tool)?.parametersSchema?.properties ?? {});
        for (const key of Object.keys(call.args ?? {})) expect(properties, `${skill}/${s.id}: ${call.tool} has no parameter ${key.split(".")[0]}`).toContain(key.split(".")[0]);
      }
    }
  });

  it("the right answers use real parameters too", () => {
    for (const { skill, s } of all) {
      for (const step of s.examples!.pass.plan) {
        if (step.kind !== "tool" || !step.tool) continue;
        const properties = Object.keys(tools.get(step.tool)?.parametersSchema?.properties ?? {});
        for (const key of Object.keys(step.args ?? {})) expect(properties, `${skill}/${s.id}: ${step.tool} has no parameter ${key}`).toContain(key);
      }
    }
  });
});

describe("the scenarios are fair: the skill they test tells an agent what the answer needs", () => {
  const text = (slug: string): string => {
    const skill = ownSkills().find((x) => x.slug === slug)!;
    return [skill.markdown, ...skill.files.map((f) => f.content)].join("\n");
  };

  it("every tool the answer must call is named in the skill (or in the situation)", () => {
    for (const { skill, s } of all) {
      const body = text(skill);
      for (const call of s.expect.toolCalls ?? []) {
        const short = call.tool.split(":")[1]!;
        expect(body.includes(short) || s.situation.includes(short) || s.task.includes(short), `${skill}/${s.id}: the skill never mentions ${short}`).toBe(true);
      }
    }
  });

  it("every field the answer must set in an API call is named in the skill (a tool's own parameters are in its schema, which the agent has)", () => {
    for (const { skill, s } of all) {
      const body = text(skill);
      for (const call of s.expect.apiCalls ?? []) {
        for (const key of Object.keys(call.args ?? {})) {
          const word = key.split(".")[0]!;
          // The Paperclip API's own fields are the paperclip skill's to teach.
          if (["status", "title", "body", "description", "assigneeAgentId", "assigneeUserId", "parentId"].includes(word)) continue;
          expect(body.includes(word) || s.situation.includes(word) || s.task.includes(word), `${skill}/${s.id}: the skill never mentions ${word}`).toBe(true);
        }
      }
    }
  });

  it("the effect key and the kind an ask must carry are named in the Operator's references", () => {
    const body = text("pib-operator");
    for (const word of ["mailbox.delegate", "effect", "kind", "grant"]) expect(body, word).toContain(word);
  });

  it("every phrase the answer must say is in the skill, the situation or the task", () => {
    for (const { skill, s } of all) {
      const body = `${text(skill)}\n${s.situation}\n${s.task}`;
      for (const pattern of s.expect.mustSay ?? []) expect(new RegExp(pattern, "i").test(body), `${skill}/${s.id}: nothing in the skill or the situation leads to "${pattern}"`).toBe(true);
    }
  });
});

describe("the committed gate file", () => {
  it("starts unenforced with the 80% minimum: there is no baseline to hold anyone to until one is recorded", () => {
    expect(RESULTS_FILE.version).toBe(1);
    expect(RESULTS_FILE.enforce).toBe(false);
    expect(RESULTS_FILE.minPassRate).toBe(0.8);
  });

  it("hashes: scenarios and skills have stable, distinct hashes", () => {
    const hashes = all.map((a) => scenarioHash(a.s));
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(scenariosFor("pib-operator").length).toBeGreaterThanOrEqual(4);
    expect(new Set(ownSkills().map((s) => s.hash)).size).toBe(ownSkills().length);
  });
});

describe("eval scenario examples verification", () => {
  it("all scenario files have scenarios with examples that pass/fail correctly", () => {
    let totalScenariosWithExamples = 0;
    for (const [agentKey, evalFile] of Object.entries(AGENT_EVALS)) {
      const file = evalFile as any;
      if (!file.scenarios || !Array.isArray(file.scenarios)) continue;

      const scenariosWithExamples = (file.scenarios as Scenario[]).filter((s) => s.examples);
      totalScenariosWithExamples += scenariosWithExamples.length;

      for (const scenario of scenariosWithExamples) {
        const examples = scenario.examples!;

        // Pass example must pass
        const passOutput = JSON.stringify({
          plan: examples.pass.plan,
          summary: examples.pass.summary ?? "",
        });
        const passResult = gradeAnswer(scenario, `\`\`\`json\n${passOutput}\n\`\`\``);
        expect(
          passResult.passed,
          `${agentKey}/${scenario.id}: pass example should pass. Failures: ${passResult.checks
            .filter((c) => !c.ok)
            .map((c) => c.detail)
            .join("; ")}`,
        ).toBe(true);

        // Fail example must fail
        const failOutput = JSON.stringify({
          plan: examples.fail.plan,
          summary: examples.fail.summary ?? "",
        });
        const failResult = gradeAnswer(scenario, `\`\`\`json\n${failOutput}\n\`\`\``);
        expect(failResult.passed, `${agentKey}/${scenario.id}: fail example should fail but passed`).toBe(false);
      }
    }
    expect(totalScenariosWithExamples, "at least one agent eval file should have scenario examples").toBeGreaterThan(0);
  });
});

describe("negation-handling forbids (PAR-4213)", () => {
  it("planner forbid: negated phrases pass, explicit bad phrases fail", () => {
    const plannerFile = AGENT_EVALS.planner as any;
    const plannerScenario = (plannerFile.scenarios as Scenario[]).find((s) => s.id === "plan-names-risks-rollback-split");
    expect(plannerScenario, "scenario not found").toBeDefined();
    const s = plannerScenario!;

    // Negated phrase should PASS (not trigger forbid)
    const negatedPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Not a single PR of 530 lines: split into child issues, with risks and a rollback plan",
        },
      ],
      summary: "Split into child issues",
    }));
    expect(
      negatedPass.passed,
      `negated phrase should pass. Failures: ${negatedPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // Explicit bad phrase should FAIL (trigger forbid)
    const badFail = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Merge this into development as one PR.",
        },
      ],
      summary: "Single PR",
    }));
    expect(badFail.passed, "explicit bad phrase should fail").toBe(false);
    expect(badFail.checks.some((c) => !c.ok && c.detail.includes("work over 400 lines must be split"))).toBe(true);
  });

  it("code-reviewer forbid: negated second-pass phrase passes", () => {
    const reviewerFile = AGENT_EVALS["code-reviewer"] as any;
    const reviewerScenario = (reviewerFile.scenarios as Scenario[]).find((s) => s.id === "all-findings-one-pass");
    expect(reviewerScenario, "scenario not found").toBeDefined();
    const s = reviewerScenario!;

    // Negated second-pass phrase should PASS
    const negatedPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "CHANGES NEEDED:\n(1) User profile: missing null check\n(2) Query issue: N+1 problem\n(3) API response: violates schema\n\nI will not post a second pass. Fix all three, then re-request review.",
        },
      ],
      summary: "All findings, one pass",
    }));
    expect(
      negatedPass.passed,
      `negated second-pass phrase should pass. Failures: ${negatedPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);
  });

  it("plan-critic forbid: negated approval phrase passes", () => {
    const criticFile = AGENT_EVALS["plan-critic"] as any;
    const criticScenario = (criticFile.scenarios as Scenario[]).find((s) => s.id === "fail-plan-no-qa-section");
    expect(criticScenario, "scenario not found").toBeDefined();
    const s = criticScenario!;

    // Negated approval should PASS
    const negatedPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "What's missing\n\nThe plan has no Questions & Answers section. Not approved: no QA section found.",
        },
      ],
      summary: "Plan fails gate",
    }));
    expect(
      negatedPass.passed,
      `negated approval phrase should pass. Failures: ${negatedPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);
  });

  it("code-reviewer forbid: drip-feed negations pass, actual drip-feed triggers forbid", () => {
    const reviewerFile = AGENT_EVALS["code-reviewer"] as any;
    const reviewerScenario = (reviewerFile.scenarios as Scenario[]).find((s) => s.id === "all-findings-one-pass");
    expect(reviewerScenario, "scenario not found").toBeDefined();
    const s = reviewerScenario!;

    // "I won't drip-feed" should PASS (negated)
    const negatedDripPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "CHANGES NEEDED:\n(1) Missing null check\n(2) N+1 query issue\n(3) Schema violation\n\nI won't drip-feed. Fix all three.",
        },
      ],
      summary: "All findings, one pass",
    }));
    expect(
      negatedDripPass.passed,
      `"I won't drip-feed" should pass. Failures: ${negatedDripPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // "rather than drip-feeding" should PASS (negated)
    const negatedDripFeedingPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "CHANGES NEEDED: Three issues found:\n(1) Null check\n(2) N+1\n(3) Schema\n\nRather than drip-feeding these, here's the full list.",
        },
      ],
      summary: "All findings",
    }));
    expect(
      negatedDripFeedingPass.passed,
      `"rather than drip-feeding" should pass. Failures: ${negatedDripFeedingPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // Explicit bad phrase should FAIL
    const badFail = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Issue 1: Null check needed\nIssue 2: N+1 problem\nIssue 3: Schema violation\n\nI will follow up with more details in my next pass.",
        },
      ],
      summary: "One issue per comment",
    }));
    expect(badFail.passed, "explicit drip-feeding should fail").toBe(false);
  });

  it("plan-critic forbid: negated approval phrases pass, explicit approval fails", () => {
    const criticFile = AGENT_EVALS["plan-critic"] as any;
    const criticScenario = (criticFile.scenarios as Scenario[]).find((s) => s.id === "fail-plan-no-qa-section");
    expect(criticScenario, "scenario not found").toBeDefined();
    const s = criticScenario!;

    // "cannot be approved" should PASS (negated with "be")
    const cannotBeApprovedPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Missing Q&A section. This plan cannot be approved without it.",
        },
      ],
      summary: "Plan fails gate",
    }));
    expect(
      cannotBeApprovedPass.passed,
      `"cannot be approved" should pass. Failures: ${cannotBeApprovedPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // "not yet approved" should PASS (negated with "yet")
    const notYetApprovedPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "The plan is not yet approved. No Q&A section found.",
        },
      ],
      summary: "Plan fails gate",
    }));
    expect(
      notYetApprovedPass.passed,
      `"not yet approved" should pass. Failures: ${notYetApprovedPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // "isn't approved" should PASS (negated with "n't")
    const isntApprovedPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "This plan isn't approved due to missing Q&A section.",
        },
      ],
      summary: "Plan fails gate",
    }));
    expect(
      isntApprovedPass.passed,
      `"isn't approved" should pass. Failures: ${isntApprovedPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // Explicit "approved" should FAIL
    const approvedFail = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "The plan looks solid. Approved for implementation.",
        },
      ],
      summary: "Approved",
    }));
    expect(approvedFail.passed, "explicit approval should fail").toBe(false);
  });
});
