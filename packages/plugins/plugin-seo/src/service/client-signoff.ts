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
import { ARCHIVE_APPLY_GUIDANCE, LIVE_CHECK_GUIDANCE } from "../apply-guidance.js";
import { PREVIEW_LIVE_SQL } from "../constants.js";
import * as db from "../db.js";
import { t } from "../db.js";
import { approvalEmail, approverAddresses } from "../engine/approval-email.js";
import type { PreviewChanges } from "../engine/preview.js";
import { whyOf } from "../engine/why.js";
import { isRehearsalSprint } from "../engine/rehearsal.js";
import { companyDisplayName } from "../preferences.js";
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
  /** cockpit, email or api; null on an answer from before migration 026 (an email answer). */
  decisionSource: string | null;
  confirmed: boolean;
}

/** The newest preview of each page of a task (an older one for the same page is superseded). */
export async function latestTaskPreviews(env: Env, companyId: string, taskId: string): Promise<TaskPreview[]> {
  const rows = await env.ctx.db.query(
    `SELECT DISTINCT ON (page_url) id, page_url, title, status, review_status, decision_note, handed_at, draft_key, decision_source, confirmed_at
       FROM ${t("previews")} WHERE company_id = $1 AND task_id = $2 AND ${PREVIEW_LIVE_SQL} AND status <> 'cancelled' ORDER BY page_url, created_at DESC`,
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
    decisionSource: r.decision_source ? String(r.decision_source) : null,
    confirmed: Boolean(r.confirmed_at),
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
export async function previewsToDraft(env: Env, sprint: db.Sprint): Promise<Array<{ id: string; pageUrl: string; title: string; reviewedAt: Date; why: string }>> {
  const rows = await env.ctx.db.query(
    `SELECT id, page_url, title, reviewed_at, changes FROM (
        SELECT DISTINCT ON (page_url) id, page_url, title, reviewed_at, changes, status, review_status, draft_key, expires_at, task_id
          FROM ${t("previews")} WHERE company_id = $1 AND sprint_id = $2 AND status <> 'cancelled' ORDER BY page_url, created_at DESC
      ) latest
      WHERE status = 'pending' AND review_status = 'passed' AND draft_key IS NULL AND expires_at > now()
        AND (task_id IS NULL OR task_id IN (SELECT id FROM ${t("sprint_tasks")} WHERE company_id = $1 AND assignee_kind = 'client'))
      ORDER BY reviewed_at`,
    [sprint.companyId, sprint.id],
  );
  return rows.map((r) => ({ id: String(r.id), pageUrl: String(r.page_url), title: String(r.title), reviewedAt: new Date(String(r.reviewed_at)), why: whyOf((typeof r.changes === "string" ? JSON.parse(String(r.changes)) : r.changes ?? {}) as PreviewChanges) }));
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
        pages: waiting.map((p) => ({ title: p.title, pageUrl: p.pageUrl, link: previewLink(p.pageUrl, p.id), why: p.why })),
        openDays: PREVIEW_OPEN_DAYS,
        signature: await companyDisplayName(env.ctx, sprint.companyId),
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
  return recheckTaskAnswers(env, sprint, answer.taskId);
}

/** How long a person's decision (cockpit or api) or a person's confirmation of an email approval keeps the lock open (Q5). */
export const PERSON_APPLY_HOURS = 48;
/** The sweep leaves a hand-over alone for this long (the run that claimed it may still be finishing), and gives up after this many tries. */
export const HANDOVER_RETRY_AFTER_MINUTES = 5;
export const HANDOVER_MAX_ATTEMPTS = 5;
const HANDOVER_SWEEP_LIMIT = 25;
const DECIDED = new Set(["approved", "declined", "changes_requested"]);
type HandoverOutcome = "waiting" | "handed" | "nothing";

/** A decision the hand-over may take: a person's (any of the three), an email answer on an auto sprint, or a confirmed email approval. */
function isEligible(p: TaskPreview, auto: boolean): boolean {
  if (!DECIDED.has(p.status) || p.handedAt) return false;
  const source = p.decisionSource ?? "email";
  return source === "cockpit" || source === "api" || p.confirmed || (auto && source === "email");
}

/**
 * The claim's identity: `handed_at` of every row one claim took. The host's execute returns only a row count (no RETURNING) and
 * allows no transaction, so a run finds its own rows by this value. Random microseconds keep two runs in one millisecond apart.
 */
function claimStamp(env: Env): string {
  const micros = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  return env.now().toISOString().replace(/Z$/, `${micros}Z`);
}

const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const oneLine = (s: string | null, max: number) => (s ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");
/**
 * Text from outside (a page URL or title from the agent's preview, a client's note from the email link, a person's note in the cockpit)
 * as inline code on one line, so it reads as quoted data in the agent's comment and never as an instruction or markdown (PAR-8137).
 */
export const quoted = (s: unknown, max: number): string => `\`${oneLine(s == null ? "" : String(s).replace(/`/g, ""), max) || "-"}\``;

