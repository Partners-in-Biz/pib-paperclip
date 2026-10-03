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
import { verificationKindOf, verifyInstruction } from "../engine/verify-route.js";
import { resolveAgent } from "./agent.js";
import { assertPreviewLinksChecked } from "./preview.js";
import {
  actorLabel,
  assignableUser,
  bool,
  cockpitPath,
  companyInfo,
  errorMessage,
  num,
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
import { routePrReview } from "./review.js";
import { setVerifyFailure, sprintVerifyRoute, sprintWordPressSite, verifyFailureOf, sprintHasSftp, wpConnectorItemFor, wpSftpItemFor } from "./wordpress.js";

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
        await commentOn(env, sprint.companyId, previous.issueId, carried.length > 0 ? `${carried.length} open ${carried.length === 1 ? "item" : "items"} moved to this week's Needs you issue.` : "Nothing is open any more.");
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
    await commentOn(env, sprint.companyId, issueId, `New item: **${item.title}**. ${item.why}`, { pointer: "the whole item is in this issue's description" });
  }
  return { issueId, added: merged.added, key: item.key };
}

/**
 * An agent task whose Needs you item is open (a PR to merge, a login to add, a client's sign-off) is waiting on
 * a person, not working. If the agent did not block-task it, the host keeps waking it ("continuation needed")
 * and every run just re-checks the same thing. Park such tasks as blocked; `continueTasks` resumes them when the
 * item is done. Runs from the 5-minute job; returns how many tasks it parked.
 */
export async function parkTasksWaitingOnYou(env: Env): Promise<number> {
  const companies = await env.ctx.db.query(`SELECT DISTINCT company_id FROM ${db.t("sprints")} WHERE status = 'active'`);
  let parked = 0;
  for (const row of companies) {
    const companyId = String(row.company_id);
    for (const digest of await db.openNeedsYouDigests(env.ctx.db, companyId)) {
      for (const item of digest.items) {
        if (item.status !== "open" || item.optional || item.key.startsWith("task:")) continue;
        for (const taskId of item.taskIds ?? []) {
          const task = await db.getTask(env.ctx.db, companyId, taskId);
          if (!task || task.owner !== "agent" || !task.issueId || (task.status !== "in_progress" && task.status !== "not_started")) continue;
          if (task.assigneeKind && task.assigneeKind !== "agent" && task.assigneeKind !== "unassigned") continue;
          try {
            const updated = await patchIssue(env, companyId, task.issueId, { status: "blocked" });
            if (!updated) continue;
            await db.updateTask(env.ctx.db, companyId, task.id, { status: "blocked", issue_status: "blocked", blocker_reason: `Waiting on you: ${item.title}`, assignee_kind: "needs_you" });
            await commentOn(env, companyId, task.issueId, `Waiting on a person: **${item.title}** (it is on the Needs you list). This task is parked; it goes back to the SEO Specialist when that is done. No need to check it again.`);
            parked += 1;
          } catch (error) {
            env.ctx.logger.info("SEO park waiting task failed", { taskId, error: errorMessage(error) });
          }
        }
      }
    }
  }
  return parked;
}

/**
 * The client asked for changes: the sign-off items that waited on that answer for this one task are no longer
 * waiting (and must not park the task again). Setup items (logins, repo links) are left alone.
 */
export async function closeSignoffItems(env: Env, companyId: string, sprintId: string, taskId: string, note: string): Promise<number> {
  const sprint = await requireSprint(env, companyId, sprintId);
  const info = await companyInfo(env, companyId);
  const digest = await currentDigest(env, info, sprint, "read");
  if (!digest) return 0;
  let closed = 0;
  const items = digest.items.map((item) => {
    const only = (item.taskIds ?? []).length === 1 && item.taskIds![0] === taskId;
    if (item.status !== "open" || !only || (STANDARD_KEYS as readonly string[]).includes(item.key)) return item;
    closed += 1;
    return { ...item, status: "done" as const, doneAt: nowIso(env), doneBy: "client", note };
  });
  if (closed === 0) return 0;
  const next = { ...digest, items };
  await db.upsertNeedsYou(env.ctx.db, next);
  await syncDigestIssue(env, info, sprint, next);
  return closed;
}

