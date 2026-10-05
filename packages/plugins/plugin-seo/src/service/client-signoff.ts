/**
 * Automatic client sign-off (a sprint with `clientSignoff: "auto"` on a pr_only WordPress site). A person used to carry every
 * preview from the Reviewer to the client and back; here the plugin does the waiting and the paperwork, a person only reads
 * and sends the one email draft:
 *
 *  1. The Reviewer passes a preview → the task parks on the client (blocked, not the agent's, not in flight), so the rest of
 *     the week carries on. The agent is not woken.
 *  2. The 5-minute job batches passed previews into ONE approval email, drafted in Gmail (Mailbox `mail.draft.requested`),
 *     and puts one "send this draft" line on Needs you.
 *  3. The client presses Approve or Request changes on the preview link (recorded by the preview service).
 *  4. When the client has answered every preview of a task, the plugin lifts the sign-off lock for a short window, takes the
 *     task back to the SEO agent and wakes it with what to apply and what to revise.
 *
 * The client's Approve click is the go-ahead. Nothing here edits a site: applying is the agent's work through the Connector,
 * and it can only write while the window is open.
 */
import { MAIL_EVENTS, PIB_PLUGINS, pluginEvent, wakeIssue, type MailDraftRequested, type MailDraftResult } from "@partnersinbiz/pib-plugin-kit";
import { createHash } from "node:crypto";
import * as db from "../db.js";
import { t } from "../db.js";
import { approvalEmail, approverAddresses } from "../engine/approval-email.js";
import { isRehearsalSprint } from "../engine/rehearsal.js";
import { SIGNOFF_MODES, type SignoffMode } from "../engine/sprint.js";
import { actorLabel, companyInfo, errorMessage, oneOf, reqStr, SeoError, type Actor, type Env, type Params } from "./common.js";
import { assertWritable, loadSprintContext } from "./context.js";
import { commentOn, patchIssue } from "./issues.js";
import { closeNeedsYouItems, addNeedsYou } from "./needs-you.js";
import { previewLink } from "./preview-links.js";
import { liftWriteLock } from "./signoff.js";

/** How long the client's approval keeps the sign-off lock open for the agent to apply it. */
export const AUTO_APPLY_HOURS = 6;
/** The previews of tasks that are parked on the client become one email once nothing new has been parked for this long, or the oldest has waited the maximum. */
export const DRAFT_QUIET_MINUTES = 10;
export const DRAFT_MAX_WAIT_HOURS = 1;
export const DRAFT_KIND = "seo-approval";
const PREVIEW_OPEN_DAYS = 30;

export function isAutoSignoff(sprint: Pick<db.Sprint, "clientSignoff" | "changePolicy" | "siteAccess" | "siteUrl" | "clientRef">): boolean {
  return sprint.clientSignoff === "auto" && sprint.changePolicy === "pr_only" && sprint.siteAccess === "wordpress" && !isRehearsalSprint(sprint);
}

interface TaskPreview {
  id: string;
  pageUrl: string;
  title: string;
  status: string;
  reviewStatus: string;
  note: string | null;
  handedAt: string | null;
  draftKey: string | null;
}

/** The newest preview of each page of a task (an older one for the same page is superseded). */
async function latestTaskPreviews(env: Env, companyId: string, taskId: string): Promise<TaskPreview[]> {
  const rows = await env.ctx.db.query(
    `SELECT DISTINCT ON (page_url) id, page_url, title, status, review_status, decision_note, handed_at, draft_key
       FROM ${t("previews")} WHERE company_id = $1 AND task_id = $2 AND expires_at > now() ORDER BY page_url, created_at DESC`,
    [companyId, taskId],
  );
  return rows.map((r) => ({
    id: String(r.id),
    pageUrl: String(r.page_url),
    title: String(r.title),
    status: String(r.status),
    reviewStatus: String(r.review_status ?? "pending"),
    note: r.decision_note ? String(r.decision_note) : null,
    handedAt: r.handed_at ? String(r.handed_at) : null,
    draftKey: r.draft_key ? String(r.draft_key) : null,
  }));
}

/**
 * The Reviewer passed a preview of an auto sprint. When every preview of the task has been looked at and none is with the
 * agent for changes, the task parks on the client. Returns what happened.
 */
