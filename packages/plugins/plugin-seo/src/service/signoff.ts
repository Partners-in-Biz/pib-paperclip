/**
 * Sign-off lock for WordPress sites on a pr_only sprint. This plugin tells the CRM (which owns the Connector
 * tools) which sites need the client's sign-off; the CRM then refuses agents' writes to them. A person lifts the
 * lock for a limited window with "Apply approved changes" (approve-site-writes) after the client signed off.
 */
import { normalisePageUrl, PIB_PLUGINS, pluginEvent, wakeIssue } from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import { t } from "../db.js";
import { actorId, num, reqStr, SeoError, errorMessage, type Actor, type Env, type Params } from "./common.js";
import { ARCHIVE_APPLY_GUIDANCE, LIVE_CHECK_GUIDANCE } from "../apply-guidance.js";
import { APPROVAL_VALID_DAYS } from "../constants.js";
import { assertWritable, loadSprintContext } from "./context.js";
import { commentOn } from "./issues.js";

export const SIGNOFF_EVENT = "site.signoff";
export const APPROVAL_EVENT = "site.write-approved";
export const APPROVAL_DEFAULT_HOURS = 24;

/** Tells the CRM, for every linked WordPress site of an active sprint, whether it needs sign-off. Idempotent; runs every 5 minutes. */
export async function syncSignoff(env: Env): Promise<number> {
  const rows = await env.ctx.db.query(
    `SELECT company_id, site_id, bool_or(change_policy = 'pr_only') AS required
       FROM ${t("sprints")}
      WHERE site_access = 'wordpress' AND site_id IS NOT NULL AND status <> 'archived'
      GROUP BY company_id, site_id`,
  );
  let sent = 0;
  for (const row of rows) {
    try {
      await env.ctx.events.emit(SIGNOFF_EVENT, String(row.company_id), { siteId: String(row.site_id), required: Boolean(row.required) });
      sent += 1;
    } catch (error) {
      env.ctx.logger.info("SEO sign-off sync failed", { siteId: String(row.site_id), error: errorMessage(error) });
    }
  }
  return sent;
}

/** Opens the sign-off lock for this sprint's WordPress site until `hours` from now. Returns when it closes (ISO). */
export async function liftWriteLock(env: Env, sprint: Pick<db.Sprint, "companyId" | "siteId">, by: string, hours: number): Promise<string> {
  const until = new Date(env.now().getTime() + hours * 3_600_000).toISOString();
  await env.ctx.events.emit(APPROVAL_EVENT, sprint.companyId, { siteId: sprint.siteId, until, by });
  return until;
}

/**
 * The page-scoped apply window of one site (PAR-9131 T3, Q13). The window's pages are the approved previews that were handed to the
 * agent, whose `apply_until` has not passed and whose task issue is not done or cancelled, across every sprint of the company on
 * this site. It is sent to the CRM as a whole (`scope: "pages"`, replace semantics), with `seq` from `clock_timestamp()` in
 * microseconds read in the same statement as the set, so the CRM keeps the newest read and drops a late event. An empty set is
 * the close. The board's whole-site grant (approveSiteWrites) is separate and untouched. Returns the pages sent.
 */