/** Hand waiting tasks back: human tasks complete, agent tasks go back to the agent (todo + wake). */
async function continueTasks(env: Env, sprint: db.Sprint, taskIds: string[], by: string, note?: string | null): Promise<number> {
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
    await commentOn(env, sprint.companyId, task.issueId, `What this task waited for is done (${by}). Back to the SEO Specialist.${note ? ` ${note}` : ""}`);
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

/**
 * A verification item (Search Console access, a Bing tag or file, the IndexNow key file) on a WordPress sprint whose
 * Connector can place verification tags (wp-verify) is agent work, not a person's: it is closed as superseded and its
 * tasks go back to the agent, unless the wp-verify route already failed for that kind.
 */
async function supersededByWpVerify(env: Env, sprint: db.Sprint, item: NeedsYouItem): Promise<boolean> {
  if (item.check !== "manual" && item.check !== "gsc_access") return false;
  const kind = verificationKindOf(item);
  if (!kind || sprint.siteAccess !== "wordpress") return false;
  if (verifyFailureOf(sprint, kind)) return false;
  return (await sprintVerifyRoute(env, sprint)).route !== "none";
}

/** Whether the plugin itself can see the item done: true / false, or null when only a person can say. */
export async function checkNeedsYouItem(env: Env, info: CompanyInfo, sprint: db.Sprint, item: NeedsYouItem): Promise<boolean | null> {
  if (await supersededByWpVerify(env, sprint, item)) return true;
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
    case "playbook_decided":
      return (await env.playbooks.pendingForSprint(sprint.companyId, sprint.id)).length === 0;
    case "wp_connector": {
      // Another site link replaced the WordPress one: only a person can say whether the item still matters.
      if (sprint.siteAccess !== "wordpress") return null;
      const site = await sprintWordPressSite(env, sprint);
      return site?.connector_status === "connected";
    }
    case "wp_sftp":
      return sprint.siteAccess === "wordpress" ? sprintHasSftp(env, sprint) : null;
    default:
      // A hand-off line for a task (block-task, or a person's own task) is over once its task is done or skipped,
      // whoever finished it: the agent often completes the task itself after the reason it waited went away.
      return isTaskHandoff(item) ? tasksAllTerminal(env, sprint, item.taskIds ?? []) : null;
  }
}

/** A Needs you line that exists only because a sprint task was handed to a person. */
function isTaskHandoff(item: NeedsYouItem): boolean {
  // Only the standard `task:<id>` lines. A custom-keyed item can name a task it was raised from and still be a real ask
  // for a person (for example deactivating a plugin) that outlives that task.
  return item.kind === "task" && item.key.startsWith("task:") && (item.taskIds?.length ?? 0) > 0;
}

