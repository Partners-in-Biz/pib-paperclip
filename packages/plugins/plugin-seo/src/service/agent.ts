/**
 * The managed SEO Specialist agent, the SEO project, and the routines.
 *
 * `permissions.pluginTools` is not enforced by the host and the tool gateway
 * denies by default, so activation also merges a `tools:use` grant for plugin
 * tools into the agent's existing grants (`grants.set` replaces the whole set).
 */
import { AGENT_KEY, PROJECT_KEY, ROUTINE_KEYS } from "../constants.js";
import * as db from "../db.js";
import type { AgentAvailability } from "../engine/sprint.js";
import { assignableUser, errorMessage, SeoError, type Actor, type Env } from "./common.js";
import { getIssue, patchIssue } from "./issues.js";
import { wakeIssue } from "@partnersinbiz/pib-plugin-kit";

export const PLUGIN_TOOLS_GRANT = { permissionKey: "tools:use", scope: { providerType: "paperclip_plugin" } } as const;

type GrantInput = { permissionKey: string; scope?: Record<string, unknown> | null };

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Existing grants plus the plugin-tools grant, without duplicates. */
export function mergeGrants(existing: GrantInput[], add: GrantInput): { grants: GrantInput[]; added: boolean } {
  const key = (g: GrantInput) => `${g.permissionKey}|${stable(g.scope ?? null)}`;
  const seen = new Set<string>();
  const grants: GrantInput[] = [];
  for (const g of existing) {
    const k = key(g);
    if (seen.has(k)) continue;
    seen.add(k);
    grants.push({ permissionKey: g.permissionKey, scope: g.scope ?? null });
  }
  const addKey = key(add);
  if (seen.has(addKey)) return { grants, added: false };
  grants.push({ permissionKey: add.permissionKey, scope: add.scope ?? null });
  return { grants, added: true };
}

/** Resolve (never create) the managed agent. Jobs call this with an explicit company. */
export async function resolveAgent(env: Env, companyId: string): Promise<AgentAvailability> {
  try {
    const resolved = await env.ctx.agents.managed.get(AGENT_KEY, companyId);
    if (!resolved.agentId || !resolved.agent) return null;
    return { id: resolved.agentId, status: String(resolved.agent.status) };
  } catch (error) {
    env.ctx.logger.info("SEO agent lookup failed", { companyId, error: errorMessage(error) });
    return null;
  }
}

export async function ensureProject(env: Env, companyId: string): Promise<string | null> {
  try {
    const resolved = await env.ctx.projects.managed.reconcile(PROJECT_KEY, companyId);
    return resolved.projectId ?? null;
  } catch (error) {
    env.ctx.logger.info("SEO project reconcile failed", { companyId, error: errorMessage(error) });
    return null;
  }
}

export interface ActivationResult {
  agent: { id: string | null; name: string | null; status: string | null; resolution: string; approvalId: string | null };
  project: { id: string | null; status: string };
  routines: Array<{ key: string; id: string | null; status: string; routineStatus: string | null }>;
  grant: "added" | "already_present" | "failed";
  grantError?: string;
  adoptedIssues: number;
  skills: Array<{ skillKey: string; action: string; error?: string }>;
  instructions: string[];
}

