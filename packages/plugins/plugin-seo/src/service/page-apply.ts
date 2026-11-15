/**
 * Page apply grants (PAR-9493 T2a): who may approve applying a Reviewer-passed change to some pages of a task on a pr_only
 * WordPress site, and which pages. A person may; an agent only while it is in the `signoffDelegateAgentIds` setting and is
 * not the live assignee of the task's issue (no self-approval). The pages must be the task's own pages, each needs a Reviewer
 * PASS (a passed preview, or a Reviewer comment on the task issue or a child of it), and a site holds at most 10 open grant
 * pages. `approvePageApply` (T2b) writes the rows, sends the window, resolves the Needs you item and tells the task issue once
 * per `apply_until`; `revokePageApply` closes grants early.
 */
import { normalisePageUrl, reviewerAgentId, sameSite, siteKey, wakeIssue } from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import { t } from "../db.js";
import { APPROVAL_VALID_DAYS } from "../constants.js";
import { TERMINAL_TASK_STATUSES } from "../engine/sprint.js";
import { actorLabel, companyInfo, errorMessage, num, reqStr, SeoError, str, strList, type Actor, type Env, type Params } from "./common.js";
import { assertWritable, requireSprint } from "./context.js";
import { commentOn, getIssue } from "./issues.js";
import { resolveNeedsYou } from "./needs-you.js";
import { APPROVAL_DEFAULT_HOURS, delegateAgentIds, syncApplyWindow } from "./signoff.js";

export const MAX_GRANT_PAGES = 10;
const MAX_NOTE = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A page's identity for matching: host without www, plus the normalised path (protocol and www do not matter). */
function pageKey(url: string): string | null {
  const host = siteKey(url);
  return host ? `${host}${new URL(url).pathname}` : null;
}

/**
 * The pages the task already names (plan Q4): its optimization's target_url, its previews' page_url (any status), its page
 * groups' urls and the pages it dropped. Normalised and sorted; unparseable entries are left out.
 */
export async function taskPageSet(env: Env, companyId: string, task: db.SprintTask, siteUrl: string): Promise<string[]> {
  const raw: string[] = [];
  if (task.parentOptimizationId) {
    const opt = await db.getOptimization(env.ctx.db, companyId, task.parentOptimizationId);
    if (opt?.targetUrl) raw.push(opt.targetUrl);
  }
  const previews = await env.ctx.db.query(`SELECT page_url FROM ${t("previews")} WHERE company_id = $1 AND task_id = $2`, [companyId, task.id]);
  raw.push(...previews.map((r: Record<string, unknown>) => String(r.page_url ?? "")));
  for (const chunk of await db.listChunks(env.ctx.db, companyId, task.id)) raw.push(...chunk.urls);
  const dropped = ((task.evidence ?? {}) as { droppedPages?: Array<{ pageUrl?: unknown }> }).droppedPages;
  if (Array.isArray(dropped)) for (const d of dropped) if (typeof d?.pageUrl === "string") raw.push(d.pageUrl);
  return [...new Set(raw.map((u) => normalisePageUrl(u, siteUrl)).filter((u): u is string => u !== null))].sort();
}

/**
 * The Reviewer PASS for these pages (plan Q8). A page passes when the newest non-cancelled preview of the task on it has
 * review_status 'passed'. Pages without that need `reviewCommentId`: a live comment in the company by the company's Reviewer,
 * on the task issue or a child of it, under APPROVAL_VALID_DAYS old, with PASS as a word and no FAIL. Returns the review ref
 * (`comment:<id>` or `preview:<ids>`) or throws a refusal that names what is missing.
 */
export async function reviewerPass(env: Env, companyId: string, task: db.SprintTask, pages: string[], reviewCommentId: string | null): Promise<string> {
  const rows = await env.ctx.db.query(
    `SELECT id, page_url, review_status FROM ${t("previews")}
      WHERE company_id = $1 AND task_id = $2 AND status <> 'cancelled' ORDER BY created_at DESC, id DESC`,
    [companyId, task.id],
  );
  // Rows come newest first, so the first row per pageKey is the newest across every stored spelling (www, trailing slash).
  const newest = new Map<string, { id: string; status: string }>();
  for (const r of rows) {
    const key = normalisePageUrl(String(r.page_url ?? ""));
    const k = key ? pageKey(key) : null;
    if (k && !newest.has(k)) newest.set(k, { id: String(r.id), status: String(r.review_status) });
  }
  const passedIds: string[] = [];
  const missing: string[] = [];
  for (const page of pages) {
    const p = newest.get(pageKey(page)!);
    if (p?.status === "passed") passedIds.push(p.id);
    else missing.push(page);
  }
  if (missing.length === 0) return `preview:${passedIds.join(",")}`;
  if (!reviewCommentId) {
    const reviewer = await reviewerAgentId(env.ctx, companyId).catch(() => null);
    const comment = reviewer
      ? "or pass reviewCommentId: the id of the Reviewer's PASS comment on the task issue (or a child of it)"
      : "or pass reviewCommentId of a Reviewer PASS comment (no Reviewer is set up in the Cockpit for this company, so that route is closed until one is)";
    throw new SeoError(`No Reviewer PASS for ${missing.join(", ")}. Make a preview of each page with create-preview and let the Reviewer pass it, ${comment}.`);
  }
  await commentPass(env, companyId, task, reviewCommentId);
  return `comment:${reviewCommentId}`;
}

