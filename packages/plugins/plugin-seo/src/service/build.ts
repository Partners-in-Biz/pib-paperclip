/**
 * Build hand-off: the SEO Specialist decides what a page or site change should be; the Developer (or Senior
 * Developer for theme, template, many-page or ecommerce work) builds it. `request-build` opens a build issue
 * under the task's issue for the developer; when that issue is done (or cancelled or blocked) the SEO agent
 * is told on the task issue and woken, then verifies the result on the live site and completes the task.
 */
import { coversPluginTools, wakeIssue } from "@partnersinbiz/pib-plugin-kit";
import { buildOriginId, ORIGIN, taskIdFromBuildOrigin } from "../constants.js";
import * as db from "../db.js";
import { t } from "../db.js";
import { isRehearsalSprint, REHEARSAL_REFUSAL } from "../engine/rehearsal.js";
import { siteCopyFor, taskProjectId } from "./tasks.js";
import { actorLabel, errorMessage, oneOf, reqStr, SeoError, str, type Actor, type Env, type Params } from "./common.js";
import { assertWritable, loadSprintContext } from "./context.js";
import { commentOn, getIssue, openIssue, patchIssue } from "./issues.js";
import { previewLink } from "./preview-links.js";

export type BuildLevel = "developer" | "senior";

interface Builder {
  id: string;
  name: string;
  level: BuildLevel;
}

const USABLE = new Set(["idle", "running", "active"]);

/** The Developer and Senior Developer agents of the company (engineers by those names) that can take work. */
export async function findBuilders(env: Env, companyId: string): Promise<{ developer: Builder | null; senior: Builder | null }> {
  const agents = await env.ctx.agents.list({ companyId, limit: 200 });
  const pick = (re: RegExp, level: BuildLevel): Builder | null => {
    const a = agents.find((x) => re.test(String(x.name ?? "").trim()) && USABLE.has(String(x.status)));
    return a ? { id: String(a.id), name: String(a.name), level } : null;
  };
  return { developer: pick(/^developer$/i, "developer"), senior: pick(/^senior developer$/i, "senior") };
}

async function canUsePluginTools(env: Env, companyId: string, agentId: string): Promise<boolean> {
  try {
    const grants = await env.ctx.authorization.grants.list({ companyId, principalType: "agent", principalId: agentId });
    return grants.some((g) => String(g.permissionKey) === "tools:use" && coversPluginTools((g.scope as Record<string, unknown> | null) ?? null));
  } catch {
    return false;
  }
}

export function buildBrief(input: {
  taskTitle: string;
  taskIdentifier: string | null;
  summary: string;
  changeSet: string;
  acceptance: string | null;
  previewUrl: string | null;
  site: { url: string; wordpressSiteId: string | null; repoUrl: string | null; defaultBranch: string | null; hosting: string | null; policy: string; branch: string | null; access: string };
  requester: string;
}): string {
  const where =
    input.site.access === "wordpress"
      ? `WordPress site ${input.site.url}${input.site.wordpressSiteId ? ` (siteId ${input.site.wordpressSiteId})` : ""}. Changes go through the Connector tools (partnersinbiz.crm wp-* tools; siteId and a reason on every write), then check them on the live site.`
      : input.site.access === "repo"
        ? `Site repo ${input.site.repoUrl ?? "(see the project workspace)"}, default branch ${input.site.defaultBranch ?? "main"}${input.site.hosting ? `, hosting ${input.site.hosting}` : ""}. Work on branch \`${input.site.branch ?? "seo/<task>"}\`, commit, push and open a pull request. Do NOT merge it: the SEO Specialist runs the scope check and decides.`
        : `Site ${input.site.url}.`;
  return [
    `# Build request from the SEO Specialist (${input.requester})`,
    "",
    `For the SEO task "${input.taskTitle}"${input.taskIdentifier ? ` (${input.taskIdentifier})` : ""}. The SEO Specialist decided what the page should say and why; you build it.`,
    "",
    "## What to build",
    input.summary,
    "",
    "## Exact change set",
    input.changeSet,
    ...(input.acceptance ? ["", "## Done when", input.acceptance] : []),
    ...(input.previewUrl ? ["", `## Client-approved preview`, `${input.previewUrl} (the client approved this; match it).`] : []),
    "",
    "## Where",
    where,
    `Change policy: ${input.site.policy.replace(/_/g, " ")}.`,
    "",
    "## Rules",
    "- Build only what the change set says. Do not change other pages, settings, plugins or content, and do not delete anything.",
    "- Never invent facts, prices, reviews or ratings. Keep the client's voice and real details.",
    "- If something is unclear or cannot be done as written, comment what you need and set this issue to blocked; do not guess.",
    "",
    "## When you finish",
    "Comment: what you changed (pages or files), the PR link or live URL, and the checks you ran. Then set this issue to done. The SEO Specialist verifies it on the live site and closes the SEO task.",
  ].join("\n");
}

