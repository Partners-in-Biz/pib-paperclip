/**
 * The sprint's site link: which Paperclip project (workspace = the site repo)
 * code and content tasks run in, and the change policy for the agent's PRs.
 */
import { PLUGIN_ID } from "../namespace.js";
import * as db from "../db.js";
import {
  CHANGE_POLICIES,
  evaluateChange,
  githubRepo,
  HOSTINGS,
  SEO_SCOPE,
  SEO_SCOPE_CATEGORIES,
  type ChangePolicy,
  type ChecksState,
  type ProposedChange,
} from "../engine/site-change.js";
import { ensureProject, resolveAgent } from "./agent.js";
import { actorLabel, bool, companyInfo, errorMessage, oneOf, reqStr, SeoError, str, type Actor, type Env, type Params } from "./common.js";
import { requireSprint } from "./context.js";
import { commentOn } from "./issues.js";
import { resolveNeedsYou } from "./needs-you.js";
import { relocateCodeTasks } from "./tasks.js";
import { sprintClock } from "../engine/sprint.js";

export function siteLinkView(sprint: db.Sprint) {
  return {
    siteAccess: sprint.siteAccess,
    siteProjectId: sprint.siteProjectId,
    repoUrl: sprint.repoUrl,
    github: githubRepo(sprint.repoUrl),
    defaultBranch: sprint.defaultBranch,
    framework: sprint.framework,
    hosting: sprint.hosting,
    changePolicy: sprint.changePolicy,
  };
}

interface ProjectOption {
  projectId: string;
  name: string;
  urlKey: string | null;
  repoUrl: string | null;
  defaultBranch: string | null;
  suggested: boolean;
}

function siteTokens(siteUrl: string): string[] {
  try {
    const host = new URL(siteUrl).hostname.replace(/^www\./, "");
    const base = host.split(".")[0] ?? host;
    return [host, base, base.replace(/-/g, "")].filter((t) => t.length >= 3);
  } catch {
    return [];
  }
}

/** Company projects that could hold the site repo (the plugin's own SEO project excluded). */
export async function siteProjectOptions(env: Env, companyId: string, siteUrl: string | null): Promise<ProjectOption[]> {
  const projects = await env.ctx.projects.list({ companyId, limit: 200 });
  const tokens = siteUrl ? siteTokens(siteUrl) : [];
  const out: ProjectOption[] = [];
  for (const project of projects) {
    const p = project as unknown as Record<string, unknown> & { managedByPlugin?: { pluginKey?: string } | null };
    if (p.archivedAt) continue;
    if (p.managedByPlugin?.pluginKey === PLUGIN_ID) continue;
    const primary = (p.primaryWorkspace ?? null) as { repoUrl?: string | null; defaultRef?: string | null; repoRef?: string | null } | null;
    const codebase = (p.codebase ?? null) as { repoUrl?: string | null; defaultRef?: string | null } | null;
    const repoUrl = primary?.repoUrl ?? codebase?.repoUrl ?? null;
    const haystack = `${String(p.name ?? "")} ${repoUrl ?? ""}`.toLowerCase();
    out.push({
      projectId: String(p.id),
      name: String(p.name ?? "Project"),
      urlKey: typeof p.urlKey === "string" ? p.urlKey : null,
      repoUrl,
      defaultBranch: primary?.defaultRef ?? primary?.repoRef ?? codebase?.defaultRef ?? null,
      suggested: Boolean(repoUrl) && tokens.some((t) => haystack.includes(t.toLowerCase())),
    });
  }
  return out.sort((a, b) => Number(b.suggested) - Number(a.suggested) || Number(Boolean(b.repoUrl)) - Number(Boolean(a.repoUrl)) || a.name.localeCompare(b.name));
}

export async function listSiteProjectsTool(env: Env, companyId: string, params: Params) {
  const sprintId = str(params, "sprintId");
  const sprint = sprintId ? await requireSprint(env, companyId, sprintId) : null;
  const info = await companyInfo(env, companyId);
  const options = await siteProjectOptions(env, companyId, sprint?.siteUrl ?? null);
  return {
    ...(sprint ? { sprintId: sprint.id, current: siteLinkView(sprint) } : {}),
    projects: options,
    createProject: {
      link: info.prefix ? `/${info.prefix}/projects` : "/projects",
      steps: "Projects → New project → add a workspace with the repo URL and default branch. Paperclip cannot create project workspaces from a plugin.",
    },
  };
}

const POLICY_RANK: Record<ChangePolicy, number> = { pr_only: 0, merge_seo_scope: 1, full: 2 };