/** true when every task is done or skipped; null (only a person can say) while any is still open or unknown. */
async function tasksAllTerminal(env: Env, sprint: db.Sprint, ids: string[]): Promise<boolean | null> {
  for (const id of ids) {
    const task = await db.getTask(env.ctx.db, sprint.companyId, id);
    if (!task || !(TERMINAL_TASK_STATUSES as string[]).includes(task.status)) return null;
  }
  return true;
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
  const tasksContinued = await continueTasks(env, fresh, item.taskIds ?? [], by, note);
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
    if (item.check === "manual" && !isTaskHandoff(item) && !(await supersededByWpVerify(env, sprint, item))) continue;
    try {
      if ((await checkNeedsYouItem(env, info, sprint, item)) === true) {
        const superseded = await supersededByWpVerify(env, sprint, item);
        const kind = superseded ? verificationKindOf(item) : null;
        const site = superseded ? await sprintVerifyRoute(env, sprint) : null;
        const note = kind && site?.siteId ? `Superseded: the PiB Connector can place this itself now, so it is no longer a person's job. ${verifyInstruction(kind, site.siteId)}` : isTaskHandoff(item) ? "Its task is done or skipped, so this line is closed." : null;
        const r = await resolveNeedsYou(env, info, sprint, item.key, "checked by the SEO plugin", note);
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

/** Open items `needs-you` returns by default (the digest was ~35 KB with every item in full). */
export const NEEDS_YOU_LIST_DEFAULT = 30;
const DONE_LIST = 20;

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

/** An item as a short row: what it is and who it waits for, not the steps, links or copy-ready text (`key` returns those). */
export function compactItem(item: ReturnType<typeof itemView>) {
  return { key: item.key, kind: item.kind, title: clip(item.title, 140), why: clip(item.why, 160), status: item.status, optional: item.optional, taskIds: item.taskIds, addedAt: item.addedAt, ...(item.doneAt ? { doneAt: item.doneAt } : {}) };
}

/**
 * The week's digest. Short by default: open items as one-line rows (up to 30) and the done ones as keys with their
 * titles; `key` returns one item in full, `compact: false` every item in full.
 */
export async function needsYouTool(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  const view = await needsYouView(env, info, sprint);
  const key = str(params, "key", { max: 200 });
  if (key) {
    const item = [...view.open, ...view.done].find((i) => i.key === key);
    if (!item) throw new SeoError(`There is no Needs you item with the key ${key} on this week's digest (needs-you lists the keys).`);
    return { sprintId: sprint.id, weekStart: view.weekStart, issueId: view.issueId, issueIdentifier: view.issueIdentifier, item };
  }
  if (bool(params, "compact") === false) return { sprintId: sprint.id, ...view };
  const limit = num(params, "limit", { integer: true, min: 1, max: 100 }) ?? NEEDS_YOU_LIST_DEFAULT;
  const open = view.open.slice(0, limit).map(compactItem);
  const done = [...view.done].sort((a, b) => String(b.doneAt ?? "").localeCompare(String(a.doneAt ?? ""))).slice(0, DONE_LIST).map((i) => ({ key: i.key, title: clip(i.title, 100), doneAt: i.doneAt }));
  return {
    sprintId: sprint.id,
    weekStart: view.weekStart,
    issueId: view.issueId,
    issueIdentifier: view.issueIdentifier,
    compact: true,
    open,
    openTotal: view.open.length,
    done,
    doneTotal: view.done.length,
    ...(view.open.length > open.length ? { more: `${view.open.length - open.length} more open items not shown: raise limit (at most 100).` } : {}),
    detail: "Rows are short. Pass key for one item in full (steps, links, copy-ready text), or compact false for every item in full.",
  };
}

const KINDS = ["grant", "review", "pr", "message", "task", "indexing"] as const;

/** Keys with a standard item (exact steps and links written by the plugin). */
export const STANDARD_KEYS = ["github_token", "site_project", "service_account", "bing_key", "wp_connector", "wp_sftp"] as const;

export async function needsYouAddTool(env: Env, companyId: string, actor: Actor, params: Params) {
  await assertPreviewLinksChecked(env, companyId, params);
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  const taskIds = strList(params, "taskIds", { max: 20, itemMax: 100 });
  const key = str(params, "key", { max: 120 });
  if (key && (STANDARD_KEYS as readonly string[]).includes(key)) {
    if (key === "wp_connector") {
      if (sprint.siteAccess !== "wordpress") throw new SeoError("wp_connector is for a sprint linked to a WordPress site (link-site with wordpressSiteId).");
      const item = wpConnectorItemFor(info, sprint, await sprintWordPressSite(env, sprint), taskIds);
      return { sprintId: sprint.id, ...(await addNeedsYou(env, info, sprint, item, { reopen: true })), standard: true, by: actorLabel(actor) };
    }
    if (key === "wp_sftp") {
      if (sprint.siteAccess !== "wordpress") throw new SeoError("wp_sftp is for a sprint linked to a WordPress site (link-site with wordpressSiteId).");
      const item = wpSftpItemFor(info, sprint, await sprintWordPressSite(env, sprint), taskIds);
      return { sprintId: sprint.id, ...(await addNeedsYou(env, info, sprint, item, { reopen: true })), standard: true, by: actorLabel(actor) };
    }
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
  const item: NewNeedsYouItem = {
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
  };
  // Verification on a WordPress site whose Connector can place tags and key files is the agent's work.
  const verifyKind = verificationKindOf(item);
  if (verifyKind && sprint.siteAccess === "wordpress") {
    const wp = await sprintVerifyRoute(env, sprint);
    if (wp.route !== "none" && !verifyFailureOf(sprint, verifyKind)) {
      const tried = str(params, "wpVerifyFailed", { max: 500 });
      if (!tried) {
        throw new SeoError(
          `Not a Needs you item: this WordPress site's Connector ${wp.route === "available" ? "has wp-verify" : `(${wp.connectorVersion ?? "unknown version"}) can be updated to get it`}, so ${verifyKind === "google" ? "Search Console access" : verifyKind === "bing" ? "Bing verification" : "the IndexNow key file"} is your work. ${wp.route === "update" ? "Run the CRM's wp-connector update first. " : ""}${verifyInstruction(verifyKind, wp.siteId ?? "?")} Only if wp-verify or the search engine's verify step failed, call needs-you-add again with wpVerifyFailed set to what you tried and the error (it is recorded on the sprint).`,
        );
      }
      await setVerifyFailure(env, sprint, verifyKind, tried);
    }
  }
  const result = await addNeedsYou(env, info, sprint, item, { reopen: true });
  // An out-of-scope PR is outward-facing: the Cockpit Reviewer checks it before the owner merges.
  const reviewIssueId = kind === "pr" && result.added ? await routePrReview(env, sprint, item) : null;
  return { sprintId: sprint.id, ...result, ...(reviewIssueId ? { reviewIssueId } : {}), by: actorLabel(actor) };
}

export async function needsYouResolveTool(env: Env, companyId: string, actor: Actor, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  const key = reqStr(params, "key", { max: 120 });
  const result = await resolveNeedsYou(env, info, sprint, key, actorLabel(actor), str(params, "note", { max: 1000 }) ?? null);
  if (!result.resolved && !result.stillOpen) throw new SeoError(`No open Needs you item ${key} on this sprint`);
  return { sprintId: sprint.id, key, ...result };
}