/** Evidence on the task: the build issues requested for it, and what was last reported back. */
interface BuildRef {
  issueId: string;
  agentId: string;
  at: string;
  reported?: string;
  /** preview-fix: opened by the plugin after the Reviewer sent a preview back for a build problem. */
  kind?: "preview-fix";
}

/** Developer fixes of a preview the plugin opens for one task before it hands the problem to the owner. */
export const MAX_PREVIEW_FIXES = 3;

export function buildsOf(task: db.SprintTask): BuildRef[] {
  const raw = (task.evidence ?? {}).builds;
  return Array.isArray(raw) ? (raw as BuildRef[]) : [];
}

export async function requestBuild(env: Env, companyId: string, actor: Actor, params: Params) {
  const sprintId = reqStr(params, "sprintId");
  const taskId = reqStr(params, "taskId", { max: 80 });
  const ctx = await loadSprintContext(env, companyId, sprintId);
  const { sprint } = ctx;
  assertWritable(sprint);
  if (isRehearsalSprint(sprint)) throw new SeoError(REHEARSAL_REFUSAL);
  const task = await db.getTask(env.ctx.db, companyId, taskId);
  if (!task || task.sprintId !== sprintId) throw new SeoError("No such task on this sprint.");
  if (task.status === "done" || task.status === "skipped") throw new SeoError(`This task is already ${task.status}.`);
  const summary = reqStr(params, "summary", { max: 4000 });
  const changeSet = reqStr(params, "changeSet", { max: 30_000 });
  const acceptance = str(params, "acceptance", { max: 3000 }) ?? null;
  const level = oneOf(params, "level", ["developer", "senior"] as const) ?? "developer";

  // A WordPress site that needs the client's sign-off is only built after the client approved a preview.
  let previewUrl: string | null = null;
  const previewId = str(params, "previewId", { max: 80 });
  if (sprint.siteAccess === "wordpress" && sprint.changePolicy === "pr_only") {
    if (!previewId) throw new SeoError("This site needs the client's sign-off first: make a preview with create-preview, get it approved, then request the build with previewId. (list-previews shows the status.)");
    const rows = await env.ctx.db.query(`SELECT status FROM ${t("previews")} WHERE id = $1 AND company_id = $2 AND sprint_id = $3 LIMIT 1`, [previewId, companyId, sprintId]);
    if (!rows[0]) throw new SeoError("No such preview on this sprint.");
    if (String(rows[0].status) !== "approved") throw new SeoError(`That preview is ${String(rows[0].status).replace(/_/g, " ")}, not approved. Build only what the client approved.`);
  }
  if (previewId) previewUrl = previewLink(sprint.siteUrl, previewId);

  const open = buildsOf(task).find((b) => !b.reported || b.reported === "blocked");
  if (open) throw new SeoError(`A build is already open for this task (issue ${open.issueId}). Wait for it to be reported back, or comment on that issue.`);

  const { developer, senior } = await findBuilders(env, companyId);
  const builder = level === "senior" ? senior ?? developer : developer ?? senior;
  if (!builder) throw new SeoError("No Developer or Senior Developer is available (idle or running). Do the build yourself, or block-task and ask the owner to staff one.");
  if (sprint.siteAccess === "wordpress" && !(await canUsePluginTools(env, companyId, builder.id))) {
    throw new SeoError(`${builder.name} cannot use plugin tools yet, and a WordPress site is changed through the Connector tools. Do this build yourself, or ask the owner to allow plugin tools for ${builder.name} (agent permissions).`);
  }

  const site = siteCopyFor(sprint, task);
  const brief = buildBrief({
    taskTitle: task.title,
    taskIdentifier: task.issueIdentifier,
    summary,
    changeSet,
    acceptance,
    previewUrl,
    site: {
      url: sprint.siteUrl,
      wordpressSiteId: sprint.siteId,
      repoUrl: site?.repoUrl ?? sprint.repoUrl,
      defaultBranch: sprint.defaultBranch,
      hosting: sprint.hosting,
      policy: sprint.changePolicy,
      branch: site?.branch ?? null,
      access: sprint.siteAccess,
    },
    requester: actorLabel(actor),
  });
  const created = await openIssue(env, {
    companyId,
    sprint,
    title: `Build: ${task.title}`,
    description: brief,
    originKind: ORIGIN.build,
    originId: buildOriginId(task.id),
    projectId: task.issueProjectId ?? taskProjectId(sprint, true, ctx.sprint.projectId),
    parentId: task.issueId ?? sprint.rootIssueId ?? undefined,
    assigneeAgentId: builder.id,
    wake: true,
    wakeReason: `SEO build request: ${task.title}`,
  });
  const builds = [...buildsOf(task), { issueId: created.id, agentId: builder.id, at: env.now().toISOString() } satisfies BuildRef];
  await db.updateTask(env.ctx.db, companyId, task.id, { evidence: { ...(task.evidence ?? {}), builds } });
  if (task.issueId) {
    await commentOn(env, companyId, task.issueId, `Build requested from ${builder.name}${created.woke ? "" : " (not woken yet)"}: issue ${created.id}. The build is theirs; I verify it on the live site when it is reported back.`);
  }
  return {
    taskId: task.id,
    buildIssueId: created.id,
    assignedTo: builder.name,
    next: `End your turn now. ${builder.name} builds it and you are woken on this task's issue when it is done. Then verify the live result (check-meta, crawler-sim, validate-schema) and complete the task with the evidence; if it is not right, comment on the build issue with exactly what to fix.`,
  };
}

