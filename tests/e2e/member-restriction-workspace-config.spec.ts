import { writeFileSync } from "node:fs";
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { BAD_CLASSES, BASE, classified, recordApi, type ApiCall } from "./fixtures/member-restriction-shell";
import {
  O_TASK, PROJECT, R_TASK, RUN, WORKSPACE, ownRoute, restoreFlags, setMode, setUp, type Fixture,
} from "./fixtures/member-restriction-workspace-config";

// AC-G10, host configuration (PAR-12608 4.6; PAR-13318, C4i-d 2/2). R, a restricted member at
// `enforce`, visits the project configuration page, a project workspace page, the new project
// and new task dialogs and task detail: the host-configuration controls are not offered, he
// still creates a project and a task and picks a workspace mode, and no request of PAR-12952's
// files is one the server's route table classes closed, unlisted or refused. O, the owner, sees
// every control on the same pages. Real server, no `/api` mocks.

type Row = ApiCall & { cls: string };
type Visitor = "R" | "O";
const settle = (page: Page) => page.waitForTimeout(1_500);

async function expectNoErrorShown(page: Page) {
  await expect(page.getByText(/Something went wrong|Unable to load Paperclip|couldn.t load/i)).toHaveCount(0);
  await expect(page.locator('aside[aria-live="polite"] li')).toHaveCount(0);
}

async function open(page: Page, f: Fixture, route: string, text: string) {
  await page.goto(`${BASE}/${f.prefix}/${route}`);
  // At 390 the breadcrumb copy is hidden; the page's own copy is the visible one.
  await expect(page.getByText(text).filter({ visible: true }).first()).toBeVisible();
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
  await page.screenshot({ path: file, fullPage: true });
  await testInfo.attach(name, { path: file, contentType: "image/png" });
}

/** The picker button of a task property row ("Execution", "Model"). */
const propertyButton = (page: Page, label: string) => page.locator("[data-property-row]")
  .filter({ has: page.getByText(label, { exact: true }) }).getByRole("button");

/** Shown (true) or left out (false) for this visitor. */
const shows = async (locator: ReturnType<Page["locator"]>, shown: boolean) =>
  shown ? expect(locator.first()).toBeVisible() : expect(locator).toHaveCount(0);

async function projectConfiguration(page: Page, f: Fixture, all: boolean) {
  await open(page, f, `projects/${f.projectId}/configuration`, "Visibility");
  const main = page.locator("main");
  await shows(main.getByText("Env", { exact: true }), all);
  await shows(main.locator('section[aria-label="Repositories"]'), all);
  await shows(main.getByText("Codebase", { exact: true }), all);
  await shows(main.getByText("Execution Workspaces", { exact: true }), all);
}

async function projectWorkspace(page: Page, f: Fixture, all: boolean) {
  await open(page, f, `projects/${f.projectId}/workspaces/${f.workspaceId}`, WORKSPACE);
  await shows(page.getByRole("button", { name: "Save changes" }), all);
  await shows(page.getByText("Read only. The company owner manages this workspace."), !all);
}

async function newTaskDialog(page: Page, f: Fixture, all: boolean) {
  await open(page, f, `projects/${f.projectId}/issues`, PROJECT);
  // The project page's own button: the dialog opens on this project (worktrees are on here).
  await page.locator("main").getByRole("button", { name: /^New task$/i }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(PROJECT).first()).toBeVisible();
  await settle(page);
  await dialog.getByRole("combobox", { name: "Worktrees" }).click();
  await expect(page.getByText("Project workspace").first()).toBeVisible();
  // The group shows only with an isolated workspace to offer (made by a run); O's list read is checked below.
  if (!all) await shows(page.getByText("Reuse a worktree"), false);
  await page.keyboard.press("Escape");
  return dialog;
}

async function taskDetail(page: Page, f: Fixture, all: boolean) {
  await open(page, f, `issues/${all ? f.oTaskId : f.rTaskId}`, all ? O_TASK : R_TASK);
  // An agent's task opens chat-first with the properties panel closed.
  const showPanel = page.getByRole("button", { name: /^Show (properties|task side panel)$/ });
  if (await showPanel.count()) await showPanel.first().click();
  const propertiesTab = page.getByText("Properties", { exact: true });
  await page.getByText(/^(Labels|Open a side panel tab)$/).first().waitFor();
  if (await page.getByText("Open a side panel tab").count()) await propertiesTab.first().click();
  await expect(page.getByText("Labels", { exact: true }).first()).toBeVisible();
  await propertyButton(page, "Execution").first().click();
  await expect(page.getByText("New isolated workspace").first()).toBeVisible();
  await shows(page.getByText("Reuse existing workspace…"), all);
}

/** R's whole visit at 1440, with his three writes; returns the writes' answers. */
async function visitR(page: Page, f: Fixture) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await projectConfiguration(page, f, false);
  await projectWorkspace(page, f, false);

  await open(page, f, "projects", PROJECT);
  await page.getByRole("button", { name: "Create project" }).first().click();
  const projectDialog = page.getByRole("dialog");
  await projectDialog.getByLabel("Project name").fill(`R project ${RUN}`);
  await expect(projectDialog.getByRole("region", { name: "Source repositories" })).toHaveCount(0);
  const created = page.waitForResponse((r) => r.request().method() === "POST"
    && new URL(r.url()).pathname === `/api/companies/${f.companyId}/projects`);
  await projectDialog.getByRole("button", { name: "Create project" }).click();
  const project = await created;
  await settle(page);
  await expectNoErrorShown(page);

  const taskDialog = await newTaskDialog(page, f, false);
  await taskDialog.locator('[contenteditable="true"]').first().click();
  await page.keyboard.type(`R new task ${RUN}`);
  const createdTask = page.waitForResponse((r) => r.request().method() === "POST"
    && new URL(r.url()).pathname === `/api/companies/${f.companyId}/issues`);
  await taskDialog.getByRole("button", { name: /^Create task/ }).click();
  const task = await createdTask;
  await settle(page);
  await expectNoErrorShown(page);

  // Task detail: the mode picker is offered without the reuse entry; his pick is the next test.
  await taskDetail(page, f, false);
  await page.keyboard.press("Escape");
  return { project, task };
}

