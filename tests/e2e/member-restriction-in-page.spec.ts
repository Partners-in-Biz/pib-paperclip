import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Browser, type Page, type TestInfo } from "@playwright/test";
import { createRouteClassifier } from "../../server/src/services/member-restriction/route-table";

// AC-G10, the in-page part (PAR-12608 4.6; PAR-12930 C4g-2a). A restricted
// person under `enforce` visits the task list, inbox, search, the command
// palette and the sidebar: no error screen or toast, and the company label list
// and external-object summaries are never requested. Every request is classified
// by the server's own route table and attached; the full "no closed request"
// assertion is T2's (PAR-13262). Real server (playwright-member-restriction.config.ts); no `/api` mocks.

const BASE = process.env.PAPERCLIP_E2E_MR_BASE_URL ?? "http://127.0.0.1:3197";
const CONFIG = process.env.PAPERCLIP_E2E_MR_CONFIG ?? "";
const RUN = Date.now();
const LABEL = `MR label ${RUN}`;
const TASK = `Restricted person's task ${RUN}`;
const classify = createRouteClassifier();

type Json = Record<string, unknown> | null;
type ApiCall = { method: string; path: string; status: number; code: string | null };
type Fixture = { companyId: string; prefix: string; owner: Page; person: Page; taskId: string };

