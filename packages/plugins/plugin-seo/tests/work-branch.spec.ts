/**
 * 0.22.0: a repo sprint's PR base, branch point and scope diff come from `default_branch`, which was `main` unless
 * somebody typed another one (the workspace's default ref is empty on the dev-flow projects, whose policy says
 * `origin/development`). The branch now comes from the project's workspace policy; a typed branch still wins.
 */
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { branchName, workBranchFromPolicy } from "../src/engine/site-change.js";
import { shownBranch, siteLinkParams } from "../src/ui/site-link.js";
import { NAMESPACE } from "../src/namespace.js";
import * as dbm from "../src/db.js";
import { createEnv, type Actor } from "../src/service/common.js";
import { healWorkBranch, linkSiteTool, siteProjectOptions } from "../src/service/site.js";

describe("workBranchFromPolicy", () => {
  it("reads the workspace policy's base ref as a branch name", () => {
    expect(workBranchFromPolicy({ enabled: true, workspaceStrategy: { type: "git_worktree", baseRef: "origin/development" } })).toBe("development");
    expect(workBranchFromPolicy({ workspaceStrategy: { baseRef: "refs/heads/staging" } })).toBe("staging");
    expect(workBranchFromPolicy({ workspaceStrategy: { baseRef: "refs/remotes/origin/release/2026" } })).toBe("release/2026");
    expect(workBranchFromPolicy({ workspaceStrategy: { baseRef: "main" } })).toBe("main");
    expect(workBranchFromPolicy({ workspaceStrategy: { baseRef: " origin/feature/a " } })).toBe("feature/a");
  });

  it("says nothing when the project sets no base ref or a ref that is not a branch", () => {
    // Penny: shared workspace, no strategy.
    expect(workBranchFromPolicy({ enabled: true, defaultMode: "shared_workspace", allowIssueOverride: false })).toBeNull();
    expect(workBranchFromPolicy(null)).toBeNull();
    expect(workBranchFromPolicy(undefined)).toBeNull();
    expect(workBranchFromPolicy("origin/development")).toBeNull();
    expect(workBranchFromPolicy({ workspaceStrategy: null })).toBeNull();
    expect(workBranchFromPolicy({ workspaceStrategy: { baseRef: "" } })).toBeNull();
    expect(workBranchFromPolicy({ workspaceStrategy: { baseRef: "HEAD" } })).toBeNull();
    expect(workBranchFromPolicy({ workspaceStrategy: { baseRef: "origin/HEAD" } })).toBeNull();
    expect(workBranchFromPolicy({ workspaceStrategy: { baseRef: "a".repeat(40) } })).toBeNull();
    expect(workBranchFromPolicy({ workspaceStrategy: { baseRef: 5 } })).toBeNull();
  });

  it("branchName strips the remote and ref prefixes only", () => {
    expect(branchName("origin/development")).toBe("development");
    expect(branchName("refs/heads/main")).toBe("main");
    expect(branchName("development")).toBe("development");
    expect(branchName("originals/x")).toBe("originals/x");
  });
});

type Row = Record<string, unknown>;

const SPRINT: Row = {
  id: "sp-1", company_id: "co-1", name: "Acme", site_url: "https://acme.co.za", site_name: "Acme", client_ref: null, client_name: null,
  status: "active", start_date: "2026-09-01", template_id: "outrank-90", template_version: 4, autopilot_mode: "safe", owner_user_id: "user-1",
  project_id: "proj-1", root_issue_id: null, root_issue_identifier: null, agent_id: null, notes: null, paused_reason: null, health: {}, scoreboard: {}, today: {},
  current_day: 25, current_week: 4, current_phase: 1, last_daily_on: null, last_weekly_on: null, audit_days_done: [0], seeded_at: "2026-09-01T00:00:00Z",
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", site_access: "unlinked", default_branch: "main", change_policy: "merge_seo_scope",
};

const POLICY_DEV = { enabled: true, defaultMode: "isolated_workspace", workspaceStrategy: { type: "git_worktree", baseRef: "origin/development" }, allowIssueOverride: true };

