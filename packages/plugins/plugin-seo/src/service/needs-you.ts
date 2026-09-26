/**
 * "Needs you" digest service: one issue per sprint per week (assigned to the
 * sprint owner) listing the few things only a person can do. Items dedupe by
 * key, close on their own when the plugin can check them, and resolving one
 * hands the waiting tasks back to the SEO agent.
 */
import { randomUUID } from "node:crypto";
import { ORIGIN } from "../constants.js";
import * as db from "../db.js";
import {
  carryOver,
  mergeItem,
  needsYouDescription,
  needsYouTitle,
  openItems,
  resolveItem,
  weekStart,
  type NeedsYouItem,
  type NewNeedsYouItem,
} from "../engine/needs-you.js";
import { TERMINAL_TASK_STATUSES } from "../engine/sprint.js";
import { resolveAgent } from "./agent.js";
import {
  actorLabel,
  assignableUser,
  bool,
  cockpitPath,
  companyInfo,
  errorMessage,
  reqStr,
  SeoError,
  str,
  strList,
  type Actor,
  type CompanyInfo,
  type Env,
  type Params,
} from "./common.js";
import { requireSprint, sprintCopy } from "./context.js";
import { loadServiceAccount } from "./google-access.js";
import { bingKeyItem, githubTokenItem, linkSiteItem, serviceAccountItem } from "../engine/items.js";
import { settingsPath } from "./settings-path.js";
import { commentOn, getIssue, OPEN_ISSUE_STATUSES, openIssue, patchIssue } from "./issues.js";

const nowIso = (env: Env) => env.now().toISOString();

/**
 * This week's digest row. `read`: this week's, else last week's while it has
 * open items, else null. `write`: always this week's (created with last
 * week's open items). `rollover`: create this week's only when last week
 * still has open items (the daily run, so each week gets its own issue).
 */
async function currentDigest(env: Env, info: CompanyInfo, sprint: db.Sprint, mode: "read" | "write" | "rollover"): Promise<db.NeedsYouDigest | null> {
  const week = weekStart(info.today);
  const existing = await db.getNeedsYou(env.ctx.db, sprint.companyId, sprint.id, week);
  if (existing) return existing;
  const previous = await db.latestNeedsYouBefore(env.ctx.db, sprint.companyId, sprint.id, week);
  const carried = previous ? openItems(previous.items) : [];
  if (mode === "read") return carried.length > 0 ? previous : null;
  if (mode === "rollover" && carried.length === 0) return null;
  await db.upsertNeedsYou(env.ctx.db, { id: randomUUID(), companyId: sprint.companyId, sprintId: sprint.id, weekStart: week, items: carryOver([], carried), status: "open" });
  if (previous && previous.status === "open") {
    await db.upsertNeedsYou(env.ctx.db, { id: previous.id, companyId: sprint.companyId, sprintId: sprint.id, weekStart: previous.weekStart, items: previous.items, status: "done" });
    if (previous.issueId) {
      const old = await getIssue(env, sprint.companyId, previous.issueId);
      if (old && OPEN_ISSUE_STATUSES.has(String(old.status))) {
        await commentOn(env, sprint.companyId, previous.issueId, carried.length > 0 ? `${carried.length} open item(s) moved to this week's Needs you issue.` : "Nothing is open any more.");
        await patchIssue(env, sprint.companyId, previous.issueId, { status: "done" });
      }
    }
  }
  return db.getNeedsYou(env.ctx.db, sprint.companyId, sprint.id, week);
}

