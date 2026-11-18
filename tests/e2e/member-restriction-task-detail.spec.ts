import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Browser, type Page, type TestInfo } from "@playwright/test";
import { createRouteClassifier } from "../../server/src/services/member-restriction/route-table";

// AC-G10 on task detail (PAR-12608 4.6; PAR-12932 C4g-2b). A restricted person under
// `enforce` opens his own task and the board chat: no error shown, and the task-detail
// panels' closed routes are never requested. Real server
// (playwright-member-restriction.config.ts, from PAR-12930); no `/api` mocks. Every
// request is classified by the server's route table and attached; the full "no closed
// request" run over the shell is PAR-13267's. Until PAR-13263 opens the shell routes
// (`/api/health`, instance settings) R at `enforce` cannot load the app, so this spec
// passes only once that lands, as PAR-12930's does.

const BASE = process.env.PAPERCLIP_E2E_MR_BASE_URL ?? "http://127.0.0.1:3197";
const RUN = Date.now();
const TASK = `Restricted person's task ${RUN}`;
const classify = createRouteClassifier();
type Row = { method: string; path: string; status: number; code: string | null; cls?: string };
type Fixture = { companyId: string; prefix: string; owner: Page; person: Page; taskId: string; taskRef: string };

async function api<T = Record<string, unknown>>(page: Page, method: string, url: string, data?: unknown) {
  const res = await page.evaluate(async ({ method, url, data }) => {
    const response = await fetch(url, { method, credentials: "include",
      headers: data === undefined ? undefined : { "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data) });
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
  await page.getByLabel("Email").fill(`${name.toLowerCase().replace(/\W+/g, "-")}-td-${RUN}@paperclip.local`);
  await page.getByLabel("Password").fill(`paperclip-${RUN}-password`);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page).not.toHaveURL(/\/auth/, { timeout: 20_000 });
  return page;
}

async function setUp(browser: Browser): Promise<Fixture> {
  const owner = await signUp(browser, "Owner");
  const invite = execFileSync(process.execPath, ["cli/node_modules/tsx/dist/cli.mjs", "packages/db/scripts/create-auth-bootstrap-invite.ts",
    "--config", process.env.PAPERCLIP_E2E_MR_CONFIG ?? "", "--base-url", BASE], { cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8" });
  await api(owner, "POST", `/api/invites/${new URL(invite.trim()).pathname.split("/").at(-1)}/accept`, { requestType: "human" });
  const company = await api<{ id: string; issuePrefix: string }>(owner, "POST", "/api/companies", { name: `MR task detail ${RUN}` });
  const join = await api<{ inviteUrl: string }>(owner, "POST", `/api/companies/${company.id}/invites`, { allowedJoinTypes: "human", humanRole: "operator" });
  const person = await signUp(browser, "Restricted Person");
  await api(person, "POST", `/api/invites/${new URL(join.inviteUrl, BASE).pathname.split("/").at(-1)}/accept`, { requestType: "human" });
  const session = await api<{ user: { id: string } }>(person, "GET", "/api/auth/get-session");
  const { members } = await api<{ members: Array<{ id: string; principalId: string }> }>(owner, "GET", `/api/companies/${company.id}/members`);
  const member = members.find((entry) => entry.principalId === session.user.id)!;
  await api(owner, "PUT", `/api/companies/${company.id}/members/${member.id}/restriction`, { restricted: true });
  const task = await api<{ id: string; identifier: string }>(owner, "POST", `/api/companies/${company.id}/issues`, { title: TASK, status: "todo", assigneeUserId: session.user.id });
  return { companyId: company.id, prefix: company.issuePrefix, owner, person, taskId: task.id, taskRef: task.identifier };
}

const setMode = (f: Fixture, mode: "report" | "enforce") => api(f.owner, "PUT", `/api/companies/${f.companyId}/member-restriction-mode`, { mode });

function recordApi(page: Page) {
  const rows: Row[] = [];
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/")) return;
    const code = response.status() === 403 ? ((await response.json().catch(() => null)) as { code?: string } | null)?.code ?? null : null;
    rows.push({ method: response.request().method(), path: url.pathname, status: response.status(), code });
  });
  return rows;
}
const classified = (rows: Row[]) => Promise.all(rows.map(async (row) => {
  const match = await classify(row.method, row.path);
  return { ...row, cls: match.kind === "matched" ? match.entry.class : match.kind };
}));
/** This ticket's task-detail routes; `live-runs` is also the sidebar's (PAR-13264), so the unit test carries it. */
const PANEL_ROUTE = /^\/api\/(issues\/[^/]+\/(feedback-votes|privacy-constraints|access-grants|watchdog|recovery-actions|accepted-plan-decompositions)|routines\/[^/]+$|companies\/[^/]+\/skills\/[^/]+$)/;
const settle = (page: Page) => page.waitForTimeout(2_000);
async function expectNoErrorShown(page: Page) {
  await expect(page.getByText(/Something went wrong|Unable to load Paperclip|Couldn.t load/i)).toHaveCount(0);
  await expect(page.locator('aside[aria-live="polite"] li')).toHaveCount(0);
}
async function visit(page: Page, f: Fixture) {
  await page.goto(`${BASE}/${f.prefix}/issues/${f.taskRef}`);
  await expect(page.getByText(TASK).first()).toBeVisible();
  await settle(page);
  await expectNoErrorShown(page);
  await page.goto(`${BASE}/${f.prefix}/board-chat`);
  await settle(page);
  await expectNoErrorShown(page);
}
function attach(testInfo: TestInfo, name: string, rows: unknown) {
  const file = testInfo.outputPath(name);
  writeFileSync(file, JSON.stringify(rows, null, 2));
  return testInfo.attach(name, { path: file, contentType: "application/json" });
}

test.describe.serial("member restriction: task detail sends no closed panel request (AC-G10)", () => {
  let f: Fixture;
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    f = await setUp(browser);
  });

  for (const who of ["owner", "person at report"] as const) {
    test(`${who}: the panel requests are made as today`, async () => {
      await setMode(f, who === "owner" ? "enforce" : "report");
      const page = who === "owner" ? f.owner : f.person;
      const rows = recordApi(page);
      await visit(page, f);
      // The page reads by the task's identifier, the board chat by its own task's id.
      expect(rows.filter((row) => row.path.endsWith("/feedback-votes") && row.status === 200).length,
        JSON.stringify(rows.map((row) => `${row.status} ${row.path}`))).toBeGreaterThanOrEqual(1);
    });
  }

  test("person at enforce: no error, no 403 MEMBER_RESTRICTED, no panel route", async ({}, testInfo) => {
    await setMode(f, "enforce");
    const rows = recordApi(f.person);
    await visit(f.person, f);
    const all = await classified(rows);
    await attach(testInfo, "restricted-enforce-task-detail-requests.json", all);
    expect(all.filter((row) => PANEL_ROUTE.test(row.path))).toEqual([]);
    expect(all.filter((row) => row.code === "MEMBER_RESTRICTED" && PANEL_ROUTE.test(row.path))).toEqual([]);
  });

  test("stale session: switched to enforce on an open task, the page catches up quietly", async () => {
    test.setTimeout(120_000);
    await setMode(f, "report");
    const page = f.person;
    await page.goto(`${BASE}/${f.prefix}/issues/${f.taskRef}`);
    await expect(page.getByText(TASK).first()).toBeVisible();
    const during = recordApi(page);
    await setMode(f, "enforce");
    // Past the app's 30 s staleTime, a focus refetches the open page's feedback votes with the old session.
    await page.waitForTimeout(31_000);
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    // The old session still asks once; the 403 MEMBER_RESTRICTED is "nothing to show" and re-reads the session.
    const refusedAt = () => during.findIndex((row) => row.path.endsWith("/feedback-votes") && row.code === "MEMBER_RESTRICTED");
    await expect.poll(refusedAt, { timeout: 15_000 }).toBeGreaterThanOrEqual(0);
    await expect.poll(() => during.slice(refusedAt()).some((row) => row.path === "/api/auth/get-session"), { timeout: 10_000 }).toBe(true);
    await settle(page);
    await expectNoErrorShown(page);
    const after = recordApi(page);
    await page.reload();
    await expect(page.getByText(TASK).first()).toBeVisible();
    await settle(page);
    expect(after.filter((row) => PANEL_ROUTE.test(row.path))).toEqual([]);
  });

  test("visual QA of task detail as the restricted person at 1440 and 390", async ({ browser }, testInfo) => {
    await setMode(f, "enforce");
    const storageState = await f.person.context().storageState();
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ storageState, viewport: { width, height: width === 390 ? 844 : 900 } });
      const page = await context.newPage();
      await page.goto(`${BASE}/${f.prefix}/issues/${f.taskRef}`);
      await expect(page.getByText(TASK).first()).toBeVisible();
      await settle(page);
      await expectNoErrorShown(page);
      const file = testInfo.outputPath(`task-detail-${width}.png`);
      await page.screenshot({ path: file });
      await testInfo.attach(`task-detail-${width}`, { path: file, contentType: "image/png" });
      await context.close();
    }
  });
});