export async function syncSiteWindow(env: Env, companyId: string, siteId: string, by: string): Promise<{ pages: string[]; until: string | null; seq: string }> {
  // One row even when the set is empty (the LEFT JOIN on a one-row select), so the close carries a seq too.
  const rows = await env.ctx.db.query(
    `SELECT w.page_url, w.apply_until, floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint::text AS seq
       FROM (SELECT 1 AS one) o LEFT JOIN (
         SELECT p.page_url, p.apply_until FROM ${t("previews")} p
           JOIN ${t("sprints")} s ON s.company_id = p.company_id AND s.id = p.sprint_id
           JOIN ${t("sprint_tasks")} k ON k.company_id = p.company_id AND k.id = p.task_id
          WHERE p.company_id = $1 AND s.site_id = $2 AND p.status = 'approved' AND p.handed_at IS NOT NULL AND p.apply_until > now()
            AND COALESCE(k.issue_status, '') NOT IN ('done', 'cancelled') AND k.status NOT IN ('done', 'skipped', 'na')
       ) w ON true`,
    [companyId, siteId],
  );
  const open = rows.filter((r) => r.page_url != null);
  const pages = [...new Set(open.map((r) => normalisePageUrl(String(r.page_url))).filter((u): u is string => u !== null))].sort();
  const until = pages.length > 0 ? open.map((r) => (r.apply_until instanceof Date ? r.apply_until : new Date(String(r.apply_until))).toISOString()).sort().at(-1)! : null;
  const seq = rows.map((r) => String(r.seq ?? "")).filter((s) => /^[1-9][0-9]*$/.test(s)).sort((a, b) => (a.length - b.length) || a.localeCompare(b)).at(-1);
  if (!seq) throw new Error("the apply window read returned no seq");
  await env.ctx.events.emit(APPROVAL_EVENT, companyId, { siteId, scope: "pages", pages, until, seq, by });
  return { pages, until, seq };
}

/** syncSiteWindow for the sprint's site. A sprint without a site id has no lock to open, so nothing is sent (null). */
export async function syncApplyWindow(env: Env, sprint: Pick<db.Sprint, "companyId" | "siteId">, by: string) {
  if (!sprint.siteId) return null;
  return syncSiteWindow(env, sprint.companyId, sprint.siteId, by);
}

/**
 * The 5-minute backstop: re-sends the window of every site with an approved, handed-over preview whose window is open or ended
 * under an hour ago. So a task closed without an `issue.updated` reaching us, or an `apply_until` that passed, still closes it.
 */
export async function syncApplyWindows(env: Env): Promise<number> {
  const sites = await env.ctx.db.query(
    `SELECT DISTINCT p.company_id, s.site_id FROM ${t("previews")} p JOIN ${t("sprints")} s ON s.company_id = p.company_id AND s.id = p.sprint_id
      WHERE s.site_id IS NOT NULL AND p.status = 'approved' AND p.handed_at IS NOT NULL AND p.apply_until > now() - interval '1 hour'`,
  );
  let sent = 0;
  for (const row of sites) {
    try {
      await syncSiteWindow(env, String(row.company_id), String(row.site_id), "seo:window-job");
      sent += 1;
    } catch (error) {
      env.ctx.logger.info("SEO apply window sync failed", { siteId: String(row.site_id), error: errorMessage(error) });
    }
  }
  return sent;
}

/**
 * A task issue changed (done, cancelled, reopened): re-send the window of each site where its task has an open approved preview.
 * The task's current issue counts as well as the preview's own (a long thread moves the task to a continuation issue).
 */
export async function syncWindowForIssue(env: Env, companyId: string, issueId: string): Promise<number> {
  const sites = await env.ctx.db.query(
    `SELECT DISTINCT s.site_id FROM ${t("previews")} p JOIN ${t("sprints")} s ON s.company_id = p.company_id AND s.id = p.sprint_id
       LEFT JOIN ${t("sprint_tasks")} k ON k.company_id = p.company_id AND k.id = p.task_id
      WHERE p.company_id = $1 AND (p.issue_id = $2 OR k.issue_id = $2) AND s.site_id IS NOT NULL AND p.status = 'approved' AND p.handed_at IS NOT NULL AND p.apply_until > now()`,
    [companyId, issueId],
  );
  for (const row of sites) await syncSiteWindow(env, companyId, String(row.site_id), `seo:issue:${issueId}`);
  return sites.length;
}

export const SITE_CHANGED_EVENT = pluginEvent(PIB_PLUGINS.crm, "site.changed");

/**
 * The CRM's `site.changed` (PAR-9131 Q16): an agent write on an approved page went through. The first one inside a preview's window
 * marks it applied (apply started; Undo is refused from then on). It does not close the window. Idempotent: a replayed event keeps
 * the earliest time. A site none of this company's sprints is on changes nothing. Returns the rows marked.
 */