async function commentPass(env: Env, companyId: string, task: db.SprintTask, commentId: string): Promise<void> {
  const reviewer = await reviewerAgentId(env.ctx, companyId).catch(() => null);
  if (!reviewer) throw new SeoError("This company has no Reviewer set up in the Cockpit, so a review comment cannot count. Make a preview of each page with create-preview and let the Reviewer pass it.");
  if (!UUID.test(commentId)) throw new SeoError("reviewCommentId must be a comment id (uuid).");
  const rows = await env.ctx.db.query(
    `SELECT c.issue_id::text AS issue_id, c.author_agent_id::text AS author_agent_id, c.body,
            (c.created_at > now() - interval '${APPROVAL_VALID_DAYS} days') AS fresh
       FROM public.issue_comments c WHERE c.company_id = $1 AND c.id = $2::uuid AND c.deleted_at IS NULL LIMIT 1`,
    [companyId, commentId],
  );
  const row = rows[0];
  if (!row) throw new SeoError(`Comment ${commentId} was not found in this company (or was deleted).`);
  if (String(row.author_agent_id ?? "") !== reviewer) throw new SeoError(`Comment ${commentId} was not written by the company's Reviewer, so it is not a Reviewer PASS.`);
  const issueId = String(row.issue_id ?? "");
  let onTask = issueId === task.issueId;
  if (!onTask && issueId) onTask = (await getIssue(env, companyId, issueId))?.parentId === task.issueId;
  if (!onTask) throw new SeoError(`Comment ${commentId} is not on the task's issue or a child of it.`);
  if (row.fresh !== true && row.fresh !== "t" && row.fresh !== "true") throw new SeoError(`Comment ${commentId} is older than ${APPROVAL_VALID_DAYS} days; ask the Reviewer to check the change again.`);
  const body = String(row.body ?? "");
  if (!/\bPASS\b/.test(body) || /\bFAIL/.test(body)) throw new SeoError(`Comment ${commentId} is not a PASS (it must say PASS and must not say FAIL).`);
}

export interface AuthorisedGrant {
  sprint: db.Sprint;
  task: db.SprintTask;
  input: db.PageGrantInput;
}

/** What the grant gate checks, without the grant's own `note` and `hours`. */
export interface PageApplyCheck {
  sprintId: string;
  taskId: string;
  pageUrls: string[];
  reviewCommentId: string | null;
}

/** Gate step 1: who may approve at all. Throws the refusal. */
async function assertGrantActor(env: Env, companyId: string, actor: Actor): Promise<void> {
  if (actor.kind === "system") throw new SeoError("Only a person or a sign-off delegate agent can approve applying page changes.");
  if (actor.kind === "agent") {
    const delegates = await delegateAgentIds(env, companyId);
    if (!delegates.includes(actor.agentId.toLowerCase())) {
      throw new SeoError("You are not a sign-off delegate (SEO setting signoffDelegateAgentIds, saved by an instance admin). Put the change set on Needs you (needs-you-add, with the task id) for the delegate or a person.");
    }
  }
}

/**
 * Whether `actor` may approve applying these pages right now (PAR-10548 T5): every check of `authorisePageApply` except
 * parsing `note` and `hours`, in the same order and with the same sentences. Read-only. Returns the first refusal, or null
 * when the gate would say yes. A failure that is not a refusal (a database error) is thrown, never read as a yes.
 */
export async function pageApplyRefusal(env: Env, companyId: string, actor: Actor, input: PageApplyCheck): Promise<string | null> {
  try {
    await assertGrantActor(env, companyId, actor);
    await checkGrant(env, companyId, actor, input);
    return null;
  } catch (error) {
    if (error instanceof SeoError) return error.message;
    throw error;
  }
}

