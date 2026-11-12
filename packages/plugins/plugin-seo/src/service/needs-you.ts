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
  needsYouTitle,
  openItems,
  resolveItem,
  weekStart,
  weeklyNeedsYouDescription,
  type NeedsYouItem,
  type NewNeedsYouItem,
} from "../engine/needs-you.js";
import type { AiBotKind } from "../checks/geo.js";
import { probeKind } from "../engine/geo.js";
import { sprintLabel } from "../engine/copy.js";
import { isRehearsalSprint } from "../engine/rehearsal.js";
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
import { agentInstruction, agentRouteFor, isPageChangeTitle, needsPageWindow, type AgentRoute, type HandoffSite } from "../engine/needs-you-handoff.js";
import { findSeoClientProject } from "./site.js";
import { commentOn, getIssue, OPEN_ISSUE_STATUSES, openIssue, patchIssue } from "./issues.js";
import { routePrReview } from "./review.js";
import { tellSignoffDelegate } from "./signoff-delegate.js";
import { setVerifyFailure, sprintVerifyRoute, sprintWordPressSite, verifyFailureOf, sprintHasSftp, wpConnectorItemFor, wpSftpItemFor } from "./wordpress.js";

const nowIso = (env: Env) => env.now().toISOString();

/**
 * This week's digest row. `read`: this week's, else last week's while it has
 * open items, else null. `write`: always this week's (created with last
 * week's open items). `rollover`: create this week's only when last week
 * still has open items (the daily run, so each week gets its own issue).
 */
export async function currentDigest(env: Env, info: CompanyInfo, sprint: db.Sprint, mode: "read" | "write" | "rollover"): Promise<db.NeedsYouDigest | null> {
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
    // The old week's issue is shared by every sprint: close it only once the last sprint's digest has moved on.
    const sharing = previous.issueId ? await db.getNeedsYouByIssue(env.ctx.db, sprint.companyId, previous.issueId) : [];
    if (previous.issueId && !sharing.some((d) => d.id !== previous.id && d.status === "open")) {
      const old = await getIssue(env, sprint.companyId, previous.issueId);
      if (old && OPEN_ISSUE_STATUSES.has(String(old.status))) {
        await commentOn(env, sprint.companyId, previous.issueId, carried.length > 0 ? `${carried.length} open ${carried.length === 1 ? "item" : "items"} moved to this week's Needs you issue.` : "Nothing is open any more.");
        await patchIssue(env, sprint.companyId, previous.issueId, { status: "done" });
      }
    }
  }
  return db.getNeedsYou(env.ctx.db, sprint.companyId, sprint.id, week);
}

/**
 * Create, update or close the week's one Needs you issue to match the items of every sprint that shares it. The issue
 * is shared per company per week and belongs to no client's project: each sprint's digest row points at it, and its
 * description summarises the items by client. Only digests linked to the issue (or joining it now) count, so an issue
 * that belongs to one sprint alone never shows or closes on another client's items.
 */