/** R picks "New isolated workspace" on his task; the PATCH's answer. */
async function pickMode(page: Page, f: Fixture) {
  await taskDetail(page, f, false);
  // The UI patches by identifier (`/api/issues/MRC-1`), not by id.
  const picked = page.waitForResponse((r) => r.request().method() === "PATCH"
    && /^\/api\/issues\/[^/]+$/.test(new URL(r.url()).pathname));
  await page.getByText("New isolated workspace").first().click();
  const mode = await picked;
  await settle(page);
  await expectNoErrorShown(page);
  return mode;
}

async function shots(page: Page, f: Fixture, who: Visitor, testInfo: TestInfo) {
  const all = who === "O";
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await projectConfiguration(page, f, all);
    await shot(page, testInfo, `${who}-project-configuration-${width}`);
    await projectWorkspace(page, f, all);
    await shot(page, testInfo, `${who}-project-workspace-${width}`);
    await open(page, f, "projects", PROJECT);
    await page.getByRole("button", { name: "Create project" }).first().click();
    await expect(page.getByRole("dialog").getByLabel("Project name")).toBeVisible();
    await shot(page, testInfo, `${who}-new-project-${width}`);
    await page.keyboard.press("Escape");
    await newTaskDialog(page, f, all);
    await shot(page, testInfo, `${who}-new-task-${width}`);
    await page.keyboard.press("Escape");
    await open(page, f, `issues/${all ? f.oTaskId : f.rTaskId}`, all ? O_TASK : R_TASK);
    await shot(page, testInfo, `${who}-task-detail-${width}`);
  }
}

const bad = (rows: Row[]) => rows.filter((row) => BAD_CLASSES.includes(row.cls));

test.describe.serial("member restriction: host configuration and tree control (C4i-d)", () => {
  let f: Fixture;

  test.beforeAll(async ({ browser }) => {
    f = await setUp(browser);
  });

  test.afterAll(async () => {
    if (!f) return;
    await setMode(f, "off");
    await restoreFlags(f);
  });

  test("R at enforce: controls left out, his writes answered, no closed request from these files", async ({}, testInfo) => {
    test.setTimeout(300_000);
    await setMode(f, "enforce");
    const calls = recordApi(f.person);
    const { project, task } = await visitR(f.person, f);
    const rows = await classified(calls);
    await attach(testInfo, "R-enforce-requests.json", rows);
    // Not this ticket's: closed, unlisted or refused requests of other files, listed for their owners.
    const other = rows.filter((row) => !ownRoute(row) && (BAD_CLASSES.includes(row.cls) || row.code === "MEMBER_RESTRICTED"));
    await attach(testInfo, "R-enforce-other-closed.json", other);

    expect(project.status()).toBe(201);
    expect(project.request().postDataJSON()).toMatchObject({ repositoryIds: [] });
    expect(task.status()).toBe(201);
    expect(JSON.stringify(task.request().postDataJSON().assigneeAdapterOverrides ?? null)).not.toContain("chrome");

    expect(rows.length).toBeGreaterThan(20);
    expect(rows.filter((row) => ownRoute(row) && row.code === "MEMBER_RESTRICTED")).toEqual([]);
    expect(bad(rows).filter(ownRoute)).toEqual([]);
    // Task detail: neither the tree-control preview nor the tree holds are read.
    expect(rows.filter((row) => /\/tree-control\/preview|\/tree-holds/.test(row.path))).toEqual([]);

    await shots(f.person, f, "R", testInfo);
  });

  test("R at enforce picks a workspace mode on his task (200)", async () => {
    await setMode(f, "enforce");
    await f.person.setViewportSize({ width: 1440, height: 900 });
    const mode = await pickMode(f.person, f);
    expect(mode.status()).toBe(200);
    expect(mode.request().postDataJSON()).toMatchObject({ executionWorkspacePreference: "isolated_workspace" });
  });

  test("O: every host-configuration control shows on the same pages", async ({}, testInfo) => {
    test.setTimeout(300_000);
    const page = f.owner;
    const calls = recordApi(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await projectConfiguration(page, f, true);
    await projectWorkspace(page, f, true);
    await open(page, f, "projects", PROJECT);
    await page.getByRole("button", { name: "Create project" }).first().click();
    await expect(page.getByRole("dialog").getByRole("region", { name: "Source repositories" })).toBeVisible();
    await page.keyboard.press("Escape");
    await newTaskDialog(page, f, true);
    await page.keyboard.press("Escape");
    await taskDetail(page, f, true);
    await page.keyboard.press("Escape");
    await propertyButton(page, "Model").first().click();
    await expect(page.getByText("Enable Chrome (--chrome)").first()).toBeVisible();
    await page.keyboard.press("Escape");
    const rows = await classified(calls);
    await attach(testInfo, "O-requests.json", rows);
    expect(rows.filter((row) => row.code === "MEMBER_RESTRICTED")).toEqual([]);
    // The reads R does not send are sent and answered for the owner.
    for (const route of ["/secrets", "/git-authorization", "/project-repositories", "/execution-workspaces", "/tree-holds"]) {
      expect(rows.some((row) => row.path.endsWith(route) && row.status === 200), route).toBe(true);
    }

    await shots(page, f, "O", testInfo);
  });
});
