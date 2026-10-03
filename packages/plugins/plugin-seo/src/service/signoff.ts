/**
 * Sign-off lock for WordPress sites on a pr_only sprint. This plugin tells the CRM (which owns the Connector
 * tools) which sites need the client's sign-off; the CRM then refuses agents' writes to them. A person lifts the
 * lock for a limited window with "Apply approved changes" (approve-site-writes) after the client signed off.
 */
import { wakeIssue } from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import { t } from "../db.js";
import { actorId, num, reqStr, SeoError, errorMessage, type Actor, type Env, type Params } from "./common.js";
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
    `SELECT id, task_id, issue_id, page_url, title FROM ${t("previews")} WHERE company_id = $1 AND sprint_id = $2 AND status = 'approved' AND expires_at > now() ORDER BY decided_at`,
    [companyId, sprintId],
  );
  if (approved.length === 0) throw new SeoError("No client has approved a preview on this sprint yet. Send the preview link to the client first; their Approve click is what unlocks this.");
  const until = new Date(env.now().getTime() + hours * 3_600_000).toISOString();
  await env.ctx.events.emit(APPROVAL_EVENT, companyId, { siteId: sprint.siteId, until, by: actorId(actor) });
  // Page addresses only, at most 15: a long list would make the comment (and the thread) big; list-previews has the rest.
  const shown = approved.slice(0, 15).map((r) => `- ${String(r.page_url)}`);
  const more = approved.length > shown.length ? `\n- …and ${approved.length - shown.length} more: partnersinbiz.seo:list-previews with status approved (limit 100) shows all of them.` : "";
  const list = `${shown.join("\n")}${more}`;
  const body = `The owner approved applying the client-approved changes for the next ${hours} hours. Apply only these (the previews with status approved, see list-previews), then verify each on the live site and complete the task with the evidence:\n${list}\n\nAnything that is not an approved preview still needs the client's sign-off.`;
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