async function syncDigestIssue(env: Env, info: CompanyInfo, sprint: db.Sprint, digest: db.NeedsYouDigest): Promise<string | null> {
  // The week's digests of every sprint, with this one as just written by the caller.
  const week = (await db.getNeedsYouForWeek(env.ctx.db, sprint.companyId, digest.weekStart)).filter((d) => d.id !== digest.id && d.sprintId !== digest.sprintId);
  const issueId = digest.issueId ?? week.find((d) => d.issueId)?.issueId ?? null;
  const siblings = week.filter((d) => !d.issueId || d.issueId === issueId);
  const all = [digest, ...siblings];
  const open = all.flatMap((d) => openItems(d.items));
  // Quiet items (optional advice such as the Google Analytics grants) never open or reopen the issue on their own.
  const loud = open.filter((i) => !i.quiet);
  const identifier = digest.issueIdentifier ?? siblings.find((d) => d.issueId === issueId)?.issueIdentifier ?? null;
  const description = await weeklyDescription(env, info, sprint, all);
  const link = async (id: string, ident: string | null) => {
    // Every digest of the week points at the one issue (this sprint joins one a sibling opened).
    for (const d of all) if (d.issueId !== id) await db.setNeedsYouIssue(env.ctx.db, sprint.companyId, d.id, id, ident);
  };
  if (!issueId) {
    if (open.length === 0 || loud.length === 0) return null;
    try {
      const created = await openIssue(env, {
        companyId: sprint.companyId,
        sprint,
        title: needsYouTitle(digest.weekStart),
        description,
        originKind: ORIGIN.needsYou,
        originId: `weekly:${digest.weekStart}`,
        // No projectId: the issue covers several clients, so filing it under one would misfile the others.
        assigneeUserId: assignableUser(sprint.ownerUserId),
        priority: "high",
        wake: false,
      });
      const issue = await getIssue(env, sprint.companyId, created.id);
      await link(created.id, issue?.identifier ?? null);
      return created.id;
    } catch (error) {
      env.ctx.logger.info("SEO needs-you issue not created", { sprintId: sprint.id, error: errorMessage(error) });
      return null;
    }
  }
  if (issueId !== digest.issueId) await link(issueId, identifier);
  const issue = await getIssue(env, sprint.companyId, issueId);
  const isOpen = issue ? OPEN_ISSUE_STATUSES.has(String(issue.status)) : false;
  if (open.length === 0) {
    if (isOpen || issue?.description !== description) await patchIssue(env, sprint.companyId, issueId, { description, ...(isOpen ? { status: "done" } : {}) });
    if (isOpen) await commentOn(env, sprint.companyId, issueId, "Every item is done. The SEO Specialist carries on.");
    for (const d of all) await db.upsertNeedsYou(env.ctx.db, { ...d, status: "done" });
  } else if (issue && !isOpen && loud.length === 0) {
    // Only quiet items are open and a person already closed this issue: leave it closed (touching it would be read as a
    // person closing it again). The items stay on the digest, the page and the Needs you tool.
    if (digest.status === "done") await db.upsertNeedsYou(env.ctx.db, { ...digest, status: "open" });
  } else {
    // Skip a patch that changes nothing: the daily re-check calls this for every sprint, and each patch is logged in full.
    if (!isOpen || issue?.description !== description) await patchIssue(env, sprint.companyId, issueId, { description, ...(issue && !isOpen ? { status: "todo" } : {}) });
    if (digest.status === "done") await db.upsertNeedsYou(env.ctx.db, { ...digest, status: "open" });
  }
  return issueId;
}

/** The weekly issue's description: the items of every sprint that has some, grouped by client. */
async function weeklyDescription(env: Env, info: CompanyInfo, sprint: db.Sprint, digests: db.NeedsYouDigest[]): Promise<string> {
  const groups: Array<{ sprint: ReturnType<typeof sprintCopy>; items: NeedsYouItem[]; cockpitPath: string | null; proposals: number }> = [];
  for (const d of digests) {
    const s = d.sprintId === sprint.id ? sprint : await db.getSprint(env.ctx.db, sprint.companyId, d.sprintId);
    if (!s) continue;
    const proposals = (await db.listOptimizations(env.ctx.db, sprint.companyId, s.id, { status: "proposed" })).length;
    groups.push({ sprint: sprintCopy(s), items: d.items, cockpitPath: cockpitPath(info, s), proposals });
  }
  return weeklyNeedsYouDescription(groups, digests[0]?.weekStart ?? info.today);
}

/** Re-render this week's issue (for example after new optimization proposals); nothing is opened or closed that was not already. */
export async function refreshNeedsYouIssue(env: Env, info: CompanyInfo, sprint: db.Sprint): Promise<void> {
  const digest = await db.getNeedsYou(env.ctx.db, sprint.companyId, sprint.id, weekStart(info.today));
  if (digest?.issueId) await syncDigestIssue(env, info, sprint, digest);
}

/** Who closes an item the plugin checked itself (a person's closes carry their own name). */
export const PLUGIN_CHECK_BY = "checked by the SEO plugin";

/** Whether a "done by" label names a person (a board user or the sprint owner), not the plugin or an agent. */
export function isPersonLabel(by: string | null | undefined): boolean {
  return /^(user |a board user|the sprint owner)/.test(by ?? "");
}

/**
 * The latest state of an item over the sprint's recent digests (a done item is not carried into a new week, so it is
 * found in the week it was closed). Looks back 26 weeks; null when it never existed in that time.
 */
export async function lastNeedsYouItem(env: Env, sprint: db.Sprint, key: string): Promise<NeedsYouItem | null> {
  for (const digest of await db.recentNeedsYouDigests(env.ctx.db, sprint.companyId, sprint.id, 26)) {
    const item = digest.items.find((i) => i.key === key);
    if (item) return item;
  }
  return null;
}

/**
 * Add (or update) one item on this week's digest. A rehearsal sprint asks nobody for anything: nothing is recorded and no
 * issue is opened (engine/rehearsal.ts), whichever job or tool raised the item.
 */
