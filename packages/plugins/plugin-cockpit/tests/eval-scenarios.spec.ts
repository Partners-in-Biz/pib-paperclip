/**
 * Verify that scenario examples pass and fail as expected using the real scorer.
 */
import { describe, expect, it } from "vitest";
import { gradeAnswer, type Scenario } from "../src/eval-model.js";
import { AGENT_EVALS } from "../src/eval-scenarios.js";

describe("eval scenario examples", () => {
  for (const [agentKey, evalFile] of Object.entries(AGENT_EVALS)) {
    const file = evalFile as any;
    if (!file.scenarios || !Array.isArray(file.scenarios)) continue;

    const scenariosWithExamples = (file.scenarios as Scenario[]).filter((s) => s.examples);
    if (scenariosWithExamples.length === 0) continue;

    describe(`${agentKey}`, () => {
      for (const scenario of scenariosWithExamples) {
        const examples = scenario.examples!;

        it(`${scenario.id}: pass example passes`, () => {
          const passOutput = JSON.stringify({
            plan: examples.pass.plan,
            summary: examples.pass.summary ?? "",
          });
          const result = gradeAnswer(scenario, `\`\`\`json\n${passOutput}\n\`\`\``);
          expect(result.passed, `Scenario ${scenario.id} pass example should pass. Failures: ${result.checks.filter((c) => !c.ok).map((c) => c.detail).join("; ")}`).toBe(
            true,
          );
        });

        it(`${scenario.id}: fail example fails`, () => {
          const failOutput = JSON.stringify({
            plan: examples.fail.plan,
            summary: examples.fail.summary ?? "",
          });
          const result = gradeAnswer(scenario, `\`\`\`json\n${failOutput}\n\`\`\``);
          expect(result.passed, `Scenario ${scenario.id} fail example should fail but passed`).toBe(false);
        });
      }
    });
  }
});
