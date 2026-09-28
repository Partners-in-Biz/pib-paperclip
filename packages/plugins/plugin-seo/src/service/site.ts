/**
 * The sprint's site link: which Paperclip project (workspace = the site repo)
 * code and content tasks run in, or which CRM WordPress site the agent
 * changes through the PiB Connector, and the change policy.
 */
import { sameSite } from "@partnersinbiz/pib-plugin-kit/client-sites";
import { plural } from "../engine/plain.js";
import { PLUGIN_ID } from "../namespace.js";
import * as db from "../db.js";
import type { CrmSiteRow } from "@partnersinbiz/pib-plugin-kit";
import {
  CHANGE_POLICIES,
  evaluateChange,
  evaluateWordPressChange,
  githubRepo,
  HOSTINGS,
  SEO_SCOPE,
  SEO_SCOPE_CATEGORIES,
  WORDPRESS_SCOPE_CATEGORIES,
  type ChangePolicy,
  type ChecksState,
  type ProposedChange,
} from "../engine/site-change.js";
import { ensureProject, resolveAgent } from "./agent.js";
import { actorLabel, bool, companyInfo, errorMessage, oneOf, reqStr, SeoError, str, type Actor, type Env, type Params } from "./common.js";
import { requireSprint } from "./context.js";
import { commentOn } from "./issues.js";
import { addNeedsYou, resolveNeedsYou } from "./needs-you.js";
import { relocateCodeTasks } from "./tasks.js";
import { sprintClock } from "../engine/sprint.js";
import { clientWordPressSites, requireWordPressSite, sprintCrmPath, sprintWordPressSite, wordPressSiteView, wpConnectorItemFor } from "./wordpress.js";

