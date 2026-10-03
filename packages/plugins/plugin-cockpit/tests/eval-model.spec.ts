/**
 * Golden scenarios for skills, the pure part (Q5-3, Q2-11, Q10-5): the file format,
 * the grader, pass rates per skill version and the gate. A grader that cannot fail
 * would let a worse skill ship, so every rule is shown to reject a wrong answer.
 */
import { describe, expect, it } from "vitest";
import {
  EvalError,
  evalMarker,
  evalPrompt,
  extractPlan,
  gateSkill,
  gradeAnswer,
  MIN_PASS_RATE,
  offlineGate,
  parseResultsFile,
  parseScenarioFile,
  resultsEntry,
  scenarioHash,
  skillContentHash,
  skillState,
  type Baseline,
  type ResultRow,
  type ResultsFile,
  type Scenario,
} from "../src/eval-model.js";

const known = (name: string) => name.startsWith("partnersinbiz.cockpit:");

const scenario = (patch: Partial<Scenario> = {}): Scenario => ({
  id: "ask-once",
  title: "Ask once",
  source: "Audit",
  situation: "An issue is blocked on a login only the owner can give.",
  task: "Handle it.",
  expect: {
    toolCalls: [{ tool: "partnersinbiz.cockpit:ask-owner", args: { kind: "grant", "effect.key": "mailbox.delegate" } }],
    apiCalls: [{ method: "PATCH", path: "^/api/issues/[^/]+$", args: { status: "blocked" } }],
    forbid: [{ tool: "partnersinbiz.cockpit:post-daily-brief", reason: "not the place for a question" }],
    mustSay: ["owner"],
  },
  ...patch,
});

const answer = (plan: unknown[], summary = "done"): string => `Here is my answer.\n\n\`\`\`json\n${JSON.stringify({ plan, summary })}\n\`\`\``;

const ask = { kind: "tool", tool: "partnersinbiz.cockpit:ask-owner", args: { kind: "grant", question: "q", effect: { key: "mailbox.delegate" } }, say: "ask the owner" };
const block = { kind: "api", method: "patch", path: "/api/issues/PAR-1", args: { status: "blocked" } };

describe("parseScenarioFile", () => {
  const file = (patch: Record<string, unknown> = {}) => ({ skill: "pib-operator", version: 1, scenarios: [scenario()], ...patch });
  const problems = (raw: unknown) => {
    try {
      parseScenarioFile(raw, ["pib-operator"], known);
    } catch (error) {
      expect(error).toBeInstanceOf(EvalError);
      return (error as Error).message;
    }
    return "";
  };

  it("accepts a well-formed file", () => {
    expect(parseScenarioFile(file(), ["pib-operator"], known).scenarios).toHaveLength(1);
  });

  it("lists every problem at once", () => {
    const text = problems({ skill: "pib-ghost", version: 0, scenarios: [] });
    for (const part of ["skill must be one of", "version must be", "at least one scenario"]) expect(text, part).toContain(part);
  });

  it("refuses a scenario that could never fail, an unknown tool and bad patterns", () => {
    expect(problems(file({ scenarios: [scenario({ expect: {} })] }))).toContain("could never fail");
    expect(problems(file({ scenarios: [scenario({ expect: { toolCalls: [{ tool: "partnersinbiz.crm:ghost" }] } })] }))).toContain("is not a tool");
    expect(problems(file({ scenarios: [scenario({ expect: { forbid: [{ tool: "partnersinbiz.crm:ghost", reason: "x" }] } })] }))).toContain("is not a tool");
    expect(problems(file({ scenarios: [scenario({ expect: { mustSay: ["("] } })] }))).toContain("invalid pattern");
    expect(problems(file({ scenarios: [scenario({ expect: { apiCalls: [{ method: "GET", path: "(" }] } })] }))).toContain("valid path pattern");
    expect(problems(file({ scenarios: [scenario({ expect: { forbid: [{ reason: "x" }] } })] }))).toContain("forbids nothing");
    expect(problems(file({ scenarios: [scenario({ expect: { forbid: [{ tool: "partnersinbiz.cockpit:ask-owner" } as never] } })] }))).toContain("needs a reason");
  });

  it("refuses a duplicate id, a long situation and bad repeats", () => {
    expect(problems(file({ scenarios: [scenario(), scenario()] }))).toContain("used twice");
    expect(problems(file({ scenarios: [scenario({ situation: "x".repeat(4001) })] }))).toContain("over 4000");
    expect(problems(file({ scenarios: [scenario({ repeats: 9 })] }))).toContain("repeats is from 1 to 5");
  });
});

