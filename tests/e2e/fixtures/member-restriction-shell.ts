import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Browser, type Page } from "@playwright/test";
import { createRouteClassifier } from "../../../server/src/services/member-restriction/route-table";

// Fixtures for member-restriction-shell.spec.ts (PAR-13267, AC-G10). New file on purpose:
// the open C tickets' specs keep their own helpers (stage C test rules, spec 8).

export const BASE = process.env.PAPERCLIP_E2E_MR_BASE_URL ?? "http://127.0.0.1:3197";
const CONFIG = process.env.PAPERCLIP_E2E_MR_CONFIG ?? "";
const ROOT = path.resolve(import.meta.dirname, "../../..");
export const RUN = Date.now();
export const TASK = `Shell task ${RUN}`;
export const AGENT = `Shell agent ${RUN}`;
export const PROJECT = `Shell project ${RUN}`;
export const PLUGIN_KEY = "paperclip.e2e-mr-issues";

/**
 * Every experimental flag read by a file of C4g-2c-1 (PAR-13264) or C4g-2c-2 (PAR-13266):
 * `grep -o 'experimentalSettings?.enable[A-Za-z]*'` over those files at branch time
 * (base 2c595b0d7). `enableEnvironments` is new since `ca62e3160`.
 */
export const GATING_FLAGS = [
  "enableDecisions", "enableCombinedInboxTasks", "enableIsolatedWorkspaces", "enableExternalObjects",
  "enableBuiltInAgents", "enableCases", "enableConferenceRoomChat", "enableStatusCards",
  "enableGoalsSidebarLink", "enableApps", "enablePaperclipDeveloperMode", "enableEnvironments",
] as const;

export type Shell = "coordinator" | "production";
export type ApiCall = { method: string; path: string; status: number; code: string | null; at: string };
export type Fixture = {
  companyId: string; prefix: string; owner: Page; person: Page;
  taskId: string; agentId: string; projectId: string; workspaceId: string; originalFlags: Record<string, unknown>;
  /** Set by `setFlags`: every gating flag on. */
  flagsOn?: boolean;
};