export async function activateAgent(env: Env, companyId: string, actor: Actor): Promise<ActivationResult> {
  if (actor.kind !== "user") throw new SeoError("Only a board user can activate the SEO agent");
  const skills = await env.skills.force(companyId);
  const agentRes = await env.ctx.agents.managed.reconcile(AGENT_KEY, companyId);
  const projectRes = await env.ctx.projects.managed.reconcile(PROJECT_KEY, companyId);
  const routines: ActivationResult["routines"] = [];
  for (const key of ROUTINE_KEYS) {
    try {
      const r = await env.ctx.routines.managed.reconcile(key, companyId, {
        assigneeAgentId: agentRes.agentId,
        projectId: projectRes.projectId,
      });
      routines.push({ key, id: r.routineId, status: r.status, routineStatus: r.routine ? String(r.routine.status) : null });
    } catch (error) {
      routines.push({ key, id: null, status: `failed: ${errorMessage(error)}`, routineStatus: null });
    }
  }

  let grant: ActivationResult["grant"] = "failed";
  let grantError: string | undefined;
  if (agentRes.agentId) {
    try {
      const existing = await env.ctx.authorization.grants.list({ companyId, principalType: "agent", principalId: agentRes.agentId });
      const merged = mergeGrants(
        existing.map((g) => ({ permissionKey: String(g.permissionKey), scope: (g.scope as Record<string, unknown> | null) ?? null })),
        PLUGIN_TOOLS_GRANT,
      );
      if (merged.added) {
        await env.ctx.authorization.grants.set({
          companyId,
          principalType: "agent",
          principalId: agentRes.agentId,
          grants: merged.grants as Parameters<Env["ctx"]["authorization"]["grants"]["set"]>[0]["grants"],
          grantedByUserId: assignableUser(actor.userId),
        });
        grant = "added";
      } else {
        grant = "already_present";
      }
    } catch (error) {
      grantError = errorMessage(error);
    }
  }

  let adopted = 0;
  if (agentRes.agentId) {
    await db.setAgentForCompany(env.ctx.db, companyId, agentRes.agentId);
    adopted = await adoptUnassignedAgentTasks(env, companyId, { id: agentRes.agentId, status: String(agentRes.agent?.status ?? "") });
  }

  const status = agentRes.agent ? String(agentRes.agent.status) : null;
  const instructions: string[] = [];
  if (status === "pending_approval" || agentRes.approvalId) {
    instructions.push("Approve the SEO Specialist hire in Approvals (this company requires board approval for new agents).");
  }
  if (status === "paused" || status === "pending_approval") {
    instructions.push("Open Agents → SEO Specialist, check its adapter has a working model key, then click Resume.");
  }
  instructions.push(
    "Open Routines → \"Run today's SEO\" and \"Weekly SEO review\": set each routine active and enable its schedule trigger (they are created paused with triggers off).",
  );
  if (grant === "failed") instructions.push(`Tool access could not be granted automatically (${grantError ?? "no agent"}). Grant the agent tools:use for plugin tools in its permissions.`);
  return {
    agent: { id: agentRes.agentId, name: agentRes.agent ? String(agentRes.agent.name) : null, status, resolution: agentRes.status, approvalId: agentRes.approvalId ?? null },
    project: { id: projectRes.projectId, status: projectRes.status },
    routines,
    grant,
    ...(grantError ? { grantError } : {}),
    adoptedIssues: adopted,
    skills: skills.map((s) => ({ skillKey: s.skillKey, action: s.action, ...(s.error ? { error: s.error } : {}) })),
    instructions,
  };
}

/** Hand agent-owned issues that were created before the agent existed to the agent. */
export async function adoptUnassignedAgentTasks(env: Env, companyId: string, agent: { id: string; status: string }): Promise<number> {
  const sprints = await db.listSprints(env.ctx.db, companyId);
  let adopted = 0;
  for (const sprint of sprints) {
    if (sprint.autopilotMode === "off" || sprint.status === "archived") continue;
    const tasks = await db.listTasks(env.ctx.db, companyId, sprint.id, { status: ["not_started", "in_progress"], owner: "agent" });
    for (const task of tasks) {
      if (!task.issueId || task.assigneeKind !== "unassigned") continue;
      const issue = await getIssue(env, companyId, task.issueId);
      if (!issue || issue.assigneeAgentId || issue.assigneeUserId || !["todo", "backlog"].includes(String(issue.status))) continue;
      const updated = await patchIssue(env, companyId, task.issueId, { assigneeAgentId: agent.id, status: "todo" });
      if (!updated) continue;
      await db.updateTask(env.ctx.db, companyId, task.id, { assignee_kind: "agent" });
      if (!["paused", "pending_approval", "terminated"].includes(agent.status)) {
        await wakeIssue(env.ctx, task.issueId, companyId, "SEO task assigned to the SEO Specialist");
      }
      adopted += 1;
    }
  }
  return adopted;
}