describe("hashes and the prompt", () => {
  it("the skill hash follows the text of the skill and its references, and nothing else", () => {
    const a = skillContentHash({ markdown: "# A", files: [{ path: "references/b.md", content: "b" }, { path: "references/a.md", content: "a" }] });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    // The order the files come in does not matter.
    expect(skillContentHash({ markdown: "# A", files: [{ path: "references/a.md", content: "a" }, { path: "references/b.md", content: "b" }] })).toBe(a);
    expect(skillContentHash({ markdown: "# A", files: [{ path: "references/a.md", content: "a" }, { path: "references/b.md", content: "B" }] })).not.toBe(a);
    expect(skillContentHash({ markdown: "# A!", files: [] })).not.toBe(skillContentHash({ markdown: "# A", files: [] }));
  });

  it("a scenario's hash changes with what it asks and what it expects, not with its examples", () => {
    const base = scenarioHash(scenario());
    expect(scenarioHash(scenario({ task: "Handle it now." }))).not.toBe(base);
    expect(scenarioHash(scenario({ expect: { mustSay: ["other"] } }))).not.toBe(base);
    expect(scenarioHash(scenario({ examples: { pass: { plan: [] }, fail: { plan: [] } } }))).toBe(base);
  });

  it("the prompt carries the marker, the situation, the task and the paper-mode contract, never the expectations", () => {
    const text = evalPrompt("pib-operator", scenario());
    expect(text).toContain(evalMarker("pib-operator", scenario()));
    expect(text).toContain("An issue is blocked on a login");
    expect(text).toContain("## Your task");
    expect(text).toContain("Do not call any plugin tool or Paperclip API that changes anything");
    expect(text).toContain('"plan"');
    expect(text).not.toContain("mailbox.delegate");
    expect(text).not.toContain("forbid");
  });
});

describe("extractPlan", () => {
  it("reads the plan from a json fence, whatever surrounds it", () => {
    const got = extractPlan(answer([block]));
    expect("plan" in got && got.plan[0]).toMatchObject({ kind: "api", method: "PATCH" });
  });

  it("reads a bare object, braces inside strings and a later fence", () => {
    const bare = extractPlan('Sure: {"plan":[{"kind":"comment","say":"close } brace"}],"summary":"x"} thanks');
    expect("plan" in bare && bare.plan[0]!.say).toBe("close } brace");
    const two = extractPlan('```json\n{"not":"it"}\n```\nand\n```json\n{"plan":[{"kind":"none","say":"nothing"}]}\n```');
    expect("plan" in two && two.plan).toHaveLength(1);
  });

  it("says what is wrong with an answer that has no plan or a bad step", () => {
    expect(extractPlan("I would ask the owner.")).toMatchObject({ error: expect.stringContaining("no JSON plan") });
    expect(extractPlan('{"plan":[{"kind":"dance"}]}')).toMatchObject({ error: expect.stringContaining("no valid kind") });
    expect(extractPlan('{"plan":"not a list"}')).toMatchObject({ error: expect.stringContaining("no JSON plan") });
  });
});