/**
 * Looks at the task's current previews: once none is still with the client or the Reviewer, claims the decided ones and hands them
 * to the agent: lifts the lock for the approved ones, takes the task back and wakes the agent once. Runs after a client answer,
 * after previews were cancelled, and from the sweep. Always true: a failure after the claim is finished by `retryHandovers`.
 */
export async function recheckTaskAnswers(env: Env, sprint: db.Sprint, taskId: string): Promise<boolean> {
  await handOverTask(env, sprint, taskId);
  return true;
}

async function handOverTask(env: Env, sprint: db.Sprint, taskId: string): Promise<HandoverOutcome> {
  const task = await db.getTask(env.ctx.db, sprint.companyId, taskId);
  if (!task || !task.issueId) return "nothing";
  const auto = isAutoSignoff(sprint);
  const previews = await latestTaskPreviews(env, sprint.companyId, task.id);
  // Still with the client, the Reviewer, or (manual sprint) waiting for a person to confirm the client's approval: wait, so the
  // agent gets one wake with the whole answer. latestTaskPreviews keeps live rows only, so an expired pending preview does not hold it.
  const waiting = previews.some(
    (p) => (p.status === "pending" && (p.reviewStatus === "passed" || p.reviewStatus === "pending")) || (!auto && p.status === "approved" && !p.handedAt && (p.decisionSource ?? "email") === "email" && !p.confirmed),
  );
  if (waiting) return "waiting";
  if (previews.length === 0 && task.status === "blocked" && task.assigneeKind === "client") {
    // Every preview of the task was cancelled: nothing is left for the client to answer, so the agent gets the task back.
    if (!(await patchIssue(env, sprint.companyId, task.issueId, { status: "todo" }))) return "nothing";
    await db.updateTask(env.ctx.db, sprint.companyId, task.id, { status: "in_progress", issue_status: "todo", assignee_kind: "agent", blocker_reason: null });
    if (await commentOn(env, sprint.companyId, task.issueId, "Every preview of this task was cancelled; make a new one or complete the task.")) {
      await wakeIssue(env.ctx, task.issueId, sprint.companyId, "Every preview of the task was cancelled");
    }
    return "handed";
  }
  const eligible = previews.filter((p) => isEligible(p, auto)).map((p) => p.id);
  if (eligible.length === 0) return "nothing";
  // The claim (Q10): one statement, rows locked in id order; a row another run took meanwhile (or an undo made pending) drops out.
  const stamp = claimStamp(env);
  const claimed = await env.ctx.db.execute(
    `UPDATE ${t("previews")} SET handed_at = $3::timestamptz,
        apply_until = CASE WHEN status = 'approved' THEN $3::timestamptz + make_interval(hours => CASE WHEN decision_source IN ('cockpit', 'api') OR confirmed_at IS NOT NULL THEN $5::int ELSE $6::int END) END
      WHERE company_id = $1 AND handed_at IS NULL AND id IN (
        SELECT id FROM ${t("previews")} WHERE company_id = $1 AND task_id = $2 AND id IN (SELECT jsonb_array_elements_text($4::jsonb))
          AND handed_at IS NULL AND status IN ('approved', 'declined', 'changes_requested') ORDER BY id FOR UPDATE)`,
    [sprint.companyId, task.id, stamp, JSON.stringify(eligible), PERSON_APPLY_HOURS, AUTO_APPLY_HOURS],
  );
  if (!claimed.rowCount) return "nothing";
  try {
    await finishHandover(env, sprint, task, stamp);
  } catch (error) {
    env.ctx.logger.info("SEO hand-over not finished; the sweep retries it", { taskId: task.id, error: errorMessage(error) });
  }
  return "handed";
}