interface Setup {
  policy?: unknown;
  workspace?: { repoUrl?: string | null; defaultRef?: string | null; repoRef?: string | null } | null;
  sprint?: Row;
  marker?: string;
  projectFails?: boolean;
  /** Reading the branch marker from the host's state fails. */
  markerReadFails?: boolean;
}

function host(setup: Setup = {}) {
  const sprint = { ...SPRINT, ...(setup.sprint ?? {}) };
  const executes: Array<{ sql: string; params: unknown[] }> = [];
  const state = new Map<string, unknown>();
  if (setup.marker) state.set("seo-branch:sp-1", setup.marker);
  const ctx = {
    db: {
      namespace: NAMESPACE,
      async query(sql: string) {
        if (/FROM plugin_seo_\w+\.sprints WHERE id = \$1/.test(sql)) return [sprint];
        return [];
      },
      async execute(sql: string, params: unknown[] = []) {
        executes.push({ sql, params });
        return { rowCount: 1 };
      },
    },
    config: { get: vi.fn(async () => ({})) },
    companies: { get: vi.fn(async () => ({ id: "co-1", issuePrefix: "PAR" })) },
    projects: {
      get: vi.fn(async (id: string) => {
        if (setup.projectFails) throw new Error("host down");
        return { id, name: "Hunt and Gun", executionWorkspacePolicy: setup.policy ?? null, codebase: { repoUrl: null, defaultRef: null }, primaryWorkspace: setup.workspace ?? null };
      }),
      getPrimaryWorkspace: vi.fn(async () => (setup.workspace === undefined ? { repoUrl: "https://github.com/Partners-in-Biz/penny", defaultRef: null, repoRef: null } : setup.workspace)),
      list: vi.fn(async () => []),
    },
    state: {
      get: vi.fn(async (key: { stateKey: string; namespace?: string }) => {
        if (setup.markerReadFails) throw new Error("state down");
        return state.get(`${key.namespace}:${key.stateKey}`) ?? null;
      }),
      set: vi.fn(async (key: { stateKey: string; namespace?: string }, value: unknown) => void state.set(`${key.namespace}:${key.stateKey}`, value)),
      delete: vi.fn(async (key: { stateKey: string; namespace?: string }) => void state.delete(`${key.namespace}:${key.stateKey}`)),
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  } as unknown as PluginContext;
  const env = createEnv(ctx, { now: () => new Date("2026-10-03T08:00:00Z"), fetch: vi.fn() as never, site: vi.fn() as never });
  return { env, ctx, executes, state };
}

const person = { kind: "user", userId: "user-1" } as unknown as Actor;

/** The columns a sprints UPDATE sets (name → param). */
function sprintPatch(executes: Array<{ sql: string; params: unknown[] }>): Record<string, unknown> {
  const update = executes.find((e) => /UPDATE plugin_seo_\w+\.sprints SET/.test(e.sql));
  if (!update) return {};
  const set = /SET (.*) WHERE/.exec(update.sql)![1]!;
  return Object.fromEntries([...set.matchAll(/(\w+) = \$(\d+)/g)].map((m) => [m[1]!, update.params[Number(m[2]) - 1]]));
}

describe("link-site: which branch a repo sprint uses", () => {
  it("takes the project's work branch when its workspace has no default ref", async () => {
    const h = host({ policy: POLICY_DEV });
    await linkSiteTool(h.env, "co-1", person, { sprintId: "sp-1", projectId: "proj-dev" });
    expect(sprintPatch(h.executes)).toMatchObject({ site_access: "repo", site_project_id: "proj-dev", default_branch: "development" });
    // Nothing typed: no manual marker, so a later heal may follow the policy.
    expect(h.state.size).toBe(0);
  });

  it("prefers the policy's work branch to the workspace's default ref", async () => {
    const h = host({ policy: POLICY_DEV, workspace: { repoUrl: "https://github.com/x/y", defaultRef: "main", repoRef: "main" } });
    await linkSiteTool(h.env, "co-1", person, { sprintId: "sp-1", projectId: "proj-dev" });
    expect(sprintPatch(h.executes).default_branch).toBe("development");
  });

  it("falls back to the workspace's default ref, then leaves the stored branch alone", async () => {
    const withRef = host({ policy: null, workspace: { repoUrl: "https://github.com/x/y", defaultRef: "refs/heads/trunk" } });
    await linkSiteTool(withRef.env, "co-1", person, { sprintId: "sp-1", projectId: "proj-1" });
    expect(sprintPatch(withRef.executes).default_branch).toBe("trunk");
    // No policy and no ref (the PiB website's project says main on its workspace; others say nothing): the DB default stays.
    const none = host({ policy: { enabled: true, defaultMode: "shared_workspace" }, workspace: { repoUrl: "https://github.com/x/y", defaultRef: null } });
    await linkSiteTool(none.env, "co-1", person, { sprintId: "sp-1", projectId: "proj-1" });
    expect(sprintPatch(none.executes)).not.toHaveProperty("default_branch");
  });

  it("a branch typed into link-site wins, and the sprint remembers it was typed", async () => {
    const h = host({ policy: POLICY_DEV });
    await linkSiteTool(h.env, "co-1", person, { sprintId: "sp-1", projectId: "proj-dev", defaultBranch: "origin/release" });
    expect(sprintPatch(h.executes).default_branch).toBe("release");
    expect(h.state.get("seo-branch:sp-1")).toBe("manual");
    const main = host({ policy: POLICY_DEV });
    await linkSiteTool(main.env, "co-1", person, { sprintId: "sp-1", projectId: "proj-dev", defaultBranch: "main" });
    expect(sprintPatch(main.executes).default_branch).toBe("main");
    expect(main.state.get("seo-branch:sp-1")).toBe("manual");
  });
});

describe("link-site: saving the same project again never moves a branch somebody set", () => {
  // The SEO page always sends the project it shows; hosting and change policy edits arrive as the same project again.
  const linked = (extra: Row = {}) => ({ site_access: "repo", site_project_id: "proj-dev", repo_url: "https://github.com/x/y", ...extra });

  it("keeps a branch typed by hand (the marker), even when the project's work branch differs", async () => {
    const h = host({ policy: POLICY_DEV, sprint: linked({ default_branch: "release" }), marker: "manual" });
    await linkSiteTool(h.env, "co-1", person, { sprintId: "sp-1", projectId: "proj-dev", changePolicy: "pr_only" });
    expect(sprintPatch(h.executes)).not.toHaveProperty("default_branch");
    expect(sprintPatch(h.executes)).toMatchObject({ change_policy: "pr_only" });
    expect(h.state.get("seo-branch:sp-1")).toBe("manual");
    // A hand-typed `main` on a project whose policy says development is kept too.
    const main = host({ policy: POLICY_DEV, sprint: linked({ default_branch: "main" }), marker: "manual" });
    await linkSiteTool(main.env, "co-1", person, { sprintId: "sp-1", projectId: "proj-dev", hosting: "vercel" });
    expect(sprintPatch(main.executes)).not.toHaveProperty("default_branch");
    expect(sprintPatch(main.executes)).toMatchObject({ hosting: "vercel" });
  });

  it("keeps any branch other than the default main, typed before the marker existed", async () => {
    const h = host({ policy: POLICY_DEV, sprint: linked({ default_branch: "release" }) });
    await linkSiteTool(h.env, "co-1", person, { sprintId: "sp-1", projectId: "proj-dev", hosting: "other" });
    expect(sprintPatch(h.executes)).not.toHaveProperty("default_branch");
    // The workspace default ref is no different: a re-save does not reset the branch to it.
    const ws = host({ policy: null, workspace: { repoUrl: "https://github.com/x/y", defaultRef: "main" }, sprint: linked({ default_branch: "staging" }) });
    await linkSiteTool(ws.env, "co-1", person, { sprintId: "sp-1", projectId: "proj-dev", hosting: "other" });
    expect(sprintPatch(ws.executes)).not.toHaveProperty("default_branch");
  });

  it("leaves the branch alone when the marker cannot be read", async () => {
    const h = host({ policy: POLICY_DEV, sprint: linked({ default_branch: "main" }), markerReadFails: true });
    await linkSiteTool(h.env, "co-1", person, { sprintId: "sp-1", projectId: "proj-dev", hosting: "other" });
    expect(sprintPatch(h.executes)).not.toHaveProperty("default_branch");
  });

  it("still follows the policy for a sprint on the default main that nobody typed (what the daily heal does too)", async () => {
    const h = host({ policy: POLICY_DEV, sprint: linked({ default_branch: "main" }) });
    await linkSiteTool(h.env, "co-1", person, { sprintId: "sp-1", projectId: "proj-dev", hosting: "other" });
    expect(sprintPatch(h.executes).default_branch).toBe("development");
    expect(h.state.size).toBe(0);
  });

  it("a branch typed in the same save still wins on a re-save", async () => {
    const h = host({ policy: POLICY_DEV, sprint: linked({ default_branch: "release" }), marker: "manual" });
    await linkSiteTool(h.env, "co-1", person, { sprintId: "sp-1", projectId: "proj-dev", defaultBranch: "hotfix" });
    expect(sprintPatch(h.executes).default_branch).toBe("hotfix");
    expect(h.state.get("seo-branch:sp-1")).toBe("manual");
  });

  it("a different project takes its own work branch, and the old typed branch stops counting as typed", async () => {
    const h = host({ policy: POLICY_DEV, sprint: linked({ site_project_id: "proj-old", default_branch: "release" }), marker: "manual" });
    await linkSiteTool(h.env, "co-1", person, { sprintId: "sp-1", projectId: "proj-dev" });
    expect(sprintPatch(h.executes)).toMatchObject({ site_project_id: "proj-dev", default_branch: "development" });
    expect(h.state.has("seo-branch:sp-1")).toBe(false);
    // Linking from a sprint that had no repo (a WordPress or unlinked one) is a new link too.
    const wp = host({ policy: POLICY_DEV, sprint: { site_access: "wordpress", site_project_id: null, default_branch: "release" }, marker: "manual" });
    await linkSiteTool(wp.env, "co-1", person, { sprintId: "sp-1", projectId: "proj-dev" });
    expect(sprintPatch(wp.executes).default_branch).toBe("development");
  });

  it("a different project with no branch of its own keeps the stored branch and its marker", async () => {
    const h = host({ policy: null, workspace: { repoUrl: "https://github.com/x/y", defaultRef: null }, sprint: linked({ site_project_id: "proj-old", default_branch: "release" }), marker: "manual" });
    await linkSiteTool(h.env, "co-1", person, { sprintId: "sp-1", projectId: "proj-dev" });
    expect(sprintPatch(h.executes)).not.toHaveProperty("default_branch");
    expect(h.state.get("seo-branch:sp-1")).toBe("manual");
  });
});

describe("the SEO page's Site repo form (what it sends to link-site)", () => {
  const form = { sprintId: "sp-1", choice: "proj-dev", branch: "release", branchEdited: false, hosting: "", changePolicy: "merge_seo_scope" };

  it("does not send the branch it merely displays, so a save of hosting or policy cannot reset it", () => {
    expect(siteLinkParams(form)).toEqual({ sprintId: "sp-1", projectId: "proj-dev", changePolicy: "merge_seo_scope" });
    expect(siteLinkParams({ ...form, hosting: "vercel", changePolicy: "pr_only" })).toEqual({ sprintId: "sp-1", projectId: "proj-dev", hosting: "vercel", changePolicy: "pr_only" });
  });

  it("sends a branch that was typed, trimmed, and never for a WordPress site or no repo", () => {
    expect(siteLinkParams({ ...form, branch: " hotfix ", branchEdited: true })).toMatchObject({ projectId: "proj-dev", defaultBranch: "hotfix" });
    expect(siteLinkParams({ ...form, branch: "  ", branchEdited: true })).not.toHaveProperty("defaultBranch");
    expect(siteLinkParams({ ...form, choice: "wp:site-1", branch: "x", branchEdited: true })).toEqual({ sprintId: "sp-1", wordpressSiteId: "site-1", changePolicy: "merge_seo_scope" });
    expect(siteLinkParams({ ...form, choice: "__none" })).toEqual({ sprintId: "sp-1", noRepo: true, changePolicy: "merge_seo_scope" });
    expect(siteLinkParams({ ...form, choice: "" })).toEqual({ sprintId: "sp-1", changePolicy: "merge_seo_scope" });
  });

  it("shows the sprint's own branch for its project and the work branch for a newly picked one", () => {
    const shown = { branchEdited: false, choice: "proj-dev", currentChoice: "proj-dev", branch: "release", pickedBranch: "development" };
    expect(shownBranch(shown)).toBe("release");
    expect(shownBranch({ ...shown, choice: "proj-new" })).toBe("development");
    expect(shownBranch({ ...shown, choice: "proj-new", pickedBranch: null })).toBe("release");
    expect(shownBranch({ ...shown, choice: "proj-new", branchEdited: true, branch: "mine" })).toBe("mine");
  });

  it("end to end: the form's save of an unchanged project leaves a typed branch where it was", async () => {
    const h = host({ policy: POLICY_DEV, sprint: { site_access: "repo", site_project_id: "proj-dev", default_branch: "release" }, marker: "manual" });
    await linkSiteTool(h.env, "co-1", person, siteLinkParams({ ...form, hosting: "vercel" }));
    expect(sprintPatch(h.executes)).not.toHaveProperty("default_branch");
    expect(sprintPatch(h.executes)).toMatchObject({ hosting: "vercel" });
  });
});

describe("the project list the SEO page offers", () => {
  it("shows the work branch as each project's branch", async () => {
    const h = host();
    (h.ctx.projects.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "p-dev", name: "Hunt and Gun", urlKey: "hg", executionWorkspacePolicy: POLICY_DEV, primaryWorkspace: { repoUrl: "https://github.com/x/hg", defaultRef: null }, codebase: null },
      { id: "p-site", name: "Website", urlKey: "web", executionWorkspacePolicy: null, primaryWorkspace: { repoUrl: "https://github.com/x/web", defaultRef: "main" }, codebase: null },
    ]);
    const options = await siteProjectOptions(h.env, "co-1", null);
    expect(options.map((o) => [o.projectId, o.defaultBranch]).sort()).toEqual([["p-dev", "development"], ["p-site", "main"]]);
  });
});

