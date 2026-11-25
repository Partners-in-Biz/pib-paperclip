import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Browser, type Page } from "@playwright/test";
import { api, BASE } from "./member-restriction-shell";

// Fixtures for member-restriction-workspace-config.spec.ts (PAR-13318, C4i-d 2/2, AC-G10).
// New file on purpose (stage C test rules): the shell spec's `api` and request recorder are
// reused as they are; this file owns its owner login, company and records.

const CONFIG = process.env.PAPERCLIP_E2E_MR_CONFIG ?? "";
const HOME = process.env.PAPERCLIP_E2E_MR_HOME ?? "";
const ROOT = path.resolve(import.meta.dirname, "../../..");
export const RUN = Date.now();
export const PROJECT = `Config project ${RUN}`;
export const WORKSPACE = `Config codebase ${RUN}`;
export const R_TASK = `R config task ${RUN}`;
export const O_TASK = `Owner config task ${RUN}`;
/** Turned on for the visit: the workspace pages, pickers and env reads exist only with these. */
export const FLAGS = ["enableIsolatedWorkspaces", "enableEnvironments"] as const;

export type Fixture = {
  companyId: string; prefix: string; owner: Page; person: Page; personId: string;
  projectId: string; workspaceId: string; rTaskId: string; oTaskId: string;
  originalFlags: Record<string, unknown>;
};

const tsx = (script: string, args: string[]) => execFileSync(process.execPath,
  ["cli/node_modules/tsx/dist/cli.mjs", script, ...args], { cwd: ROOT, encoding: "utf8" }).trim();

