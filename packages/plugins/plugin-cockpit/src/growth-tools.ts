/** Runs the growth ledger and metric tools (declarations in `growth-tool-declarations.ts`). */
import type { ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { toolFail, toolOk } from "@partnersinbiz/pib-plugin-kit";
import type { Env } from "./env.js";
import { message } from "./env.js";
import { GrowthLedgerError, listLedger, parseLedgerInput, parseMetricInput, recordMetric, scopeText, upsertLedger } from "./growth-ledger.js";
import { GROWTH_TOOL_NAMES } from "./growth-tool-declarations.js";
import { checkTag, GrowthTagError, parseTag, writeTag } from "./growth-tagging.js";

export { GROWTH_TOOL_SET } from "./growth-tool-declarations.js";

const ok = (content: string, data: unknown): ToolResult => toolOk(content, data) as ToolResult;
const fail = (text: string): ToolResult => toolFail(text) as ToolResult;

export async function runGrowthTool(env: Env, name: string, raw: unknown, run: ToolRunContext): Promise<ToolResult> {
  const companyId = run.companyId;
  const p = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  try {
    if (name === GROWTH_TOOL_NAMES.recordMetric) {
      const input = parseMetricInput(p);
      const tag = parseTag(p);
      if (tag?.experimentId && tag.arm) await checkTag(env, companyId, { experimentId: tag.experimentId, arm: tag.arm }, input);
      await recordMetric(env, companyId, input);
      if (tag) await writeTag(env, companyId, tag, input);
      const tagged = tag?.experimentId ? ` and tagged it to ${tag.experimentId} (${tag.arm})` : tag ? " and cleared its experiment tag" : "";
      return ok(`Recorded ${input.metric} = ${input.value} for ${input.channel}, ${input.subject}, ${input.window}${tagged}.`, { ...input, experimentId: tag?.experimentId ?? null, arm: tag?.arm ?? null });
    }
    if (name === GROWTH_TOOL_NAMES.ledger) {
      const rows = await listLedger(env, companyId, {
        channel: typeof p.channel === "string" && p.channel.trim() ? p.channel.trim() : null,
        scopeKey: p.scope === undefined || p.scope === "" ? null : scopeText(p.scope),
        experimentId: typeof p.experimentId === "string" && p.experimentId.trim() ? p.experimentId.trim() : null,
        limit: typeof p.limit === "number" ? p.limit : undefined,
      });
      return ok(rows.length === 0 ? "The growth ledger has no verdicts for this filter." : `${rows.length} ${rows.length === 1 ? "verdict" : "verdicts"}.`, { items: rows, count: rows.length });
    }
    if (name === GROWTH_TOOL_NAMES.ledgerUpsert) {
      const input = parseLedgerInput(p, env.now());
      const created = await upsertLedger(env, companyId, input);
      return ok(created ? `Added the verdict for ${input.experimentId} to the ledger.` : `The ledger already has this verdict for ${input.experimentId}; nothing changed.`, { created, experimentId: input.experimentId, channel: input.channel, scope: input.scopeKey });
    }
    return fail(`Unknown tool ${name}`);
  } catch (error) {
    if (error instanceof GrowthLedgerError || error instanceof GrowthTagError) return fail(error.message);
    env.ctx.logger.info("Cockpit growth tool failed", { name, error: message(error) });
    return fail(`${name} failed: ${message(error)}`);
  }
}
