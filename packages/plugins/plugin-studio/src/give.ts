/**
 * Give a Studio file to an agent: a person picks an agent that can run, writes what it should do, and Studio opens a
 * normal issue assigned to that agent with the instruction as written, linked to the asset.
 *
 * The agent can't use `studio-get-asset` (installing a plugin grants nobody its tools) and never gets a signed link,
 * and the plugin SDK can't attach files to issues. So the worker writes a copy on this server and puts its path in the
 * issue. Only agents that run as local processes here can read it; the others are shown, with the reason, and refused.
 * Giving grants no tools and spends no credits.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sameClient, scopeOfRow } from "@partnersinbiz/pib-plugin-kit";
import { addLink, getAssetRow } from "./assets.js";
import { StudioConfig } from "./config.js";
import { num } from "./db.js";
import { errorText, StudioError } from "./errors.js";
import { clientOfProject } from "./scope.js";
import { canGenerate } from "./service.js";
import { assertOwnKey, extFor, getObject, GIVEN_KEEP_DAYS, givenCopy } from "./storage.js";

/** Statuses an agent can be woken from. Paused, terminated and pending-approval agents are never offered. */
export const RUNNABLE_STATUSES = ["active", "idle", "running", "error"] as const;

/** Adapters that run as a process on this server, as the same user as the worker, so they can read the copy. */
export const LOCAL_ADAPTERS = ["process", "claude_local", "codex_local", "gemini_local", "grok_local", "hermes_local", "kimi_local", "opencode_local", "pi_local", "acpx_local"] as const;

export const MAX_INSTRUCTION = 10_000;

interface AgentLike {
  id: string;
  name: string;
  title?: string | null;
  status: string;
  adapterType: string;
}

export interface AgentChoice {
  id: string;
  name: string;
  title: string | null;
  status: string;
  adapterType: string;
  canRun: boolean;
  canOpen: boolean;
  /** Why this agent can't take the file, or null when it can. */
  why: string | null;
}

export function agentChoice(agent: AgentLike): AgentChoice {
  const canRun = (RUNNABLE_STATUSES as readonly string[]).includes(agent.status);
  const canOpen = (LOCAL_ADAPTERS as readonly string[]).includes(agent.adapterType);
  const why = !canRun
    ? `${agent.name} is ${agent.status.replace(/_/g, " ")}, so it can't run.`
    : !canOpen
      ? `${agent.name} runs off this server (${agent.adapterType}), so it can't open Studio files.`
      : null;
  return { id: agent.id, name: agent.name, title: agent.title ?? null, status: agent.status, adapterType: agent.adapterType, canRun, canOpen, why };
}

/** Agents a person may pick: only ones that can run; those that can open the file first, then by name. */
export async function giveChoices(ctx: PluginContext, companyId: string): Promise<AgentChoice[]> {
  const agents = (await ctx.agents.list({ companyId, limit: 500 })) as unknown as AgentLike[];
  return agents
    .map(agentChoice)
    .filter((a) => a.canRun)
    .sort((a, b) => Number(b.canOpen) - Number(a.canOpen) || a.name.localeCompare(b.name));
}

