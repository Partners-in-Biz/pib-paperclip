/**
 * Eval files Cockpit ships (a template maps to its own evalFile, else `<key>.json`) in AGENT_EVALS (plugin-cockpit/evals/agents). The
 * template sync stamps `evalFile` on `metadata.pibPack` only for these, because
 * Cockpit's weekly agentResearch skips a pack whose eval is not shipped.
 * tests/shipped-evals.spec.ts keeps this list equal to that directory.
 */
export const SHIPPED_EVAL_FILES: readonly string[] = [
  "acceptance.json",
  "afrikaans-editor.json",
  "arjun.json",
  "bookkeeper.json",
  "code-reviewer.json",
  "crm-data-steward.json",
  "deal-desk.json",
  "developer.json",
  "dogfood-tester.json",
  "inbound-qualifier.json",
  "iris.json",
  "kai.json",
  "loyalty-plus-engineer-mac.json",
  "mira.json",
  "nadia.json",
  "operator.json",
  "outbound-social-specialist.json",
  "pib.json",
  "plan-critic.json",
  "planner.json",
  "product-designer.json",
  "release-engineer.json",
  "ren.json",
  "revenue-lead.json",
  "reviewer.json",
  "sales-lead.json",
  "senior-developer.json",
  "seo-specialist.json",
  "steve.json",
  "summarizer.json",
  "theo.json",
  "wiki-maintainer.json",
];

export function shippedEvalFile(evalFile: string | undefined): string | undefined {
  return evalFile && SHIPPED_EVAL_FILES.includes(evalFile) ? evalFile : undefined;
}