describe("gradeAnswer", () => {
  const grade = (plan: unknown[], summary = "the owner decides", s = scenario()) => gradeAnswer(s, answer(plan, summary));

  it("passes the right plan, with nested arguments matched by their dotted path", () => {
    const got = grade([ask, block]);
    expect(got.passed).toBe(true);
    expect(got.checks.every((c) => c.ok)).toBe(true);
  });

  it("fails an answer that is not in the format", () => {
    const got = gradeAnswer(scenario(), "I would ask the owner to grant it.");
    expect(got.passed).toBe(false);
    expect(got.checks[0]!.detail).toContain("no JSON plan");
  });

  it("fails a missing tool call and says which argument was wrong", () => {
    const missing = grade([block]);
    expect(missing.passed).toBe(false);
    expect(missing.checks.some((c) => !c.ok && c.detail.includes("ask-owner is missing"))).toBe(true);
    const wrong = grade([{ ...ask, args: { kind: "decision", effect: { key: "mailbox.delegate" } } }, block]);
    expect(wrong.passed).toBe(false);
    expect(wrong.checks.some((c) => c.detail.includes('kind should be "grant"'))).toBe(true);
    const noEffect = grade([{ ...ask, args: { kind: "grant" } }, block]);
    expect(noEffect.checks.some((c) => !c.ok && c.detail.includes("effect.key"))).toBe(true);
  });

  it("fails an API call with the wrong method, path or body", () => {
    expect(grade([ask, { ...block, method: "post" }]).passed).toBe(false);
    expect(grade([ask, { ...block, path: "/api/agents/a1" }]).passed).toBe(false);
    expect(grade([ask, { ...block, args: { status: "done" } }]).passed).toBe(false);
  });

  it("fails a forbidden call, and the call is named", () => {
    const got = grade([ask, block, { kind: "tool", tool: "partnersinbiz.cockpit:post-daily-brief", args: {} }]);
    expect(got.passed).toBe(false);
    expect(got.checks.some((c) => !c.ok && c.detail.includes("not the place for a question"))).toBe(true);
  });

  it("fails when a required word is not said, or a forbidden one is", () => {
    expect(grade([{ ...ask, say: "ask" }, block], "nothing relevant").passed).toBe(false);
    expect(grade([{ ...ask, say: "ask" }, block], "nothing relevant").checks.some((c) => !c.ok && c.detail.includes("It says owner"))).toBe(true);
    const s = scenario({ expect: { mustNotSay: ["no browser"], mustSay: ["owner"] } });
    expect(grade([], "ask the owner", s).passed).toBe(true);
    expect(grade([], "the owner, but there is no browser", s).passed).toBe(false);
  });

  it("counts the words in the plan's say fields as said", () => {
    const s = scenario({ expect: { mustSay: ["late review"] } });
    expect(grade([{ kind: "comment", say: "Late review: this was not seen before" }], "", s).passed).toBe(true);
  });

  it("an optional call that is missing is fine; a required one is not", () => {
    const s = scenario({ expect: { toolCalls: [{ tool: "partnersinbiz.cockpit:memory-recall", optional: true }, { tool: "partnersinbiz.cockpit:ask-owner" }] } });
    expect(grade([ask], "", s).passed).toBe(true);
    expect(grade([{ kind: "tool", tool: "partnersinbiz.cockpit:memory-recall", args: {} }], "", s).passed).toBe(false);
  });

  it("when ordered, a call that comes too early does not count", () => {
    const s = scenario({
      expect: { ordered: true, toolCalls: [{ tool: "partnersinbiz.cockpit:memory-recall" }, { tool: "partnersinbiz.cockpit:ask-owner" }] },
    });
    const recall = { kind: "tool", tool: "partnersinbiz.cockpit:memory-recall", args: {} };
    expect(grade([recall, ask], "", s).passed).toBe(true);
    expect(grade([ask, recall], "", s).passed).toBe(false);
  });

  it("a forbidden argument is forbidden on its own, and only for the call it names", () => {
    const s = scenario({ expect: { forbid: [{ args: { assigneeUserId: { exists: true } }, reason: "never assign a person" }], mustSay: ["x"] } });
    expect(grade([{ kind: "api", method: "PATCH", path: "/api/issues/1", args: { assigneeUserId: "u1" } }], "x", s).passed).toBe(false);
    expect(grade([{ kind: "api", method: "PATCH", path: "/api/issues/1", args: { status: "todo" } }], "x", s).passed).toBe(true);
    const done = scenario({ expect: { forbid: [{ apiPath: "^/api/issues/", method: "PATCH", args: { status: { oneOf: ["done", "cancelled"] } }, reason: "no approving" }] } });
    expect(grade([{ kind: "api", method: "PATCH", path: "/api/issues/9", args: { status: "done" } }], "", done).passed).toBe(false);
    expect(grade([{ kind: "api", method: "PATCH", path: "/api/issues/9", args: { assigneeUserId: "u" } }], "", done).passed).toBe(true);
    // A forbidden pattern in the words only is not a forbidden call.
    const textOnly = scenario({ expect: { forbid: [{ text: "secret", reason: "no secrets" }] } });
    expect(grade([{ kind: "comment", say: "all fine" }], "ok", textOnly).passed).toBe(true);
    expect(grade([{ kind: "comment", say: "the secret is x" }], "ok", textOnly).passed).toBe(false);
  });

  it("matches arguments by pattern, presence, contents and null", () => {
    const s = scenario({
      expect: { toolCalls: [{ tool: "partnersinbiz.cockpit:ask-owner", args: { issueId: { matches: "^PAR-\\d+$" }, links: { notEmpty: true }, options: { contains: "Yes" }, reason: null, why: { exists: true } } }] },
    });
    const call = (args: Record<string, unknown>) => grade([{ kind: "tool", tool: "partnersinbiz.cockpit:ask-owner", args }], "", s).passed;
    expect(call({ issueId: "PAR-12", links: [{ href: "/x" }], options: ["Yes"], reason: null, why: "w" })).toBe(true);
    expect(call({ issueId: "12", links: [{ href: "/x" }], options: ["Yes"], reason: null, why: "w" })).toBe(false);
    expect(call({ issueId: "PAR-12", links: [], options: ["Yes"], reason: null, why: "w" })).toBe(false);
    expect(call({ issueId: "PAR-12", links: [{ href: "/x" }], options: ["No"], reason: null, why: "w" })).toBe(false);
    expect(call({ issueId: "PAR-12", links: [{ href: "/x" }], options: ["Yes"], reason: "set", why: "w" })).toBe(false);
    expect(call({ issueId: "PAR-12", links: [{ href: "/x" }], options: ["Yes"], reason: null })).toBe(false);
  });

  it("a plan longer than the allowed steps fails", () => {
    const s = scenario({ expect: { maxSteps: 2, mustSay: ["x"] } });
    const step = { kind: "comment", say: "x" };
    expect(grade([step, step], "", s).passed).toBe(true);
    expect(grade([step, step, step], "", s).passed).toBe(false);
  });
});

