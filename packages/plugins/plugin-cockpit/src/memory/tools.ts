/**
 * Runs the memory tools. Every PiB skill tells agents to start a task with
 * memory-recall and to save lessons with memory-add (kit `COMPANY_MEMORY_SECTION`).
 */
import type { ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { MEMORY_TOOLS, toolFail, toolOk } from "@partnersinbiz/pib-plugin-kit";
export { MEMORY_TOOL_DECLARATIONS, MEMORY_TOOL_NAMES } from "./declarations.js";
import type { Env } from "../env.js";
import { addFact, feedback, MemoryError, recall, review, search, updateFact, type Actor } from "./service.js";

const ok = (content: string, data: unknown): ToolResult => toolOk(content, data) as ToolResult;
const fail = (message: string): ToolResult => toolFail(message) as ToolResult;

export async function runMemoryTool(env: Env, name: string, params: unknown, run: ToolRunContext): Promise<ToolResult> {
  const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
  const actor: Actor = { agentId: run.agentId ?? null, runId: run.runId ?? null, userId: null };
  const companyId = run.companyId;
  try {
    if (name === MEMORY_TOOLS.recall) {
      const brief = await recall(env, companyId, p, actor);
      return ok(brief.body, { briefId: brief.briefId, method: brief.method, cached: brief.cached, facts: brief.facts, client: brief.client, area: brief.area, totalFacts: brief.totalFacts, tokens: brief.tokens });
    }
    if (name === MEMORY_TOOLS.add) {
      const result = await addFact(env, companyId, p, actor);
      return ok(result.message, { status: result.status, id: result.fact.id, fact: result.fact, similar: result.similar, superseded: result.superseded });
    }
    if (name === MEMORY_TOOLS.update) {
      const result = await updateFact(env, companyId, p);
      return ok(result.message, { fact: result.fact });
    }
    if (name === MEMORY_TOOLS.search) {
      const result = await search(env, companyId, p, actor);
      return ok(result.body, result);
    }
    if (name === MEMORY_TOOLS.feedback) {
      const result = await feedback(env, companyId, p, actor);
      return ok(result.message, result);
    }
    if (name === MEMORY_TOOLS.review) {
      const result = await review(env, companyId);
      const s = result.stats;
      return ok(
        `${s.facts.active} active facts (${s.added7d} added this week), ${s.briefs7d.total} briefs this week (${s.briefs7d.jev} by Jev, avg ${s.briefs7d.avgFacts} facts, ~${s.briefs7d.avgTokens} tokens). ${result.verdict} ${result.duplicates.length} likely duplicates, ${result.noisy.length} noisy facts, ${result.staleCount} unused for 120+ days.${result.misfiled.length ? ` ${result.misfiled.length} company-wide ${result.misfiled.length === 1 ? "fact names" : "facts name"} a client, so ${result.misfiled.length === 1 ? "it reaches" : "they reach"} every client's brief: move each with its suggestion (memory-add with that client and supersedes).` : ""}${result.agentsSkippingMemory.length ? ` ${result.agentsSkippingMemory.length} agent(s) started most runs without memory-recall: remind them (comment on their issues) that every task starts with it.` : ""}`,
        result,
      );
    }
    return fail(`Unknown memory tool ${name}`);
  } catch (error) {
    if (error instanceof MemoryError) return fail(error.message);
    env.ctx.logger.info("Memory tool failed", { name, error: error instanceof Error ? error.message : String(error) });
    return fail(`Memory is unavailable right now (${error instanceof Error ? error.message : String(error)}). Carry on with the task; put lessons in your closing comment under **Learned:**.`);
  }
}