export async function addNeedsYou(env: Env, info: CompanyInfo, sprint: db.Sprint, item: NewNeedsYouItem, opts: { reopen?: boolean } = {}): Promise<{ issueId: string | null; added: boolean; key: string }> {
  if (isRehearsalSprint(sprint)) return { issueId: null, added: false, key: item.key };
  const digest = await currentDigest(env, info, sprint, "write");
  if (!digest) return { issueId: null, added: false, key: item.key };
  const merged = mergeItem(digest.items, item, nowIso(env), opts);
  if (!merged.changed && digest.issueId) return { issueId: digest.issueId, added: false, key: item.key };
  const next = { ...digest, items: merged.items, status: "open" as const };
  await db.upsertNeedsYou(env.ctx.db, next);
  const issueId = await syncDigestIssue(env, info, sprint, next);
  if (merged.added && issueId && digest.issueId && !item.quiet) {
    await commentOn(env, sprint.companyId, issueId, `New item for ${sprintLabel(sprint)}: **${item.title}**. ${item.why}`, { pointer: "the whole item is on the client's SEO page" });
  }
  await tellSignoffDelegate(env, sprint.companyId, sprint.id);
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
export async function closeSignoffItems(env: Env, companyId: string, sprintId: string, taskId: string, note: string, by = "client"): Promise<number> {
  const sprint = await requireSprint(env, companyId, sprintId);
  const info = await companyInfo(env, companyId);
  const digest = await currentDigest(env, info, sprint, "read");
  if (!digest) return 0;
  let closed = 0;
  const items = digest.items.map((item) => {
    const only = (item.taskIds ?? []).length === 1 && item.taskIds![0] === taskId;
    if (item.status !== "open" || !only || (STANDARD_KEYS as readonly string[]).includes(item.key)) return item;
    closed += 1;
    return { ...item, status: "done" as const, doneAt: nowIso(env), doneBy: by, note };
  });
  if (closed === 0) return 0;
  const next = { ...digest, items };
  await db.upsertNeedsYou(env.ctx.db, next);
  await syncDigestIssue(env, info, sprint, next);
  await tellSignoffDelegate(env, sprint.companyId, sprint.id);
  return closed;
}

/**
 * A sprint task closed (done or cancelled): its Needs you rows are over. Closes, on every recent digest of the sprint,
 * the open `review:<taskId>` / `task:<taskId>` rows and any row whose taskIds are all closed tasks (a row that lists
 * several tasks stays open while one of them is still open). Setup items (logins, repo links) are left alone.
 */
export async function closeItemsForClosedTask(env: Env, companyId: string, sprintId: string, taskId: string, note: string): Promise<number> {
  const sprint = await requireSprint(env, companyId, sprintId);
  const info = await companyInfo(env, companyId);
  const digests = (await db.recentNeedsYouDigests(env.ctx.db, companyId, sprintId)).filter((d) => d.items.some((i) => i.status === "open"));
  let total = 0;
  for (const digest of digests) {
    let closed = 0;
    const items: NeedsYouItem[] = [];
    for (const item of digest.items) {
      const ids = item.taskIds ?? [];
      const lists = ids.includes(taskId) || item.key === `review:${taskId}` || item.key === `task:${taskId}`;
      if (item.status !== "open" || !lists || (STANDARD_KEYS as readonly string[]).includes(item.key)) { items.push(item); continue; }
      const others = ids.filter((id) => id !== taskId);
      if (others.length > 0 && (await tasksAllTerminal(env, sprint, others)) !== true) { items.push(item); continue; }
      closed += 1;
      items.push({ ...item, status: "done" as const, doneAt: nowIso(env), doneBy: "plugin", note });
    }
    if (closed === 0) continue;
    const next = { ...digest, items };
    await db.upsertNeedsYou(env.ctx.db, next);
    if (digest.status === "open") await syncDigestIssue(env, info, sprint, next);
    total += closed;
  }
  return total;
}

/**
 * A person switched an extra off: its optional lines are over. Closed without a check and without handing any task back
 * (no wake), with the reason as the note. Returns how many were closed.
 */
export async function closeNeedsYouItems(env: Env, info: CompanyInfo, sprint: db.Sprint, keys: string[], by: string, note: string): Promise<number> {
  const digest = await currentDigest(env, info, sprint, "read");
  if (!digest) return 0;
  let closed = 0;
  const items = digest.items.map((item) => {
    if (item.status !== "open" || !keys.includes(item.key)) return item;
    closed += 1;
    return { ...item, status: "done" as const, doneAt: nowIso(env), doneBy: by, note };
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

/** A page group's issue the agent blocked goes back to the agent (todo + wake) when its Needs you line is done. 1 when it was resumed. */
async function continueGroup(env: Env, sprint: db.Sprint, chunkId: string, by: string): Promise<number> {
  const chunk = await db.getChunk(env.ctx.db, sprint.companyId, chunkId);
  if (!chunk?.issueId || (chunk.status !== "open" && chunk.status !== "queued")) return 0;
  const issue = await getIssue(env, sprint.companyId, chunk.issueId);
  if (!issue || String(issue.status) !== "blocked") return 0; // a person already moved it
  const agent = await resolveAgent(env, sprint.companyId);
  const updated = await patchIssue(env, sprint.companyId, chunk.issueId, { status: "todo", ...(agent ? { assigneeAgentId: agent.id, assigneeUserId: null } : {}) });
  if (!updated) return 0;
  await commentOn(env, sprint.companyId, chunk.issueId, `What this group waited for is done (${by}). Back to the SEO Specialist: carry on with the pages.`);
  if (agent && !["paused", "pending_approval", "terminated"].includes(agent.status)) {
    try {
      await env.ctx.issues.requestWakeup(chunk.issueId, sprint.companyId, { reason: "SEO page group unblocked", idempotencyKey: `wake:${chunk.issueId}:${Date.now()}` });
    } catch (error) {
      env.ctx.logger.info("SEO wake skipped", { issueId: chunk.issueId, error: errorMessage(error) });
    }
  }
  return 1;
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
    case "ga4_access": {
      // Both Google Analytics grants close the same way: a pull of the sprint's property worked.
      const ga4 = await db.getIntegration(env.ctx.db, sprint.companyId, sprint.id, "ga4");
      return ga4?.status === "connected" && Boolean(ga4.propertyUrl);
    }
    case "geo_firewall": {
      // The latest geo-audit's server probes saw no refusal (null before any audit: only a person can say).
      const latest = await db.latestGeoAudit(env.ctx.db, sprint.companyId, sprint.id);
      if (!latest) return null;
      // Only a refused search bot keeps the item open: a refused training crawler is the client's choice.
      const probes = ((latest.sections as { serverProbes?: Array<{ token: string; kind?: AiBotKind; blocked?: boolean }> }).serverProbes ?? []);
      return probes.length > 0 && !probes.some((p) => p.blocked && probeKind({ token: p.token, ...(p.kind ? { kind: p.kind } : {}) }) === "search");
    }
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
export async function resolveNeedsYou(env: Env, info: CompanyInfo, sprint: db.Sprint, key: string, by: string, note?: string | null, opts: { person?: boolean } = {}): Promise<{ resolved: boolean; stillOpen: string | null; tasksContinued: number }> {
  const digest = await currentDigest(env, info, sprint, "read");
  if (!digest) return { resolved: false, stillOpen: null, tasksContinued: 0 };
  const item = digest.items.find((i) => i.key === key && i.status === "open");
  if (!item) return { resolved: false, stillOpen: null, tasksContinued: 0 };
  const fresh = (await db.getSprint(env.ctx.db, sprint.companyId, sprint.id)) ?? sprint;
  // A person's word beats the AI-bot probe: it cannot tell a real block from a CDN that lets the real bots in by address.
  const seen = item.check === "geo_firewall" && opts.person ? true : await checkNeedsYouItem(env, info, fresh, item);
  if (seen === false) {
    return { resolved: false, stillOpen: `The plugin does not see "${item.title}" done yet. ${item.steps[item.steps.length - 1] ?? ""}`.trim(), tasksContinued: 0 };
  }
  const result = resolveItem(digest.items, key, by, nowIso(env), note);
  const next = { ...digest, items: result.items };
  await db.upsertNeedsYou(env.ctx.db, next);
  const tasksContinued = (await continueTasks(env, fresh, item.taskIds ?? [], by, note)) + (key.startsWith("chunk:") ? await continueGroup(env, fresh, key.slice("chunk:".length), by) : 0);
  const issueId = await syncDigestIssue(env, info, fresh, next);
  if (issueId && openItems(next.items).length > 0) await commentOn(env, sprint.companyId, issueId, `Done: **${item.title}** (${by}). ${item.after}`);
  await tellSignoffDelegate(env, sprint.companyId, sprint.id);
  return { resolved: true, stillOpen: null, tasksContinued };
}

/** Daily: close items the plugin can see done. */
export async function recheckNeedsYou(env: Env, info: CompanyInfo, sprint: db.Sprint): Promise<number> {
  const digest = await currentDigest(env, info, sprint, "rollover");
  if (!digest) {
    await tellSignoffDelegate(env, sprint.companyId, sprint.id);
    return 0;
  }
  // A new week: open this week's issue for the carried items (last week's closed on rollover). An existing issue is
  // re-rendered too, so its summary never falls behind while this sprint's own items stay quiet.
  if (digest.issueId || openItems(digest.items).length > 0) await syncDigestIssue(env, info, sprint, digest);
  let resolved = 0;
  for (const item of openItems(digest.items)) {
    if (item.check === "manual" && !isTaskHandoff(item) && !(await supersededByWpVerify(env, sprint, item))) continue;
    try {
      if ((await checkNeedsYouItem(env, info, sprint, item)) === true) {
        const superseded = await supersededByWpVerify(env, sprint, item);
        const kind = superseded ? verificationKindOf(item) : null;
        const site = superseded ? await sprintVerifyRoute(env, sprint) : null;
        const note = kind && site?.siteId ? `Superseded: the PiB Connector can place this itself now, so it is no longer a person's job. ${verifyInstruction(kind, site.siteId)}` : isTaskHandoff(item) ? "Its task is done or skipped, so this line is closed." : null;
        const r = await resolveNeedsYou(env, info, sprint, item.key, PLUGIN_CHECK_BY, note);
        if (r.resolved) resolved += 1;
      }
    } catch (error) {
      env.ctx.logger.info("SEO needs-you check failed", { key: item.key, error: errorMessage(error) });
    }
  }
  // The daily job is also the backstop: a delegate who became eligible (a preview passed) is told here.
  await tellSignoffDelegate(env, sprint.companyId, sprint.id);
  return resolved;
}

/**
 * A person closed the weekly issue. Closing marks nothing done: the issue is only a summary, so a close says nothing about
 * items its reader may never have seen. What the plugin can see done closes now; the issue reopens while anything else is open.
 */
export async function onNeedsYouIssueUpdated(env: Env, companyId: string, issueId: string): Promise<boolean> {
  const digests = await db.getNeedsYouByIssue(env.ctx.db, companyId, issueId);
  if (digests.length === 0) return false;
  const waiting = digests.filter((d) => d.status === "open");
  if (waiting.length === 0) return true;
  const issue = await getIssue(env, companyId, issueId);
  if (!issue || OPEN_ISSUE_STATUSES.has(String(issue.status))) return true;
  const info = await companyInfo(env, companyId);
  for (const digest of waiting) {
    const sprint = await db.getSprint(env.ctx.db, companyId, digest.sprintId);
    if (sprint) await recheckNeedsYou(env, info, sprint);
  }
  const stillOpen: string[] = [];
  for (const digest of await db.getNeedsYouByIssue(env.ctx.db, companyId, issueId)) {
    // Quiet items never reopen the issue on their own.
    const loud = openItems(digest.items).filter((i) => !i.quiet).length;
    if (digest.status !== "open" || loud === 0) continue;
    const sprint = await db.getSprint(env.ctx.db, companyId, digest.sprintId);
    stillOpen.push(`${sprint ? sprintLabel(sprint) : digest.sprintId}: ${loud}`);
  }
  if (stillOpen.length > 0) {
    await patchIssue(env, companyId, issueId, { status: "todo" });
    await commentOn(env, companyId, issueId, `Reopened: closing this issue does not mark items done. Still open — ${stillOpen.join("; ")}. Mark them done on each client's SEO page → Integrations.`);
  }
  return true;
}

export function itemView(item: NeedsYouItem) {
  return { key: item.key, kind: item.kind, title: item.title, why: item.why, steps: item.steps, links: item.links, after: item.after, copy: item.copy ?? null, optional: Boolean(item.optional), status: item.status, check: item.check, taskIds: item.taskIds ?? [], addedAt: item.addedAt, doneAt: item.doneAt ?? null };
}

/** The site facts that decide which items the SEO agent can take over (Give to agent). */
export async function handoffSite(env: Env, sprint: db.Sprint): Promise<HandoffSite> {
  const wp = sprint.siteAccess === "wordpress" ? await sprintWordPressSite(env, sprint).catch(() => null) : null;
  return {
    siteAccess: sprint.siteAccess,
    changePolicy: sprint.changePolicy,
    clientSignoff: sprint.clientSignoff,
    connectorConnected: wp?.connector_status === "connected",
    sftp: Boolean(wp && Array.isArray(wp.access) && wp.access.includes("sftp")),
  };
}

export async function needsYouView(env: Env, info: CompanyInfo, sprint: db.Sprint) {
  const digest = await currentDigest(env, info, sprint, "read");
  const open = digest ? openItems(digest.items) : [];
  const site = open.length > 0 ? await handoffSite(env, sprint) : null;
  return {
    weekStart: digest?.weekStart ?? weekStart(info.today),
    issueId: digest?.issueId ?? null,
    issueIdentifier: digest?.issueIdentifier ?? null,
    // agent: the route when the SEO agent can do the item itself (the page shows Give to agent), else null.
    open: open.map((item) => ({ ...itemView(item), agent: site ? agentRouteFor(item, site) : null })),
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
  // Automatic client sign-off: a page's copy goes to the client as a preview, not to a person as a change set to apply.
  if (sprint.clientSignoff === "auto" && ["task", "review", "pr"].includes(kind) && taskIds.length > 0) {
    const pages = await env.ctx.db.query(
      `SELECT t.id FROM ${db.t("sprint_tasks")} t WHERE t.company_id = $1 AND t.id IN (SELECT jsonb_array_elements_text($2::jsonb)) AND t.task_type = 'page-write'
         AND NOT EXISTS (SELECT 1 FROM ${db.t("previews")} p WHERE p.task_id = t.id AND p.status <> 'cancelled')`,
      [companyId, JSON.stringify(taskIds)],
    );
    if (pages.length > 0) {
      throw new SeoError("This sprint's client sign-off is automatic: do not hand a page's change set to a person. Make a preview of each page with partnersinbiz.seo:create-preview (with the task's taskId) and end your turn: the plugin parks the task on the client, drafts the approval email and wakes you with what to apply. If create-preview itself fails, say so in a comment on the task and end your turn: the plugin retries.");
    }
  }
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
  // A page change or template markup the agent can make itself is not a person's job (the Give to agent rules). A real
  // person-only step that the rules mistake for one is let through with personOnly saying why (kept on the item).
  const route = verifyKind ? null : agentRouteFor({ ...item, status: "open" }, await handoffSite(env, sprint));
  if (route === "content" || route === "theme") {
    const personOnly = str(params, "personOnly", { max: 500 });
    if (!personOnly) {
      throw new SeoError(`Not a Needs you item: you can do this yourself. ${agentInstruction(route, await handoffSite(env, sprint), sprint.id)} Only if it truly needs a person (wp-admin, an account, a judgement), call needs-you-add again with personOnly saying exactly what only a person can do.`);
    }
    item.why = `${item.why}\n\nOnly a person: ${personOnly}`.slice(0, 2600);
  }
  const result = await addNeedsYou(env, info, sprint, item, { reopen: true });
  // A page change set on a pr_only manual sign-off WordPress sprint is opened for applying by needs-you-resolve with pageUrls,
  // which needs the task: without it the resolver must pass taskId. A wording heuristic, so a warning, never a refusal.
  const warning = taskIds.length === 0 && needsPageWindow(sprint) && isPageChangeTitle(item.title) ? PAGE_CHANGE_NO_TASK_WARNING : null;
  // An out-of-scope PR is outward-facing: the Cockpit Reviewer checks it before the owner merges.
  const reviewIssueId = kind === "pr" && result.added ? await routePrReview(env, sprint, item) : null;
  return { sprintId: sprint.id, ...result, ...(reviewIssueId ? { reviewIssueId } : {}), ...(warning ? { warning } : {}), by: actorLabel(actor) };
}

export const PAGE_CHANGE_NO_TASK_WARNING =
  "Added, but with no taskIds: this looks like a page change set on a pr_only site, and opening its apply window needs the task. Call needs-you-add again with the same key and taskIds = the sprint task of the page, or whoever resolves it must pass taskId.";
const NOT_OPENED_NEXT =
  "Resolved, but no apply window was opened: on this pr_only site the agent still may not write the page. To open it, call partnersinbiz.seo:approve-page-apply (sprintId, taskId, pageUrls, note; reviewCommentId when the pages have no passed preview), or needs-you-resolve with pageUrls and taskId next time.";

/** The task a page approval on an item is for: `taskId` (one of the item's tasks when it names any), else its only task. */
function pageApprovalTask(item: NeedsYouItem, taskId: string | null): string {
  const ids = item.taskIds ?? [];
  if (taskId) {
    if (ids.length > 0 && !ids.includes(taskId)) throw new SeoError(`Task ${taskId} is not one of this item's tasks (${ids.join(", ")}).`);
    return taskId;
  }
  if (ids.length === 1) return ids[0]!;
  throw new SeoError(`${ids.length === 0 ? "This item names no task" : `This item names ${ids.length} tasks (${ids.join(", ")})`}: pass taskId (the sprint task whose pages these are) with pageUrls.`);
}

export async function needsYouResolveTool(env: Env, companyId: string, actor: Actor, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  const key = reqStr(params, "key", { max: 120 });
  const note = str(params, "note", { max: 1000 }) ?? null;
  const pageUrls = strList(params, "pageUrls");
  const digest = await currentDigest(env, info, sprint, "read");
  const item = digest?.items.find((i) => i.key === key && i.status === "open") ?? null;
  if (pageUrls.length > 0) {
    // Opens the window first (approve-page-apply resolves the item as its own step): a refused grant leaves the item open.
    if (!item) throw new SeoError(`No open Needs you item ${key} on this sprint`);
    const taskId = pageApprovalTask(item, str(params, "taskId", { max: 100 }) ?? null);
    const reviewCommentId = str(params, "reviewCommentId", { max: 100 });
    // Loaded on use: page-apply imports resolveNeedsYou from this module, so a static import would be a cycle.
    const { approvePageApply } = await import("./page-apply.js");
    const grant = await approvePageApply(env, companyId, actor, {
      sprintId: sprint.id, taskId, pageUrls, needsYouKey: key, note: note ?? `Needs you item resolved: ${item.title}`.slice(0, 1000),
      ...(reviewCommentId ? { reviewCommentId } : {}),
    });
    return { ...grant, sprintId: sprint.id, key, resolved: grant.needsYouResolved, applyWindow: "opened" as const };
  }
  const result = await resolveNeedsYou(env, info, sprint, key, actorLabel(actor), note, { person: actor.kind === "user" });
  if (!result.resolved && !result.stillOpen) throw new SeoError(`No open Needs you item ${key} on this sprint`);
  // Any caller: a person may also resolve a page change set without knowing the agent still may not write it.
  if (result.resolved && item && needsPageWindow(sprint) && isPageChangeTitle(item.title)) {
    return { sprintId: sprint.id, key, ...result, applyWindow: "not_opened" as const, next: NOT_OPENED_NEXT };
  }
  return { sprintId: sprint.id, key, ...result };
}

// ---------------------------------------------------------------------------
// Give to agent (SEO page, Integrations → Needs you)
// ---------------------------------------------------------------------------

/** Items one "give all" hands over; the rest stay on the page for another press. */
export const GIVE_ALL_MAX = 60;
const GIVE_WHY_MAX = 600;
const GIVE_STEP_MAX = 300;

function handoffSection(item: NeedsYouItem, route: AgentRoute, site: HandoffSite, sprintId: string, n: number | null): string[] {
  const lines = [`### ${n ? `${n}. ` : ""}${clip(item.title, 200)}`, "", agentInstruction(route, site, sprintId), "", `**What the item said:** ${clip(item.why, GIVE_WHY_MAX)}`];
  if (item.steps.length > 0) lines.push("", ...item.steps.slice(0, 6).map((step, i) => `${i + 1}. ${clip(step, GIVE_STEP_MAX)}`));
  if ((item.taskIds ?? []).length > 0) lines.push("", `Sprint tasks: ${(item.taskIds ?? []).map((id) => `\`${id}\``).join(", ")}`);
  lines.push("", `<sub>Needs you key \`${item.key}\`: the whole item (links, copy-ready text) is in partnersinbiz.seo:needs-you with this key.</sub>`, "");
  return lines;
}

/**
 * A person gives Needs you items the SEO agent can do back to it: one item (`key`) or every such item (`all`). Each item is
 * closed as handed over; tasks it waited on go back to the agent with the item's instructions as a comment, and items with
 * no open task become one issue for the agent in the client's project. Items only a person can do are refused.
 */
export async function giveNeedsYouToAgent(env: Env, companyId: string, actor: Actor, params: Params) {
  if (actor.kind !== "user") throw new SeoError("Give to agent is a button for people on the SEO page.");
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  if (isRehearsalSprint(sprint)) throw new SeoError("A rehearsal sprint hands nothing to anybody.");
  const info = await companyInfo(env, companyId);
  const digest = await currentDigest(env, info, sprint, "read");
  const key = str(params, "key", { max: 200 });
  const all = bool(params, "all") === true;
  if (!key && !all) throw new SeoError("Pass key (one item) or all: true.");
  const site = await handoffSite(env, sprint);
  const open = digest ? openItems(digest.items) : [];
  const picked = (key ? open.filter((i) => i.key === key) : open)
    .map((item) => ({ item, route: agentRouteFor(item, site) }))
    .filter((x): x is { item: NeedsYouItem; route: AgentRoute } => x.route !== null)
    .slice(0, GIVE_ALL_MAX);
  if (key && open.every((i) => i.key !== key)) throw new SeoError(`No open Needs you item ${key} on this sprint.`);
  if (picked.length === 0) throw new SeoError(key ? "Only a person can do this one: it stays on Needs you." : "Nothing on Needs you is something the agent can do itself.");
  const agent = await resolveAgent(env, companyId);
  if (!agent || ["paused", "pending_approval", "terminated"].includes(agent.status)) {
    throw new SeoError("The SEO Specialist is not available (not hired, paused or terminated): nothing was handed over.");
  }
  const by = `${actorLabel(actor)}, given to the SEO Specialist`;

  // Tasks the items waited on: each goes back to the agent once, with every item that named it.
  const byTask = new Map<string, Array<{ item: NeedsYouItem; route: AgentRoute }>>();
  const loose: Array<{ item: NeedsYouItem; route: AgentRoute }> = [];
  for (const entry of picked) {
    let placed = false;
    for (const taskId of entry.item.taskIds ?? []) {
      const task = await db.getTask(env.ctx.db, companyId, taskId);
      if (!task?.issueId || (TERMINAL_TASK_STATUSES as string[]).includes(task.status)) continue;
      byTask.set(task.id, [...(byTask.get(task.id) ?? []), entry]);
      placed = true;
      break;
    }
    if (!placed) loose.push(entry);
  }

  // Close first, so the 5-minute job does not park a task again while it still sees the item open.
  const issues: string[] = [];
  await closeNeedsYouItems(env, info, sprint, picked.map((p) => p.item.key), by, "Given to the SEO Specialist from the SEO page.");

  let tasksResumed = 0;
  for (const [taskId, entries] of byTask) {
    const task = await db.getTask(env.ctx.db, companyId, taskId);
    if (!task?.issueId) continue;
    const updated = await patchIssue(env, companyId, task.issueId, { status: "todo", assigneeAgentId: agent.id, assigneeUserId: null });
    if (!updated) {
      loose.push(...entries);
      continue;
    }
    await db.updateTask(env.ctx.db, companyId, task.id, { status: "in_progress", issue_status: "todo", assignee_kind: "agent", blocker_reason: null });
    const body = [`A person gave this back to you from the Needs you list: you can do ${entries.length === 1 ? "it" : "these"} yourself.`, "", ...entries.flatMap((e) => handoffSection(e.item, e.route, site, sprint.id, null))];
    await commentOn(env, companyId, task.issueId, body.join("\n").trimEnd());
    try {
      await env.ctx.issues.requestWakeup(task.issueId, companyId, { reason: "Needs you item given to the SEO Specialist", idempotencyKey: `give:${task.issueId}:${Date.now()}` });
    } catch (error) {
      env.ctx.logger.info("SEO wake skipped", { issueId: task.issueId, error: errorMessage(error) });
    }
    issues.push(task.issueId);
    tasksResumed += 1;
  }

  let createdIssueId: string | null = null;
  if (loose.length > 0) {
    const projectId = sprint.clientProjectId ?? (await findSeoClientProject(env, sprint).catch(() => null));
    const title = loose.length === 1 ? `Do it yourself: ${clip(loose[0]!.item.title, 180)}` : `Needs you items given back to you: ${sprintLabel(sprint)} (${loose.length})`;
    const description = [
      `A person gave ${loose.length === 1 ? "this item" : `these ${loose.length} items`} from ${sprintLabel(sprint)}'s Needs you list back to you (sprintId ${sprint.id}): you can do ${loose.length === 1 ? "it" : "them"} yourself.`,
      "",
      loose.length > 1 ? "Several items often describe the same page change (refresh, apply, approve): treat those as one piece of work. Work through them in one run where you can; complete this issue when every item is done or explained." : "Complete this issue when it is done or explained.",
      "",
      ...loose.flatMap((e, i) => handoffSection(e.item, e.route, site, sprint.id, loose.length > 1 ? i + 1 : null)),
    ].join("\n").trimEnd();
    const created = await openIssue(env, {
      companyId,
      sprint,
      title,
      description,
      originKind: ORIGIN.needsYou,
      originId: `give:${sprint.id}:${env.now().getTime()}`,
      ...(projectId ? { projectId } : {}),
      assigneeAgentId: agent.id,
      priority: "medium",
      wake: true,
      wakeReason: "Needs you items given to the SEO Specialist",
    });
    createdIssueId = created.id;
    issues.push(created.id);
  }

  const left = open.length - picked.length;
  return { sprintId: sprint.id, given: picked.length, tasksResumed, issueId: createdIssueId, issueIds: issues, stillNeedYou: left };
}