/** Checks the call (plan Approach 3, in that order) and returns the grant to write. Throws a SeoError naming the first refusal. */
export async function authorisePageApply(env: Env, companyId: string, actor: Actor, params: Params): Promise<AuthorisedGrant> {
  await assertGrantActor(env, companyId, actor);
  const sprintId = reqStr(params, "sprintId");
  const taskId = reqStr(params, "taskId");
  const note = reqStr(params, "note", { max: MAX_NOTE });
  const hours = num(params, "hours", { min: 1, max: 72, integer: true }) ?? APPROVAL_DEFAULT_HOURS;
  const reviewCommentId = str(params, "reviewCommentId") ?? null;
  const urls = strList(params, "pageUrls");
  const { sprint, task, pages: unique, reviewRef } = await checkGrant(env, companyId, actor, { sprintId, taskId, pageUrls: urls, reviewCommentId });

  const label = actor.kind === "agent" ? `${actorLabel(actor)} (sign-off delegate)` : actorLabel(actor);
  const applyUntil = new Date(env.now().getTime() + hours * 3_600_000).toISOString();
  return {
    sprint,
    task,
    input: {
      companyId, sprintId: sprint.id, siteId: sprint.siteId!, taskId: task.id, pageUrls: unique, grantedBy: label,
      grantedByAgentId: actor.kind === "agent" ? actor.agentId.toLowerCase() : null, reviewRef, note, applyUntil,
    },
  };
}

/** The gate after step 1 and the parse: the sprint, the task and its issue, the pages, the Reviewer PASS and the cap. Read-only. */
async function checkGrant(
  env: Env,
  companyId: string,
  actor: Actor,
  { sprintId, taskId, pageUrls: urls, reviewCommentId }: PageApplyCheck,
): Promise<{ sprint: db.Sprint; task: db.SprintTask; pages: string[]; reviewRef: string }> {
  if (urls.length < 1 || urls.length > MAX_GRANT_PAGES) throw new SeoError(`pageUrls must list 1 to ${MAX_GRANT_PAGES} pages`);

  const sprint = await requireSprint(env, companyId, sprintId);
  if (sprint.siteAccess !== "wordpress" || !sprint.siteId) throw new SeoError("This sprint is not linked to a WordPress site, so there is no lock to open.");
  if (sprint.changePolicy !== "pr_only") throw new SeoError("This sprint's change policy is not pr_only, so the agent is not held back.");
  if (sprint.clientSignoff === "auto") throw new SeoError("This sprint uses automatic client sign-off: make a preview with create-preview; the client's approval opens the window.");
  assertWritable(sprint);
  const task = await db.getTask(env.ctx.db, companyId, taskId);
  if (!task || task.sprintId !== sprint.id) throw new SeoError(`Task ${taskId} is not on this sprint.`);

  const issue = task.issueId ? await getIssue(env, companyId, task.issueId) : null;
  if (actor.kind === "agent") {
    if (!task.issueId) throw new SeoError("The task has no issue to tell, so an agent cannot approve applying its pages. Ask a person.");
    if (!issue) throw new SeoError("The task's issue could not be read, so self-approval cannot be ruled out. Try again later.");
    if (issue.assigneeAgentId && issue.assigneeAgentId.toLowerCase() === actor.agentId.toLowerCase()) {
      throw new SeoError("You are the assignee of the task's issue: no self-approval. Hand the task issue back to the SEO agent, or ask a person.");
    }
  }
  if ((TERMINAL_TASK_STATUSES as string[]).includes(task.status)) throw new SeoError(`The task is ${task.status}; there is nothing left to apply.`);
  const issueStatus = issue?.status ?? task.issueStatus;
  if (issueStatus === "done" || issueStatus === "cancelled") throw new SeoError(`The task's issue is ${issueStatus}; there is nothing left to apply.`);

  const pages: string[] = [];
  for (const url of urls) {
    const page = normalisePageUrl(url);
    if (!page) throw new SeoError(`${url} is not a page address (a full http(s) URL without ? or #).`);
    if (!sameSite(page, sprint.siteUrl)) throw new SeoError(`${url} is not on the sprint's site (${sprint.siteUrl}).`);
    pages.push(page);
  }
  const set = await taskPageSet(env, companyId, task, sprint.siteUrl);
  if (set.length === 0) throw new SeoError("The task names no page (no target URL, preview, page group or dropped page), so no page of it can be approved. Ask a person.");
  const allowed = new Set(set.map(pageKey));
  const outside = pages.filter((p) => !allowed.has(pageKey(p)));
  if (outside.length > 0) throw new SeoError(`${outside.join(", ")} is not one of the task's pages: ${set.join(", ")}.`);
  // One row per page: dedupe on pageKey so www and bare spellings of one page count once (first spelling wins).
  const byKey = new Map<string, string>();
  for (const p of pages) if (!byKey.has(pageKey(p)!)) byKey.set(pageKey(p)!, p);
  const unique = [...byKey.values()];

  const reviewRef = await reviewerPass(env, companyId, task, unique, reviewCommentId);

  // Open grant pages on the site after this call, counting a re-grant once. Race: two calls at the same moment can each see
  // room and together pass 10 (at most 10 + 10); the window still closes with each task, and revoke-page-apply stops it.
  const open = await env.ctx.db.query(
    `SELECT count(*)::int AS n FROM (SELECT page_url FROM ${t("page_apply_grants")} WHERE company_id = $1 AND site_id = $2 AND revoked_at IS NULL AND apply_until > now()
       UNION SELECT jsonb_array_elements_text($3::jsonb)) x`,
    [companyId, sprint.siteId, JSON.stringify(unique)],
  );
  const total = Number(open[0]?.n ?? 0);
  if (total > MAX_GRANT_PAGES) throw new SeoError(`This would leave ${total} pages open for applying on the site; at most ${MAX_GRANT_PAGES}. Revoke or finish other grants first.`);
  return { sprint, task, pages: unique, reviewRef };
}