export async function afterPreviewPassed(env: Env, sprint: db.Sprint, taskId: string | null, issueId: string | null): Promise<"parked" | "waiting" | "agent" | "off"> {
  if (!isAutoSignoff(sprint) || !taskId) return "off";
  const task = await db.getTask(env.ctx.db, sprint.companyId, taskId);
  if (!task || !task.issueId) return "off";
  const previews = await latestTaskPreviews(env, sprint.companyId, taskId);
  // A preview still waiting for the Reviewer: the task stays parked for the Reviewer until the last verdict.
  if (previews.some((p) => p.reviewStatus === "pending")) return "waiting";
  // The agent is revising something the Reviewer sent back: do not take the task from it.
  if (task.status !== "blocked" || task.assigneeKind !== "reviewer") return "agent";
  const waiting = previews.filter((p) => p.status === "pending" && p.reviewStatus === "passed");
  if (waiting.length === 0) return "agent";
  await db.updateTask(env.ctx.db, sprint.companyId, task.id, {
    assignee_kind: "client",
    blocker_reason: `Waiting for the client to answer ${waiting.length === 1 ? "the preview of" : `${waiting.length} previews:`} ${waiting.map((p) => p.pageUrl).slice(0, 3).join(", ")}${waiting.length > 3 ? ", …" : ""}`,
  });
  const target = issueId ?? task.issueId;
  await commentOn(
    env,
    sprint.companyId,
    target,
    `The Reviewer passed ${waiting.length === 1 ? "the preview" : "the previews"}. The plugin drafts one approval email for the client (a person sends it from Gmail) and takes it from there: this task is parked on the client and you are woken once they have answered every preview of it. Nothing to do now; carry on with the next task.`,
    { dedupeKey: `signoff-parked:${task.id}` },
  );
  return "parked";
}

// ---------------------------------------------------------------------------
// The approval email draft
// ---------------------------------------------------------------------------

async function approvers(env: Env, sprint: db.Sprint): Promise<Array<{ email: string; name: string }>> {
  if (!sprint.clientRef) return [];
  const rows =
    sprint.clientKind === "contact"
      ? await env.ctx.db.query(`SELECT name, emails FROM ${t("crm_contacts")} WHERE company_id = $1 AND id = $2 AND NOT deleted LIMIT 1`, [sprint.companyId, sprint.clientRef])
      : await env.ctx.db.query(`SELECT name, emails FROM ${t("crm_contacts")} WHERE company_id = $1 AND $2 = ANY(account_ids) AND NOT deleted ORDER BY name LIMIT 20`, [sprint.companyId, sprint.clientRef]);
  const contacts = rows.map((r) => ({ name: String(r.name ?? ""), emails: (Array.isArray(r.emails) ? r.emails : []).map(String) }));
  return approverAddresses(contacts, new URL(sprint.siteUrl).hostname);
}

export function draftKeyFor(sprintId: string, previewIds: string[]): string {
  return `seo-approval:${sprintId}:${createHash("sha1").update([...previewIds].sort().join(",")).digest("hex").slice(0, 16)}`;
}

/** Passed, unanswered, not yet in a draft, and its task is parked on the client (every preview of the task has been looked at): the newest preview of each page. */
async function previewsToDraft(env: Env, sprint: db.Sprint): Promise<Array<{ id: string; pageUrl: string; title: string; reviewedAt: Date }>> {
  const rows = await env.ctx.db.query(
    `SELECT id, page_url, title, reviewed_at FROM (
        SELECT DISTINCT ON (page_url) id, page_url, title, reviewed_at, status, review_status, draft_key, expires_at, task_id
          FROM ${t("previews")} WHERE company_id = $1 AND sprint_id = $2 ORDER BY page_url, created_at DESC
      ) latest
      WHERE status = 'pending' AND review_status = 'passed' AND draft_key IS NULL AND expires_at > now()
        AND (task_id IS NULL OR task_id IN (SELECT id FROM ${t("sprint_tasks")} WHERE company_id = $1 AND assignee_kind = 'client'))
      ORDER BY reviewed_at`,
    [sprint.companyId, sprint.id],
  );
  return rows.map((r) => ({ id: String(r.id), pageUrl: String(r.page_url), title: String(r.title), reviewedAt: new Date(String(r.reviewed_at)) }));
}

