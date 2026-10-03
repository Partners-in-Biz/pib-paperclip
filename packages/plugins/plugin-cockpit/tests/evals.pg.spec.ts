/**
 * The eval harness against a real Postgres (Q5-3, Q2-11, Q10-5): the plan the
 * Operator is handed, grading what the host's skill-test harness produced (read by
 * the Cockpit itself, never taken from the agent), results kept per skill text, the
 * baseline, and the gate the deploy asks ("no skill version ships if a golden
 * scenario regressed"). The grader and the gate rule are tested in eval-model.spec.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { evalMarker, evalPrompt, scenarioHash, skillContentHash, type Scenario } from "../src/eval-model.js";
import { scenariosFor } from "../src/eval-scenarios.js";
import { candidateSlugFor, listResults, markBaseline, ownSkills } from "../src/evals.js";
import { NAMESPACE } from "../src/namespace.js";
import { saveTeam } from "../src/roles.js";
import { COMPANY, OTHER_COMPANY, embeddedAvailable } from "./helpers/pg.js";
import { startWorlds, type Hybrid } from "./helpers/hybrid.js";
import { installedLikeHost, type InstalledCopy } from "./helpers/host-skills.js";

// The committed gate file (evals/results.json) grows with every recorded baseline; these tests describe the harness, so they run against an empty one.
vi.mock("../src/eval-scenarios.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/eval-scenarios.js")>()),
  RESULTS_FILE: { version: 1, enforce: false, minPassRate: 0.8, skills: {} },
}));

const available = await embeddedAvailable();
const d = available ? describe : describe.skip;

const A = COMPANY;
const B = OTHER_COMPANY;
const OP = "aaaaaaaa-0000-4000-8000-0000000000a1";
const OTHER = "aaaaaaaa-0000-4000-8000-0000000000a5";
const NOW = "2026-10-04T10:00:00.000Z";
const SKILL = "pib-operator";
const info = ownSkills().find((s) => s.slug === SKILL)!;
const scenarios = scenariosFor(SKILL);
const run = { agentId: OP, runId: "r1", companyId: A, projectId: "p1" };
const asOther = { agentId: OTHER, runId: "r2", companyId: A, projectId: "p1" };

type ToolResult = { content: string; data: Record<string, any>; error?: string };

const answer = (plan: unknown[], summary = "done"): string => `\`\`\`json\n${JSON.stringify({ plan, summary })}\n\`\`\``;
const right = (s: Scenario): string => answer(s.examples!.pass.plan, s.examples!.pass.summary);
const wrong = (s: Scenario): string => answer(s.examples!.fail.plan, s.examples!.fail.summary);

d("skill evals (Postgres)", () => {
  let worlds: Awaited<ReturnType<typeof startWorlds>>;
  beforeAll(async () => {
    worlds = await startWorlds();
  }, 120_000);
  afterAll(async () => {
    await worlds?.stop();
  });

  /**
   * The company's copy of the Operator skill as the HOST stores it (key line injected, helpers/host-skills.ts), not the shipped bytes:
   * same = unedited, drifted = SKILL.md edited, file-drifted = a reference file edited, no-signal = a host that reports no drift verdict
   * (then the text comparison with the key line taken out decides), none = not installed.
   */
  type Installed = "same" | "drifted" | "file-drifted" | "no-signal" | "no-signal-drifted" | "none";
  function installedCopy(mode: Installed): InstalledCopy | null {
    const host = installedLikeHost(info.skillKey, "skill-op-1");
    if (mode === "none") return null;
    if (mode === "drifted") return { ...host, markdown: `${host.markdown}\nEdited by hand.` };
    if (mode === "file-drifted") return { ...host, files: { ...host.files, [info.files[0]!.path]: `${info.files[0]!.content}\nEdited by hand.` } };
    if (mode === "no-signal") return { ...host, hostReportsDrift: false };
    if (mode === "no-signal-drifted") return { ...host, markdown: `${host.markdown}\nEdited by hand.`, hostReportsDrift: false };
    return host;
  }

  async function make(options: { installed?: Installed } = {}) {
    const mode = options.installed ?? "same";
    const copy = installedCopy(mode);
    const installed: Record<string, InstalledCopy> = copy ? { [info.skillKey]: copy } : {};
    const w = await worlds.make(
      {
        prefixes: { [A]: "PAR" },
        agents: [
          { id: OP, companyId: A, name: "Olive", status: "active", role: "general" },
          { id: OTHER, companyId: A, name: "Other", status: "active", role: "general" },
        ],
        installedSkills: installed,
      },
      NOW,
    );
    await saveTeam(w.env, A, { operatorAgentId: OP }, "user-owner");
    return Object.assign(w, { installed });
  }

  const call = async (w: Hybrid, params: Record<string, unknown>, who = run): Promise<ToolResult> => (await w.tools.get("skill-eval")!(params, who)) as ToolResult;

  let n = 0;
  /** What the host's harness leaves behind: a finished skill_test issue holding the prompt, and its `output` document. */
  function harness(w: Hybrid, scenario: Scenario, output: string | null, over: Record<string, unknown> = {}, skill = SKILL): string {
    n += 1;
    const id = `harness-${n}`;
    w.issues.set(id, { id, companyId: A, title: over.title ?? `Skill test: ${skill}`, description: evalPrompt(skill, scenario), status: "done", originKind: "skill_test", originId: `harness-run-${n}`, assigneeAgentId: OP, identifier: `PAR-${900 + n}`, ...over } as never);
    if (output !== null) w.documents.set(`${id}:output`, output);
    return id;
  }

  /** Record every scenario with the given verdict per scenario id (default: all right). */
  async function recordAll(w: Hybrid, wrongIds: string[] = [], params: Record<string, unknown> = {}) {
    const items = scenarios.map((s) => ({ scenarioId: s.id, issueId: harness(w, s, wrongIds.includes(s.id) ? wrong(s) : right(s)) }));
    return call(w, { action: "record", skill: SKILL, items, ...params });
  }

  describe("plan", () => {
    it("live: finds the installed skill and hands the Operator one harness request per scenario, with the prompt and the marker", async () => {
      const w = await make();
      // The premise the first version got wrong: the host stores the skill with its key line added, so the company's text is never the shipped bytes.
      const stored = w.installed[info.skillKey]!.markdown!;
      expect(stored).not.toBe(info.markdown);
      expect(stored).toContain('key: "plugin/partnersinbiz-cockpit/operator"');
      const out = await call(w, { action: "plan", skill: SKILL, agentId: OP });
      expect(out.error, out.content).toBeUndefined();
      expect(out.data).toMatchObject({ skill: SKILL, mode: "live", hash: info.hash, skillId: "skill-op-1", drift: false, changedFiles: [] });
      expect(out.data.notes).toEqual([]);
      expect(out.data.requests).toHaveLength(scenarios.length);
      for (const [i, s] of scenarios.entries()) {
        const request = out.data.requests[i];
        expect(request).toMatchObject({ scenarioId: s.id, method: "POST", path: `/api/companies/${A}/skills/skill-op-1/test-runs` });
        expect(request.body).toEqual({ agentId: OP, content: evalPrompt(SKILL, s) });
        expect(request.body.content).toContain(evalMarker(SKILL, s));
      }
      expect(out.data.rules.join(" ")).toContain("Never put a real client");
      expect(out.content).toContain(`${scenarios.length} harness requests for ${SKILL} (live, text ${info.hash})`);
    });

    it("live: an edited SKILL.md is drift, naming the file", async () => {
      const out = await call(await make({ installed: "drifted" }), { action: "plan", skill: SKILL, agentId: OP });
      expect(out.data.drift).toBe(true);
      expect(out.data.changedFiles).toEqual(["SKILL.md"]);
      expect(out.data.notes.join(" ")).toContain("differs from what the plugin ships (SKILL.md)");
    });

    it("live: an edited reference file is drift even though SKILL.md is untouched (the host's own verdict covers every file)", async () => {
      const out = await call(await make({ installed: "file-drifted" }), { action: "plan", skill: SKILL, agentId: OP });
      expect(out.data.drift).toBe(true);
      expect(out.data.changedFiles).toEqual([info.files[0]!.path]);
      expect(out.data.notes.join(" ")).toContain(info.files[0]!.path);
    });

    it("live: a host that reports no drift verdict is judged by the text with the managed key line taken out of both sides", async () => {
      const clean = await call(await make({ installed: "no-signal" }), { action: "plan", skill: SKILL, agentId: OP });
      expect(clean.data.drift).toBe(false);
      const edited = await call(await make({ installed: "no-signal-drifted" }), { action: "plan", skill: SKILL, agentId: OP });
      expect(edited.data.drift).toBe(true);
      expect(edited.data.changedFiles).toEqual(["SKILL.md"]);
    });

    it("live: says when the skill is not installed at all", async () => {
      const none = await make({ installed: "none" });
      expect((await call(none, { action: "plan", skill: SKILL, agentId: OP })).error).toContain("is not installed in this company yet");
    });

    it("picks scenarios, refuses names that are not the skill's, an unknown skill and an agent that is not in the company", async () => {
      const w = await make();
      const one = await call(w, { action: "plan", skill: SKILL, agentId: OP, scenarioIds: [scenarios[1]!.id] });
      expect(one.data.requests).toHaveLength(1);
      expect(one.data.requests[0].scenarioId).toBe(scenarios[1]!.id);
      expect((await call(w, { action: "plan", skill: SKILL, agentId: OP, scenarioIds: ["no-such"] })).error).toContain("is a scenario of pib-operator");
      expect((await call(w, { action: "plan", skill: "pib-ghost", agentId: OP })).error).toContain("is not one of the Cockpit's skills");
      expect((await call(w, { action: "plan", skill: SKILL, agentId: "aaaaaaaa-0000-4000-8000-0000000000ff" })).error).toContain("was not found in this company");
      expect((await call(w, { action: "plan" })).error).toBe("plan needs skill.");
    });

    it("warns about a paused agent: the host refuses test runs for it", async () => {
      const w = await make();
      w.agents.find((a) => a.id === OTHER)!.status = "paused";
      const out = await call(w, { action: "plan", skill: SKILL, agentId: OTHER });
      expect(out.data.notes.join(" ")).toContain("is paused");
    });

    it("candidate: needs the full text, installs it as a separately named test copy and never under the real name", async () => {
      const w = await make();
      expect((await call(w, { action: "plan", skill: SKILL, agentId: OP, mode: "candidate" })).error).toContain("needs candidateMarkdown");
      const markdown = `${info.markdown}\n\n## Extra\nAlways say why.\n`;
      const out = await call(w, { action: "plan", skill: SKILL, agentId: OP, mode: "candidate", candidateMarkdown: markdown });
      const hash = skillContentHash({ markdown: markdown.trim(), files: info.files });
      expect(out.data).toMatchObject({ mode: "candidate", hash, shippedHash: info.hash });
      expect(hash).not.toBe(info.hash);
      const [create, ...files] = out.data.install as Array<{ method: string; path: string; body: Record<string, string> }>;
      expect(create).toMatchObject({ method: "POST", path: `/api/companies/${A}/skills` });
      expect(create!.body.slug).toBe(`${SKILL}-candidate-${hash.slice(0, 6)}`);
      expect(create!.body.markdown).toContain(`name: ${create!.body.slug}`);
      expect(create!.body.markdown).not.toMatch(/^name: pib-operator$/m);
      expect(files).toHaveLength(info.files.length);
      expect(out.data.requests[0].path).toBe(`/api/companies/${A}/skills/<candidateSkillId>/test-runs`);
      expect(out.data.cleanup).toMatchObject({ method: "DELETE" });
      expect(out.data.rules.join(" ")).toContain(`candidateHash ${hash}`);
    });

    it("lists the scenarios without touching anything", async () => {
      const w = await make();
      const out = await call(w, { action: "scenarios" });
      expect(out.data.skills.map((s: { skill: string }) => s.skill).sort()).toEqual(["pib-acceptance", "pib-company-os", "pib-operator", "pib-reviewer"]);
      expect(out.data.skills.find((s: { skill: string }) => s.skill === SKILL).hash).toBe(info.hash);
      expect(await listResults(w.ctx, A, SKILL)).toEqual([]);
    });
  });

  describe("record", () => {
    it("reads the harness task's output itself and grades it: a right answer passes, a wrong one fails with the reason", async () => {
      const w = await make();
      const good = harness(w, scenarios[0]!, right(scenarios[0]!));
      const bad = harness(w, scenarios[1]!, wrong(scenarios[1]!));
      const out = await call(w, { action: "record", skill: SKILL, items: [{ scenarioId: scenarios[0]!.id, issueId: good }, { scenarioId: scenarios[1]!.id, issueId: bad }] });
      expect(out.error, out.content).toBeUndefined();
      expect(out.data.recorded[0]).toMatchObject({ state: "graded", passed: true });
      expect(out.data.recorded[1]).toMatchObject({ state: "graded", passed: false });
      expect(out.data.recorded[1].checks.some((c: { ok: boolean }) => !c.ok)).toBe(true);
      expect(out.content).toContain("Graded 2 (1 passed, 1 failed)");
      expect(out.data.state).toMatchObject({ hash: info.hash, total: scenarios.length, passed: 1, measured: 2 });
      expect(out.data.entry).toBeNull();
      const rows = await listResults(w.ctx, A, SKILL);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.scenarioId === scenarios[0]!.id)).toMatchObject({ passed: true, skillHash: info.hash, mode: "live", harnessIssueId: good, agentId: OP, baseline: false });
      expect(rows.find((r) => r.scenarioId === scenarios[1]!.id)!.planExcerpt).toContain("plan");
    });

    it("the agent's say-so is not the answer: a task whose output document says nothing gets no grade", async () => {
      const w = await make();
      const empty = harness(w, scenarios[0]!, "   ");
      const none = harness(w, scenarios[1]!, null);
      const out = await call(w, { action: "record", skill: SKILL, items: [{ scenarioId: scenarios[0]!.id, issueId: empty }, { scenarioId: scenarios[1]!.id, issueId: none }] });
      expect(out.data.recorded.map((r: { state: string }) => r.state)).toEqual(["refused", "refused"]);
      expect(out.data.recorded[0].detail).toContain("no `output` document");
      expect(await listResults(w.ctx, A, SKILL)).toEqual([]);
    });

    it("refuses an issue that is not a harness run, one made from other scenario text, one from another company and a scenario of another skill", async () => {
      const w = await make();
      const ordinary = harness(w, scenarios[0]!, right(scenarios[0]!), { originKind: "manual" });
      const stale = harness(w, scenarios[0]!, right(scenarios[0]!), { description: "[eval:pib-operator:blocked-no-way-out:0000000000000000]\nan older prompt" });
      const foreign = harness(w, scenarios[0]!, right(scenarios[0]!), { companyId: B });
      const good = harness(w, scenarios[0]!, right(scenarios[0]!));
      const out = await call(w, { action: "record", skill: SKILL, items: [{ scenarioId: scenarios[0]!.id, issueId: ordinary }, { scenarioId: scenarios[0]!.id, issueId: stale }, { scenarioId: scenarios[0]!.id, issueId: foreign }, { scenarioId: "no-such", issueId: good }, { scenarioId: scenarios[0]!.id, issueId: "PAR-404" }] });
      const states = out.data.recorded.map((r: { state: string; detail?: string }) => `${r.state}:${r.detail ?? ""}`);
      expect(states[0]).toContain("not a skill-test harness run");
      expect(states[1]).toContain("marker does not match");
      expect(states[2]).toContain("not found in this company");
      expect(states[3]).toContain("is not a scenario of pib-operator");
      expect(states[4]).toContain("not found in this company");
      expect(await listResults(w.ctx, A, SKILL)).toEqual([]);
    });

    it("one run is graded once: recording it again changes nothing, and a task still running waits", async () => {
      const w = await make();
      const id = harness(w, scenarios[0]!, right(scenarios[0]!));
      const item = { scenarioId: scenarios[0]!.id, issueId: id };
      expect((await call(w, { action: "record", skill: SKILL, items: [item] })).data.recorded[0].state).toBe("graded");
      expect((await call(w, { action: "record", skill: SKILL, items: [item] })).data.recorded[0].state).toBe("already");
      expect(await listResults(w.ctx, A, SKILL)).toHaveLength(1);
      const running = harness(w, scenarios[1]!, null, { status: "in_progress" });
      const waiting = await call(w, { action: "record", skill: SKILL, items: [{ scenarioId: scenarios[1]!.id, issueId: running }] });
      expect(waiting.data.recorded[0]).toMatchObject({ state: "not-done" });
      expect(waiting.content).toContain("1 not finished yet");
    });

    it("an installed, unedited skill records fine: the host's key line is not drift", async () => {
      const w = await make();
      const id = harness(w, scenarios[0]!, right(scenarios[0]!));
      const out = await call(w, { action: "record", skill: SKILL, items: [{ scenarioId: scenarios[0]!.id, issueId: id }] });
      expect(out.error, out.content).toBeUndefined();
      expect(out.data.recorded[0]).toMatchObject({ state: "graded", passed: true });
    });

    it("refuses to file results under text agents are not reading: an edited SKILL.md, an edited reference file, and either one on a host that reports no verdict", async () => {
      for (const installed of ["drifted", "file-drifted", "no-signal-drifted"] as const) {
        const w = await make({ installed });
        const id = harness(w, scenarios[0]!, right(scenarios[0]!));
        const out = await call(w, { action: "record", skill: SKILL, items: [{ scenarioId: scenarios[0]!.id, issueId: id }] });
        expect(out.error, installed).toContain("differs from what the plugin ships");
        if (installed === "file-drifted") expect(out.error).toContain(info.files[0]!.path);
        expect(await listResults(w.ctx, A, SKILL)).toEqual([]);
      }
    });

    it("refuses to file live results for a skill the company does not have", async () => {
      const w = await make({ installed: "none" });
      const id = harness(w, scenarios[0]!, right(scenarios[0]!));
      const out = await call(w, { action: "record", skill: SKILL, items: [{ scenarioId: scenarios[0]!.id, issueId: id }] });
      expect(out.error).toContain("is not installed in this company");
      expect(await listResults(w.ctx, A, SKILL)).toEqual([]);
    });

    it("ties a run to the skill it tested: a run of another skill or of a candidate's test copy is not a run of the live skill, and the reverse", async () => {
      const w = await make();
      const other = harness(w, scenarios[0]!, right(scenarios[0]!), { title: "Skill test: pib-reviewer" });
      const copy = harness(w, scenarios[0]!, right(scenarios[0]!), { title: `Skill test: ${candidateSlugFor(SKILL, "0123456789abcdef")}` });
      const untitled = harness(w, scenarios[0]!, right(scenarios[0]!), { title: "Some other task" });
      const out = await call(w, { action: "record", skill: SKILL, items: [other, copy, untitled].map((issueId) => ({ scenarioId: scenarios[0]!.id, issueId })) });
      expect(out.data.recorded.map((r: { state: string }) => r.state)).toEqual(["refused", "refused", "refused"]);
      expect(out.data.recorded[0].detail).toContain('tested "pib-reviewer", not pib-operator');
      expect(out.data.recorded[1].detail).toContain("not run on the live skill text");
      expect(out.data.recorded[2].detail).toContain("no skill name in its title");
      expect(await listResults(w.ctx, A, SKILL)).toEqual([]);
      // A candidate's runs must name that candidate's test copy, not the live skill.
      const hash = "0123456789abcdef";
      const live = harness(w, scenarios[0]!, right(scenarios[0]!));
      const mine = harness(w, scenarios[0]!, right(scenarios[0]!), { title: `Skill test: ${candidateSlugFor(SKILL, hash)}` });
      const asCandidate = await call(w, { action: "record", skill: SKILL, mode: "candidate", candidateHash: hash, items: [live, mine].map((issueId) => ({ scenarioId: scenarios[0]!.id, issueId })) });
      expect(asCandidate.data.recorded[0].state).toBe("refused");
      expect(asCandidate.data.recorded[0].detail).toContain("not the candidate's test copy");
      expect(asCandidate.data.recorded[1].state).toBe("graded");
    });

    it("needs items, and a candidate needs its hash", async () => {
      const w = await make();
      expect((await call(w, { action: "record", skill: SKILL })).error).toContain("needs items");
      const id = harness(w, scenarios[0]!, right(scenarios[0]!));
      const item = { scenarioId: scenarios[0]!.id, issueId: id };
      expect((await call(w, { action: "record", skill: SKILL, mode: "candidate", items: [item] })).error).toContain("needs candidateHash");
      expect((await call(w, { action: "record", skill: SKILL, mode: "candidate", candidateHash: "nope", items: [item] })).error).toContain("needs candidateHash");
    });

    it("when every scenario has a result it hands back the entry for evals/results.json", async () => {
      const w = await make();
      const out = await recordAll(w);
      expect(out.data.state).toMatchObject({ passed: scenarios.length, total: scenarios.length, missing: [] });
      expect(out.data.entry).toMatchObject({ passRate: 1, hash: info.hash });
      expect(Object.keys(out.data.entry.scenarios).sort()).toEqual(scenarios.map((s) => s.id).sort());
      expect(out.data.resultsFile).toContain("evals/results.json");
    });

    it("results are kept per company", async () => {
      const w = await make();
      await recordAll(w);
      expect(await listResults(w.ctx, A, SKILL)).toHaveLength(scenarios.length);
      expect(await listResults(w.ctx, B, SKILL)).toEqual([]);
    });
  });

  describe("report", () => {
    it("shows each skill's pass count on the current text, what failed and why, and the committed gate", async () => {
      const w = await make();
      await recordAll(w, [scenarios[2]!.id]);
      const out = await call(w, { action: "report", skill: SKILL });
      const report = out.data.skills[0];
      expect(report).toMatchObject({ skill: SKILL, hash: info.hash, scenarios: scenarios.length });
      expect(report.current.passed).toBe(scenarios.length - 1);
      expect(report.failing).toHaveLength(1);
      expect(report.failing[0].scenarioId).toBe(scenarios[2]!.id);
      expect(report.failing[0].checks.length).toBeGreaterThan(0);
      expect(report.gate.status).toBe("below-threshold");
      expect(report.committed).toMatchObject({ status: "no-baseline", ok: true });
      expect(report.committed.reason).toContain("not enforced yet");
      expect(report.baseline).toBeNull();
      expect(report.history).toHaveLength(1);
      expect(out.content).toContain(`${SKILL}: ${scenarios.length - 1} of ${scenarios.length} pass on ${info.hash} (no baseline)`);
    });

    it("with no skill named it covers every skill that has scenarios", async () => {
      const w = await make();
      const out = await call(w, { action: "report" });
      expect(out.data.skills.map((s: { skill: string }) => s.skill).sort()).toEqual(["pib-acceptance", "pib-company-os", "pib-operator", "pib-reviewer"]);
      for (const s of out.data.skills) expect(s.current.passed).toBe(0);
    });
  });

  describe("baseline", () => {
    it("only the Operator records it, and only after every scenario has run on the live text", async () => {
      const w = await make();
      expect((await call(w, { action: "baseline", skill: SKILL }, asOther)).error).toContain("Only the Operator");
      const early = await call(w, { action: "baseline", skill: SKILL });
      expect(early.error).toContain(`Run every scenario on the live skill first (${scenarios.length} are missing`);
      await recordAll(w);
      const done = await call(w, { action: "baseline", skill: SKILL });
      expect(done.error, done.content).toBeUndefined();
      expect(done.data.hash).toBe(info.hash);
      expect(done.data.entry).toMatchObject({ hash: info.hash, passRate: 1 });
      expect(done.data.warnings).toEqual([]);
      expect(done.data.commit.join("\n")).toContain(`skills.${SKILL}.baseline`);
      expect((await listResults(w.ctx, A, SKILL)).every((r) => r.baseline)).toBe(true);
    });

    it("a baseline of a skill that mostly fails says so instead of calling it good", async () => {
      const w = await make();
      await recordAll(w, scenarios.slice(0, 2).map((s) => s.id));
      const done = await call(w, { action: "baseline", skill: SKILL });
      expect(done.data.warnings[0]).toContain(`Only ${scenarios.length - 2} of ${scenarios.length} scenarios pass`);
    });

    it("refuses a baseline of text that is not what agents read: edited after the runs, an edited reference file, or no copy at all", async () => {
      const w = await make();
      await recordAll(w);
      // The company's copy was edited after the runs: the baseline would describe text nobody reads.
      w.installed[info.skillKey]!.markdown = `${w.installed[info.skillKey]!.markdown}\nEdited by hand.`;
      expect((await call(w, { action: "baseline", skill: SKILL })).error).toContain("differs from what the plugin ships (SKILL.md)");
      expect((await listResults(w.ctx, A, SKILL)).some((r) => r.baseline)).toBe(false);
      const file = info.files[0]!.path;
      const host = installedLikeHost(info.skillKey, "skill-op-1");
      w.installed[info.skillKey] = { ...host, files: { ...host.files, [file]: "changed" } };
      expect((await call(w, { action: "baseline", skill: SKILL })).error).toContain(file);
      delete w.installed[info.skillKey];
      expect((await call(w, { action: "baseline", skill: SKILL })).error).toContain("is not installed in this company");
      expect((await listResults(w.ctx, A, SKILL)).some((r) => r.baseline)).toBe(false);
    });

    it("an unedited, host-shaped copy baselines (the live path the first version refused)", async () => {
      const w = await make();
      await recordAll(w);
      expect(w.installed[info.skillKey]!.markdown).not.toBe(info.markdown);
      expect((await call(w, { action: "baseline", skill: SKILL })).error).toBeUndefined();
    });

    it("never drops the old baseline because the new text has only candidate results: it refuses and the old one stays", async () => {
      const w = await make();
      // An older text of the skill has a baseline (rows written the way a baseline leaves them).
      const old = "aaaaaaaaaaaaaaaa";
      for (const [i, s] of scenarios.entries()) {
        await w.ctx.db.execute(
          `INSERT INTO ${NAMESPACE}.eval_results (id, company_id, skill_slug, skill_hash, scenario_id, scenario_hash, mode, harness_issue_id, passed, baseline, graded_at) VALUES ($1, $2, $3, $4, $5, $6, 'live', $7, true, true, $8)`,
          [`old${i}`, A, SKILL, old, s.id, scenarioHash(s), `old-harness-${i}`, "2026-09-01T00:00:00.000Z"],
        );
      }
      // The shipped text's only results were run on a candidate's test copy of that same text.
      const items = scenarios.map((s) => ({ scenarioId: s.id, issueId: harness(w, s, right(s), { title: `Skill test: ${candidateSlugFor(SKILL, info.hash)}` }) }));
      const recorded = await call(w, { action: "record", skill: SKILL, mode: "candidate", candidateHash: info.hash, items });
      expect(recorded.data.state.missing).toEqual([]);
      const refused = await call(w, { action: "baseline", skill: SKILL });
      expect(refused.error).toContain(`Run every scenario on the live skill first (${scenarios.length} are missing`);
      const rows = await listResults(w.ctx, A, SKILL);
      expect(rows.filter((r) => r.baseline).map((r) => r.skillHash)).toEqual(scenarios.map(() => old));
      expect(rows.filter((r) => r.skillHash === info.hash).every((r) => !r.baseline && r.mode === "candidate")).toBe(true);
    });

    it("markBaseline changes nothing at all when the text has no live results (the statement guards itself, whoever calls it)", async () => {
      const w = await make();
      const old = "cccccccccccccccc";
      for (const [i, s] of scenarios.entries()) {
        await w.ctx.db.execute(
          `INSERT INTO ${NAMESPACE}.eval_results (id, company_id, skill_slug, skill_hash, scenario_id, scenario_hash, mode, harness_issue_id, passed, baseline, graded_at) VALUES ($1, $2, $3, $4, $5, $6, 'live', $7, true, true, $8)`,
          [`old${i}`, A, SKILL, old, s.id, scenarioHash(s), `old-harness-${i}`, "2026-09-01T00:00:00.000Z"],
        );
      }
      // The new text has candidate-mode rows only.
      const candidate = harness(w, scenarios[0]!, right(scenarios[0]!), { title: `Skill test: ${candidateSlugFor(SKILL, info.hash)}` });
      await call(w, { action: "record", skill: SKILL, mode: "candidate", candidateHash: info.hash, items: [{ scenarioId: scenarios[0]!.id, issueId: candidate }] });
      expect(await markBaseline(w.ctx, A, SKILL, info.hash)).toBe(0);
      expect((await listResults(w.ctx, A, SKILL)).filter((r) => r.baseline)).toHaveLength(scenarios.length);
      // Another company's baseline is never touched.
      expect(await markBaseline(w.ctx, B, SKILL, old)).toBe(0);
      expect((await listResults(w.ctx, A, SKILL)).filter((r) => r.baseline && r.skillHash === old)).toHaveLength(scenarios.length);
    });

    it("moving the baseline to a new live text clears the old one in the same step", async () => {
      const w = await make();
      const old = "bbbbbbbbbbbbbbbb";
      for (const [i, s] of scenarios.entries()) {
        await w.ctx.db.execute(
          `INSERT INTO ${NAMESPACE}.eval_results (id, company_id, skill_slug, skill_hash, scenario_id, scenario_hash, mode, harness_issue_id, passed, baseline, graded_at) VALUES ($1, $2, $3, $4, $5, $6, 'live', $7, true, true, $8)`,
          [`old${i}`, A, SKILL, old, s.id, scenarioHash(s), `old-harness-${i}`, "2026-09-01T00:00:00.000Z"],
        );
      }
      await recordAll(w);
      expect((await call(w, { action: "baseline", skill: SKILL })).error).toBeUndefined();
      const rows = await listResults(w.ctx, A, SKILL);
      expect(rows.filter((r) => r.baseline).every((r) => r.skillHash === info.hash)).toBe(true);
      expect(rows.filter((r) => r.baseline)).toHaveLength(scenarios.length);
      expect(rows.filter((r) => r.skillHash === old).some((r) => r.baseline)).toBe(false);
    });
  });

  describe("the gate", () => {
    it("blocks a text no scenario was run on, and says which", async () => {
      const w = await make();
      const out = await call(w, { action: "gate", skill: SKILL });
      expect(out.data.ship).toBe(false);
      expect(out.data.verdicts[0]).toMatchObject({ skill: SKILL, status: "unmeasured", ship: false });
      expect(out.content).toContain(`Do not ship: ${SKILL} (unmeasured`);
      expect(out.data.rule).toContain("No skill version ships if a golden scenario that passed at the baseline now fails");
    });

    it("lets a text through when every scenario passes, and tells the owner there is no baseline yet", async () => {
      const w = await make();
      await recordAll(w);
      const out = await call(w, { action: "gate", skill: SKILL });
      expect(out.data.ship).toBe(true);
      expect(out.data.verdicts[0].status).toBe("no-baseline");
      await call(w, { action: "baseline", skill: SKILL });
      const after = await call(w, { action: "gate", skill: SKILL });
      expect(after.data.verdicts[0].status).toBe("pass");
      expect(after.content).toBe("May ship: 1 skills checked.");
    });

    it("blocks a candidate that regresses a scenario the baseline passed, and passes one that does not", async () => {
      const w = await make();
      await recordAll(w);
      await call(w, { action: "baseline", skill: SKILL });
      const markdown = `${info.markdown}\n\n## Candidate\nA change.\n`;
      const plan = await call(w, { action: "plan", skill: SKILL, agentId: OP, mode: "candidate", candidateMarkdown: markdown });
      const hash = plan.data.hash as string;
      // The candidate loses one scenario.
      const copyTitle = (h: string) => ({ title: `Skill test: ${candidateSlugFor(SKILL, h)}` });
      const items = scenarios.map((s) => ({ scenarioId: s.id, issueId: harness(w, s, s.id === scenarios[3]!.id ? wrong(s) : right(s), copyTitle(hash)) }));
      const recorded = await call(w, { action: "record", skill: SKILL, mode: "candidate", candidateHash: hash, items });
      expect(recorded.error, recorded.content).toBeUndefined();
      expect(recorded.data.hash).toBe(hash);
      expect((await listResults(w.ctx, A, SKILL)).filter((r) => r.skillHash === hash).every((r) => r.mode === "candidate")).toBe(true);
      const blocked = await call(w, { action: "gate", skill: SKILL, candidateHash: hash });
      expect(blocked.data.ship).toBe(false);
      expect(blocked.data.verdicts[0]).toMatchObject({ status: "regressed", regressions: [scenarios[3]!.id] });
      expect(blocked.content).toContain("Do not ship");
      // The shipped text is untouched by the candidate's results.
      expect((await call(w, { action: "gate", skill: SKILL })).data.verdicts[0].status).toBe("pass");
      // A second candidate that keeps everything passing may ship.
      const plan2 = await call(w, { action: "plan", skill: SKILL, agentId: OP, mode: "candidate", candidateMarkdown: `${info.markdown}\n\n## Another\nOther.\n` });
      const hash2 = plan2.data.hash as string;
      await call(w, { action: "record", skill: SKILL, mode: "candidate", candidateHash: hash2, items: scenarios.map((s) => ({ scenarioId: s.id, issueId: harness(w, s, right(s), copyTitle(hash2)) })) });
      expect((await call(w, { action: "gate", skill: SKILL, candidateHash: hash2 })).data.verdicts[0]).toMatchObject({ ship: true, status: "pass" });
    });

    it("a baseline switched to a newer text moves what is compared with", async () => {
      const w = await make();
      await recordAll(w);
      await call(w, { action: "baseline", skill: SKILL });
      const report = (await call(w, { action: "report", skill: SKILL })).data.skills[0];
      expect(report.baseline).toEqual({ hash: info.hash, passRate: 1 });
    });
  });
});