describe("pass rates per skill version", () => {
  const a = scenario({ id: "scenario-a" });
  const b = scenario({ id: "scenario-b" });
  const row = (id: string, passed: boolean, hash = "h1", at = "2026-10-03T10:00:00Z", s = a): ResultRow => ({ skillSlug: "pib-operator", skillHash: hash, scenarioId: id, scenarioHash: scenarioHash({ ...s, id }), passed, gradedAt: at });

  it("counts a scenario once it has run, and a scenario that has not run as not passed", () => {
    const state = skillState([a, b], "h1", [row("scenario-a", true)]);
    expect(state).toMatchObject({ total: 2, measured: 1, passed: 1, passRate: 0.5, missing: ["scenario-b"] });
  });

  it("ignores results for another skill text or an older version of the scenario", () => {
    const rows = [row("scenario-a", true, "other-hash"), { ...row("scenario-a", true), scenarioHash: "stale" }];
    expect(skillState([a], "h1", rows).measured).toBe(0);
  });

  it("uses the newest run, and with repeats the share that passed", () => {
    const flaky = scenario({ id: "scenario-a", repeats: 3 });
    const runs = [row("scenario-a", true, "h1", "2026-10-01T10:00:00Z", flaky), row("scenario-a", false, "h1", "2026-10-02T10:00:00Z", flaky), row("scenario-a", true, "h1", "2026-10-03T10:00:00Z", flaky)];
    expect(skillState([flaky], "h1", runs).scenarios["scenario-a"]).toMatchObject({ runs: 3, passedRuns: 2, measured: true, passed: true });
    expect(skillState([flaky], "h1", runs.slice(0, 2)).scenarios["scenario-a"]).toMatchObject({ measured: false, passed: false });
    const mostlyFailing = [row("scenario-a", false, "h1", "2026-10-01T10:00:00Z", flaky), row("scenario-a", false, "h1", "2026-10-02T10:00:00Z", flaky), row("scenario-a", true, "h1", "2026-10-03T10:00:00Z", flaky)];
    expect(skillState([flaky], "h1", mostlyFailing).scenarios["scenario-a"]!.passed).toBe(false);
    // The oldest run falls out once there are more than `repeats`.
    expect(skillState([flaky], "h1", [row("scenario-a", false, "h1", "2026-09-01T10:00:00Z", flaky), ...runs]).scenarios["scenario-a"]!.passedRuns).toBe(2);
  });
});