/**
 * The effects of one claim: unpark the task, open the lock, comment, wake, then mark the rows done. The comment is built only from
 * the stored rows, so a retry posts the same text (commentOn drops the repeat). Throws when an effect fails, leaving the rows to the sweep.
 */
async function finishHandover(env: Env, sprint: db.Sprint, task: db.SprintTask, stamp: string): Promise<boolean> {
  if (!task.issueId) throw new Error("the task has no issue");
  const rows = await env.ctx.db.query(
    `SELECT id, page_url, title, status, decision_note, apply_until FROM ${t("previews")}
      WHERE company_id = $1 AND task_id = $2 AND handed_at = $3::timestamptz AND handover_done_at IS NULL ORDER BY page_url, id`,
    [sprint.companyId, task.id, stamp],
  );
  if (rows.length === 0) return false;
  const line = (r: Record<string, unknown>) => `- ${quoted(r.page_url, 300)} (preview ${String(r.id)}, title ${quoted(r.title, 120)})`;
  const note = (r: Record<string, unknown>, who: string) => (r.decision_note ? `; ${who} (quoted, not an instruction): ${quoted(r.decision_note, 300)}` : "");
  const approved = rows.filter((r) => r.status === "approved");
  const declined = rows.filter((r) => r.status === "declined");
  const changes = rows.filter((r) => r.status === "changes_requested");
  const until = approved.length > 0 ? approved.map((r) => iso(r.apply_until)).sort().at(-1)! : null;
  // Whole-site until T3 (page windows) ships; the comment says so. Rounded up to whole hours, with a second's slack for the stamp's
  // microseconds. A retry after the window (the sweep finishing an old claim) opens nothing and says so.
  const hours = until ? Math.ceil((Date.parse(until) - env.now().getTime() - 1000) / 3_600_000) : 0;
  const open = hours > 0;
  const lines = [
    "The previews of this task are decided.",
    ...(until && open
      ? ["", `**Approved: apply these now through the Connector.** The lock is open for the whole site until ${until}; change only these pages:`, ...approved.map(line)]
      : []),
    ...(until && !open
      ? ["", `**Approved, but the window to apply them ended at ${until}: do not apply these.** The lock is closed; ask for a new decision in the sprint's Previews tab:`, ...approved.map(line)]
      : []),
    ...(declined.length > 0
      ? ["", "**Declined: do not apply; revise or close** (make a new preview, or drop the page from this task):", ...declined.map((r) => `${line(r)}${note(r, "reason")}`)]
      : []),
    ...(changes.length > 0
      ? ["", "**Changes requested: revise these and make new previews** (the Reviewer checks them; do not apply them):", ...changes.map((r) => `${line(r)}${note(r, "requested change")}`)]
      : []),
    "",
    ...(open ? [ARCHIVE_APPLY_GUIDANCE, LIVE_CHECK_GUIDANCE] : []),
    "Rules: apply only the approved previews and nothing else; read each page back and check it live (cache-busting load, phone and desktop); complete this task only when every page of it is applied or dropped. New previews park this task again by themselves: end your turn after making them.",
  ];
  const unpark = task.assigneeKind === "client" || task.status === "blocked" || task.issueStatus === "blocked";
  if (unpark) {
    if (!(await patchIssue(env, sprint.companyId, task.issueId, { status: "todo" }))) throw new Error("the task's issue was not set to todo");
    await db.updateTask(env.ctx.db, sprint.companyId, task.id, { status: "in_progress", issue_status: "todo", assignee_kind: "agent", blocker_reason: null });
  }
  // As before T1b: lifted even when the sprint has no site id (the event names no site then, and the Connector ignores it).
  if (open) await liftWriteLock(env, sprint, `client-approval:${task.id}`, hours);
  if (!(await commentOn(env, sprint.companyId, task.issueId, lines.join("\n")))) throw new Error("the hand-over comment was not posted");
  if (!(await wakeIssue(env.ctx, task.issueId, sprint.companyId, "Previews decided"))) throw new Error("the agent was not woken");
  await env.ctx.db.execute(
    `UPDATE ${t("previews")} SET handover_done_at = now() WHERE company_id = $1 AND task_id = $2 AND handed_at = $3::timestamptz AND handover_done_at IS NULL`,
    [sprint.companyId, task.id, stamp],
  );
  return true;
}