/** Runs from the 5-minute job: one approval email draft per batch of passed previews, per auto sprint. Returns how many drafts it requested. */
export async function draftApprovalRequests(env: Env): Promise<number> {
  const sprints = (await env.ctx.db.query(`SELECT id, company_id FROM ${t("sprints")} WHERE client_signoff = 'auto' AND status = 'active'`)).map((r) => ({ id: String(r.id), companyId: String(r.company_id) }));
  let requested = 0;
  for (const ref of sprints) {
    try {
      const sprint = await db.getSprint(env.ctx.db, ref.companyId, ref.id);
      if (!sprint || !isAutoSignoff(sprint)) continue;
      const waiting = await previewsToDraft(env, sprint);
      if (waiting.length === 0) continue;
      const now = env.now().getTime();
      const newest = Math.max(...waiting.map((p) => p.reviewedAt.getTime()));
      const oldest = Math.min(...waiting.map((p) => p.reviewedAt.getTime()));
      // Let a task's previews finish passing, so the client gets one email, not one per page.
      if (now - newest < DRAFT_QUIET_MINUTES * 60_000 && now - oldest < DRAFT_MAX_WAIT_HOURS * 3_600_000) continue;
      const key = draftKeyFor(sprint.id, waiting.map((p) => p.id));
      const claimed = await env.ctx.db.execute(
        `UPDATE ${t("previews")} SET draft_key = $3, draft_status = 'requested', drafted_at = now() WHERE company_id = $1 AND sprint_id = $2 AND id IN (SELECT jsonb_array_elements_text($4::jsonb)) AND draft_key IS NULL`,
        [sprint.companyId, sprint.id, key, JSON.stringify(waiting.map((p) => p.id))],
      );
      if (!claimed.rowCount) continue;
      const to = await approvers(env, sprint);
      const mail = approvalEmail({
        siteName: sprint.siteName,
        firstNames: to.map((a) => a.name.split(/\s+/)[0] ?? ""),
        pages: waiting.map((p) => ({ title: p.title, pageUrl: p.pageUrl, link: previewLink(p.pageUrl, p.id) })),
        openDays: PREVIEW_OPEN_DAYS,
        signature: "Partners in Biz",
      });
      const request: MailDraftRequested = {
        key,
        to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        context: { plugin: PIB_PLUGINS.seo, kind: DRAFT_KIND, id: sprint.id, clientKind: sprint.clientKind, clientRef: sprint.clientRef },
      };
      try {
        await env.ctx.events.emit(MAIL_EVENTS.draftRequested, sprint.companyId, request as unknown as Record<string, unknown>);
        requested += 1;
      } catch (error) {
        // Not sent: free the previews so the next run asks again.
        await env.ctx.db.execute(`UPDATE ${t("previews")} SET draft_key = NULL, draft_status = NULL, drafted_at = NULL WHERE company_id = $1 AND draft_key = $2`, [sprint.companyId, key]);
        throw error;
      }
    } catch (error) {
      env.ctx.logger.info("SEO approval draft not requested", { sprintId: ref.id, error: errorMessage(error) });
    }
  }
  return requested;
}