export async function linkSiteTool(env: Env, companyId: string, actor: Actor, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const info = await companyInfo(env, companyId);
  const patch: Record<string, unknown> = {};
  const projectId = str(params, "projectId", { max: 100 });
  const noRepo = bool(params, "noRepo") ?? false;
  const unlink = bool(params, "unlink") ?? false;
  if (unlink) {
    if (actor.kind !== "user") throw new SeoError("Only a person can unlink the site repo");
    Object.assign(patch, { site_access: "unlinked", site_project_id: null, repo_url: null });
  } else if (noRepo) {
    Object.assign(patch, { site_access: "none", site_project_id: null, repo_url: null });
  } else if (projectId) {
    const project = await env.ctx.projects.get(projectId, companyId);
    if (!project) throw new SeoError(`Project ${projectId} was not found in this company`);
    let repoUrl: string | null = null;
    let branch: string | null = null;
    try {
      const workspace = await env.ctx.projects.getPrimaryWorkspace(projectId, companyId);
      repoUrl = workspace?.repoUrl ?? null;
      branch = workspace?.defaultRef ?? workspace?.repoRef ?? null;
    } catch (error) {
      env.ctx.logger.info("SEO site workspace read failed", { projectId, error: errorMessage(error) });
    }
    const codebase = (project as unknown as { codebase?: { repoUrl?: string | null; defaultRef?: string | null } }).codebase;
    repoUrl = repoUrl ?? codebase?.repoUrl ?? null;
    branch = branch ?? codebase?.defaultRef ?? null;
    Object.assign(patch, { site_access: "repo", site_project_id: projectId, repo_url: repoUrl });
    if (branch && !str(params, "defaultBranch")) patch.default_branch = branch.replace(/^refs\/heads\/|^origin\//, "");
  }
  const defaultBranch = str(params, "defaultBranch", { max: 100 });
  if (defaultBranch) patch.default_branch = defaultBranch;
  const framework = str(params, "framework", { max: 40 });
  if (framework) patch.framework = framework;
  const hosting = oneOf(params, "hosting", HOSTINGS);
  if (hosting) patch.hosting = hosting;
  const policy = oneOf(params, "changePolicy", CHANGE_POLICIES);
  if (policy) {
    if (actor.kind !== "user" && POLICY_RANK[policy] > POLICY_RANK[sprint.changePolicy]) {
      throw new SeoError("An agent can lower the change policy but not raise it. Ask a person to change it on the SEO page.");
    }
    patch.change_policy = policy;
  }
  if (Object.keys(patch).length === 0) throw new SeoError("Nothing to change: pass projectId, noRepo, unlink, defaultBranch, framework, hosting or changePolicy");
  await db.updateSprint(env.ctx.db, companyId, sprint.id, patch);
  const fresh = (await db.getSprint(env.ctx.db, companyId, sprint.id))!;
  let moved = { moved: 0, opened: 0 };
  let resolved = false;
  const linkChanged = fresh.siteAccess !== sprint.siteAccess || fresh.siteProjectId !== sprint.siteProjectId;
  if (linkChanged) {
    if (fresh.siteAccess !== "unlinked") {
      resolved = (await resolveNeedsYou(env, info, fresh, "site_project", actorLabel(actor)).catch(() => ({ resolved: false }))).resolved;
    }
    if (fresh.rootIssueId && fresh.seededAt && fresh.siteAccess !== "unlinked") {
      const clock = sprintClock(fresh.startDate, info.today);
      moved = await relocateCodeTasks(env, {
        info,
        sprint: fresh,
        day: clock.day,
        agent: await resolveAgent(env, companyId),
        projectId: fresh.projectId ?? (await ensureProject(env, companyId)),
      }).catch((error: unknown) => {
        env.ctx.logger.info("SEO code task move failed", { sprintId: sprint.id, error: errorMessage(error) });
        return { moved: 0, opened: 0 };
      });
    }
    if (fresh.rootIssueId) {
      const what = fresh.siteAccess === "repo" ? `the repo project (${fresh.repoUrl ?? "no repo URL on its workspace yet"})` : fresh.siteAccess === "none" ? "no repo access (change sets go through Needs you)" : "nothing (unlinked)";
      await commentOn(env, companyId, fresh.rootIssueId, `Site linked to ${what} by ${actorLabel(actor)}. Change policy: ${fresh.changePolicy.replace(/_/g, " ")}.${moved.moved + moved.opened > 0 ? ` ${moved.moved} code task(s) moved, ${moved.opened} issue(s) opened.` : ""}`);
    }
  }
  const warnings: string[] = [];
  if (fresh.siteAccess === "repo" && !fresh.repoUrl) warnings.push("The project's workspace has no repo URL. Add one in the project (workspace → repo URL) so the agent can push.");
  if (fresh.siteAccess === "repo" && fresh.repoUrl && !githubRepo(fresh.repoUrl)) warnings.push("The repo is not on GitHub: the agent pushes with git but must open and merge PRs by hand-off.");
  return { sprintId: sprint.id, ...siteLinkView(fresh), needsYouResolved: resolved, codeTasksMoved: moved.moved, issuesOpened: moved.opened, warnings };
}

export async function getSiteLinkTool(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  return {
    sprintId: sprint.id,
    ...siteLinkView(sprint),
    scope: SEO_SCOPE,
    next:
      sprint.siteAccess === "unlinked"
        ? "No site repo linked yet: code tasks wait. list-site-projects shows candidate projects; link-site links one (or noRepo: true)."
        : sprint.siteAccess === "none"
          ? "No repo access: prepare exact change sets and add them to Needs you (needs-you-add kind task)."
          : "Work code tasks in this project's workspace on seo/<task> branches; decide merges with check-change-scope.",
  };
}

export async function checkChangeScopeTool(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const raw = params.changes;
  if (!Array.isArray(raw) || raw.length === 0) throw new SeoError("changes must list every changed file as { path, category }");
  const changes: ProposedChange[] = raw.slice(0, 300).map((item) => {
    const c = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    if (typeof c.path !== "string" || !c.path.trim()) throw new SeoError("Every change needs a path");
    return { path: c.path.trim(), category: typeof c.category === "string" ? c.category.trim() : "other" };
  });
  const checks = (oneOf(params, "checks", ["passed", "failed", "pending"] as const) ?? "pending") as ChecksState;
  const verdict = evaluateChange(sprint.changePolicy, changes, checks);
  return { sprintId: sprint.id, changePolicy: sprint.changePolicy, checks, ...verdict, categories: SEO_SCOPE_CATEGORIES };
}