async function api<T = Json>(page: Page, method: string, url: string, data?: unknown) {
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

async function signUp(browser: Browser, name: string) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(`${BASE}/auth`);
  await page.getByRole("button", { name: "Create one" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(`${name.toLowerCase().replace(/\W+/g, "-")}-${RUN}@paperclip.local`);
  await page.getByLabel("Password").fill(`paperclip-${RUN}-password`);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page).not.toHaveURL(/\/auth/, { timeout: 20_000 });
  return page;
}

function bootstrapInviteToken() {
  const url = execFileSync(process.execPath, [
    "cli/node_modules/tsx/dist/cli.mjs", "packages/db/scripts/create-auth-bootstrap-invite.ts", "--config", CONFIG, "--base-url", BASE,
  ], { cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8" }).trim();
  return new URL(url).pathname.split("/").at(-1)!;
}

/** The owner (instance admin), a restricted operator with one task and a company label. */
async function setUp(browser: Browser): Promise<Fixture> {
  const owner = await signUp(browser, "Owner");
  await api(owner, "POST", `/api/invites/${bootstrapInviteToken()}/accept`, { requestType: "human" });
  await api(owner, "PATCH", "/api/instance/settings/experimental", { enableExternalObjects: true });
  const company = await api<{ id: string; issuePrefix: string }>(owner, "POST", "/api/companies", { name: `MR in-page ${RUN}` });
  const invite = await api<{ inviteUrl: string }>(owner, "POST", `/api/companies/${company.id}/invites`, { allowedJoinTypes: "human", humanRole: "operator" });
  const person = await signUp(browser, "Restricted Person");
  await api(person, "POST", `/api/invites/${new URL(invite.inviteUrl, BASE).pathname.split("/").at(-1)}/accept`, { requestType: "human" });
  const session = await api<{ user: { id: string } }>(person, "GET", "/api/auth/get-session");
  const { members } = await api<{ members: Array<{ id: string; principalId: string }> }>(owner, "GET", `/api/companies/${company.id}/members`);
  const member = members.find((entry) => entry.principalId === session.user.id)!;
  await api(owner, "PUT", `/api/companies/${company.id}/members/${member.id}/restriction`, { restricted: true });
  const label = await api<{ id: string }>(owner, "POST", `/api/companies/${company.id}/labels`, { name: LABEL, color: "#2563eb" });
  const task = await api<{ id: string }>(owner, "POST", `/api/companies/${company.id}/issues`, {
    title: TASK, status: "todo", assigneeUserId: session.user.id, labelIds: [label.id],
  });
  return { companyId: company.id, prefix: company.issuePrefix, owner, person, taskId: task.id };
}

const setMode = (f: Fixture, mode: "off" | "report" | "enforce") =>
  api(f.owner, "PUT", `/api/companies/${f.companyId}/member-restriction-mode`, { mode });

/** Records every `/api` response of a page, with the error code of a refusal. */
function recordApi(page: Page) {
  const calls: ApiCall[] = [];
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/")) return;
    let code: string | null = null;
    if (response.status() === 403) code = ((await response.json().catch(() => null)) as { code?: string } | null)?.code ?? null;
    calls.push({ method: response.request().method(), path: url.pathname, status: response.status(), code });
  });
  return calls;
}

async function classified(calls: ApiCall[]) {
  return Promise.all(calls.map(async (call) => {
    const match = await classify(call.method, call.path);
    return { ...call, cls: match.kind === "matched" ? match.entry.class : match.kind };
  }));
}

/**
 * This ticket's two routes (PAR-13261 decision): the company label list and the
 * external-object summaries. The other closed routes the shell, sidebar and inbox
 * call are gated by T2 (PAR-13262), which turns the full "no closed request"
 * assertion on; until then the full list is attached as evidence only.
 */
const ownRoute = (f: Fixture, call: { path: string }) =>
  call.path === `/api/companies/${f.companyId}/labels`
  || call.path === `/api/companies/${f.companyId}/issues/external-object-summaries`;

/** Live polling keeps the network busy, so "networkidle" never comes: give late requests a moment. */
const settle = (page: Page) => page.waitForTimeout(2_000);

// The inbox's "Some inbox items couldn't load" comes from routes T2 gates; T2 adds it back here.
async function expectNoErrorShown(page: Page) {
  await expect(page.getByText(/Something went wrong|Unable to load Paperclip/i)).toHaveCount(0);
  await expect(page.locator('aside[aria-live="polite"] li')).toHaveCount(0);
}

/** Task list, inbox, search, command palette (open, type) and the sidebar, at desktop width. */
async function visit(page: Page, prefix: string) {
  await page.goto(`${BASE}/${prefix}/issues`);
  await expect(page.getByText(TASK).first()).toBeVisible();
  await expect(page.getByRole("navigation").first()).toBeVisible();
  await expectNoErrorShown(page);
  await page.goto(`${BASE}/${prefix}/inbox/all`);
  await settle(page);
  await expectNoErrorShown(page);
  await page.goto(`${BASE}/${prefix}/search?q=${encodeURIComponent("Restricted")}`);
  await expect(page.getByText(TASK).first()).toBeVisible();
  await expectNoErrorShown(page);
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder("Search tasks, agents, projects...").fill("Restricted");
  await expect(page.getByRole("dialog").getByText(TASK).first()).toBeVisible();
  await settle(page);
  await expectNoErrorShown(page);
  await page.keyboard.press("Escape");
}

async function labelFilterShown(page: Page, prefix: string) {
  await page.goto(`${BASE}/${prefix}/issues`);
  await expect(page.getByText(TASK).first()).toBeVisible();
  await page.getByRole("button", { name: "Filter", exact: true }).first().click();
  const shown = await page.locator('[data-filter-options="labels"], section.task-filter-group:has(> h3:text-is("Label"))').count();
  await page.keyboard.press("Escape");
  return shown > 0;
}

function attachList(testInfo: TestInfo, name: string, rows: unknown) {
  const file = testInfo.outputPath(name);
  writeFileSync(file, JSON.stringify(rows, null, 2));
  return testInfo.attach(name, { path: file, contentType: "application/json" });
}

test.describe.serial("member restriction: pages that stay open send no closed request (AC-G10)", () => {
  let f: Fixture;
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    expect((await (await fetch(`${BASE}/api/health`)).json()).deploymentMode).toBe("authenticated");
    f = await setUp(browser);
  });

  test("owner: the requests are made and the label control shows; the closed ones are listed", async ({}, testInfo) => {
    await setMode(f, "enforce");
    const calls = recordApi(f.owner);
    await visit(f.owner, f.prefix);
    expect(await labelFilterShown(f.owner, f.prefix)).toBe(true);
    const rows = await classified(calls);
    expect(rows.some((row) => row.path === `/api/companies/${f.companyId}/labels` && row.status === 200)).toBe(true);
    expect(rows.some((row) => row.path.endsWith("/issues/external-object-summaries") && row.status === 200)).toBe(true);
    // The branch-time list (evidence, not the assertion): every route these pages call that R may not.
    const closed = [...new Map(rows.filter((row) => ["closed", "unlisted", "refused"].includes(row.cls))
      .map((row) => [`${row.method} ${row.path}`, { method: row.method, path: row.path, cls: row.cls }])).values()];
    await attachList(testInfo, "closed-routes-called-by-open-pages.json", closed);
  });

  test("restricted person under enforce: no error, and labels and summaries are not requested", async ({}, testInfo) => {
    await setMode(f, "enforce");
    const calls = recordApi(f.person);
    await visit(f.person, f.prefix);
    expect(await labelFilterShown(f.person, f.prefix)).toBe(false);
    const rows = await classified(calls);
    await attachList(testInfo, "restricted-enforce-requests.json", rows);
    // Not sent at all, so neither can come back 403 MEMBER_RESTRICTED.
    expect(rows.filter((row) => ownRoute(f, row))).toEqual([]);
  });

  test("restricted person under report: the requests are made and the label control shows", async () => {
    await setMode(f, "report");
    const calls = recordApi(f.person);
    await visit(f.person, f.prefix);
    expect(await labelFilterShown(f.person, f.prefix)).toBe(true);
    expect(calls.some((call) => call.path === `/api/companies/${f.companyId}/labels` && call.status === 200)).toBe(true);
    expect(calls.some((call) => call.path.endsWith("/issues/external-object-summaries") && call.status === 200)).toBe(true);
  });

  test("stale session: switched to enforce while the list is open, the list catches up quietly", async () => {
    await setMode(f, "report");
    const page = f.person;
    await page.goto(`${BASE}/${f.prefix}/issues`);
    await expect(page.getByText(TASK).first()).toBeVisible();
    await settle(page);
    const calls = recordApi(page);
    await setMode(f, "enforce");
    // A change to his own task reaches the open page live and refetches the list, labels included.
    const refused = page.waitForResponse((r) => r.url().endsWith(`/api/companies/${f.companyId}/labels`) && r.status() === 403);
    await api(f.owner, "PATCH", `/api/issues/${f.taskId}`, { title: `${TASK} (edited)` });
    await refused;
    // The 403 fallback refreshes the session at once (no focus, no reload), so the gate closes.
    await expect.poll(() => calls.some((call) => call.path === "/api/auth/get-session"), { timeout: 10_000 }).toBe(true);
    await expectNoErrorShown(page);
    const after = recordApi(page);
    await page.reload();
    await expect(page.getByText(TASK).first()).toBeVisible();
    await settle(page);
    const rows = await classified(after);
    expect(rows.filter((row) => ownRoute(f, row))).toEqual([]);
  });

  test("visual QA as the restricted person at 1440 and 390", async ({}, testInfo) => {
    await setMode(f, "enforce");
    const page = f.person;
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const shot = async (name: string) => {
        const file = testInfo.outputPath(`${name}-${width}.png`);
        await page.screenshot({ path: file });
        await testInfo.attach(`${name}-${width}`, { path: file, contentType: "image/png" });
      };
      for (const [name, route, text] of [["task-list", "issues", TASK], ["inbox", "inbox/all", null], ["search", `search?q=Restricted`, TASK]] as const) {
        await page.goto(`${BASE}/${f.prefix}/${route}`);
        if (text) await expect(page.getByText(text).first()).toBeVisible();
        await settle(page);
        await shot(name);
      }
      await page.goto(`${BASE}/${f.prefix}/issues`);
      await page.keyboard.press("Control+k");
      await page.getByPlaceholder("Search tasks, agents, projects...").fill("Restricted");
      await expect(page.getByRole("dialog").getByText(TASK).first()).toBeVisible();
      await shot("command-palette");
      await page.keyboard.press("Escape");
      if (width === 390) await page.getByRole("button", { name: "Open sidebar" }).first().click();
      await expect(page.getByRole("navigation").first()).toBeVisible();
      await shot("sidebar-expanded");
    }
  });
});