/** Authorises and writes the grant rows (a repeat keeps the later apply_until, one row per page). No emit, comment or wake yet (T2b). */
export async function grantPageApply(env: Env, companyId: string, actor: Actor, params: Params): Promise<AuthorisedGrant & { written: number }> {
  const grant = await authorisePageApply(env, companyId, actor, params);
  const written = await db.upsertPageGrants(env.ctx.db, grant.input);
  return { ...grant, written };
}

export const PAGE_APPLY_RETRY = "call approve-page-apply again with the same input; it only does the missing steps";
/** The CRM's url-only write rule for a page window (plugin-crm site-signoff.ts), said to the agent with the pages. */
const URL_ONLY_RULE =
  "Change only these pages, with posts/update, posts/img-alt, seo/set or schema/set by url alone; any other write is refused and needs a new preview and approval.";

/** Whether the sprint's Needs you item `key` is already done (on any recent week). */
async function needsYouItemDone(env: Env, sprint: db.Sprint, key: string): Promise<boolean> {
  const digests = await db.recentNeedsYouDigests(env.ctx.db, sprint.companyId, sprint.id);
  return digests.some((d) => d.items.some((i) => i.key === key && i.status === "done"));
}

/**
 * approve-page-apply (plan Approach 3): authorise, then claim then effect (PAR-9133): (a) write the grants; (b) send the site's
 * window (a failure leaves the rows; the 5-minute job re-sends); (c) resolve `needsYouKey` (an item already done counts);
 * (d) claim the notice and, only when this call claimed a new `apply_until`, comment on the task issue and wake it. A failed
 * comment gives the claim back, so a repeat call posts it; the same input again posts nothing.
 */