describe("the gate", () => {
  const a = scenario({ id: "scenario-a" });
  const b = scenario({ id: "scenario-b" });
  const c = scenario({ id: "scenario-c" });
  const scenarios = [a, b, c];
  const row = (id: string, passed: boolean, hash: string): ResultRow => ({ skillSlug: "pib-operator", skillHash: hash, scenarioId: id, scenarioHash: scenarioHash({ ...a, id }), passed, gradedAt: "2026-10-03T10:00:00Z" });
  const all = (hash: string, passes: boolean[]): ResultRow[] => scenarios.map((s, i) => row(s.id, passes[i]!, hash));
  const baseline: Baseline = { hash: "old", passRate: 1, scenarios: { "scenario-a": true, "scenario-b": true, "scenario-c": true } };
  const gate = (rows: ResultRow[], over: Partial<Parameters<typeof gateSkill>[0]> = {}) => gateSkill({ skill: "pib-operator", hash: "new", scenarios, rows, baseline, ...over });

  it("lets a skill ship when every scenario passes and none regressed", () => {
    expect(gate(all("new", [true, true, true]))).toMatchObject({ ship: true, status: "pass", regressions: [], passRate: 1 });
  });

  it("blocks a skill when a scenario that passed at the baseline fails now: the rule the deploy calls", () => {
    const verdict = gate(all("new", [true, false, true]));
    expect(verdict).toMatchObject({ ship: false, status: "regressed", regressions: ["scenario-b"] });
    expect(verdict.reasons[0]).toContain("scenario-b");
  });

  it("a scenario that failed at the baseline too is not a regression", () => {
    const failedBefore: Baseline = { ...baseline, scenarios: { ...baseline.scenarios, "scenario-b": false } };
    const verdict = gate(all("new", [true, false, true]), { baseline: failedBefore });
    expect(verdict.regressions).toEqual([]);
  });

  it("blocks a skill under the minimum pass rate even with nothing to compare with", () => {
    const verdict = gate(all("new", [true, false, false]), { baseline: null });
    expect(verdict).toMatchObject({ ship: false, status: "below-threshold" });
    expect(verdict.reasons[0]).toContain(`minimum is ${Math.round(MIN_PASS_RATE * 100)}%`);
  });

  it("blocks a skill text the scenarios were never run on, unless the rule is relaxed", () => {
    expect(gate([])).toMatchObject({ ship: false, status: "unmeasured", missing: ["scenario-a", "scenario-b", "scenario-c"] });
    expect(gate([row("scenario-a", true, "new")])).toMatchObject({ ship: false, status: "unmeasured" });
    expect(gate([row("scenario-a", true, "new")], { requireFull: false })).toMatchObject({ ship: true, status: "unmeasured" });
    // Results for the old text say nothing about the new one.
    expect(gate(all("old", [true, true, true]))).toMatchObject({ ship: false, status: "unmeasured" });
  });

  it("a partial run that already shows a regression blocks without waiting for the rest", () => {
    expect(gate([row("scenario-a", false, "new")], { requireFull: false })).toMatchObject({ ship: false, status: "regressed", regressions: ["scenario-a"] });
  });

  it("with no baseline yet, a clean run ships and says to record one", () => {
    const verdict = gate(all("new", [true, true, true]), { baseline: null });
    expect(verdict).toMatchObject({ ship: true, status: "no-baseline" });
    expect(verdict.reasons[0]).toContain("record this one");
  });

  it("a skill with no scenarios is not gated", () => {
    expect(gate([], { scenarios: [] })).toMatchObject({ ship: true, status: "no-scenarios" });
  });
});