describe("healWorkBranch (the daily run)", () => {
  const linked = (extra: Row = {}) => dbm.getSprint({ namespace: NAMESPACE, query: async () => [{ ...SPRINT, site_access: "repo", site_project_id: "proj-dev", default_branch: "main", ...extra }], execute: async () => ({ rowCount: 0 }) } as never, "co-1", "sp-1") as Promise<dbm.Sprint>;

  it("moves a repo sprint still on main to the project's work branch, once", async () => {
    const h = host({ policy: POLICY_DEV });
    const fresh = await healWorkBranch(h.env, await linked());
    expect(fresh.defaultBranch).toBe("development");
    expect(sprintPatch(h.executes)).toEqual(expect.objectContaining({ default_branch: "development" }));
    // Next day the sprint says development: nothing to do.
    const again = host({ policy: POLICY_DEV });
    expect((await healWorkBranch(again.env, await linked({ default_branch: "development" }))).defaultBranch).toBe("development");
    expect(again.executes).toEqual([]);
    expect(again.ctx.projects.get).not.toHaveBeenCalled();
  });

  it("never overrides a branch typed by hand, or any branch other than the default main", async () => {
    const manual = host({ policy: POLICY_DEV, marker: "manual" });
    expect((await healWorkBranch(manual.env, await linked())).defaultBranch).toBe("main");
    expect(manual.executes).toEqual([]);
    const typed = host({ policy: POLICY_DEV });
    expect((await healWorkBranch(typed.env, await linked({ default_branch: "release" }))).defaultBranch).toBe("release");
    expect(typed.executes).toEqual([]);
  });

  it("leaves projects with no work branch, other site modes and host errors alone", async () => {
    for (const setup of [{ policy: null }, { policy: { workspaceStrategy: { baseRef: "origin/main" } } }, { policy: POLICY_DEV, projectFails: true }]) {
      const h = host(setup);
      expect((await healWorkBranch(h.env, await linked())).defaultBranch).toBe("main");
      expect(h.executes).toEqual([]);
    }
    const wp = host({ policy: POLICY_DEV });
    expect((await healWorkBranch(wp.env, await linked({ site_access: "wordpress", site_project_id: null }))).defaultBranch).toBe("main");
    expect(wp.executes).toEqual([]);
  });
});