function firstLine(text: string, max: number): string {
  const line = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export function giveTitle(assetName: string, instruction: string): string {
  return `Studio: ${firstLine(instruction, 80) || assetName}`;
}

export function giveDescription(instruction: string, file: { name: string; mime: string; bytes: number; version: number; assetId: string; client: string; path: string }): string {
  return [
    instruction,
    "",
    "---",
    "**Studio file**, given to you from Studio by a person.",
    "",
    `- File: ${file.name} (${file.mime}, ${Math.max(1, Math.round(file.bytes / 1024))} KB, version ${file.version})`,
    `- Studio asset id: \`${file.assetId}\``,
    `- Client: ${file.client}`,
    `- Path on this server (kept ${GIVEN_KEEP_DAYS} days): \`${file.path}\``,
    "",
    "Open the file at that path with your file tools. When you're done, comment on this issue with what you did.",
  ].join("\n");
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The page's Give to agent action. Every check runs here, not only on the page. */
export async function giveAsset(ctx: PluginContext, companyId: string, params: Record<string, unknown>, giver: { userId: string; role: string | null }) {
  if (!canGenerate(giver.role)) throw new StudioError("Viewers can look at Studio but can't give files to agents.", "forbidden");
  const assetId = text(params.assetId);
  const agentId = text(params.agentId);
  // The instruction goes into the issue as written: only checked, never trimmed or rewritten.
  const instruction = typeof params.instruction === "string" ? params.instruction : "";
  if (!assetId || !agentId) throw new StudioError("assetId and agentId are required.", "bad_give");
  if (!instruction.trim()) throw new StudioError("Write what the agent should do with the file.", "bad_give");
  if (instruction.length > MAX_INSTRUCTION) throw new StudioError(`The instruction is ${instruction.length} characters; keep it under ${MAX_INSTRUCTION}.`, "bad_give");

  const row = await getAssetRow(ctx, companyId, assetId);
  // A client's file only goes on that client's work: the issue lands in the asset's project, which must be theirs.
  const scope = scopeOfRow(row);
  const owner = await clientOfProject(ctx, companyId, row.project_id);
  if (scope && (!owner || !sameClient(scope, { kind: owner.kind, id: owner.id }))) {
    throw new StudioError(`This is ${row.client_name ?? "a client"}'s file and it isn't in one of their projects, so Studio can't put it on a task. A client's file only goes on that client's work.`, "wrong_client");
  }
  if (!scope && owner) throw new StudioError(`This file is own work but sits in ${owner.name}'s project, so Studio can't put it on a task.`, "wrong_client");

  const agent = (await ctx.agents.get(agentId, companyId).catch(() => null)) as unknown as AgentLike | null;
  if (!agent) throw new StudioError("That agent isn't in this company.", "unknown_agent");
  const choice = agentChoice(agent);
  if (choice.why) throw new StudioError(choice.why, choice.canRun ? "agent_cant_open" : "agent_cant_run");

  assertOwnKey(companyId, row.r2_key);
  const bucket = await new StudioConfig(ctx, companyId).bucket();
  const version = num(row.current_version);
  const path = await givenCopy(companyId, randomUUID(), row.id, version, extFor(row.mime), await getObject(bucket, companyId, row.r2_key));

  const issue = await ctx.issues.create({
    companyId,
    title: giveTitle(row.name, instruction),
    description: giveDescription(instruction, { name: row.name, mime: row.mime, bytes: num(row.bytes), version, assetId: row.id, client: row.client_name ?? "Own work", path }),
    projectId: row.project_id ?? undefined,
    assigneeAgentId: agent.id,
    status: "todo",
    priority: "medium",
    originId: row.id,
    actor: { actorUserId: giver.userId },
  });
  await addLink(ctx, companyId, row.id, "issue", issue.id);

  // The host doesn't wake an agent on a plugin-created issue, so ask once. A refused wake (budget) keeps the issue.
  let woken = false;
  let wakeError: string | null = null;
  try {
    const out = await ctx.issues.requestWakeup(issue.id, companyId, { reason: "studio_give", contextSource: "studio_give", idempotencyKey: `studio-give:${issue.id}`, actorUserId: giver.userId });
    woken = (out as { queued?: boolean } | null)?.queued !== false;
  } catch (error) {
    wakeError = errorText(error);
    ctx.logger.warn("Studio give: wake refused", { issueId: issue.id, error: wakeError });
  }
  return {
    issueId: String(issue.id),
    identifier: (issue as { identifier?: string | null }).identifier ?? null,
    title: issue.title,
    agent: { id: agent.id, name: agent.name },
    woken,
    wakeError,
  };
}

/** The issues this asset was given to (Studio-made, with this asset as origin), newest last, for the asset detail. */
export async function givenIssues(ctx: PluginContext, companyId: string, assetId: string, issueIds: string[]) {
  const out: Array<{ id: string; identifier: string | null; title: string | null; status: string | null; agentName: string | null }> = [];
  for (const id of [...new Set(issueIds)].slice(-20)) {
    const issue = (await ctx.issues.get(id, companyId).catch(() => null)) as
      | { id: string; identifier?: string | null; title?: string | null; status?: string | null; originKind?: string | null; originId?: string | null; assigneeAgentId?: string | null }
      | null;
    if (!issue || issue.originId !== assetId || !String(issue.originKind ?? "").startsWith("plugin:")) continue;
    const agent = issue.assigneeAgentId ? ((await ctx.agents.get(issue.assigneeAgentId, companyId).catch(() => null)) as { name?: string } | null) : null;
    out.push({ id: String(issue.id), identifier: issue.identifier ?? null, title: issue.title ?? null, status: issue.status ?? null, agentName: agent?.name ?? null });
  }
  return out;
}