export async function approvePageApply(env: Env, companyId: string, actor: Actor, params: Params) {
  const needsYouKey = str(params, "needsYouKey", { max: 120 }) ?? null;
  const { sprint, task, input } = await authorisePageApply(env, companyId, actor, params);
  await db.upsertPageGrants(env.ctx.db, input);
  const pages = input.pageUrls;
  const warnings: string[] = [];
  let failed = false;

  let windowSent = false;
  try {
    await syncApplyWindow(env, sprint, input.grantedBy);
    windowSent = true;
  } catch (error) {
    failed = true;
    warnings.push(`The apply window did not reach the CRM yet (${errorMessage(error)}); the grant is saved and the 5-minute job sends it.`);
  }

  let needsYouResolved = false;
  if (needsYouKey) {
    try {
      const result = await resolveNeedsYou(env, await companyInfo(env, companyId), sprint, needsYouKey, input.grantedBy, input.note, { person: actor.kind === "user" });
      if (result.resolved || (!result.stillOpen && (await needsYouItemDone(env, sprint, needsYouKey)))) needsYouResolved = true;
      else if (result.stillOpen) {
        failed = true;
        warnings.push(result.stillOpen);
      } else warnings.push(`No Needs you item ${needsYouKey} on this sprint; nothing was resolved.`);
    } catch (error) {
      failed = true;
      warnings.push(`Needs you item ${needsYouKey} was not resolved (${errorMessage(error)}).`);
    }
  }

  const open = (await db.openPageGrants(env.ctx.db, companyId, task.id)).filter((g) => pages.includes(g.pageUrl));
  const applyUntil = open.map((g) => g.applyUntil).sort().at(-1) ?? input.applyUntil;
  let issueNotified = false;
  if (task.issueId) {
    const claimed = await db.claimGrantNotice(env.ctx.db, companyId, task.id, pages);
    if (claimed === 0) issueNotified = true; // this apply_until was already told
    else {
      const body = [
        `Approved to apply by ${input.grantedBy}, until ${applyUntil}:`,
        ...pages.map((p) => `- ${p}`),
        "",
        `Note: ${input.note}`,
        `Review: ${input.reviewRef}`,
        "",
        `${URL_ONLY_RULE} Then verify each page live with check-meta and complete-task with the evidence.`,
      ].join("\n");
      if (await commentOn(env, companyId, task.issueId, body, { dedupeKey: `page-apply:${task.id}:${applyUntil}` })) {
        issueNotified = true;
        await wakeIssue(env.ctx, task.issueId, companyId, "Page changes approved: apply them");
      } else {
        failed = true;
        warnings.push("The task issue could not be told.");
        await db.releaseGrantNotice(env.ctx.db, companyId, task.id, pages).catch((error: unknown) => {
          env.ctx.logger.info("SEO grant notice release failed", { taskId: task.id, error: errorMessage(error) });
        });
      }
    }
  }
  return {
    sprintId: sprint.id, siteId: sprint.siteId, taskId: task.id, pages, applyUntil, windowSent, needsYouResolved, issueNotified,
    ...(warnings.length > 0 ? { warnings } : {}), ...(failed ? { retry: PAGE_APPLY_RETRY } : {}),
  };
}

/**
 * revoke-page-apply (plan Approach 4): a person, or a sign-off delegate (any grant on the site), closes the task's open grants
 * (`pageUrls` empty = all), re-sends the window and tells the task issue once. Nothing open: `revoked: 0`, no comment.
 */
export async function revokePageApply(env: Env, companyId: string, actor: Actor, params: Params) {
  if (actor.kind === "system") throw new SeoError("Only a person or a sign-off delegate agent can revoke a page apply grant.");
  if (actor.kind === "agent" && !(await delegateAgentIds(env, companyId)).includes(actor.agentId.toLowerCase())) {
    throw new SeoError("You are not a sign-off delegate (SEO setting signoffDelegateAgentIds), so you cannot revoke a page apply grant. Ask the delegate or a person.");
  }
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const taskId = reqStr(params, "taskId");
  const task = await db.getTask(env.ctx.db, companyId, taskId);
  if (!task || task.sprintId !== sprint.id) throw new SeoError(`Task ${taskId} is not on this sprint.`);
  const wanted = strList(params, "pageUrls").map((url) => {
    const page = normalisePageUrl(url);
    if (!page) throw new SeoError(`${url} is not a page address (a full http(s) URL without ? or #).`);
    return pageKey(page);
  });
  const open = await db.openPageGrants(env.ctx.db, companyId, task.id);
  const target = open.map((g) => g.pageUrl).filter((p) => wanted.length === 0 || wanted.includes(pageKey(p)));
  const label = actor.kind === "agent" ? `${actorLabel(actor)} (sign-off delegate)` : actorLabel(actor);
  const revoked = target.length > 0 ? await db.revokePageGrants(env.ctx.db, companyId, task.id, target, label) : 0;
  if (revoked === 0) return { sprintId: sprint.id, siteId: sprint.siteId, taskId: task.id, revoked: 0, pages: [] };

  const warnings: string[] = [];
  let windowSent = false;
  try {
    await syncApplyWindow(env, sprint, label);
    windowSent = true;
  } catch (error) {
    warnings.push(`The closed window did not reach the CRM yet (${errorMessage(error)}); the 5-minute job re-sends it within the hour.`);
  }
  let issueNotified = false;
  if (task.issueId) {
    issueNotified = await commentOn(env, companyId, task.issueId, `The apply window is closed for ${target.join(", ")} (${label}): do not write to these pages.`);
    if (!issueNotified) warnings.push("The task issue could not be told.");
  }
  return { sprintId: sprint.id, siteId: sprint.siteId, taskId: task.id, revoked, pages: target, windowSent, issueNotified, ...(warnings.length > 0 ? { warnings } : {}) };
}