/** `site`: the projected CRM site of a wordpress sprint, when the caller loaded it (else null). */
export function siteLinkView(sprint: db.Sprint, site?: CrmSiteRow | null) {
  return {
    siteAccess: sprint.siteAccess,
    siteProjectId: sprint.siteProjectId,
    siteId: sprint.siteId,
    site: sprint.siteAccess === "wordpress" && site ? wordPressSiteView(site) : null,
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

/** The sprint client's WordPress sites for the site link picker (matching URL first). */
export async function wordPressSiteOptions(env: Env, sprint: db.Sprint) {
  const rows = await clientWordPressSites(env, sprint).catch(() => [] as CrmSiteRow[]);
  const sites = rows.map((row) => ({ ...wordPressSiteView(row), suggested: sameSite(row.url, sprint.siteUrl) }));
  return sites.sort((a, b) => Number(b.suggested) - Number(a.suggested) || a.url.localeCompare(b.url));
}

export async function listSiteProjectsTool(env: Env, companyId: string, params: Params) {
  const sprintId = str(params, "sprintId");
  const sprint = sprintId ? await requireSprint(env, companyId, sprintId) : null;
  const info = await companyInfo(env, companyId);
  const options = await siteProjectOptions(env, companyId, sprint?.siteUrl ?? null);
  return {
    ...(sprint ? { sprintId: sprint.id, current: siteLinkView(sprint, await sprintWordPressSite(env, sprint)), wordpressSites: await wordPressSiteOptions(env, sprint) } : {}),
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
  const wordpressSiteId = str(params, "wordpressSiteId", { max: 100 });
  const noRepo = bool(params, "noRepo") ?? false;
  const unlink = bool(params, "unlink") ?? false;
  let wpSite: CrmSiteRow | null = null;
  if (unlink) {
    if (actor.kind !== "user") throw new SeoError("Only a person can unlink the site repo");
    Object.assign(patch, { site_access: "unlinked", site_project_id: null, site_id: null, repo_url: null });
  } else if (noRepo) {
    Object.assign(patch, { site_access: "none", site_project_id: null, site_id: null, repo_url: null });
  } else if (wordpressSiteId) {
    wpSite = await requireWordPressSite(env, sprint, wordpressSiteId);
    Object.assign(patch, { site_access: "wordpress", site_id: wpSite.id, site_project_id: null, repo_url: null });
    if (!sprint.hosting && !str(params, "hosting")) patch.hosting = "other";
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
    Object.assign(patch, { site_access: "repo", site_project_id: projectId, site_id: null, repo_url: repoUrl });
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
  if (Object.keys(patch).length === 0) throw new SeoError("Nothing to change: pass projectId, wordpressSiteId, noRepo, unlink, defaultBranch, framework, hosting or changePolicy");
  await db.updateSprint(env.ctx.db, companyId, sprint.id, patch);
  const fresh = (await db.getSprint(env.ctx.db, companyId, sprint.id))!;
  let moved = { moved: 0, opened: 0 };
  let resolved = false;
  const linkChanged = fresh.siteAccess !== sprint.siteAccess || fresh.siteProjectId !== sprint.siteProjectId || fresh.siteId !== sprint.siteId;
  const site = wpSite ?? (await sprintWordPressSite(env, fresh));
  if (linkChanged) {
    if (fresh.siteAccess !== "unlinked") {
      resolved = (await resolveNeedsYou(env, info, fresh, "site_project", actorLabel(actor)).catch(() => ({ resolved: false }))).resolved;
    }
    // A WordPress site without a connected Connector: the one grant goes on Needs you straight away.
    if (fresh.siteAccess === "wordpress" && site && site.connector_status !== "connected") {
      await addNeedsYou(env, info, fresh, wpConnectorItemFor(info, fresh, site)).catch((error: unknown) => {
        env.ctx.logger.info("SEO wp_connector item not added", { sprintId: sprint.id, error: errorMessage(error) });
      });
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
      const what =
        fresh.siteAccess === "repo"
          ? `the repo project (${fresh.repoUrl ?? "no repo URL on its workspace yet"})`
          : fresh.siteAccess === "wordpress"
            ? `the WordPress site ${site?.url ?? fresh.siteUrl} through the PiB Connector (${site ? wordPressSiteView(site).summary : "site not found in the CRM"})`
            : fresh.siteAccess === "none"
              ? "no repo access (change sets go through Needs you)"
              : "nothing (unlinked)";
      await commentOn(env, companyId, fresh.rootIssueId, `Site linked to ${what} by ${actorLabel(actor)}. Change policy: ${fresh.changePolicy.replace(/_/g, " ")}.${moved.moved + moved.opened > 0 ? ` ${plural(moved.moved, "code task")} moved, ${plural(moved.opened, "issue")} opened.` : ""}`);
    }
  }
  const warnings: string[] = [];
  if (fresh.siteAccess === "repo" && !fresh.repoUrl) warnings.push("The project's workspace has no repo URL. Add one in the project (workspace → repo URL) so the agent can push.");
  if (fresh.siteAccess === "repo" && fresh.repoUrl && !githubRepo(fresh.repoUrl)) warnings.push("The repo is not on GitHub: the agent pushes with git but must open and merge PRs by hand-off.");
  if (fresh.siteAccess === "wordpress" && site && site.connector_status !== "connected") {
    warnings.push(`The PiB Connector is not connected on ${site.url} yet. Connect it on the CRM client page → Websites (the steps are on Needs you).`);
  }
  return { sprintId: sprint.id, ...siteLinkView(fresh, site), needsYouResolved: resolved, codeTasksMoved: moved.moved, issuesOpened: moved.opened, warnings };
}

/** What the agent does on a wordpress sprint, by change policy (get-site-link `next`). */
export function wordPressNext(sprint: db.Sprint, site: CrmSiteRow | null, prefix: string | null): string {
  const tools = [
    "`partnersinbiz.crm:wp-seo` (op get / set: title, description, canonical, noindex, nofollow, focusKeyword, ogTitle, ogDescription)",
    "`partnersinbiz.crm:wp-schema`",
    "`partnersinbiz.crm:wp-redirects`",
    "`partnersinbiz.crm:wp-robots`",
    "`partnersinbiz.crm:wp-sitemap`",
    "`partnersinbiz.crm:wp-health`",
    "`partnersinbiz.crm:wp-log`",
    "`partnersinbiz.crm:wp-undo`",
  ].join(", ");
  const policy =
    sprint.changePolicy === "pr_only"
      ? "Change policy pr_only: read with the tools, then write the exact change set (page, field, old value, new value), put it on Needs you (needs-you-add kind task, the change set in copy) and block-task."
      : `Change policy ${sprint.changePolicy.replace(/_/g, " ")}: apply SEO fields, schema, redirects, extra robots.txt lines and sitemap settings yourself, then verify.`;
  if (!site) return `This sprint is linked to WordPress site ${sprint.siteId ?? "?"}, which is no longer in the CRM. Ask a person to pick the site again (needs-you-add key site_project) and work other tasks meanwhile.`;
  const lines = [
    `WordPress site ${site.url} (${wordPressSiteView(site).summary}). Every SEO change on this site goes through the CRM's Connector tools with siteId "${site.id}": ${tools}. All take siteId; writes take a reason.`,
    "Then verify on the live site with check-meta, validate-schema, check-sitemap and crawler-sim (use check-change-scope with wp:<area>:<target> paths first when unsure).",
    policy,
    "Plugin installs (`partnersinbiz.crm:wp-plugins`) always go to Needs you for a person.",
  ];
  if (site.connector_status !== "connected") {
    lines.unshift(`The PiB Connector is not connected (${site.connector_status}): needs-you-add with key wp_connector, then block-task. Steps for the person: ${sprintCrmPath(prefix, sprint)} → Websites.`);
  }
  return lines.join(" ");
}

export async function getSiteLinkTool(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const site = await sprintWordPressSite(env, sprint);
  const info = sprint.siteAccess === "wordpress" ? await companyInfo(env, companyId) : null;
  return {
    sprintId: sprint.id,
    ...siteLinkView(sprint, site),
    scope: SEO_SCOPE,
    ...(sprint.siteAccess === "wordpress" ? { wordpressScope: WORDPRESS_SCOPE_CATEGORIES } : {}),
    next:
      sprint.siteAccess === "unlinked"
        ? "No site repo linked yet: code tasks wait. list-site-projects shows candidate projects and the client's WordPress sites; link-site links one (projectId, wordpressSiteId or noRepo: true)."
        : sprint.siteAccess === "wordpress"
          ? wordPressNext(sprint, site, info?.prefix ?? null)
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
  if (sprint.siteAccess === "wordpress") {
    // No CI on the Connector: the change is verified on the live site after it is applied.
    return { sprintId: sprint.id, changePolicy: sprint.changePolicy, checks, ...evaluateWordPressChange(sprint.changePolicy, changes), categories: WORDPRESS_SCOPE_CATEGORIES };
  }
  const verdict = evaluateChange(sprint.changePolicy, changes, checks);
  return { sprintId: sprint.id, changePolicy: sprint.changePolicy, checks, ...verdict, categories: SEO_SCOPE_CATEGORIES };
}