/** A build issue changed: tell the SEO task's issue once per status and wake the SEO agent. Returns true when the event was a build issue. */
export async function onBuildIssueUpdated(env: Env, companyId: string, issueId: string): Promise<boolean> {
  try {
    const issue = await getIssue(env, companyId, issueId);
    if (!issue || issue.originKind !== ORIGIN.build) return false;
    const taskId = taskIdFromBuildOrigin(issue.originId);
    const task = taskId ? await db.getTask(env.ctx.db, companyId, taskId) : null;
    const status = String(issue.status);
    if (!task || !["done", "cancelled", "blocked"].includes(status)) return true;
    const builds = buildsOf(task);
    const at = builds.findIndex((b) => b.issueId === issueId);
    if (at === -1 || builds[at]!.reported === status) return true;
    const fix = builds[at]!.kind === "preview-fix";
    if (fix && status === "done") {
      // The developer's corrected preview is what goes back to the Reviewer; without one the fix is not finished.
      const newer = await env.ctx.db.query(`SELECT id FROM ${t("previews")} WHERE company_id = $1 AND task_id = $2 AND created_at > $3::timestamptz LIMIT 1`, [companyId, task.id, builds[at]!.at]);
      if (newer.length === 0) {
        if (await patchIssue(env, companyId, issueId, { status: "todo" })) {
          await commentOn(env, companyId, issueId, "Reopened: no corrected preview was made. Make it with create-preview (see the steps in the description), then set this issue to done.");
          await wakeIssue(env.ctx, issueId, companyId, "Make the corrected preview");
        }
        return true;
      }
      builds[at] = { ...builds[at]!, reported: status };
      await db.updateTask(env.ctx.db, companyId, task.id, { evidence: { ...(task.evidence ?? {}), builds } });
      return true; // The Reviewer checks the new preview; the SEO Specialist is woken when it passes.
    }
    builds[at] = { ...builds[at]!, reported: status };
    await db.updateTask(env.ctx.db, companyId, task.id, { evidence: { ...(task.evidence ?? {}), builds } });
    if (fix && task.status === "blocked" && task.assigneeKind === "reviewer") {
      // A fix that could not be done goes back to the SEO Specialist with what is needed.
      if (task.issueId && (await patchIssue(env, companyId, task.issueId, { status: "todo" }))) {
        await db.updateTask(env.ctx.db, companyId, task.id, { status: "in_progress", issue_status: "todo", assignee_kind: "agent", blocker_reason: null });
      }
    }
    if (!task.issueId) return true;
    const ref = issue.identifier ?? issueId;
    const text =
      status === "done"
        ? `The build ${ref} is done. Read its last comment for what changed, verify the result on the live site (check-meta, crawler-sim, validate-schema), then complete this task with the evidence. If it is not right, comment on ${ref} with exactly what to fix and reopen it.`
        : status === "blocked"
          ? `The build ${ref} is blocked: read its comments, answer what the developer needs (comment on ${ref} and set it back to todo), or put the question on Needs you.`
          : `The build ${ref} was cancelled. Decide: request it again, do it yourself, or skip this task.`;
    await commentOn(env, companyId, task.issueId, text);
    await wakeIssue(env.ctx, task.issueId, companyId, `Build ${status}: ${ref}`);
  } catch (error) {
    env.ctx.logger.info("SEO build report failed", { issueId, error: errorMessage(error) });
  }
  return true;
}

