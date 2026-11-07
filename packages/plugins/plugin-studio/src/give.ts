/**
 * Give a Studio file to an agent (PAR-8138): the page opens the host's New Task popup, prefilled from the asset, and the
 * person edits it, picks the agent and sends. Nothing is created until they send.
 *
 * The agent can't use `studio-get-asset` (installing a plugin grants nobody its tools) and never gets a signed link,
 * and the plugin SDK can't attach files to issues. So `prepareGive` writes a copy on this server and puts its path in
 * the prefill; `recordGive` links the created issue to the asset; `discardGive` removes the copy when the popup closes
 * without a task. The copy exists before the issue does, so the agent the host wakes on create always finds it.
 * The prompt is received text: it goes in the kit's fenced block, never as instructions. Giving spends no credits.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sameClient, scopeOfRow } from "@partnersinbiz/pib-plugin-kit";
import { buildHandoffDescription, handoffTitle } from "@partnersinbiz/pib-plugin-kit/handoff";
import { addLink, getAssetRow } from "./assets.js";
import { StudioConfig } from "./config.js";
import { num, table } from "./db.js";
import { StudioError } from "./errors.js";
import { clientOfProject } from "./scope.js";
import { canGenerate } from "./service.js";
import { assertOwnKey, extFor, getObject, GIVEN_KEEP_DAYS, givenCopy, removeGivenCopy } from "./storage.js";

/** Statuses an agent can be woken from. */
export const RUNNABLE_STATUSES = ["active", "idle", "running", "error"] as const;

/** Adapters that run as a process on this server, as the same user as the worker, so they can read the copy. */
export const LOCAL_ADAPTERS = ["process", "claude_local", "codex_local", "gemini_local", "grok_local", "hermes_local", "kimi_local", "opencode_local", "pi_local", "acpx_local"] as const;

/** The kind line of the hand-off; with the asset id it marks an issue as given from Studio. */
export const GIVE_KIND = "Studio file";
const GIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

export function giveTitle(assetName: string): string {
  return handoffTitle("Studio: ", assetName, "file");
}

export interface GiveFile {
  name: string;
  kind: string;
  mime: string;
  bytes: number;
  version: number;
  assetId: string;
  status: string;
  client: string;
  project: string | null;
  /** Null when the file was imported, not generated. */
  generation: { model: string; prompt: string; credits: number } | null;
  path: string;
}