/** Gmail opens a draft with `?authuser=<account>`; the older `u/<account>/` form shows a 404 where the account is not the first one signed in. */
export function gmailDraftLink(url: string | null | undefined): string | null {
  if (!url) return null;
  const old = /^https:\/\/mail\.google\.com\/mail\/u\/([^/]+)\/(#.*)$/.exec(url);
  return old && old[1] && old[1].includes("@") ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(decodeURIComponent(old[1]))}${old[2]}` : url;
}

/** Drafts made before the link fix: rewrite the stored link and refresh the Needs you line. Returns how many it repaired. */
export async function repairDraftLinks(env: Env): Promise<number> {
  const rows = await env.ctx.db.query(
    `SELECT DISTINCT company_id, sprint_id, draft_key, draft_url FROM ${t("previews")} WHERE draft_status = 'drafted' AND draft_url LIKE 'https://mail.google.com/mail/u/%@%' LIMIT 20`,
  );
  let repaired = 0;
  for (const row of rows) {
    const draftUrl = gmailDraftLink(String(row.draft_url));
    if (!draftUrl || draftUrl === String(row.draft_url)) continue;
    await onDraftResult(env, {
      companyId: String(row.company_id),
      payload: { key: String(row.draft_key), status: "drafted", draftUrl, context: { plugin: PIB_PLUGINS.seo, kind: DRAFT_KIND, id: String(row.sprint_id) } },
    });
    repaired += 1;
  }
  return repaired;
}

/** The Mailbox answered a draft request: record the Gmail link and put one line on Needs you (a person reads and sends it). */
export async function onDraftResult(env: Env, event: { companyId?: string | null; payload?: unknown }): Promise<void> {
  const result = (event.payload ?? {}) as Partial<MailDraftResult>;
  if (!result.key || result.context?.plugin !== PIB_PLUGINS.seo || result.context.kind !== DRAFT_KIND) return;
  const sprintId = result.context.id;
  const companyId = event.companyId;
  if (!companyId) return;
  const sprint = await db.getSprint(env.ctx.db, companyId, sprintId);
  if (!sprint) return;
  const drafted = result.status === "drafted";
  result.draftUrl = gmailDraftLink(result.draftUrl);
  await env.ctx.db.execute(`UPDATE ${t("previews")} SET draft_status = $3, draft_url = $4 WHERE company_id = $1 AND draft_key = $2`, [companyId, result.key, drafted ? "drafted" : "failed", result.draftUrl ?? null]);
  const rows = await env.ctx.db.query(`SELECT id, page_url, title FROM ${t("previews")} WHERE company_id = $1 AND draft_key = $2 ORDER BY created_at`, [companyId, result.key]);
  const pages = rows.map((r) => ({ title: String(r.title), pageUrl: String(r.page_url), link: previewLink(String(r.page_url), String(r.id)) }));
  const info = await companyInfo(env, companyId);
  const noun = pages.length === 1 ? "1 page" : `${pages.length} pages`;
  await addNeedsYou(env, info, sprint, {
    key: `approval-email:${result.key}`.slice(0, 120),
    kind: "task",
    title: drafted ? `Send the approval email to the client (${noun})` : `Send the approval links to the client (${noun}): the email draft could not be made`,
    why: drafted
      ? `The Reviewer passed ${noun} for ${sprint.siteName}. The email is drafted in your Gmail (to the client's contacts on their own domain). Nothing changes on their site until they approve.`
      : `The Reviewer passed ${noun} for ${sprint.siteName} but the Gmail draft failed (${result.error ?? "unknown error"}). Send the links yourself.`,
    steps: drafted ? ["Open the draft in Gmail, check the addresses and the wording.", "Press Send."] : ["Send each link to the client with a short note.", ...pages.map((p) => `${p.title}: ${p.link}`)],
    links: drafted && result.draftUrl ? [{ label: "Gmail draft", url: result.draftUrl }] : pages.map((p) => ({ label: p.title.slice(0, 60), url: p.link })),
    after: "The client's answers are picked up automatically: approved pages are applied by the SEO agent, change requests go back to it.",
    check: "manual",
    taskIds: [],
  }).catch((error: unknown) => env.ctx.logger.info("SEO approval email line not added", { sprintId, error: errorMessage(error) }));
  if (sprint.rootIssueId && drafted) await commentOn(env, companyId, sprint.rootIssueId, `Approval email drafted in Gmail for ${noun}: ${result.draftUrl ?? "(open Gmail drafts)"}`, { dedupeKey: `draft:${result.key}` });
}

// ---------------------------------------------------------------------------
// The client's answers
// ---------------------------------------------------------------------------

export interface AnsweredPreview {
  id: string;
  companyId: string;
  sprintId: string;
  taskId: string | null;
  issueId: string | null;
  pageUrl: string;
  title: string;
  status: string;
  note: string | null;
  draftKey: string | null;
}

/**
 * One client answer on an auto sprint. Closes the "send the email" line, and once the client has answered every preview of the
 * task, lifts the lock, takes the task back and wakes the agent. Returns true when the answer was handled here.
 */
