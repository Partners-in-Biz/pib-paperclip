/**
 * Thin, failure-tolerant wrappers over the Paperclip issues API. Every call
 * names the company explicitly so they work from jobs too.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createWorkIssue } from "@partnersinbiz/pib-plugin-kit";
import { isRehearsalSprint, REHEARSAL_REFUSAL, type RehearsalSubject } from "../engine/rehearsal.js";
import { capComment, commentFingerprint, isRepeatNotice, rememberNotice, type CommentMemory } from "../engine/thread.js";
import type { Env } from "./common.js";
import { errorMessage, SeoError } from "./common.js";

type CreateInput = Parameters<PluginContext["issues"]["create"]>[0];
type Issue = Awaited<ReturnType<PluginContext["issues"]["create"]>>;
type UpdatePatch = Parameters<PluginContext["issues"]["update"]>[1];

export interface OpenIssueInput {
  companyId: string;
  /**
   * The sprint the issue is for. Required so no path can forget the rehearsal rule: a rehearsal sprint (a fixture site or the
   * canary client, engine/rehearsal.ts) never gets an issue. Each path checks first and skips quietly; this is the net under them.
   */
  sprint: RehearsalSubject;
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
  /** Share this issue's checkout / worktree (a follow-up that carries on the same work). */
  inheritWorkspaceFromIssueId?: string;
}

/**
 * Create a `todo` issue and wake an assigned agent (plugin-created issues do
 * not wake anyone on their own). If the user assignee or the parent is
 * rejected, retry without it rather than losing the task. Refuses (SeoError, nothing created) for a rehearsal sprint.
 */
export async function openIssue(env: Env, input: OpenIssueInput): Promise<{ id: string; woke: boolean; assigned: "agent" | "user" | "none" }> {
  if (isRehearsalSprint(input.sprint)) throw new SeoError(`${REHEARSAL_REFUSAL} (not opened: ${input.title.slice(0, 80)})`);
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
    ...(input.inheritWorkspaceFromIssueId ? { inheritExecutionWorkspaceFromIssueId: input.inheritWorkspaceFromIssueId } : {}),
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

export interface CommentOptions {
  /** Longest the comment may be (default COMMENT_MAX). */
  max?: number;
  /** Where the full text lives, said in the notice when the comment is cut. */
  pointer?: string;
  /** Post this notice once per key on the issue (a round-by-round notice that would otherwise repeat). */
  dedupeKey?: string;
}

function memoryKey(companyId: string, issueId: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: "seo-comments", stateKey: issueId };
}

/**
 * Post a comment as the plugin. Every comment is capped (engine/thread.ts: threads that grow past ~80 KB cannot be
 * handed to an agent) and the same notice is not posted twice in a row on one issue. Returns true when the comment
 * is on the issue, including when an identical one already was; false when the host refused it.
 */
export async function commentOn(env: Env, companyId: string, issueId: string, body: string, opts: CommentOptions = {}): Promise<boolean> {
  const text = capComment(body, { max: opts.max, pointer: opts.pointer });
  const hash = commentFingerprint(text);
  let memory: CommentMemory | null = null;
  try {
    memory = ((await env.ctx.state.get(memoryKey(companyId, issueId))) as CommentMemory | null) ?? null;
  } catch {
    memory = null;
  }
  if (isRepeatNotice(memory, { hash, key: opts.dedupeKey, now: env.now().getTime() })) return true;
  try {
    await env.ctx.issues.createComment(issueId, text, companyId);
  } catch (error) {
    env.ctx.logger.info("SEO issue comment failed", { issueId, error: errorMessage(error) });
    return false;
  }
  try {
    await env.ctx.state.set(memoryKey(companyId, issueId), rememberNotice(memory, { hash, key: opts.dedupeKey, at: env.now().toISOString() }));
  } catch {
    // The memory only spares a repeat; the comment is already posted.
  }
  return true;
}

export const OPEN_ISSUE_STATUSES = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);