describe("the committed gate file", () => {
  const scenarios = [scenario({ id: "scenario-a" }), scenario({ id: "scenario-b" })];
  const skills = (hash: string) => [{ slug: "pib-operator", hash, scenarios }];
  const file = (over: Partial<ResultsFile> = {}, entry: ResultsFile["skills"][string] = {}): ResultsFile => ({ version: 1, enforce: true, minPassRate: 0.8, skills: { "pib-operator": entry }, ...over });
  const baseline = { hash: "old", passRate: 1, scenarios: { "scenario-a": true, "scenario-b": true } };
  const run = (f: ResultsFile, hash = "new") => offlineGate(skills(hash), f)[0]!;

  it("only reports until the file enforces: nothing to regress from yet", () => {
    const v = run(file({ enforce: false }, {}));
    expect(v).toMatchObject({ ok: true, status: "no-baseline" });
    expect(v.reason).toContain("not enforced yet");
  });

  it("once enforcing, a skill with no baseline fails", () => {
    expect(run(file({}, {}))).toMatchObject({ ok: false, status: "no-baseline" });
  });

  it("a skill that is the baseline's text passes unchanged", () => {
    expect(run(file({}, { baseline }), "old")).toMatchObject({ ok: true, status: "unchanged" });
  });

  it("a changed skill with no recorded results fails, and says how to record them", () => {
    const v = run(file({}, { baseline }));
    expect(v).toMatchObject({ ok: false, status: "unmeasured" });
    expect(v.reason).toContain("old to new");
    expect(v.reason).toContain("evals/results.json");
  });

  it("a changed skill passes with results and no regression", () => {
    expect(run(file({}, { baseline, candidates: { new: { passRate: 1, scenarios: { "scenario-a": true, "scenario-b": true } } } }))).toMatchObject({ ok: true, status: "ok" });
  });

  it("fails on a regression, a missing scenario and a low pass rate", () => {
    const regressed = run(file({}, { baseline, candidates: { new: { passRate: 0.5, scenarios: { "scenario-a": true, "scenario-b": false } } } }));
    expect(regressed).toMatchObject({ ok: false, status: "regressed" });
    expect(regressed.reason).toContain("scenario-b");
    expect(run(file({}, { baseline, candidates: { new: { passRate: 1, scenarios: { "scenario-a": true } } } }))).toMatchObject({ ok: false, status: "unmeasured" });
    const lowBaseline = { ...baseline, scenarios: { "scenario-a": false, "scenario-b": false } };
    expect(run(file({}, { baseline: lowBaseline, candidates: { new: { passRate: 0.5, scenarios: { "scenario-a": true, "scenario-b": false } } } }))).toMatchObject({ ok: false, status: "below-threshold" });
  });

  it("a waiver for exactly this text lets it through and says who accepted the risk", () => {
    const f = file({}, { baseline, waivers: [{ hash: "new", reason: "typo fix", by: "peet", at: "2026-10-03" }] });
    const v = run(f);
    expect(v).toMatchObject({ ok: true, status: "waived" });
    expect(v.reason).toContain("peet");
    expect(run(f, "another")).toMatchObject({ ok: false });
  });

  it("a skill with no scenarios is not gated", () => {
    expect(offlineGate([{ slug: "pib-x", hash: "h", scenarios: [] }], file())[0]).toMatchObject({ ok: true, status: "no-scenarios" });
  });

  it("reads the committed file and refuses a malformed one", () => {
    expect(parseResultsFile({ version: 1, enforce: false, minPassRate: 0.8, skills: {} }).enforce).toBe(false);
    expect(() => parseResultsFile({ version: 2 })).toThrow(EvalError);
    expect(() => parseResultsFile({ version: 1, enforce: "yes", minPassRate: 0.8, skills: {} })).toThrow(EvalError);
  });

  it("prints a baseline entry from a skill's state, ready to commit", () => {
    const a = scenario({ id: "scenario-a" });
    const state = skillState([a], "h1", [{ skillSlug: "pib-operator", skillHash: "h1", scenarioId: "scenario-a", scenarioHash: scenarioHash(a), passed: true, gradedAt: "2026-10-03T10:00:00Z" }]);
    expect(resultsEntry(state, "2026-10-03T10:00:00Z", ["run-1"])).toEqual({ hash: "h1", passRate: 1, scenarios: { "scenario-a": true }, measuredAt: "2026-10-03T10:00:00Z", runs: ["run-1"] });
  });
});