/** Create, update or close the digest issue to match its items. */
async function syncDigestIssue(env: Env, info: CompanyInfo, sprint: db.Sprint, digest: db.NeedsYouDigest): Promise<string | null> {
  const open = openItems(digest.items);
  const description = needsYouDescription(sprintCopy(sprint), digest.items, { week: digest.weekStart, cockpitPath: cockpitPath(info, sprint) });
  if (!digest.issueId) {
    if (open.length === 0) return null;
    try {
      const created = await openIssue(env, {
        companyId: sprint.companyId,
        title: needsYouTitle(sprint, digest.weekStart),
        description,
        originKind: ORIGIN.needsYou,
        originId: `${sprint.id}:${digest.weekStart}`,
        projectId: sprint.projectId,
        parentId: sprint.rootIssueId,
        assigneeUserId: assignableUser(sprint.ownerUserId),
        priority: "high",
        wake: false,
      });
      const issue = await getIssue(env, sprint.companyId, created.id);
      await db.setNeedsYouIssue(env.ctx.db, sprint.companyId, digest.id, created.id, issue?.identifier ?? null);
      return created.id;
    } catch (error) {
      env.ctx.logger.info("SEO needs-you issue not created", { sprintId: sprint.id, error: errorMessage(error) });
      return null;
    }
  }
  const issue = await getIssue(env, sprint.companyId, digest.issueId);
  const isOpen = issue ? OPEN_ISSUE_STATUSES.has(String(issue.status)) : false;
  if (open.length === 0) {
    await patchIssue(env, sprint.companyId, digest.issueId, { description, ...(isOpen ? { status: "done" } : {}) });
    if (isOpen) await commentOn(env, sprint.companyId, digest.issueId, "Every item is done. The SEO Specialist carries on.");
    await db.upsertNeedsYou(env.ctx.db, { ...digest, status: "done" });
  } else {
    await patchIssue(env, sprint.companyId, digest.issueId, { description, ...(issue && !isOpen ? { status: "todo" } : {}) });
    if (digest.status === "done") await db.upsertNeedsYou(env.ctx.db, { ...digest, status: "open" });
  }
  return digest.issueId;
}

/** Add (or update) one item on this week's digest. */
export async function addNeedsYou(env: Env, info: CompanyInfo, sprint: db.Sprint, item: NewNeedsYouItem, opts: { reopen?: boolean } = {}): Promise<{ issueId: string | null; added: boolean; key: string }> {
  const digest = await currentDigest(env, info, sprint, "write");
  if (!digest) return { issueId: null, added: false, key: item.key };
  const merged = mergeItem(digest.items, item, nowIso(env), opts);
  if (!merged.changed && digest.issueId) return { issueId: digest.issueId, added: false, key: item.key };
  const next = { ...digest, items: merged.items, status: "open" as const };
  await db.upsertNeedsYou(env.ctx.db, next);
  const issueId = await syncDigestIssue(env, info, sprint, next);
  if (merged.added && issueId && digest.issueId) {
    await commentOn(env, sprint.companyId, issueId, `New item: **${item.title}**. ${item.why}`);
  }
  return { issueId, added: merged.added, key: item.key };
}

/** Hand waiting tasks back: human tasks complete, agent tasks go back to the agent (todo + wake). */
async function continueTasks(env: Env, sprint: db.Sprint, taskIds: string[], by: string): Promise<number> {
  if (taskIds.length === 0) return 0;
  const agent = await resolveAgent(env, sprint.companyId);
  let resumed = 0;
  for (const taskId of taskIds) {
    const task = await db.getTask(env.ctx.db, sprint.companyId, taskId);
    if (!task || (TERMINAL_TASK_STATUSES as string[]).includes(task.status)) continue;
    if (task.owner === "human") {
      await db.updateTask(env.ctx.db, sprint.companyId, task.id, { status: "done", completed_at: nowIso(env), completed_by: by, blocker_reason: null });
      resumed += 1;
      continue;
    }
    if (!task.issueId) continue; // Not opened yet: the next materialise opens it.
    const patch = agent ? { status: "todo" as const, assigneeAgentId: agent.id, assigneeUserId: null } : { status: "todo" as const };
    const updated = await patchIssue(env, sprint.companyId, task.issueId, patch);
    if (!updated) continue;
    await db.updateTask(env.ctx.db, sprint.companyId, task.id, { status: "in_progress", blocker_reason: null, issue_status: "todo", assignee_kind: agent ? "agent" : task.assigneeKind });
    await commentOn(env, sprint.companyId, task.issueId, `What this task waited for is done (${by}). Back to the SEO Specialist.`);
    if (agent && !["paused", "pending_approval", "terminated"].includes(agent.status)) {
      try {
        await env.ctx.issues.requestWakeup(task.issueId, sprint.companyId, { reason: "SEO task unblocked", idempotencyKey: `wake:${task.issueId}:${Date.now()}` });
      } catch (error) {
        env.ctx.logger.info("SEO wake skipped", { issueId: task.issueId, error: errorMessage(error) });
      }
    }
    resumed += 1;
  }
  return resumed;
}

