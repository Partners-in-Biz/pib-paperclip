/**
 * Redesign task: a person asks for a better-looking version of a page. The Senior Developer (else the Developer)
 * designs it and shows it as a client preview (with styles), the Reviewer checks it against the live page, the
 * client signs off, and a person applies any theme change. Never part of the plan by default.
 */
import { randomUUID } from "node:crypto";
import { phaseForWeek } from "../templates/outrank-90.js";
import { ORIGIN, taskOriginId } from "../constants.js";
import * as db from "../db.js";
import { findBuilders } from "./build.js";
import { actorLabel, reqStr, SeoError, str, type Actor, type Env, type Params } from "./common.js";
import { assertWritable, loadSprintContext } from "./context.js";
import { openIssue } from "./issues.js";
import { taskProjectId } from "./tasks.js";
import { PREVIEW_BASE } from "./preview-links.js";

function hostOf(url: string): string {
  return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
}

export function redesignBrief(input: { siteUrl: string; pageUrl: string; goal: string; sprintId: string; taskId: string; requester: string; wordpress: boolean }): string {
  return [
    `# Redesign: ${input.pageUrl}`,
    "",
    `Requested by ${input.requester}. A person decided this page needs a better design. You are the designer and builder; the SEO Specialist is not involved unless you need keyword or copy input.`,
    "",
    "## What they want",
    input.goal,
    "",
    "## How to work",
    "1. Open the live page and look at it properly: its colours, fonts, spacing, how it looks on a phone. Keep the brand and everything that makes the page work (listings, menu, forms, prices, calls to action). Do not drop content.",
    `2. Design the better version and show it as a client preview with \`partnersinbiz.seo:create-preview\` (sprintId ${input.sprintId}, taskId ${input.taskId}, pageUrl ${input.pageUrl}). For a redesign you may send \`css\` (styles shown on the preview: colours, fonts, spacing, layout) as well as bodyHtml, and bodyMode replace with allowReplace true when you really replace the content area. Scripts, imports and event handlers are stripped.`,
    "3. The preview is held until the Reviewer has compared it with the live page on desktop AND phone, and judged the design (does it look like it belongs to the site, is it clearly better, is the hierarchy clear). If they send it back you fix it and make a new preview.",
    "4. After it passes, the owner shows the client. Nothing is applied to the live site until the client approves and the owner confirms.",
    ...(input.wordpress
      ? [
          "",
          "## Applying it (later)",
          "On this WordPress site, styles and template markup are theme changes: the Connector cannot make them. When the client approves, put the exact CSS and markup change on Needs you (needs-you-add, kind task) with the preview link, so a person applies it (theme markup goes over SFTP once the site's SFTP login is added).",
        ]
      : []),
    "",
    `Preview links look like ${PREVIEW_BASE}/p/<site>/<token>. Set this issue to done only when a passed preview exists and the apply step is on Needs you.`,
  ].join("\n");
}

/** A person adds a redesign of one page. Opens the task's issue for the Senior Developer (else the Developer). */
export async function addRedesign(env: Env, companyId: string, actor: Actor, params: Params) {
  if (actor.kind !== "user") throw new SeoError("A redesign is asked for by a person.");
  const sprintId = reqStr(params, "sprintId");
  const { sprint, clock } = await loadSprintContext(env, companyId, sprintId);
  assertWritable(sprint);
  if (!sprint.rootIssueId) throw new SeoError("The sprint has no root issue yet.");
  const rawUrl = reqStr(params, "pageUrl", { max: 2000 });
  let pageUrl: string;
  try {
    pageUrl = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : new URL(rawUrl, sprint.siteUrl).toString()).toString();
  } catch {
    throw new SeoError("pageUrl must be a page of the client's site (a full URL or a path such as /about).");
  }
  if (hostOf(pageUrl) !== hostOf(sprint.siteUrl)) throw new SeoError(`pageUrl must be a page on ${sprint.siteUrl}.`);
  const goal = reqStr(params, "goal", { max: 4000 });
  const { developer, senior } = await findBuilders(env, companyId);
  const builder = senior ?? developer;
  if (!builder) throw new SeoError("No Senior Developer or Developer is available (idle or running) to take a redesign.");
  const id = randomUUID();
  const label = new URL(pageUrl).pathname.replace(/\/$/, "") || "home page";
  await db.insertTasks(env.ctx.db, [{
    id,
    companyId,
    sprintId,
    templateKey: null,
    week: clock.week,
    phase: phaseForWeek(clock.week),
    dueDay: clock.day <= 0 ? null : clock.day,
    focus: "Redesign",
    title: `Redesign: ${label}`.slice(0, 240),
    description: goal,
    taskType: "redesign",
    owner: "agent",
    autopilotEligible: false,
    playbookKey: "custom",
    source: "manual",
    parentOptimizationId: null,
    context: `Redesign asked for by ${actorLabel(actor)}.`,
  }]);
  const task = await db.getTask(env.ctx.db, companyId, id);
  if (!task || !(await db.claimTaskForIssue(env.ctx.db, companyId, id))) throw new SeoError("The redesign task could not be created.");
  try {
    const projectId = taskProjectId(sprint, true, sprint.projectId);
    const created = await openIssue(env, {
      companyId,
      title: `Redesign: ${label} — ${sprint.siteName}`.slice(0, 240),
      description: redesignBrief({ siteUrl: sprint.siteUrl, pageUrl, goal, sprintId, taskId: id, requester: actorLabel(actor), wordpress: sprint.siteAccess === "wordpress" }),
      originKind: ORIGIN.task,
      originId: taskOriginId(id),
      projectId,
      parentId: sprint.rootIssueId,
      assigneeAgentId: builder.id,
      wake: true,
      wakeReason: `Redesign: ${label}`,
    });
    await db.updateTask(env.ctx.db, companyId, id, { issue_id: created.id, issue_status: "todo", assignee_kind: "agent", issue_project_id: projectId ?? null, status: "in_progress", started_at: env.now().toISOString() });
    return { taskId: id, issueId: created.id, assignedTo: builder.name, pageUrl };
  } catch (error) {
    await db.releaseTaskClaim(env.ctx.db, companyId, id);
    throw error;
  }
}
