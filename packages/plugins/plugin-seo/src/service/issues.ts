/**
 * Thin, failure-tolerant wrappers over the Paperclip issues API. Every call
 * names the company explicitly so they work from jobs too.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createWorkIssue } from "@partnersinbiz/pib-plugin-kit";
import type { Env } from "./common.js";
import { errorMessage } from "./common.js";

type CreateInput = Parameters<PluginContext["issues"]["create"]>[0];
type Issue = Awaited<ReturnType<PluginContext["issues"]["create"]>>;
type UpdatePatch = Parameters<PluginContext["issues"]["update"]>[1];

export interface OpenIssueInput {
  companyId: string;
  title: string;
  description: string;
  originKind: `plugin:${string}`;
  originId: string;
  projectId?: string | null;
  parentId?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  priority?: CreateInput["priority"];
  wake?: boolean;
  wakeReason?: string;
}

/**
 * Create a `todo` issue and wake an assigned agent (plugin-created issues do
 * not wake anyone on their own). If the user assignee or the parent is
 * rejected, retry without it rather than losing the task.
 */
export async function openIssue(env: Env, input: OpenIssueInput): Promise<{ id: string; woke: boolean; assigned: "agent" | "user" | "none" }> {
  const base: CreateInput & { wake?: boolean; wakeReason?: string } = {
    companyId: input.companyId,
    title: input.title.slice(0, 250),
    description: input.description,
    status: "todo",
    originKind: input.originKind,
    originId: input.originId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.parentId ? { parentId: input.parentId } : {}),
    ...(input.priority ? { priority: input.priority } : {}),
    wake: input.wake ?? Boolean(input.assigneeAgentId),
    wakeReason: input.wakeReason,
  };
  const attempts: Array<{ patch: Partial<CreateInput>; assigned: "agent" | "user" | "none" }> = [];
  if (input.assigneeAgentId) attempts.push({ patch: { assigneeAgentId: input.assigneeAgentId }, assigned: "agent" });
  else if (input.assigneeUserId) attempts.push({ patch: { assigneeUserId: input.assigneeUserId }, assigned: "user" });
  attempts.push({ patch: {}, assigned: "none" });
  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      const created = await createWorkIssue(env.ctx, { ...base, ...attempt.patch, wake: attempt.assigned === "agent" ? base.wake : false });
      return { id: created.id, woke: created.woke, assigned: attempt.assigned };
    } catch (error) {
      lastError = error;
      env.ctx.logger.info("SEO issue create retry", { title: input.title, assigned: attempt.assigned, error: errorMessage(error) });
    }
  }
  if (input.parentId) {
    const created = await createWorkIssue(env.ctx, { ...base, parentId: undefined, wake: false });
    return { id: created.id, woke: false, assigned: "none" };
  }
  throw lastError instanceof Error ? lastError : new Error(errorMessage(lastError));
}

export async function getIssue(env: Env, companyId: string, issueId: string): Promise<Issue | null> {
  try {
    return await env.ctx.issues.get(issueId, companyId);
  } catch (error) {
    env.ctx.logger.info("SEO issue read failed", { issueId, error: errorMessage(error) });
    return null;
  }
}

export async function patchIssue(env: Env, companyId: string, issueId: string, patch: UpdatePatch): Promise<Issue | null> {
  try {
    return await env.ctx.issues.update(issueId, patch, companyId);
  } catch (error) {
    env.ctx.logger.info("SEO issue update failed", { issueId, error: errorMessage(error) });
    return null;
  }
}

export async function commentOn(env: Env, companyId: string, issueId: string, body: string): Promise<boolean> {
  try {
    await env.ctx.issues.createComment(issueId, body, companyId);
    return true;
  } catch (error) {
    env.ctx.logger.info("SEO issue comment failed", { issueId, error: errorMessage(error) });
    return false;
  }
}

export const OPEN_ISSUE_STATUSES = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);