/** Whether the plugin itself can see the item done: true / false, or null when only a person can say. */
export async function checkNeedsYouItem(env: Env, info: CompanyInfo, sprint: db.Sprint, item: NeedsYouItem): Promise<boolean | null> {
  switch (item.check) {
    case "site_project":
      return sprint.siteAccess !== "unlinked";
    case "service_account": {
      const sa = await loadServiceAccount(info);
      return Boolean(sa.key) && !sa.error;
    }
    case "gsc_access": {
      const gsc = await db.getIntegration(env.ctx.db, sprint.companyId, sprint.id, "gsc");
      return Boolean(gsc?.propertyUrl) && gsc?.status === "connected";
    }
    case "bing_key":
      return Boolean(await info.loaded.secrets.get("bingApiKey").catch(() => undefined));
    case "task_done": {
      const ids = item.taskIds ?? [];
      if (ids.length === 0) return null;
      for (const id of ids) {
        const task = await db.getTask(env.ctx.db, sprint.companyId, id);
        if (task && !(TERMINAL_TASK_STATUSES as string[]).includes(task.status)) return false;
      }
      return true;
    }
    default:
      return null;
  }
}

/** Mark one item done (by a person, or the agent on a person's word) and carry on. */
export async function resolveNeedsYou(env: Env, info: CompanyInfo, sprint: db.Sprint, key: string, by: string, note?: string | null): Promise<{ resolved: boolean; stillOpen: string | null; tasksContinued: number }> {
  const digest = await currentDigest(env, info, sprint, "read");
  if (!digest) return { resolved: false, stillOpen: null, tasksContinued: 0 };
  const item = digest.items.find((i) => i.key === key && i.status === "open");
  if (!item) return { resolved: false, stillOpen: null, tasksContinued: 0 };
  const fresh = (await db.getSprint(env.ctx.db, sprint.companyId, sprint.id)) ?? sprint;
  const seen = await checkNeedsYouItem(env, info, fresh, item);
  if (seen === false) {
    return { resolved: false, stillOpen: `The plugin does not see "${item.title}" done yet. ${item.steps[item.steps.length - 1] ?? ""}`.trim(), tasksContinued: 0 };
  }
  const result = resolveItem(digest.items, key, by, nowIso(env), note);
  const next = { ...digest, items: result.items };
  await db.upsertNeedsYou(env.ctx.db, next);
  const tasksContinued = await continueTasks(env, fresh, item.taskIds ?? [], by);
  const issueId = await syncDigestIssue(env, info, fresh, next);
  if (issueId && openItems(next.items).length > 0) await commentOn(env, sprint.companyId, issueId, `Done: **${item.title}** (${by}). ${item.after}`);
  return { resolved: true, stillOpen: null, tasksContinued };
}

/** Daily: close items the plugin can see done. */
export async function recheckNeedsYou(env: Env, info: CompanyInfo, sprint: db.Sprint): Promise<number> {
  const digest = await currentDigest(env, info, sprint, "rollover");
  if (!digest) return 0;
  // A new week: open this week's issue for the carried items (last week's closed on rollover).
  if (!digest.issueId && openItems(digest.items).length > 0) await syncDigestIssue(env, info, sprint, digest);
  let resolved = 0;
  for (const item of openItems(digest.items)) {
    if (item.check === "manual") continue;
    try {
      if ((await checkNeedsYouItem(env, info, sprint, item)) === true) {
        const r = await resolveNeedsYou(env, info, sprint, item.key, "checked by the SEO plugin");
        if (r.resolved) resolved += 1;
      }
    } catch (error) {
      env.ctx.logger.info("SEO needs-you check failed", { key: item.key, error: errorMessage(error) });
    }
  }
  return resolved;
}

/** A person closed the digest issue: their manual items are done; checkable ones are re-checked. */
export async function onNeedsYouIssueUpdated(env: Env, companyId: string, issueId: string): Promise<boolean> {
  const digest = await db.getNeedsYouByIssue(env.ctx.db, companyId, issueId);
  if (!digest || digest.status === "done") return Boolean(digest);
  const issue = await getIssue(env, companyId, issueId);
  if (!issue || OPEN_ISSUE_STATUSES.has(String(issue.status))) return true;
  const sprint = await db.getSprint(env.ctx.db, companyId, digest.sprintId);
  if (!sprint) return true;
  const info = await companyInfo(env, companyId);
  const stillOpen: string[] = [];
  for (const item of openItems(digest.items)) {
    const r = await resolveNeedsYou(env, info, sprint, item.key, "the sprint owner (closed the Needs you issue)");
    if (!r.resolved) stillOpen.push(item.title);
  }
  if (stillOpen.length > 0) await commentOn(env, companyId, issueId, `Reopened: the plugin does not see these done yet — ${stillOpen.join("; ")}.`);
  return true;
}