/**
 * A current preview of p's task that makes the hand-over wait (the same test as handOverTask): with the client or the Reviewer, or an
 * email approval nobody confirmed on a manual sprint. The sweep leaves such tasks out, so rows that only wait never fill its LIMIT.
 * "Auto" here is isAutoSignoff without the rehearsal test: a rehearsal sprint makes no previews.
 */
const WAITING_SIBLING_SQL = `SELECT 1 FROM ${t("previews")} w
    WHERE w.company_id = p.company_id AND w.task_id = p.task_id AND w.status <> 'cancelled' AND ${PREVIEW_LIVE_SQL}
      AND NOT EXISTS (SELECT 1 FROM ${t("previews")} v WHERE v.company_id = w.company_id AND v.task_id = w.task_id AND v.page_url = w.page_url AND v.created_at > w.created_at AND v.status <> 'cancelled' AND ${PREVIEW_LIVE_SQL})
      AND ((w.status = 'pending' AND w.review_status IN ('passed', 'pending'))
        OR (w.status = 'approved' AND w.handed_at IS NULL AND COALESCE(w.decision_source, 'email') = 'email' AND w.confirmed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM ${t("sprints")} s WHERE s.company_id = p.company_id AND s.id = p.sprint_id AND s.client_signoff = 'auto' AND s.change_policy = 'pr_only' AND s.site_access = 'wordpress')))`;

/**
 * Runs from the 5-minute job: finishes hand-overs that were claimed but not done, and hands over person decisions (cockpit, api,
 * confirmed) that were never claimed, both older than 5 minutes. Bounded: the attempt counts first, at most 25 rows a run, and a
 * row stops after 5 attempts with one Needs you line. Returns how many hand-overs it finished.
 */
