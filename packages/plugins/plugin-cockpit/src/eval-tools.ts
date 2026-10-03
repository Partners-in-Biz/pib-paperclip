/**
 * Runs the skill-quality tools (declarations in `eval-tool-declarations.ts`):
 * `skill-eval` and `propose-skill-change`.
 */
import type { ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { toolFail, toolOk } from "@partnersinbiz/pib-plugin-kit";
import { EvalError, scenarioHash } from "./eval-model.js";
import { baselineEval, gateEval, planEval, recordEval, reportEval, skillsWithScenarios, ownSkills } from "./evals.js";
import { scenariosFor } from "./eval-scenarios.js";
import { EVAL_TOOL_NAMES } from "./eval-tool-declarations.js";
import type { Env } from "./env.js";
import { message } from "./env.js";
import { operatorAgentId } from "./roles.js";
import { proposeSkillChange } from "./skill-change.js";
import { SkillChangeError } from "./skill-change-model.js";

export { EVAL_TOOL_SET } from "./eval-tool-declarations.js";

const ok = (content: string, data: unknown): ToolResult => toolOk(content, data) as ToolResult;
const fail = (text: string): ToolResult => toolFail(text) as ToolResult;

function params(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const text = (value: unknown, max = 200): string | undefined => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);
const percent = (n: number | null): string => (n === null ? "no scenarios" : `${Math.round(n * 100)}%`);

export async function runEvalTool(env: Env, name: string, raw: unknown, run: ToolRunContext): Promise<ToolResult> {
  const companyId = run.companyId;
  const p = params(raw);
  try {
    if (name === EVAL_TOOL_NAMES.eval) {
      const action = text(p.action, 20);
      const skill = text(p.skill, 40);
      const mode = p.mode === "candidate" ? "candidate" : "live";
      if (action === "scenarios") {
        const slugs = skill ? [skill] : skillsWithScenarios();
        const skills = slugs.map((slug) => ({ skill: slug, scenarios: scenariosFor(slug).map((s) => ({ id: s.id, title: s.title, source: s.source, hash: scenarioHash(s), repeats: s.repeats ?? 1 })), hash: ownSkills().find((s) => s.slug === slug)?.hash ?? null }));
        return ok(`${skills.reduce((n, s) => n + s.scenarios.length, 0)} golden scenarios for ${skills.length} skills.`, { skills });
      }
      if (action === "plan") {
        if (!skill) return fail("plan needs skill.");
        const plan = await planEval(env, companyId, {
          skill,
          scenarioIds: Array.isArray(p.scenarioIds) ? p.scenarioIds.filter((x): x is string => typeof x === "string") : undefined,
          mode,
          agentId: text(p.agentId, 100) ?? run.agentId,
          candidateMarkdown: typeof p.candidateMarkdown === "string" ? p.candidateMarkdown : undefined,
          candidateFiles: Array.isArray(p.candidateFiles) ? (p.candidateFiles as Array<{ path: string; content: string }>) : undefined,
        });
        const n = (plan.requests as unknown[]).length;
        return ok(`${n} harness request${n === 1 ? "" : "s"} for ${skill} (${mode}, text ${String(plan.hash)}). Make them, wait for the tasks to finish, then record.`, plan);
      }
      if (action === "record") {
        if (!skill) return fail("record needs skill.");
        const items = Array.isArray(p.items) ? (p.items as Array<{ scenarioId?: unknown; issueId?: unknown }>).filter((i) => typeof i.scenarioId === "string" && typeof i.issueId === "string").map((i) => ({ scenarioId: String(i.scenarioId), issueId: String(i.issueId) })) : [];
        if (items.length === 0) return fail("record needs items: [{scenarioId, issueId}] for the finished harness tasks.");
        const done = await recordEval(env, companyId, { skill, mode, candidateHash: text(p.candidateHash, 40), items });
        const graded = done.recorded.filter((r) => r.state === "graded");
        const passed = graded.filter((r) => r.passed).length;
        const pending = done.recorded.filter((r) => r.state === "not-done").length;
        return ok(
          `Graded ${graded.length} (${passed} passed${graded.length - passed ? `, ${graded.length - passed} failed` : ""})${pending ? `; ${pending} not finished yet` : ""}. ${skill} ${done.hash}: ${done.state.passed} of ${done.state.total} scenarios pass${done.state.missing.length ? `, ${done.state.missing.length} not run yet` : ""}.`,
          { ...done, ...(done.entry ? { resultsFile: `Every scenario has a result for this text. For evals/results.json (candidates["${done.hash}"] for a candidate): ${JSON.stringify(done.entry)}` } : {}) },
        );
      }
      if (action === "report") {
        const skills = await reportEval(env, companyId, skill);
        const lines = skills.map((s) => `${s.skill}: ${s.current.passed} of ${s.current.total} pass on ${s.hash}${s.baseline ? ` (baseline ${percent(s.baseline.passRate)})` : " (no baseline)"}; gate ${s.gate.status}`);
        return ok(lines.join(" | ") || "No skill has scenarios.", { skills });
      }
      if (action === "baseline") {
        if (!skill) return fail("baseline needs skill.");
        const operator = await operatorAgentId(env, companyId).catch(() => null);
        if (operator && run.agentId !== operator) return fail("Only the Operator records a baseline: it decides which version is the one to beat.");
        const done = await baselineEval(env, companyId, skill);
        return ok(`Recorded the baseline for ${skill} (${done.hash}). Commit it to evals/results.json.`, done);
      }
      if (action === "gate") {
        const report = await gateEval(env, companyId, skill, text(p.candidateHash, 40));
        const blocked = report.verdicts.filter((v) => !v.ship);
        return ok(report.ship ? `May ship: ${report.verdicts.length} skills checked.` : `Do not ship: ${blocked.map((v) => `${v.skill} (${v.status}: ${v.reasons[0]})`).join("; ")}`, report);
      }
      return fail("action is one of scenarios, plan, record, report, baseline, gate.");
    }
    if (name === EVAL_TOOL_NAMES.change) {
      const skill = text(p.skill, 60);
      const diff = typeof p.diff === "string" ? p.diff : "";
      const reason = text(p.reason, 600);
      const metricKey = text(p.metricKey, 120);
      if (!skill || !diff.trim() || !reason || !metricKey) return fail("propose-skill-change needs skill, diff, reason and metricKey (the number the change should move).");
      const done = await proposeSkillChange(
        env,
        companyId,
        {
          skill,
          diff,
          file: text(p.file, 200) ?? "SKILL.md",
          reason,
          evidence: Array.isArray(p.evidence) ? p.evidence.filter((e): e is string => typeof e === "string").map((e) => e.slice(0, 200)).slice(0, 10) : [],
          sourceIssueId: text(p.sourceIssueId, 100) ?? null,
          metricKey,
          direction: p.direction === "lower" || p.direction === "higher" ? p.direction : undefined,
          baselineValue: typeof p.baselineValue === "number" ? p.baselineValue : undefined,
          targetValue: typeof p.targetValue === "number" ? p.targetValue : undefined,
          recheckInDays: typeof p.recheckInDays === "number" ? Math.round(p.recheckInDays) : 28,
          kind: text(p.kind, 20) ?? "skill",
        },
        { agentId: run.agentId ?? null },
      );
      return ok(
        `Prepared the pull request: branch ${done.package.branch} into ${done.package.base}. ${done.review ? `The diff applies (${done.review.added} lines added, ${done.review.removed} removed; ${done.review.after} of ${done.review.budget} characters).` : "Not checked against the text."} Ledger entry ${done.improvement.id} measures ${done.improvement.metricKey} again on ${done.improvement.recheckAt.slice(0, 10)}.${done.review?.needsOwner ? " It drops a never-rule: ask the owner first." : ""}`,
        done,
      );
    }
    return fail(`Unknown tool ${name}`);
  } catch (error) {
    if (error instanceof EvalError || error instanceof SkillChangeError) return fail(error.message);
    env.ctx.logger.info("Cockpit tool failed", { name, error: message(error) });
    return fail(`${name} failed: ${message(error)}`);
  }
}