export function itemView(item: NeedsYouItem) {
  return { key: item.key, kind: item.kind, title: item.title, why: item.why, steps: item.steps, links: item.links, after: item.after, copy: item.copy ?? null, optional: Boolean(item.optional), status: item.status, check: item.check, taskIds: item.taskIds ?? [], addedAt: item.addedAt, doneAt: item.doneAt ?? null };
}

export async function needsYouView(env: Env, info: CompanyInfo, sprint: db.Sprint) {
  const digest = await currentDigest(env, info, sprint, "read");
  return {
    weekStart: digest?.weekStart ?? weekStart(info.today),
    issueId: digest?.issueId ?? null,
    issueIdentifier: digest?.issueIdentifier ?? null,
    open: digest ? openItems(digest.items).map(itemView) : [],
    done: digest ? digest.items.filter((i) => i.status === "done").map(itemView) : [],
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export async function needsYouTool(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  return { sprintId: sprint.id, ...(await needsYouView(env, info, sprint)) };
}

const KINDS = ["grant", "review", "pr", "message", "task", "indexing"] as const;

/** Keys with a standard item (exact steps and links written by the plugin). */
export const STANDARD_KEYS = ["github_token", "site_project", "service_account", "bing_key"] as const;

export async function needsYouAddTool(env: Env, companyId: string, actor: Actor, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  const taskIds = strList(params, "taskIds", { max: 20, itemMax: 100 });
  const key = str(params, "key", { max: 120 });
  if (key && (STANDARD_KEYS as readonly string[]).includes(key)) {
    const settings = await settingsPath(env, info);
    const item =
      key === "github_token"
        ? githubTokenItem(info, sprint, str(params, "why", { max: 1000 }) ?? "git push or the GitHub API was refused.", taskIds)
        : key === "site_project"
          ? linkSiteItem(info, sprint, taskIds)
          : key === "service_account"
            ? serviceAccountItem({ prefix: info.prefix, settingsPath: settings }, taskIds)
            : bingKeyItem({ prefix: info.prefix, settingsPath: settings }, taskIds);
    return { sprintId: sprint.id, ...(await addNeedsYou(env, info, sprint, item, { reopen: true })), standard: true, by: actorLabel(actor) };
  }
  const kind = (str(params, "kind") ?? "grant") as NeedsYouItem["kind"];
  if (!KINDS.includes(kind as (typeof KINDS)[number])) throw new SeoError(`kind must be one of: ${KINDS.join(", ")}`);
  const title = reqStr(params, "title", { max: 200 });
  const links = strList(params, "links", { max: 10, itemMax: 1000 }).map((entry) => {
    const [label, url] = entry.includes(" | ") ? entry.split(" | ") : [entry, entry];
    return { label: label!.trim(), url: url!.trim() };
  });
  const result = await addNeedsYou(env, info, sprint, {
    key: key ?? `${kind}:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}`,
    kind,
    title,
    why: reqStr(params, "why", { max: 2000 }),
    steps: strList(params, "steps", { max: 12, itemMax: 1000 }),
    links,
    after: reqStr(params, "after", { max: 1000 }),
    copy: str(params, "copy", { max: 8000 }) ?? null,
    check: taskIds.length > 0 && kind === "pr" ? "task_done" : "manual",
    taskIds,
    optional: bool(params, "optional") ?? false,
  }, { reopen: true });
  return { sprintId: sprint.id, ...result, by: actorLabel(actor) };
}

export async function needsYouResolveTool(env: Env, companyId: string, actor: Actor, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  const key = reqStr(params, "key", { max: 120 });
  const result = await resolveNeedsYou(env, info, sprint, key, actorLabel(actor), str(params, "note", { max: 1000 }) ?? null);
  if (!result.resolved && !result.stillOpen) throw new SeoError(`No open Needs you item ${key} on this sprint`);
  return { sprintId: sprint.id, key, ...result };
}