export interface PreviewFixInput {
  previewId: string;
  taskId: string;
  pageUrl: string;
  notes: string;
  level: BuildLevel;
  reviewUrl: string | null;
  changes: Record<string, unknown>;
}

/**
 * The Reviewer sent a preview back for a build problem (markup, styling, layout, theme): a developer fixes it
 * instead of the SEO Specialist. Opens a build issue for them and keeps the task parked; they make the corrected
 * preview themselves and it goes to the Reviewer again. Returns null (the SEO Specialist is woken instead) when
 * nobody can take it.
 */
export async function startPreviewFix(env: Env, companyId: string, input: PreviewFixInput): Promise<{ issueId: string; builder: string } | { fallback: string }> {
  const task = await db.getTask(env.ctx.db, companyId, input.taskId);
  if (!task || !task.issueId) return { fallback: "the task has no open issue" };
  const { sprint } = await loadSprintContext(env, companyId, task.sprintId);
  if (isRehearsalSprint(sprint)) return { fallback: "this is a rehearsal sprint: nothing is built for it" };
  const earlier = buildsOf(task).filter((b) => b.kind === "preview-fix").length;
  if (earlier >= MAX_PREVIEW_FIXES) return { fallback: `${earlier} developer fixes of this page did not pass the check; put the question on Needs you for the owner` };
  const { developer, senior } = await findBuilders(env, companyId);
  const builder = input.level === "senior" ? senior ?? developer : developer ?? senior;
  if (!builder) return { fallback: "no Developer or Senior Developer is available" };
  if (sprint.siteAccess === "wordpress" && !(await canUsePluginTools(env, companyId, builder.id))) return { fallback: `${builder.name} cannot use plugin tools` };
  const changes = JSON.stringify(input.changes, null, 2).slice(0, 20_000);
  const brief = [
    `# Fix a client preview (sent back by the Reviewer)`,
    "",
    `For the SEO task "${task.title}"${task.issueIdentifier ? ` (${task.issueIdentifier})` : ""} on ${sprint.siteUrl}. The Reviewer compared the SEO Specialist's preview of ${input.pageUrl} with the live page and sent it back for problems in how it is BUILT (markup, styling, layout, theme), not in what it says. You fix those.`,
    "",
    "## What the Reviewer found",
    input.notes,
    "",
    ...(input.reviewUrl ? ["## See it", `Live page vs the proposal, side by side: ${input.reviewUrl}`, ""] : []),
    "## The proposal as the SEO Specialist wrote it",
    "```json",
    changes,
    "```",
    "",
    "## What to do",
    "1. Fix the problems above in the copy block (`bodyHtml`): keep the SEO Specialist's wording and facts unless a fix needs a small change. Use inline `style=\"...\"` attributes and wrapper elements: `<style>`, `<script>`, `<link>` and event handlers are stripped from previews.",
    `2. Make a corrected preview yourself with \`partnersinbiz.seo:create-preview\`: sprintId ${sprint.id}, taskId ${task.id}, pageUrl ${input.pageUrl}, the title, metaDescription, h1 and the corrected bodyHtml (bodyMode before or after; never replace the page's content). The Reviewer checks it again and the client sees nothing until it passes.`,
    "3. Comment what you changed and set this issue to done. Do not apply anything to the live site and do not touch other pages.",
    `If the problem cannot be fixed inside the copy block (it needs a theme or template change on the site itself), comment what is needed and set this issue to blocked.`,
    "",
    "The rules from the original build request apply: build only what is asked, invent no facts, delete nothing.",
  ].join("\n");
  const created = await openIssue(env, {
    companyId,
    sprint,
    title: `Fix preview: ${task.title}`.slice(0, 240),
    description: brief,
    originKind: ORIGIN.build,
    originId: buildOriginId(task.id),
    projectId: task.issueProjectId ?? undefined,
    parentId: task.issueId,
    assigneeAgentId: builder.id,
    wake: true,
    wakeReason: `Reviewer sent a preview back: ${task.title}`,
  });
  const builds = [...buildsOf(task), { issueId: created.id, agentId: builder.id, at: env.now().toISOString(), kind: "preview-fix" as const } satisfies BuildRef];
  await db.updateTask(env.ctx.db, companyId, task.id, { evidence: { ...(task.evidence ?? {}), builds }, blocker_reason: `Waiting for ${builder.name} to fix the preview the Reviewer sent back` });
  return { issueId: created.id, builder: builder.name };
}
