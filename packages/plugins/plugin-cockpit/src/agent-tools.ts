/**
 * The Cockpit's write tools for every agent: `ask-owner`, `company-profile`
 * and `update-company-profile` (the Operator's read tools live in brief.ts,
 * the memory tools in memory/tools.ts).
 */
import type { ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { toolFail, toolOk } from "@partnersinbiz/pib-plugin-kit";
import { AskError } from "./ask-model.js";
import { askOwner } from "./asks.js";
import { message, type Env } from "./env.js";
import { linkFor } from "./health.js";
import { fillProfile, profileSummary, readProfile, readProfileHistory } from "./profile.js";
import { fieldLabels, ProfileError, profileField } from "./profile-model.js";
import { TOOL_NAMES } from "./tools.js";

export const AGENT_TOOL_NAMES = new Set<string>([TOOL_NAMES.askOwner, TOOL_NAMES.profile, TOOL_NAMES.updateProfile]);

function params(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function shown(value: string | string[]): string {
  const text = Array.isArray(value) ? value.join(", ") : value;
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

export async function runAgentTool(env: Env, name: string, raw: unknown, run: ToolRunContext): Promise<ToolResult> {
  const companyId = run.companyId;
  const p = params(raw);
  try {
    if (name === TOOL_NAMES.askOwner) {
      const result = await askOwner(env, run, p);
      return toolOk(`${result.status === "updated" ? "Updated the question" : "Asked the owner"} on ${result.identifier ?? result.issueId}. ${result.next}`, result) as ToolResult;
    }
    if (name === TOOL_NAMES.profile) {
      const company = await env.ctx.companies.get(companyId).catch(() => null);
      const summary = profileSummary(await readProfile(env.ctx, companyId), (href) => linkFor(href, company?.issuePrefix ?? null), company?.name ?? null);
      const history = await readProfileHistory(env.ctx, companyId);
      const old = history.slice(0, 5).map((h) => `${profileField(h.field)?.label ?? h.field} was \"${shown(h.previous)}\" (changed ${h.at.slice(0, 10)}${h.issueId ? ` on ${h.issueId}` : ""})`).join("; ");
      return toolOk(history.length ? `${summary.content} Earlier values, newest first: ${old}.` : summary.content, { ...summary.data, history }) as ToolResult;
    }
    if (name === TOOL_NAMES.updateProfile) {
      const input = Object.fromEntries(Object.entries(p).filter(([key]) => key !== "issueId"));
      if (Object.keys(input).length === 0) return toolFail("Pass at least one field to fill, e.g. {website: \"https://example.co.za\"}.") as ToolResult;
      const result = await fillProfile(env.ctx, companyId, input, run.agentId ?? null, env.now().toISOString(), typeof p.issueId === "string" ? p.issueId : null);
      const parts: string[] = [];
      const overwrittenKeys = (result.overwritten ?? []).map((o) => o.field);
      const filledNew = result.filled.filter((k) => !overwrittenKeys.includes(k));
      if (filledNew.length) parts.push(`Filled ${fieldLabels(filledNew)}.`);
      if (result.overwritten?.length) parts.push(`Overwrote (old value kept in history, so it can be reverted): ${result.overwritten.map((o) => `${profileField(o.field)?.label ?? o.field} was \"${shown(o.previous)}\"`).join("; ")}.`);
      if (result.unchanged.length) parts.push(`Already the same: ${fieldLabels(result.unchanged)}.`);
      if (result.kept.length) parts.push(`Kept as they are (already set; only PiB (the CEO seat) changes a set value: ask PiB in an issue and quote the new value): ${result.kept.map((k) => `${profileField(k.field)?.label ?? k.field} is "${shown(k.current)}"`).join("; ")}.`);
      if (result.invalid.length) parts.push(`Not saved: ${result.invalid.map((i) => i.error).join(" ")}`);
      const data = { filled: result.filled, unchanged: result.unchanged, kept: result.kept, invalid: result.invalid, profile: result.profile };
      if (!result.filled.length && !result.unchanged.length && !result.kept.length) return toolFail(parts.join(" ") || "Nothing to fill.") as ToolResult;
      return toolOk(parts.join(" "), data) as ToolResult;
    }
    return toolFail(`Unknown tool ${name}`) as ToolResult;
  } catch (error) {
    if (error instanceof AskError || error instanceof ProfileError) return toolFail(error.message) as ToolResult;
    env.ctx.logger.info("Cockpit tool failed", { name, error: message(error) });
    return toolFail(`${name} failed: ${message(error)}`) as ToolResult;
  }
}