export async function handleClientAnswer(env: Env, sprint: db.Sprint, answer: AnsweredPreview): Promise<boolean> {
  if (!isAutoSignoff(sprint) || !answer.taskId) return false;
  if (answer.draftKey) {
    const info = await companyInfo(env, sprint.companyId);
    await closeNeedsYouItems(env, info, sprint, [`approval-email:${answer.draftKey}`.slice(0, 120)], "client", "The client has answered.").catch(() => 0);
  }
  const task = await db.getTask(env.ctx.db, sprint.companyId, answer.taskId);
  if (!task || !task.issueId) return true;
  const previews = await latestTaskPreviews(env, sprint.companyId, task.id);
  // Still with the client or the Reviewer: wait, so the agent gets one wake with the whole answer.
  if (previews.some((p) => p.status === "pending" && (p.reviewStatus === "passed" || p.reviewStatus === "pending"))) return true;
  const approved = previews.filter((p) => p.status === "approved" && !p.handedAt);
  const changes = previews.filter((p) => p.status === "changes_requested" && !p.handedAt);
  if (approved.length === 0 && changes.length === 0) return true;
  let until: string | null = null;
  if (approved.length > 0) until = await liftWriteLock(env, sprint, `client-approval:${task.id}`, AUTO_APPLY_HOURS);
  const lines = [
    `The client has answered every preview of this task.`,
    ...(approved.length > 0
      ? ["", `**Approved: apply these now through the Connector** (the sign-off lock is open until ${until}):`, ...approved.map((p) => `- ${p.pageUrl} (preview ${p.id}, "${p.title}")`)]
      : []),
    ...(changes.length > 0
      ? ["", "**Changes requested: revise these and make new previews** (the Reviewer checks them; do not apply them):", ...changes.map((p) => `- ${p.pageUrl}${p.note ? `: ${p.note.replace(/\s+/g, " ").slice(0, 300)}` : ""}`)]
      : []),
    "",
    "Rules: apply only the approved previews and nothing else; read each page back and check it live (cache-busting load, phone and desktop); complete this task only when every page of it is applied or dropped. New previews for requested changes park this task again by themselves: end your turn after making them.",
  ];
  const unparked = task.status === "blocked" && task.assigneeKind === "client";
  if (unparked && !(await patchIssue(env, sprint.companyId, task.issueId, { status: "todo" }))) return true;
  if (unparked) await db.updateTask(env.ctx.db, sprint.companyId, task.id, { status: "in_progress", issue_status: "todo", assignee_kind: "agent", blocker_reason: null });
  const handed = [...approved, ...changes].map((p) => p.id);
  await env.ctx.db.execute(`UPDATE ${t("previews")} SET handed_at = now() WHERE company_id = $1 AND id IN (SELECT jsonb_array_elements_text($2::jsonb))`, [sprint.companyId, JSON.stringify(handed)]);
  if (await commentOn(env, sprint.companyId, task.issueId, lines.join("\n"))) await wakeIssue(env.ctx, task.issueId, sprint.companyId, "The client answered: apply what was approved");
  return true;
}

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

/** A person chooses how client sign-off works for a sprint (page-only). */
export async function setSignoffMode(env: Env, companyId: string, actor: Actor, params: Params) {
  if (actor.kind !== "user" || !actor.userId?.trim()) throw new SeoError("Only a signed-in person can change how client sign-off works.");
  const { sprint } = await loadSprintContext(env, companyId, reqStr(params, "sprintId"));
  assertWritable(sprint);
  const mode = oneOf(params, "mode", SIGNOFF_MODES as readonly SignoffMode[]);
  if (!mode) throw new SeoError('Send mode: "auto" (the plugin waits for the client, drafts the email and applies what they approve) or "manual".');
  if (mode === sprint.clientSignoff) return { sprintId: sprint.id, mode, unchanged: true };
  if (mode === "auto" && (sprint.changePolicy !== "pr_only" || sprint.siteAccess !== "wordpress")) {
    throw new SeoError("Automatic client sign-off is for a WordPress site on the pr_only change policy: that is where the client's approval is what unlocks the site.");
  }
  await db.updateSprint(env.ctx.db, companyId, sprint.id, { client_signoff: mode });
  if (sprint.rootIssueId) {
    await commentOn(env, companyId, sprint.rootIssueId, mode === "auto" ? `Client sign-off set to automatic by ${actorLabel(actor)}: passed previews are emailed to the client as a Gmail draft, and what the client approves is applied by the SEO agent.` : `Client sign-off set to manual by ${actorLabel(actor)}.`);
  }
  return { sprintId: sprint.id, mode, previous: sprint.clientSignoff };
}

export const DRAFT_RESULT_EVENT = pluginEvent(PIB_PLUGINS.mailbox, MAIL_EVENTS.draftResult);
