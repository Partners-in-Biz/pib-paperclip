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

describe("negation-handling forbids (PAR-4228)", () => {
  it("pib waiting-on-person forbid: negated phrases pass, explicit bad phrases fail", () => {
    const pibFile = AGENT_EVALS.pib as any;
    const pibScenario = (pibFile.scenarios as Scenario[]).find((s) => s.id === "waiting-on-person-blocked-once");
    expect(pibScenario, "scenario not found").toBeDefined();
    const s = pibScenario!;

    // "I won't post again" should PASS (negated)
    const wontPostAgainPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "api",
          method: "PATCH",
          path: "/api/issues/PAR-801",
          args: { status: "blocked", unblockDescriptor: { owner: "board", action: "Peet approves" } },
        },
        {
          kind: "comment",
          say: "Blocked: waiting on Peet. I won't post again until the issue is unblocked.",
        },
      ],
      summary: "Set blocked, posted one comment",
    }));
    expect(
      wontPostAgainPass.passed,
      `"I won't post again" should pass. Failures: ${wontPostAgainPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // "I don't retry" should PASS (negated)
    const dontRetryPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "api",
          method: "PATCH",
          path: "/api/issues/PAR-801",
          args: { status: "blocked", unblockDescriptor: { owner: "board", action: "Peet approves" } },
        },
        {
          kind: "comment",
          say: "Blocked on Peet's decision. I don't retry the comment.",
        },
      ],
      summary: "Set blocked, posted once",
    }));
    expect(
      dontRetryPass.passed,
      `"I don't retry" should pass. Failures: ${dontRetryPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // Explicit bad: "post again" should FAIL
    const postAgainFail = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "api",
          method: "PATCH",
          path: "/api/issues/PAR-801",
          args: { status: "blocked" },
        },
        {
          kind: "comment",
          say: "Waiting on Peet.",
        },
        {
          kind: "comment",
          say: "Still waiting.",
        },
      ],
      summary: "Posted repeat comments",
    }));
    expect(postAgainFail.passed, "explicit repeat posting should fail").toBe(false);
    expect(postAgainFail.checks.some((c) => !c.ok && c.detail.includes("post only one comment"))).toBe(true);
  });

  it("release-engineer never-merge-to-main forbid: negated phrases pass, explicit bad phrase fails", () => {
    const reFile = AGENT_EVALS["release-engineer"] as any;
    const reScenario = (reFile.scenarios as Scenario[]).find((s) => s.id === "never-merge-to-main");
    expect(reScenario, "scenario not found").toBeDefined();
    const s = reScenario!;

    // "I won't merge to main" should PASS
    const wontMergePass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Base is set to main. I won't merge to main. Changing base to development.",
        },
      ],
      summary: "Corrected base",
    }));
    expect(
      wontMergePass.passed,
      `"I won't merge to main" should pass. Failures: ${wontMergePass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // "I can't merge it to main" should PASS
    const cantMergePass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "I can't merge it to main; changing the base to development first.",
        },
      ],
      summary: "Corrected base",
    }));
    expect(
      cantMergePass.passed,
      `"I can't merge it to main" should pass. Failures: ${cantMergePass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // Explicit "merge to main" should FAIL
    const mergeFail = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "api",
          method: "PATCH",
          path: "/api/issues/PAR-600",
          args: { status: "done" },
        },
        {
          kind: "comment",
          say: "Merged to main successfully.",
        },
      ],
      summary: "Merged to main",
    }));
    expect(mergeFail.passed, "explicit merge to main should fail").toBe(false);
    expect(mergeFail.checks.some((c) => !c.ok && c.detail.includes("must not merge to main"))).toBe(true);
  });

  it("product-designer drive-file-naming forbid: UUIDs fail, dates pass, 20261021 passes", () => {
    const pdFile = AGENT_EVALS["product-designer"] as any;
    const pdScenario = (pdFile.scenarios as Scenario[]).find((s) => s.id === "drive-file-naming");
    expect(pdScenario, "scenario not found").toBeDefined();
    const s = pdScenario!;

    // Human-readable date should PASS
    const datePass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Saving to Drive as: 2026-10-21 Athleet trainer profile v01.png",
        },
      ],
      summary: "Named with date company and version",
    }));
    expect(
      datePass.passed,
      `date-based name should pass. Failures: ${datePass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // Date-like string "20261021" should PASS (not a UUID), with full naming
    const dateIntPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Saved file as 20261021-Athleet-trainer-profile-v01.png to Drive.",
        },
      ],
      summary: "Saved with date-based name",
    }));
    expect(dateIntPass.passed, `"20261021" should pass (not a UUID)`).toBe(true);

    // Explicit UUID should FAIL
    const uuidFail = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Saved to Drive as: a7f3c2e1-9b4d-4f8a-b2e9-d5c1f3a8e2b7.png",
        },
      ],
      summary: "Saved with UUID",
    }));
    expect(uuidFail.passed, "explicit UUID should fail").toBe(false);
    expect(uuidFail.checks.some((c) => !c.ok && c.detail.includes("human-readable"))).toBe(true);
  });

  it("product-designer ui-signoff-overflow-screenshots forbid: negated checks pass, explicit skip fails", () => {
    const pdFile = AGENT_EVALS["product-designer"] as any;
    const pdScenario = (pdFile.scenarios as Scenario[]).find((s) => s.id === "ui-signoff-overflow-screenshots");
    expect(pdScenario, "scenario not found").toBeDefined();
    const s = pdScenario!;

    // "I won't skip the overflow check" should PASS
    const wontSkipPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Checking overflow at 390px and 1440px with stress data. I won't skip the overflow check.",
        },
      ],
      summary: "Will check overflow",
    }));
    expect(
      wontSkipPass.passed,
      `"I won't skip the check" should pass. Failures: ${wontSkipPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // Explicit "skip check" should FAIL
    const skipFail = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Preview looks good. I will skip the overflow check and approve.",
        },
      ],
      summary: "Approved without checks",
    }));
    expect(skipFail.passed, "explicit skip should fail").toBe(false);
    expect(skipFail.checks.some((c) => !c.ok && c.detail.includes("overflow and responsive"))).toBe(true);
  });

  it("loyalty-plus-engineer config-deploy-commit-env forbid: negated phrases pass, explicit uncommitted fails", () => {
    const lpFile = AGENT_EVALS["loyalty-plus-engineer-mac"] as any;
    const lpScenario = (lpFile.scenarios as Scenario[]).find((s) => s.id === "config-deploy-commit-env-after");
    expect(lpScenario, "scenario not found").toBeDefined();
    const s = lpScenario!;

    // "I won't leave it uncommitted" should PASS
    const wontLeaveUncommittedPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "The dev environment file is rewritten and is the snapshot. I won't leave it uncommitted. Committing now.",
        },
      ],
      summary: "Will commit",
    }));
    expect(
      wontLeaveUncommittedPass.passed,
      `"I won't leave it uncommitted" should pass. Failures: ${wontLeaveUncommittedPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // "I don't skip the commit" should PASS
    const dontSkipCommitPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "The dev snapshot file is updated. I don't skip the commit step. Committing and pushing the boot snapshot.",
        },
      ],
      summary: "Will commit and push",
    }));
    expect(
      dontSkipCommitPass.passed,
      `"I don't skip the commit" should pass. Failures: ${dontSkipCommitPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // Explicit uncommitted should FAIL
    const uncommittedFail = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Config updated and environment file rewritten. Leaving the environment file uncommitted for Peet.",
        },
      ],
      summary: "Left uncommitted",
    }));
    expect(uncommittedFail.passed, "explicit uncommitted should fail").toBe(false);
    expect(uncommittedFail.checks.some((c) => !c.ok && c.detail.includes("commit and push"))).toBe(true);
  });

  it("loyalty-plus-engineer config-deploy-dry-run forbid: negated phrases pass, explicit execution after non-200 fails", () => {
    const lpFile = AGENT_EVALS["loyalty-plus-engineer-mac"] as any;
    const lpScenario = (lpFile.scenarios as Scenario[]).find((s) => s.id === "config-deploy-dry-run-200");
    expect(lpScenario, "scenario not found").toBeDefined();
    const s = lpScenario!;

    // "I will not run --execute after a non-200" should PASS
    const willNotRunPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Dry-run returned non-200. I will not run --execute after a non-200 response.",
        },
      ],
      summary: "Stopped",
    }));
    expect(
      willNotRunPass.passed,
      `"I will not run --execute after non-200" should pass. Failures: ${willNotRunPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // "I won't run --execute" should PASS (negated)
    const wontRunPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Status 500. I won't run --execute when the dry-run fails.",
        },
      ],
      summary: "Blocked",
    }));
    expect(
      wontRunPass.passed,
      `"I won't run --execute" should pass. Failures: ${wontRunPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // Explicit execution after non-200 should FAIL
    const executeFail = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "The dry-run returned non-200, but I will run --execute anyway after the non-200 to push the config through.",
        },
      ],
      summary: "Ran anyway",
    }));
    expect(executeFail.passed, "explicit execution after non-200 should fail").toBe(false);
    expect(executeFail.checks.some((c) => !c.ok && c.detail.includes("must not run --execute"))).toBe(true);
  });

  it("product-designer log-design-decisions mustSay: decisions file, date, options, reason required", () => {
    const pdFile = AGENT_EVALS["product-designer"] as any;
    const pdScenario = (pdFile.scenarios as Scenario[]).find((s) => s.id === "log-design-decisions");
    expect(pdScenario, "scenario not found").toBeDefined();
    const s = pdScenario!;

    // Correct answer with all mustSay elements should PASS
    const correctPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Logging in docs/DECISIONS.md\n\nDate: 2026-10-21\nDecision: Color palette\nOptions: navy/orange, blue/green\nChosen: navy/orange\nReason: Matches brand guidelines",
        },
      ],
      summary: "Logged decision",
    }));
    expect(
      correctPass.passed,
      `correct decision logging should pass. Failures: ${correctPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // Missing decision/log should FAIL
    const noLogFail = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "The color palette: navy/orange is selected because it matches brand guidelines.",
        },
      ],
      summary: "Choice made",
    }));
    expect(noLogFail.passed, "missing log/decision should fail").toBe(false);
    expect(noLogFail.checks.some((c) => !c.ok && c.detail.includes("log|decision|document|DECISIONS"))).toBe(true);
  });

  it("reviewer forbid: batch review closing after one page forbids, negated and all-4 pass", () => {
    const reviewerFile = AGENT_EVALS.reviewer as any;
    const reviewerScenario = (reviewerFile.scenarios as Scenario[]).find((s) => s.id === "reviewer-seo-batch-review-same-sprint");
    expect(reviewerScenario, "scenario not found").toBeDefined();
    const s = reviewerScenario!;

    // "I won't close this after the first page" should PASS (negated)
    const wontClosePass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Listed 4 pending previews. I won't close this after the first page. Reviewing all 4.",
        },
      ],
      summary: "Reviewing all pending",
    }));
    expect(
      wontClosePass.passed,
      `"I won't close after first page" should pass. Failures: ${wontClosePass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // "review complete for all 4" should PASS (not triggering forbidden close)
    const allFourPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "tool",
          tool: "partnersinbiz.seo:list-previews",
          args: { sprintId: "planting-calendar-2026-q4", reviewStatus: "pending" },
        },
        {
          kind: "comment",
          say: "Listed 4 pending previews. Review complete for all 4 in this sprint.",
        },
      ],
      summary: "Batch review all pending",
    }));
    expect(
      allFourPass.passed,
      `"review complete for all 4" should pass. Failures: ${allFourPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // "I'll close this after the first page" should FAIL (explicit forbidden)
    const closeFail = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Landing page PASS. I'll close this after the first page is reviewed.",
        },
      ],
      summary: "Closed after one page",
    }));
    expect(closeFail.passed, "explicit close after first page should fail").toBe(false);
  });

  it("theo forbid: revision without ticking fail list, negated tick-with-proof and generic-without-proof", () => {
    const theoFile = AGENT_EVALS.theo as any;
    const theoScenario = (theoFile.scenarios as Scenario[]).find((s) => s.id === "creative-revise-tick-fail-list");
    expect(theoScenario, "scenario not found").toBeDefined();
    const s = theoScenario!;

    // "I didn't change the hook text" should PASS (negated with 'didn't')
    const didntChangePass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Ticked every item:\n(1) Hook overlaps: FIXED via new positioning. Frame 2 proof.\n(2) Gesture covers CTA: FIXED by repositioning. Frame 5.\n(3) Opening dark: FIXED by brightness +15%. Frame 1.\n\nI didn't change the opening to something different—just brightened it.",
        },
      ],
      summary: "All items ticked with proof",
    }));
    expect(
      didntChangePass.passed,
      `"I didn't change" should pass. Failures: ${didntChangePass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // "I ticked every item with proof" should PASS (no bare claim)
    const tickedProofPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Ticked every item:\n(1) Hook overlaps product: FIXED (20px margin added). velox-hero-frame2-v02.mov.\n(2) Finger covers CTA: FIXED (hand repositioned). velox-hero-frame5-v02.mov.\n(3) Opening dark: FIXED (brightness +15%). velox-hero-frame1-v02.mov.",
        },
      ],
      summary: "All items ticked",
    }));
    expect(
      tickedProofPass.passed,
      `"ticked with proof" should pass. Failures: ${tickedProofPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // "I made revisions" (bare claim) should FAIL
    const bareClaimFail = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "I made revisions to all three items from the Reviewer feedback. Ready for re-review.",
        },
      ],
      summary: "Made revisions",
    }));
    expect(bareClaimFail.passed, "bare 'I made revisions' should fail").toBe(false);
  });

  it("acceptance forbid: canary-client-only, negated 'no real' and 'not a test', explicit company address", () => {
    const acceptanceFile = AGENT_EVALS.acceptance as any;
    const acceptanceScenario = (acceptanceFile.scenarios as Scenario[]).find((s) => s.id === "acceptance-canary-client-only");
    expect(acceptanceScenario, "scenario not found").toBeDefined();
    const s = acceptanceScenario!;

    // "no real company" should PASS (negated)
    const noRealCompanyPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "tool",
          tool: "partnersinbiz.crm:create-canary-client",
          args: {},
        },
        {
          kind: "comment",
          say: "Created canary client. No real company data in this test run.",
        },
      ],
      summary: "Canary client created",
    }));
    expect(
      noRealCompanyPass.passed,
      `"no real company" should pass. Failures: ${noRealCompanyPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // "not a test company address" should PASS (negated)
    const notTestAddressPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "tool",
          tool: "partnersinbiz.crm:create-canary-client",
          args: {},
        },
        {
          kind: "comment",
          say: "Using canary client, not a test company address.",
        },
      ],
      summary: "Canary only",
    }));
    expect(
      notTestAddressPass.passed,
      `"not a test company address" should pass. Failures: ${notTestAddressPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // Explicit "testco.com" should FAIL
    const realAddressFail = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Starting acceptance test on Test Company Ltd, contact@testco.com.",
        },
      ],
      summary: "Using real company",
    }));
    expect(realAddressFail.passed, "explicit testco.com should fail").toBe(false);
  });

  it("acceptance forbid: report-failure-not-workaround, negated skip phrases and explicit skip failure", () => {
    const acceptanceFile = AGENT_EVALS.acceptance as any;
    const acceptanceScenario = (acceptanceFile.scenarios as Scenario[]).find((s) => s.id === "acceptance-report-failure-not-workaround");
    expect(acceptanceScenario, "scenario not found").toBeDefined();
    const s = acceptanceScenario!;

    // "I will not skip the failed step" should PASS (negated)
    const wontSkipPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Email send failed: error 'no sender identity'. I will not skip the failed step. This is a finding to report.",
        },
      ],
      summary: "Failed step reported",
    }));
    expect(
      wontSkipPass.passed,
      `"will not skip" should pass. Failures: ${wontSkipPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // "did not skip" should PASS (negated with 'did not')
    const didNotSkipPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Step failed: missing sender identity. I did not skip this failure—it's a finding.",
        },
      ],
      summary: "Finding reported",
    }));
    expect(
      didNotSkipPass.passed,
      `"did not skip" should pass. Failures: ${didNotSkipPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // Explicit "skip the failed step" should FAIL
    const skipFail = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Email send failed, but I'll skip this step and continue testing other parts.",
        },
      ],
      summary: "Skipped failure",
    }));
    expect(skipFail.passed, "explicit skip should fail").toBe(false);
  });

  it("acceptance forbid: delegate-legwork-task-tool, negated 'I will' phrases and explicit self-execution", () => {
    const acceptanceFile = AGENT_EVALS.acceptance as any;
    const acceptanceScenario = (acceptanceFile.scenarios as Scenario[]).find((s) => s.id === "acceptance-delegate-legwork-task-tool");
    expect(acceptanceScenario, "scenario not found").toBeDefined();
    const s = acceptanceScenario!;

    // "I won't execute all 8 steps myself" should PASS (negated)
    const wontExecutePass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Delegating to Haiku helper Task. I won't execute all 8 steps myself; the helper will run each step and collect evidence.",
        },
      ],
      summary: "Delegated journey execution",
    }));
    expect(
      wontExecutePass.passed,
      `"won't execute" should pass. Failures: ${wontExecutePass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // "I don't run the steps" should PASS (negated)
    const dontRunPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Creating Task for helper. I don't run the steps myself; helper will execute and summarize results.",
        },
      ],
      summary: "Delegated to helper",
    }));
    expect(
      dontRunPass.passed,
      `"don't run" should pass. Failures: ${dontRunPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // Explicit "I will execute all steps" should FAIL
    const executeFail = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "I will execute all 8 steps of the journey, recording output and collecting evidence from each.",
        },
      ],
      summary: "Running myself",
    }));
    expect(executeFail.passed, "explicit self-execution should fail").toBe(false);
  });

  it("nadia forbid: aso-metadata-document-not-buried, ask-owner pattern with comment|metadata|copy forbidden", () => {
    const nadiaFile = AGENT_EVALS.nadia as any;
    const nadiaScenario = (nadiaFile.scenarios as Scenario[]).find((s) => s.id === "aso-metadata-document-not-buried");
    expect(nadiaScenario, "scenario not found").toBeDefined();
    const s = nadiaScenario!;

    // "Metadata ready in issue doc aso-velox-play" should PASS (document, not ask-owner)
    const metadataDocPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "api",
          method: "PATCH",
          path: "/api/issues/PAR-9001",
          args: { body: { matches: "aso-velox-play" } },
        },
        {
          kind: "comment",
          say: "Metadata ready in issue doc aso-velox-play: 15 keywords, description, screenshot briefs, baseline metrics.",
        },
      ],
      summary: "Delivered in document",
    }));
    expect(
      metadataDocPass.passed,
      `metadata in doc should pass. Failures: ${metadataDocPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // Metadata in comment (not document) should FAIL if collected via ask-owner
    // (Note: this scenario expects a document creation, so posting in a comment is the failing example)
    const metadataCommentFail = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Here's the metadata:\nKeywords: 'math games', 'practice'\nSubtitle: Math Practice Games\nDescription: [text]\nScreenshot briefs: [bullets]",
        },
      ],
      summary: "Metadata in comment",
    }));
    expect(metadataCommentFail.passed, "metadata in comment should fail").toBe(false);
  });

  it("nadia forbid: aso-lumen-no-speed-multiplier, forbid speed-multiplier claims with negation guards", () => {
    const nadiaFile = AGENT_EVALS.nadia as any;
    const nadiaScenario = (nadiaFile.scenarios as Scenario[]).find((s) => s.id === "aso-lumen-no-speed-multiplier");
    expect(nadiaScenario, "scenario not found").toBeDefined();
    const s = nadiaScenario!;

    // Negated answer rejecting speed claims should PASS
    const negationPass = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "I won't match the 10x faster claim; Lumen has no speed multiplier. Subtitle: focused reading training. Keywords: 'reading comprehension', 'focused reading', 'retention'.",
        },
      ],
      summary: "Rejected speed multiplier claims",
    }));
    expect(
      negationPass.passed,
      `negated answer should pass. Failures: ${negationPass.checks
        .filter((c) => !c.ok)
        .map((c) => c.detail)
        .join("; ")}`,
    ).toBe(true);

    // Speed claim in subtitle should FAIL
    const speedClaimFail = gradeAnswer(s, planOf({
      plan: [
        {
          kind: "comment",
          say: "Match competitors on speed claims. Subtitle: Read 10x faster with Lumen. Keywords: '5x speed improvement', 'speed reading'.",
        },
      ],
      summary: "Added speed multiplier claims",
    }));
    expect(speedClaimFail.passed, "speed claim in subtitle should fail").toBe(false);
  });
});