export async function onSiteChanged(env: Env, companyId: string, payload: unknown): Promise<number> {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  if (typeof p.siteId !== "string" || typeof p.url !== "string" || typeof p.at !== "string" || Number.isNaN(Date.parse(p.at))) return 0;
  const url = normalisePageUrl(p.url);
  if (!url) return 0;
  const at = new Date(p.at).toISOString();
  const rows = await env.ctx.db.query(
    `SELECT p.id, p.page_url FROM ${t("previews")} p JOIN ${t("sprints")} s ON s.company_id = p.company_id AND s.id = p.sprint_id
      WHERE p.company_id = $1 AND s.site_id = $2 AND p.status = 'approved' AND p.handed_at <= $3::timestamptz AND p.apply_until >= $3::timestamptz`,
    [companyId, p.siteId, at],
  );
  const ids = rows.filter((r) => normalisePageUrl(String(r.page_url)) === url).map((r) => String(r.id));
  if (ids.length === 0) return 0;
  const done = await env.ctx.db.execute(
    `UPDATE ${t("previews")} SET applied_at = LEAST(COALESCE(applied_at, $3::timestamptz), $3::timestamptz)
      WHERE company_id = $1 AND id IN (SELECT jsonb_array_elements_text($2::jsonb)) AND status = 'approved'`,
    [companyId, JSON.stringify(ids), at],
  );
  return done.rowCount ?? 0;
}

/** A person says the client signed off: agents may apply the approved changes through the Connector for a while. */
export async function approveSiteWrites(env: Env, companyId: string, actor: Actor, params: Params) {
  if (actor.kind !== "user") throw new SeoError("Only a person can approve applying changes to a client's site.");
  const sprintId = reqStr(params, "sprintId");
  const hours = num(params, "hours", { min: 1, max: 72, integer: true }) ?? APPROVAL_DEFAULT_HOURS;
  const { sprint } = await loadSprintContext(env, companyId, sprintId);
  assertWritable(sprint);
  if (sprint.siteAccess !== "wordpress" || !sprint.siteId) throw new SeoError("This sprint is not linked to a WordPress site, so there is nothing to unlock.");
  if (sprint.changePolicy !== "pr_only") throw new SeoError("This sprint's change policy is not pr_only, so the agent is not held back.");
  const approved = await env.ctx.db.query(
    `SELECT id, task_id, issue_id, page_url, title FROM ${t("previews")} WHERE company_id = $1 AND sprint_id = $2 AND status = 'approved' AND decided_at > now() - interval '${APPROVAL_VALID_DAYS} days' ORDER BY decided_at`,
    [companyId, sprintId],
  );
  if (approved.length === 0) throw new SeoError("No client has approved a preview on this sprint yet. Send the preview link to the client first; their Approve click is what unlocks this.");
  const until = await liftWriteLock(env, sprint, actorId(actor), hours);
  // Page addresses only, at most 15: a long list would make the comment (and the thread) big; list-previews has the rest.
  const shown = approved.slice(0, 15).map((r) => `- ${String(r.page_url)}`);
  const more = approved.length > shown.length ? `\n- …and ${approved.length - shown.length} more: partnersinbiz.seo:list-previews with status approved (limit 100) shows all of them.` : "";
  const list = `${shown.join("\n")}${more}`;
  const body = `The owner approved applying the client-approved changes for the next ${hours} hours. Apply only these (the previews with status approved, see list-previews), then verify each on the live site and complete the task with the evidence:\n${list}\n\nAnything that is not an approved preview still needs the client's sign-off.\n\n${ARCHIVE_APPLY_GUIDANCE}\n\n${LIVE_CHECK_GUIDANCE}`;
  const woken: string[] = [];
  const seen = new Set<string>();
  for (const row of approved) {
    const issueId = row.issue_id ? String(row.issue_id) : null;
    if (!issueId || seen.has(issueId)) continue;
    seen.add(issueId);
    if (await commentOn(env, companyId, issueId, body)) {
      await wakeIssue(env.ctx, issueId, companyId, "Client sign-off approved: apply the changes");
      woken.push(issueId);
    }
  }
  return { sprintId, siteId: sprint.siteId, approvedUntil: until, approvedPreviews: approved.length, issuesNotified: woken.length };
}