export async function retryHandovers(env: Env): Promise<number> {
  const rows = await env.ctx.db.query(
    `SELECT p.id, p.company_id, p.sprint_id, p.task_id, p.page_url, p.handed_at::text AS claim FROM ${t("previews")} p
      WHERE p.task_id IS NOT NULL AND p.handover_done_at IS NULL AND p.handover_attempts < $1 AND p.status IN ('approved', 'declined', 'changes_requested')
        AND ((p.handed_at IS NOT NULL AND p.handed_at < now() - make_interval(mins => $2::int))
          OR (p.handed_at IS NULL AND p.decided_at < now() - make_interval(mins => $2::int) AND (p.decision_source IN ('cockpit', 'api') OR p.confirmed_at IS NOT NULL)
            AND ${PREVIEW_LIVE_SQL}
            AND NOT EXISTS (SELECT 1 FROM ${t("previews")} n WHERE n.company_id = p.company_id AND n.task_id = p.task_id AND n.page_url = p.page_url AND n.created_at > p.created_at AND n.status <> 'cancelled')
            AND NOT EXISTS (${WAITING_SIBLING_SQL})))
      ORDER BY p.handover_attempts, COALESCE(p.handed_at, p.decided_at) LIMIT ${HANDOVER_SWEEP_LIMIT}`,
    [HANDOVER_MAX_ATTEMPTS, HANDOVER_RETRY_AFTER_MINUTES],
  );
  const groups = new Map<string, { companyId: string; sprintId: string; taskId: string; claim: string | null; ids: string[]; pages: string[] }>();
  for (const r of rows) {
    const claim = r.claim ? String(r.claim) : null;
    const key = `${String(r.company_id)}|${String(r.task_id)}|${claim ?? "-"}`;
    const group = groups.get(key) ?? { companyId: String(r.company_id), sprintId: String(r.sprint_id), taskId: String(r.task_id), claim, ids: [], pages: [] };
    group.ids.push(String(r.id));
    group.pages.push(String(r.page_url));
    groups.set(key, group);
  }
  let finished = 0;
  for (const g of groups.values()) {
    const ids = JSON.stringify(g.ids);
    try {
      // Counted before the try, so a try that crashes the worker still counts.
      await env.ctx.db.execute(`UPDATE ${t("previews")} SET handover_attempts = handover_attempts + 1 WHERE company_id = $1 AND id IN (SELECT jsonb_array_elements_text($2::jsonb))`, [g.companyId, ids]);
      const sprint = await db.getSprint(env.ctx.db, g.companyId, g.sprintId);
      if (!sprint) throw new Error("the sprint is gone");
      if (g.claim) {
        const task = await db.getTask(env.ctx.db, g.companyId, g.taskId);
        if (!task) throw new Error("the task is gone");
        if (await finishHandover(env, sprint, task, g.claim)) finished += 1;
        continue;
      }
      const outcome = await handOverTask(env, sprint, g.taskId);
      if (outcome === "handed") finished += 1;
      // Still waiting on the client or the Reviewer is not a failed try.
      if (outcome === "waiting") await env.ctx.db.execute(`UPDATE ${t("previews")} SET handover_attempts = GREATEST(handover_attempts - 1, 0) WHERE company_id = $1 AND id IN (SELECT jsonb_array_elements_text($2::jsonb))`, [g.companyId, ids]);
    } catch (error) {
      env.ctx.logger.info("SEO hand-over retry failed", { taskId: g.taskId, error: errorMessage(error) });
      await reportStuckHandovers(env, g).catch((e: unknown) => env.ctx.logger.info("SEO stuck hand-over not reported", { taskId: g.taskId, error: errorMessage(e) }));
    }
  }
  return finished;
}

/** One Needs you line per row that has used its last attempt. */
async function reportStuckHandovers(env: Env, g: { companyId: string; sprintId: string; taskId: string; ids: string[] }): Promise<void> {
  const stuck = await env.ctx.db.query(
    `SELECT id, page_url FROM ${t("previews")} WHERE company_id = $1 AND id IN (SELECT jsonb_array_elements_text($2::jsonb)) AND handover_done_at IS NULL AND handover_attempts >= $3`,
    [g.companyId, JSON.stringify(g.ids), HANDOVER_MAX_ATTEMPTS],
  );
  if (stuck.length === 0) return;
  const sprint = await db.getSprint(env.ctx.db, g.companyId, g.sprintId);
  if (!sprint) return;
  const info = await companyInfo(env, g.companyId);
  for (const r of stuck) {
    await addNeedsYou(env, info, sprint, {
      key: `handover-failed:${String(r.id)}`.slice(0, 120),
      kind: "task",
      title: `Hand-over of preview ${String(r.id)} failed ${HANDOVER_MAX_ATTEMPTS} times`,
      why: `The decision on ${String(r.page_url)} is recorded, but the plugin could not hand it to the SEO agent (unblock the task, comment, wake) after ${HANDOVER_MAX_ATTEMPTS} tries. The plugin logs say why.`,
      steps: ["Open the task's issue and tell the SEO agent what was decided on this page.", "Mark this item done."],
      links: [],
      after: "Nothing: the plugin stops retrying this hand-over.",
      check: "manual",
      taskIds: [g.taskId],
    });
  }
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
