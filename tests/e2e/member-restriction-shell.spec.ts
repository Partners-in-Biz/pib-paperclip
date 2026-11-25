import { writeFileSync } from "node:fs";
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import {
  AGENT, BAD_CLASSES, BASE, GATING_FLAGS, PROJECT, TASK, api, classified, recordApi, restoreFlags,
  setFlags, setMode, setShell, setUp, type ApiCall, type Fixture, type Shell,
} from "./fixtures/member-restriction-shell";

// AC-G10, the shell part (PAR-12608 4.6; PAR-13267 C4g-2c-3). R, a restricted
// member at `enforce`, walks the task list, inbox, search, palette, sidebar,
// mobile nav, agents, project, execution workspace, a plugin issues list and the
// editor autocomplete, in both shells, with instance defaults and with every
// gating flag on. No error is shown and no request the server's own route table
// classes closed, unlisted or refused goes out. Real server, no `/api` mocks.

const INBOX_TABS = ["mine", "recent", "unread", "blocked", "all"];
const settle = (page: Page) => page.waitForTimeout(1_500);

async function expectNoErrorShown(page: Page) {
  await expect(page.getByText(/Something went wrong|Unable to load Paperclip|couldn.t load/i)).toHaveCount(0);
  await expect(page.locator('aside[aria-live="polite"] li')).toHaveCount(0);
}

async function open(page: Page, f: Fixture, route: string, text?: string) {
  await page.goto(`${BASE}/${f.prefix}/${route}`);
  if (text) await expect(page.getByText(text).first()).toBeVisible();
  await settle(page);
  await expectNoErrorShown(page);
}

function attach(testInfo: TestInfo, name: string, rows: unknown) {
  const file = testInfo.outputPath(name);
  writeFileSync(file, JSON.stringify(rows, null, 2));
  return testInfo.attach(name, { path: file, contentType: "application/json" });
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  const file = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: file });
  await testInfo.attach(name, { path: file, contentType: "image/png" });
}

/** The whole visit. Returns the agent-page tabs offered and whether the label filter showed. */
async function visit(page: Page, f: Fixture, shots?: { testInfo: TestInfo; tag: string }) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, f, "issues", TASK);
  for (const view of ["Board view", "List view"]) {
    const toggle = page.getByRole("button", { name: view, exact: true });
    if (await toggle.count()) { await toggle.first().click(); await settle(page); await expectNoErrorShown(page); }
  }
  await page.getByRole("button", { name: "Filter", exact: true }).first().click();
  const labelFilter = await page.locator('[data-filter-options="labels"], section.task-filter-group:has(> h3:text-is("Label"))').count() > 0;
  await page.keyboard.press("Escape");
  if (shots) await shot(page, shots.testInfo, `${shots.tag}-task-list-1440`);
  for (const tab of INBOX_TABS) await open(page, f, `inbox/${tab}`);
  if (shots) await shot(page, shots.testInfo, `${shots.tag}-inbox-sidebar-expanded-1440`);
  await open(page, f, `search?q=${encodeURIComponent("Shell task")}`, TASK);
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder("Search tasks, agents, projects...").fill("Shell");
  await expect(page.getByRole("dialog").getByText(TASK).first()).toBeVisible();
  await settle(page);
  await expectNoErrorShown(page);
  await page.keyboard.press("Escape");
  await open(page, f, "agents/all", AGENT);
  if (shots) await shot(page, shots.testInfo, `${shots.tag}-agents-1440`);
  await open(page, f, `agents/${f.agentId}`, AGENT);
  const tabs = await page.getByRole("tab").allTextContents();
  for (const name of tabs) {
    await page.getByRole("tab", { name, exact: true }).first().click();
    await settle(page);
    await expectNoErrorShown(page);
  }
  await open(page, f, `projects/${f.projectId}`, PROJECT);
  if (shots) await shot(page, shots.testInfo, `${shots.tag}-project-1440`);
  // The workspace pages exist only with `enableIsolatedWorkspaces` (IsolatedWorkspacesRouteGate redirects).
  await open(page, f, `execution-workspaces/${f.workspaceId}`, f.flagsOn ? "MR workspace" : undefined);
  await open(page, f, "mr-issues", TASK);
  await expect(page.getByTestId("mr-plugin-issues")).toBeVisible();
  // The new-task editor (task detail is C4g-2b's spec, PAR-12932).
  await open(page, f, "issues", TASK);
  await page.getByRole("button", { name: /^New task$/i }).first().click();
  const editor = page.getByRole("dialog").locator('[contenteditable="true"]').first();
  await editor.click();
  for (const trigger of ["@", "/"]) {
    await page.keyboard.type(trigger);
    await settle(page);
    await expectNoErrorShown(page);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Backspace");
  }
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [route, text, name] of [["inbox/mine", null, "inbox"], ["issues", TASK, "task-list"], ["agents/all", AGENT, "agents"], [`projects/${f.projectId}`, PROJECT, "project"]] as const) {
    await open(page, f, route, text ?? undefined);
    await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
    if (shots) await shot(page, shots.testInfo, `${shots.tag}-${name}-390`);
  }
  await page.getByRole("button", { name: "Open sidebar" }).first().click();
  await settle(page);
  await expectNoErrorShown(page);
  if (shots) await shot(page, shots.testInfo, `${shots.tag}-sidebar-expanded-390`);
  await page.setViewportSize({ width: 1440, height: 900 });
  return { tabs, labelFilter };
}

const ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** Each refused or closed call once: `METHOD /api/path (class status) on /page`, ids as `:id`. */
const bad = (rows: Awaited<ReturnType<typeof classified>>) => [...new Set(rows
  .filter((row) => BAD_CLASSES.includes(row.cls) || row.code === "MEMBER_RESTRICTED")
  .map((row) => `${row.method} ${row.path.replace(ID, ":id")} (${row.cls} ${row.status}) on ${row.at.replace(ID, ":id")}`))].sort();

/** Distinct `METHOD path` of the closed routes a not-restricted visit calls. */
const closedRoutes = (rows: Awaited<ReturnType<typeof classified>>) =>
  [...new Set(rows.filter((row) => BAD_CLASSES.includes(row.cls)).map((row) => `${row.method} ${row.path}`))];

test.describe("member restriction: no closed request over the shell, inbox, list and agent pages (AC-G10)", () => {
  // Not serial: a visit that finds a closed request must not hide the others' results.
  test.describe.configure({ mode: "default" });
  let f: Fixture;
  let ownerTabs: string[] = [];

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    expect((await (await fetch(`${BASE}/api/health`)).json()).deploymentMode).toBe("authenticated");
    f = await setUp(browser);
  });
  test.afterAll(async () => { if (f) await restoreFlags(f); });
  // The pages live in beforeAll contexts, so Playwright's own failure shot misses them.
  const pageErrors: string[] = [];
  test.beforeEach(() => {
    pageErrors.length = 0;
    for (const page of [f.owner, f.person]) {
      page.removeAllListeners("pageerror");
      page.removeAllListeners("console");
      page.on("pageerror", (error) => pageErrors.push(error.stack ?? String(error)));
      page.on("console", (message) => { if (message.type() === "error") pageErrors.push(message.text()); });
    }
  });
  test.afterEach(async ({}, testInfo) => {
    if (pageErrors.length) await attach(testInfo, "page-errors.json", pageErrors);
    if (f) await attach(testInfo, "last-urls.json", { person: f.person.url(), owner: f.owner.url() });
    if (f && testInfo.status !== testInfo.expectedStatus) {
      await shot(f.person, testInfo, "person-at-failure");
      await shot(f.owner, testInfo, "owner-at-failure");
    }
  });

  test("owner, coordinator shell, flags on: the requests are made and the controls show", async ({}, testInfo) => {
    test.setTimeout(300_000);
    await setMode(f, "enforce");
    await setFlags(f, true, "coordinator");
    const calls = recordApi(f.owner);
    const shown = await visit(f.owner, f);
    const rows = await classified(calls);
    await attach(testInfo, "owner-closed-routes.json", closedRoutes(rows));
    ownerTabs = shown.tabs;
    expect(shown.labelFilter).toBe(true);
    expect(rows.filter((row) => row.code === "MEMBER_RESTRICTED")).toEqual([]);
    // The gated reads are requested and answered for a person who is not restricted.
    for (const route of ["/labels", "/live-runs", "/heartbeat-runs"]) {
      expect(rows.some((row) => row.path.endsWith(route) && row.status === 200), route).toBe(true);
    }
  });

  test("R at report, coordinator shell, flags on: the requests are made and the controls show", async ({}, testInfo) => {
    test.setTimeout(300_000);
    await setMode(f, "report");
    await setFlags(f, true, "coordinator");
    await setShell(f, f.person, "coordinator");
    const calls = recordApi(f.person);
    const shown = await visit(f.person, f);
    const rows = await classified(calls);
    await attach(testInfo, "R-report-closed-routes.json", closedRoutes(rows));
    expect(shown.labelFilter).toBe(true);
    // `report` changes nothing on screen: he is offered the owner's agent tabs.
    expect(shown.tabs).toEqual(ownerTabs);
    expect(rows.filter((row) => row.code === "MEMBER_RESTRICTED")).toEqual([]);
    for (const route of ["/labels", "/live-runs", "/heartbeat-runs"]) {
      expect(rows.some((row) => row.path.endsWith(route) && row.status === 200), route).toBe(true);
    }
  });

  for (const shell of ["coordinator", "production"] as const satisfies readonly Shell[]) {
    for (const flagsOn of [false, true]) {
      const flagSet = flagsOn ? `flags on (${GATING_FLAGS.join(", ")})` : "instance defaults";
      test(`R at enforce, ${shell} shell, ${flagSet}: no error and no closed request`, async ({}, testInfo) => {
        test.setTimeout(300_000);
        await setMode(f, "enforce");
        await setFlags(f, flagsOn, shell);
        await setShell(f, f.person, shell);
        const calls = recordApi(f.person);
        // The saved preference is read on load; check the shell really switched.
        await open(f.person, f, "projects");
        await f.person.reload();
        await expect(f.person.locator(".coordinator-workspace")).toHaveCount(shell === "coordinator" ? 1 : 0);
        const shown = await visit(f.person, f, flagsOn ? { testInfo, tag: `R-${shell}` } : undefined);
        const rows = await classified(calls);
        await attach(testInfo, `R-${shell}-${flagsOn ? "flags-on" : "defaults"}-requests.json`, rows);
        expect(shown.labelFilter).toBe(false);
        expect(rows.length).toBeGreaterThan(20);
        expect(bad(rows)).toEqual([]);
      });
    }
  }

  test("stale session: switched to enforce while the inbox is open, no error, and the next load sends no closed request", async () => {
    await setMode(f, "report");
    await setFlags(f, true, "coordinator");
    const page = f.person;
    await open(page, f, "inbox/mine");
    await setMode(f, "enforce");
    // A change to his own task reaches the open page live and refetches it under the new mode.
    await api(f.owner, "PATCH", `/api/issues/${f.taskId}`, { title: `${TASK} (edited)` });
    await expect.poll(async () => (await api<{ title: string }>(f.owner, "GET", `/api/issues/${f.taskId}`)).title).toContain("edited");
    await page.waitForTimeout(5_000);
    await expectNoErrorShown(page);
    const after: ApiCall[] = recordApi(page);
    await page.reload();
    await settle(page);
    await expectNoErrorShown(page);
    expect(bad(await classified(after))).toEqual([]);
    await api(f.owner, "PATCH", `/api/issues/${f.taskId}`, { title: TASK });
  });
});