export async function api<T = Record<string, unknown>>(page: Page, method: string, url: string, data?: unknown) {
  const res = await page.evaluate(async ({ method, url, data }) => {
    const response = await fetch(url, {
      method, credentials: "include",
      headers: data === undefined ? undefined : { "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  }, { method, url: `${BASE}${url}`, data });
  expect(res.status, `${method} ${url}: ${JSON.stringify(res.json)}`).toBeLessThan(300);
  return res.json as T;
}

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

// The instance is claimed once. A failed test restarts the worker and runs `setUp` again,
// so the first owner's throwaway login is kept in the test server's home and reused.
const OWNER_FILE = path.join(process.env.PAPERCLIP_E2E_MR_HOME ?? ROOT, "shell-owner.json");

async function instanceOwner(browser: Browser) {
  if (existsSync(OWNER_FILE)) {
    const page = await newPage(browser);
    await page.goto(`${BASE}/auth`);
    await api(page, "POST", "/api/auth/sign-in/email", JSON.parse(readFileSync(OWNER_FILE, "utf8")));
    return page;
  }
  const { page, email, password } = await signUp(browser, "Shell Owner");
  const bootstrap = tsx("packages/db/scripts/create-auth-bootstrap-invite.ts", ["--config", CONFIG, "--base-url", BASE]);
  await api(page, "POST", `/api/invites/${new URL(bootstrap).pathname.split("/").at(-1)}/accept`, { requestType: "human" });
  writeFileSync(OWNER_FILE, JSON.stringify({ email, password }));
  return page;
}

const tsx = (script: string, args: string[]) => execFileSync(process.execPath,
  ["cli/node_modules/tsx/dist/cli.mjs", script, ...args], { cwd: ROOT, encoding: "utf8" }).trim();

/** Owner (instance admin); R, a restricted operator with his task, project, workspace, agent and plugin. */
export async function setUp(browser: Browser): Promise<Fixture> {
  const owner = await instanceOwner(browser);
  const originalFlags = await api(owner, "GET", "/api/instance/settings/experimental");
  const company = await api<{ id: string; issuePrefix: string }>(owner, "POST", "/api/companies", { name: `MR shell ${RUN}` });
  const c = `/api/companies/${company.id}`;
  const invite = await api<{ inviteUrl: string }>(owner, "POST", `${c}/invites`, { allowedJoinTypes: "human", humanRole: "operator" });
  const { page: person } = await signUp(browser, "Shell Person");
  await api(person, "POST", `/api/invites/${new URL(invite.inviteUrl, BASE).pathname.split("/").at(-1)}/accept`, { requestType: "human" });
  const session = await api<{ user: { id: string } }>(person, "GET", "/api/auth/get-session");
  const project = await api<{ id: string }>(owner, "POST", `${c}/projects`, { name: PROJECT });
  // A restricted person reads a project only through an access-member row (strict `project:read`).
  await api(owner, "POST", `/api/projects/${project.id}/access-members`, { subjectType: "user", subjectId: session.user.id });
  const agent = await api<{ id: string }>(owner, "POST", `${c}/agents`, {
    name: AGENT, role: "engineer", adapterType: "process", adapterConfig: { command: "true" },
  });
  const label = await api<{ id: string }>(owner, "POST", `${c}/labels`, { name: `Shell label ${RUN}`, color: "#2563eb" });
  const task = await api<{ id: string }>(owner, "POST", `${c}/issues`, {
    title: TASK, status: "todo", assigneeUserId: session.user.id, projectId: project.id, labelIds: [label.id],
  });
  const workspaceId = tsx("tests/e2e/fixtures/member-restriction-seed-workspace.ts",
    ["--config", CONFIG, "--company", company.id, "--project", project.id, "--issue", task.id]);
  // Installed once per instance; a restarted worker finds it there.
  const plugins = await api<Array<{ pluginKey: string }>>(owner, "GET", "/api/plugins");
  if (!plugins.some((plugin) => plugin.pluginKey === PLUGIN_KEY)) {
    await api(owner, "POST", "/api/plugins/install", {
      packageName: path.join(ROOT, "tests/e2e/fixtures/member-restriction-issues-plugin"), isLocalPath: true,
    });
  }
  const { members } = await api<{ members: Array<{ id: string; principalId: string }> }>(owner, "GET", `${c}/members`);
  const member = members.find((entry) => entry.principalId === session.user.id)!;
  await api(owner, "PUT", `${c}/members/${member.id}/restriction`, { restricted: true, pluginKeys: [PLUGIN_KEY], agentIds: [agent.id] });
  return {
    companyId: company.id, prefix: company.issuePrefix, owner, person,
    taskId: task.id, agentId: agent.id, projectId: project.id, workspaceId, originalFlags,
  };
}

export const setMode = (f: Fixture, mode: "off" | "report" | "enforce") =>
  api(f.owner, "PUT", `/api/companies/${f.companyId}/member-restriction-mode`, { mode });

/** Instance defaults, or every gating flag on; the shell flag follows `shell`. */
export async function setFlags(f: Fixture, on: boolean, shell: Shell) {
  const flags = Object.fromEntries(GATING_FLAGS.map((flag) => [flag, on ? true : f.originalFlags[flag]]));
  f.flagsOn = on;
  await api(f.owner, "PATCH", "/api/instance/settings/experimental", { ...flags, enableStreamlinedUi: shell === "coordinator" });
}

export const restoreFlags = (f: Fixture) => api(f.owner, "PATCH", "/api/instance/settings/experimental",
  Object.fromEntries([...GATING_FLAGS, "enableStreamlinedUi"].map((flag) => [flag, f.originalFlags[flag]])));

/** Coordinator shell: `Layout` + `CoordinatorSidebar`. Production: `ProductionLayout` + `Sidebar.production`. */
export const setShell = (f: Fixture, page: Page, shell: Shell) =>
  api(page, "PUT", `/api/companies/${f.companyId}/workspace-preferences/me`, { coordinatorWorkspaceEnabled: shell === "coordinator" });

/** Records every `/api` response of a page, with the error code of a refusal. */
export function recordApi(page: Page) {
  const calls: ApiCall[] = [];
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/")) return;
    let code: string | null = null;
    if (response.status() === 403) code = ((await response.json().catch(() => null)) as { code?: string } | null)?.code ?? null;
    const at = new URL(page.url()).pathname;
    calls.push({ method: response.request().method(), path: url.pathname, status: response.status(), code, at });
  });
  return calls;
}

const classify = createRouteClassifier();

/** Each call with the class the server's own route table gives it. */
export async function classified(calls: ApiCall[]) {
  return Promise.all(calls.map(async (call) => {
    const match = await classify(call.method, call.path);
    return { ...call, cls: match.kind === "matched" ? match.entry.class : match.kind };
  }));
}

export const BAD_CLASSES = ["closed", "unlisted", "refused"];
