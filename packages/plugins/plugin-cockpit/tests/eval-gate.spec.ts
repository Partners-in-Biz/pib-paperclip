/**
 * The skill gate the deploy runs (Q5-3, Q2-11, Q10-5): "no skill version ships if a
 * golden scenario regressed". The deploy script already runs this package's tests
 * before it copies anything, so the gate is this spec (`pnpm eval:gate` runs only
 * it). The committed file `evals/results.json` holds each skill's baseline and the
 * recorded results of a changed text; until it enforces (the first baseline is
 * recorded from a live run), it only reports.
 */
import { describe, expect, it } from "vitest";
import { offlineGate, skillContentHash, type ResultsFile } from "../src/eval-model.js";
import { RESULTS_FILE, scenariosFor, scenarioSkills } from "../src/eval-scenarios.js";
import { ownSkills } from "../src/evals.js";

const shipped = () => ownSkills().map((s) => ({ slug: s.slug, hash: s.hash, scenarios: scenariosFor(s.slug) }));

describe("the gate on the skills as they are in this tree", () => {
  it("the committed results hold every gated skill to its baseline (and only report while the file does not enforce)", () => {
    for (const v of offlineGate(shipped(), RESULTS_FILE)) expect(v.ok, `${v.skill} (${v.hash}): ${v.reason}`).toBe(true);
  });

  it("when the file enforces, a skill that changed since its baseline fails until its results are recorded", () => {
    const operator = ownSkills().find((s) => s.slug === "pib-operator")!;
    const scenarios = scenariosFor("pib-operator");
    const everyScenarioPassed = Object.fromEntries(scenarios.map((s) => [s.id, true]));
    const baselineOfUneditedText: ResultsFile = { version: 1, enforce: true, minPassRate: 0.8, skills: { "pib-operator": { baseline: { hash: operator.hash, passRate: 1, scenarios: everyScenarioPassed } } } };
    // The tree as it is: its own baseline, nothing to record.
    expect(offlineGate([{ slug: "pib-operator", hash: operator.hash, scenarios }], baselineOfUneditedText)[0]).toMatchObject({ ok: true, status: "unchanged" });
    // One word changed in a reference file: the hash moves, and the gate says so.
    const edited = skillContentHash({ markdown: operator.markdown, files: operator.files.map((f, i) => (i === 0 ? { ...f, content: `${f.content}\nOne more rule.` } : f)) });
    expect(edited).not.toBe(operator.hash);
    const blocked = offlineGate([{ slug: "pib-operator", hash: edited, scenarios }], baselineOfUneditedText)[0]!;
    expect(blocked).toMatchObject({ ok: false, status: "unmeasured" });
    expect(blocked.reason).toContain("evals/results.json");
    // With results recorded and none regressed, it ships; with one regression, it does not.
    const recorded = (passes: boolean[]): ResultsFile => ({ ...baselineOfUneditedText, skills: { "pib-operator": { ...baselineOfUneditedText.skills["pib-operator"]!, candidates: { [edited]: { passRate: 1, scenarios: Object.fromEntries(scenarios.map((s, i) => [s.id, passes[i] ?? true])) } } } } });
    expect(offlineGate([{ slug: "pib-operator", hash: edited, scenarios }], recorded(scenarios.map(() => true)))[0]).toMatchObject({ ok: true, status: "ok" });
    const regressed = offlineGate([{ slug: "pib-operator", hash: edited, scenarios }], recorded(scenarios.map((_, i) => i !== 1)))[0]!;
    expect(regressed).toMatchObject({ ok: false, status: "regressed" });
    expect(regressed.reason).toContain(scenarios[1]!.id);
  });

  it("every skill with scenarios is one the gate sees, and the hash covers the references too", () => {
    expect(shipped().filter((s) => s.scenarios.length > 0).map((s) => s.slug).sort()).toEqual(scenarioSkills().sort());
    const operator = ownSkills().find((s) => s.slug === "pib-operator")!;
    expect(operator.files.length).toBeGreaterThanOrEqual(8);
    expect(skillContentHash({ markdown: operator.markdown, files: [] })).not.toBe(operator.hash);
  });
});
