/**
 * The progress email: for the sprints asked for, the plugin reads each sprint's own records (what is done, what is open, the pages asked about,
 * the plan's next weeks), writes the email (engine/progress-email.ts) and asks the Mailbox for a Gmail DRAFT. Nothing is sent: a person
 * reads it, changes it and sends it. Nothing in it is free text from an agent.
 */
import { MAIL_EVENTS, PIB_PLUGINS, type MailAddress, type MailDraftRequested } from "@partnersinbiz/pib-plugin-kit";
import { createHash } from "node:crypto";
import * as db from "../db.js";
import { t } from "../db.js";
import { progressEmail, type ProgressSite } from "../engine/progress-email.js";
import { sprintClock } from "../engine/sprint.js";
import { companyInfo, reqStr, SeoError, str, strList, type Actor, type Env, type Params } from "./common.js";
import { displayTitle } from "./overview.js";

const FIRST_WEEKS = 3;
const NEXT_WEEKS = [4, 5, 6, 7];

function titleOf(sprint: db.Sprint, task: db.SprintTask): string {
  return displayTitle(task, sprint.templateId);
}

export async function siteProgress(env: Env, sprint: db.Sprint, today: string): Promise<ProgressSite> {
  const tasks = await db.listTasks(env.ctx.db, sprint.companyId, sprint.id, { limit: 1000 });
  const byWeek = (weeks: number[], keep: (task: db.SprintTask) => boolean) =>
    weeks
      .map((week) => ({ week, titles: [...new Set(tasks.filter((x) => x.week === week && keep(x)).map((x) => titleOf(sprint, x)))] }))
      .filter((w) => w.titles.length > 0);
  const done = byWeek([0, 1, 2, 3], (x) => x.status === "done");
  const open = tasks
    .filter((x) => x.week <= FIRST_WEEKS && ["not_started", "in_progress", "blocked"].includes(x.status))
    .map((x) => ({
      title: titleOf(sprint, x),
      waitingFor: (x.assigneeKind === "client" ? "you" : "us") as "you" | "us",
    }));
  const previews = await env.ctx.db.query(
    `SELECT status, review_status, draft_key, expires_at > now() AS live FROM (
        SELECT DISTINCT ON (page_url) status, review_status, draft_key, expires_at FROM ${t("previews")} WHERE company_id = $1 AND sprint_id = $2 ORDER BY page_url, created_at DESC
      ) latest`,
    [sprint.companyId, sprint.id],
  );
  const live = previews.filter((p) => p.live === true || p.live === "t");
  const dropped = new Set<string>();
  for (const x of tasks) {
    const pages = ((x.evidence ?? {}) as { droppedPages?: Array<{ pageUrl?: string }> }).droppedPages ?? [];
    for (const p of pages) if (p.pageUrl) dropped.add(p.pageUrl);
  }
  return {
    siteName: sprint.siteName,
    siteUrl: sprint.siteUrl.replace(/^https?:\/\//, "").replace(/\/$/, ""),
    day: sprintClock(sprint.startDate, today).day,
    done,
    open,
    pages: {
      prepared: live.filter((p) => String(p.review_status) === "passed").length,
      asked: live.filter((p) => String(p.review_status) === "passed" && String(p.status) === "pending" && p.draft_key).length,
      approved: live.filter((p) => String(p.status) === "approved").length,
      held: dropped.size,
    },
    next: byWeek(NEXT_WEEKS, (x) => x.status !== "skipped" && x.status !== "na"),
  };
}

/** Drafts the progress email in Gmail (the Mailbox's default account). Returns what was asked for; the draft itself appears in Gmail Drafts. */
export async function draftProgressReport(env: Env, companyId: string, _actor: Actor, params: Params) {
  const sprintIds = strList(params, "sprintIds", { max: 10, itemMax: 80 });
  if (sprintIds.length === 0) throw new SeoError("Send sprintIds: the sprints the email is about (list-sprints gives the ids).");
  const to: MailAddress[] = strList(params, "to", { max: 5, itemMax: 200 }).map((email) => ({ email: email.trim().toLowerCase() }));
  if (to.length === 0 || to.some((a) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.email))) throw new SeoError("Send to: one to five valid email addresses.");
  const info = await companyInfo(env, companyId);
  const sites: ProgressSite[] = [];
  let clientKind: "company" | "contact" | null = null;
  let clientRef: string | null = null;
  for (const id of sprintIds) {
    const sprint = await db.getSprint(env.ctx.db, companyId, id);
    if (!sprint) throw new SeoError(`No such sprint: ${id}`);
    sites.push(await siteProgress(env, sprint, info.today));
    if (sprintIds.length === 1) {
      clientKind = sprint.clientKind;
      clientRef = sprint.clientRef;
    }
  }
  const mail = progressEmail({ greetingName: str(params, "greetingName", { max: 80 }) ?? null, sites, signature: "Partners in Biz" });
  const key = `seo-report:${companyId}:${createHash("sha1").update([...sprintIds].sort().join(",") + info.today).digest("hex").slice(0, 16)}`;
  const request: MailDraftRequested = {
    key,
    to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    context: { plugin: PIB_PLUGINS.seo, kind: "seo-report", id: sprintIds[0]!, clientKind, clientRef },
  };
  await env.ctx.events.emit(MAIL_EVENTS.draftRequested, companyId, request as unknown as Record<string, unknown>);
  return { requested: true, key, to: to.map((a) => a.email), subject: mail.subject, sites: sites.map((s) => s.siteName), note: "A Gmail draft is being created in the Mailbox's default account. Nothing is sent: a person reads it and sends it.", preview: mail.text };
}