/** The popup's description: a line for the person's words, the asset's facts and prompt as fenced data, then the path. */
export function giveDescription(file: GiveFile): string {
  const gen = file.generation;
  return buildHandoffDescription({
    source: {
      kind: GIVE_KIND,
      meta: [
        ["Name", file.name],
        ["Kind", file.kind],
        ["Made", gen ? `Generated with ${gen.model}` : "Imported (not generated)"],
        ["Status", file.status],
        ["Cost", gen ? `${gen.credits} credits` : "None (imported)"],
        ["Client", file.client],
        ["Project", file.project ?? "None"],
        ["File", `${file.mime}, ${Math.max(1, Math.round(file.bytes / 1024))} KB, version ${file.version}`],
        ["Studio asset id", file.assetId],
        ["Prompt", gen ? "in the block below" : "none (imported)"],
      ],
    },
    receivedText: gen ? gen.prompt : "(Imported, so there is no prompt.)",
    readMore: "the Studio library (asset id above)",
    extra: [
      `File on this server (kept ${GIVEN_KEEP_DAYS} days): \`${file.path}\``,
      "",
      "Open the file at that path with your file tools. Only agents that run on this server can open it.",
    ],
    footer: ["When you're done, comment on this issue with what you did."],
  });
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function giveId(params: Record<string, unknown>): string {
  const id = text(params.giveId).toLowerCase();
  if (!GIVE_ID.test(id)) throw new StudioError("giveId is missing or not valid.", "bad_give");
  return id;
}

type Giver = { userId: string; role: string | null };
type Row = Awaited<ReturnType<typeof getAssetRow>>;

/** A client's file only goes on that client's work: the project must be theirs; own work never goes in a client's. */
async function assertProjectFits(ctx: PluginContext, companyId: string, row: Row, projectId: string | null) {
  const scope = scopeOfRow(row);
  const owner = await clientOfProject(ctx, companyId, projectId);
  if (scope && (!owner || !sameClient(scope, { kind: owner.kind, id: owner.id }))) {
    throw new StudioError(`This is ${row.client_name ?? "a client"}'s file and the task isn't in one of their projects. A client's file only goes on that client's work.`, "wrong_client");
  }
  if (!scope && owner) throw new StudioError(`This file is own work and the task is in ${owner.name}'s project.`, "wrong_client");
}

async function checkedRow(ctx: PluginContext, companyId: string, params: Record<string, unknown>, giver: Giver): Promise<Row> {
  if (!canGenerate(giver.role)) throw new StudioError("Viewers can look at Studio but can't give files to agents.", "forbidden");
  const assetId = text(params.assetId);
  if (!assetId) throw new StudioError("assetId is required.", "bad_give");
  return getAssetRow(ctx, companyId, assetId);
}

/** Step 1, on click: every check, a copy of the file, and the popup prefill. */
export async function prepareGive(ctx: PluginContext, companyId: string, params: Record<string, unknown>, giver: Giver) {
  const row = await checkedRow(ctx, companyId, params, giver);
  await assertProjectFits(ctx, companyId, row, row.project_id ?? null);

  let generation: GiveFile["generation"] = null;
  const generationId = (row as { generation_id?: string | null }).generation_id;
  if (generationId) {
    const [gen] = await ctx.db.query<{ model: string; prompt: string | null; estimated_credits: unknown; actual_credits: unknown }>(
      `SELECT model, prompt, estimated_credits, actual_credits FROM ${table(ctx, "generations")} WHERE company_id = $1 AND id = $2`,
      [companyId, generationId],
    );
    if (gen) generation = { model: gen.model, prompt: gen.prompt ?? "", credits: num(gen.actual_credits ?? gen.estimated_credits) };
  }
  const project = row.project_id ? ((await ctx.projects.get(row.project_id, companyId).catch(() => null)) as { name?: string } | null) : null;

  assertOwnKey(companyId, row.r2_key);
  const bucket = await new StudioConfig(ctx, companyId).bucket();
  const version = num(row.current_version);
  const id = randomUUID();
  const path = await givenCopy(companyId, id, row.id, version, extFor(row.mime), await getObject(bucket, companyId, row.r2_key));
  const extra = row as { kind?: string | null; status?: string | null };
  return {
    giveId: id,
    title: giveTitle(row.name),
    description: giveDescription({
      name: row.name,
      kind: String(extra.kind ?? ""),
      mime: row.mime,
      bytes: num(row.bytes),
      version,
      assetId: row.id,
      status: String(extra.status ?? ""),
      client: row.client_name ?? "Own work",
      project: project?.name ?? (row.project_id ? "Unknown project" : null),
      generation,
      path,
    }),
    projectId: row.project_id ?? null,
  };
}

/** The popup closed without a task: remove the copy so nothing is left behind. */
export async function discardGive(ctx: PluginContext, companyId: string, params: Record<string, unknown>, giver: Giver) {
  const row = await checkedRow(ctx, companyId, params, giver);
  return { removed: await removeGivenCopy(companyId, row.id, giveId(params)) };
}

/** Step 2, after the host created the task: re-check the client on the real issue, then link it to the asset. */
export async function recordGive(ctx: PluginContext, companyId: string, params: Record<string, unknown>, giver: Giver) {
  const row = await checkedRow(ctx, companyId, params, giver);
  const id = giveId(params);
  const issueId = text(params.issueId);
  if (!issueId) throw new StudioError("issueId is required.", "bad_give");
  const issue = (await ctx.issues.get(issueId, companyId).catch(() => null)) as
    | { id: string; identifier?: string | null; title?: string | null; description?: string | null; projectId?: string | null; assigneeAgentId?: string | null }
    | null;
  if (!issue) throw new StudioError("That task isn't in this company.", "unknown_issue");
  const name = issue.identifier ?? issue.title ?? "The task";
  try {
    await assertProjectFits(ctx, companyId, row, issue.projectId ?? null);
  } catch (error) {
    // The person moved the task to a project this file can't go on: take the file back and don't link it.
    await removeGivenCopy(companyId, row.id, id);
    throw new StudioError(`${name} was created, but: ${(error as Error).message} Studio removed the file copy and didn't link it.`, "wrong_client");
  }
  await addLink(ctx, companyId, row.id, "issue", String(issue.id));

  const warnings: string[] = [];
  if (!String(issue.description ?? "").includes(id)) {
    await removeGivenCopy(companyId, row.id, id);
    warnings.push("The file path was taken out of the task, so the agent can't open the file. Give it again to add one.");
  }
  if (!issue.assigneeAgentId) {
    warnings.push("No agent is assigned yet. Assign one that runs on this server.");
  } else {
    const agent = (await ctx.agents.get(issue.assigneeAgentId, companyId).catch(() => null)) as unknown as AgentLike | null;
    const why = agent ? agentChoice(agent).why : null;
    if (why) warnings.push(why);
  }
  return { message: `Given: ${name}.`, warning: warnings.length ? warnings.join(" ") : null };
}

/** The issues this asset was given to, newest last, for the asset detail. */
export async function givenIssues(ctx: PluginContext, companyId: string, assetId: string, issueIds: string[]) {
  const out: Array<{ id: string; identifier: string | null; title: string | null; status: string | null; agentName: string | null }> = [];
  for (const id of [...new Set(issueIds)].slice(-20)) {
    const issue = (await ctx.issues.get(id, companyId).catch(() => null)) as
      | { id: string; identifier?: string | null; title?: string | null; status?: string | null; description?: string | null; originKind?: string | null; originId?: string | null; assigneeAgentId?: string | null }
      | null;
    if (!issue) continue;
    // Old gives: Studio made the issue with this asset as origin. New gives: the host made it from Studio's hand-off text.
    const oldGive = issue.originId === assetId && String(issue.originKind ?? "").startsWith("plugin:");
    const description = String(issue.description ?? "");
    const newGive = description.includes(`**${GIVE_KIND}**`) && description.includes(assetId);
    if (!oldGive && !newGive) continue;
    const agent = issue.assigneeAgentId ? ((await ctx.agents.get(issue.assigneeAgentId, companyId).catch(() => null)) as { name?: string } | null) : null;
    out.push({ id: String(issue.id), identifier: issue.identifier ?? null, title: issue.title ?? null, status: issue.status ?? null, agentName: agent?.name ?? null });
  }
  return out;
}