const newPage = async (browser: Browser) =>
  (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();

async function signUp(browser: Browser, name: string) {
  const page = await newPage(browser);
  const email = `${name.toLowerCase().replace(/\W+/g, "-")}-${RUN}@paperclip.local`;
  const password = `paperclip-${RUN}-password`;
  await page.goto(`${BASE}/auth`);
  await page.getByRole("button", { name: "Create one" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page).not.toHaveURL(/\/auth/, { timeout: 20_000 });
  return { page, email, password };
}

// A restarted worker runs `setUp` again: the first owner's throwaway login is kept in the test home.
const OWNER_FILE = path.join(HOME || ROOT, "workspace-config-owner.json");

/** An instance admin. Claims the instance, or is made admin when another spec claimed it first. */
async function instanceOwner(browser: Browser) {
  if (existsSync(OWNER_FILE)) {
    const page = await newPage(browser);
    await page.goto(`${BASE}/auth`);
    await api(page, "POST", "/api/auth/sign-in/email", JSON.parse(readFileSync(OWNER_FILE, "utf8")));
    return page;
  }
  const { page, email, password } = await signUp(browser, "Config Owner");
  const health = await api<{ bootstrapStatus?: string }>(page, "GET", "/api/health");
  if (health.bootstrapStatus === "ready") {
    const session = await api<{ user: { id: string } }>(page, "GET", "/api/auth/get-session");
    tsx("tests/e2e/fixtures/member-restriction-seed-workspace.ts", ["--config", CONFIG, "--grant-instance-admin", session.user.id]);
  } else {
    const bootstrap = tsx("packages/db/scripts/create-auth-bootstrap-invite.ts", ["--config", CONFIG, "--base-url", BASE]);
    await api(page, "POST", `/api/invites/${new URL(bootstrap).pathname.split("/").at(-1)}/accept`, { requestType: "human" });
  }
  writeFileSync(OWNER_FILE, JSON.stringify({ email, password }));
  return page;
}

/**
 * Owner O; R, a restricted operator. A project with execution workspaces on, a codebase workspace
 * and R as access member; R's task in it, and O's task assigned to a Claude agent with a Chrome
 * override (the override row shows only for a task that has one).
 */
export async function setUp(browser: Browser): Promise<Fixture> {
  const owner = await instanceOwner(browser);
  const originalFlags = await api(owner, "GET", "/api/instance/settings/experimental");
  await api(owner, "PATCH", "/api/instance/settings/experimental", Object.fromEntries(FLAGS.map((flag) => [flag, true])));
  const company = await api<{ id: string; issuePrefix: string }>(owner, "POST", "/api/companies", { name: `MR config ${RUN}` });
  const c = `/api/companies/${company.id}`;
  const invite = await api<{ inviteUrl: string }>(owner, "POST", `${c}/invites`, { allowedJoinTypes: "human", humanRole: "operator" });
  const { page: person } = await signUp(browser, "Config Person");
  await api(person, "POST", `/api/invites/${new URL(invite.inviteUrl, BASE).pathname.split("/").at(-1)}/accept`, { requestType: "human" });
  const session = await api<{ user: { id: string } }>(person, "GET", "/api/auth/get-session");
  const project = await api<{ id: string }>(owner, "POST", `${c}/projects`, {
    name: PROJECT, executionWorkspacePolicy: { enabled: true, allowIssueOverride: true, defaultMode: "shared_workspace" },
  });
  await api(owner, "POST", `/api/projects/${project.id}/access-members`, { subjectType: "user", subjectId: session.user.id });
  const workspace = await api<{ id: string }>(owner, "POST", `/api/projects/${project.id}/workspaces`, {
    name: WORKSPACE, cwd: HOME || ROOT, isPrimary: true,
  });
  // `runner: "legacy"`: on a host qualified for the Paperclip Runner, `auto` stores a Claude agent as
  // `paperclip_runner`, which has no Chrome override (the toggle is `claude_local` only).
  const agent = await api<{ id: string; adapterType: string }>(owner, "POST", `${c}/agents`, {
    name: `Config agent ${RUN}`, role: "engineer", adapterType: "claude_local", adapterConfig: {}, runner: "legacy",
  });
  expect(agent.adapterType).toBe("claude_local");
  // Never runs: the spec only reads its task's override row.
  await api(owner, "POST", `/api/agents/${agent.id}/pause`, {});
  const rTask = await api<{ id: string }>(owner, "POST", `${c}/issues`, {
    title: R_TASK, status: "todo", assigneeUserId: session.user.id, projectId: project.id,
  });
  const oTask = await api<{ id: string }>(owner, "POST", `${c}/issues`, {
    title: O_TASK, status: "backlog", assigneeAgentId: agent.id, projectId: project.id,
    assigneeAdapterOverrides: { adapterConfig: { chrome: true } },
  });
  const { members } = await api<{ members: Array<{ id: string; principalId: string }> }>(owner, "GET", `${c}/members`);
  const member = members.find((entry) => entry.principalId === session.user.id)!;
  await api(owner, "PUT", `${c}/members/${member.id}/restriction`, { restricted: true });
  return {
    companyId: company.id, prefix: company.issuePrefix, owner, person, personId: session.user.id,
    projectId: project.id, workspaceId: workspace.id, rTaskId: rTask.id, oTaskId: oTask.id, originalFlags,
  };
}

export const setMode = (f: Fixture, mode: "off" | "report" | "enforce") =>
  api(f.owner, "PUT", `/api/companies/${f.companyId}/member-restriction-mode`, { mode });

export const restoreFlags = (f: Fixture) => api(f.owner, "PATCH", "/api/instance/settings/experimental",
  Object.fromEntries(FLAGS.map((flag) => [flag, f.originalFlags[flag] ?? false])));

/**
 * The routes the files of PAR-12952 (C4i-d 1/2) call: secrets, user-secret definitions,
 * environments, git authorization, repository options, execution-workspace lists, project
 * workspace writes and runtime commands, tree control and tree holds, adapter models.
 */
const OWN_ROUTE = new RegExp([
  "/secrets", "/user-secret-definitions", "/environments", "/git-authorization", "/project-repositories",
  "/repositories", "/execution-workspaces", "/projects/[^/]+/workspaces", "/tree-control", "/tree-holds",
  "/adapters/[^/]+/models",
].join("|"));
export const ownRoute = (call: { path: string }) => OWN_ROUTE.test(call.path);
