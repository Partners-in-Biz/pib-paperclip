import { writeFileSync } from "node:fs";
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import {
  BAD_CLASSES, BASE, TASK, classified, recordApi, setMode, setUp, type ApiCall, type Fixture,
} from "./fixtures/member-restriction-shell";

// AC-G10 on task detail (PAR-12608 4.6; PAR-12932 C4g-2b, PAR-14342). A restricted
// person under `enforce` opens his own task and the board chat: no error is shown
// ("task history could not be loaded", "Not available for your access level") and no
// request goes out that the server's own route table classes closed, unlisted,
// refused or `run` (a run route is refused for his browser session), and none is
// answered 403 MEMBER_RESTRICTED. Real server (playwright-member-restriction.config.ts);
// no `/api` mocks. Every request is classified and attached.

/** The task-detail panel routes of PAR-12932; the owner and R at `report` still request them. */
const PANEL_ROUTE = /^\/api\/(issues\/[^/]+\/(feedback-votes|privacy-constraints|access-grants|watchdog|recovery-actions|accepted-plan-decompositions)|routines\/[^/]+$|companies\/[^/]+\/skills\/[^/]+$)/;
const REFUSED_FOR_HIS_SESSION = [...BAD_CLASSES, "run"];
const settle = (page: Page) => page.waitForTimeout(2_000);

async function expectNoErrorShown(page: Page) {
  await expect(page.getByText(/Something went wrong|Unable to load Paperclip|couldn.t load/i)).toHaveCount(0);
  await expect(page.locator('aside[aria-live="polite"] li')).toHaveCount(0);
}

/** On his own task also no gap notice (PAR-14342); board chat may show its "Not available" page to him (4.6). */
async function expectTaskShownInFull(page: Page) {
  await expectNoErrorShown(page);
  await expect(page.getByText(/could not be loaded|Not available for your access level/i)).toHaveCount(0);
}

async function visit(page: Page, f: Fixture) {
  await page.goto(`${BASE}/${f.prefix}/issues/${f.taskId}`);
  await expect(page.getByText(TASK).first()).toBeVisible();
  await settle(page);
  await expectTaskShownInFull(page);
  await page.goto(`${BASE}/${f.prefix}/board-chat`);
  await settle(page);
  await expectNoErrorShown(page);
}

function attach(testInfo: TestInfo, name: string, rows: unknown) {
  const file = testInfo.outputPath(name);
  writeFileSync(file, JSON.stringify(rows, null, 2));
  return testInfo.attach(name, { path: file, contentType: "application/json" });
}

/** Requests his session must never send: a refusing class, or a 403 MEMBER_RESTRICTED answer. */
async function refusedRequests(rows: ApiCall[]) {
  return (await classified(rows))
    .filter((row) => REFUSED_FOR_HIS_SESSION.includes(row.cls) || row.code === "MEMBER_RESTRICTED")
    .map((row) => `${row.status} ${row.method} ${row.path} (${row.cls}${row.code ? `, ${row.code}` : ""})`);
}

test.describe.serial("member restriction: task detail sends no closed request (AC-G10)", () => {
  let f: Fixture;
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    f = await setUp(browser);
  });

  for (const who of ["owner", "person at report"] as const) {
    test(`${who}: the panel requests are made as today`, async () => {
      await setMode(f, who === "owner" ? "enforce" : "report");
      const page = who === "owner" ? f.owner : f.person;
      const rows = recordApi(page);
      await visit(page, f);
      expect(rows.filter((row) => row.path.endsWith("/feedback-votes") && row.status === 200).length,
        JSON.stringify(rows.map((row) => `${row.status} ${row.path}`))).toBeGreaterThanOrEqual(1);
    });
  }

  test("person at enforce: no error shown, no closed request, no 403 MEMBER_RESTRICTED", async ({}, testInfo) => {
    await setMode(f, "enforce");
    const rows = recordApi(f.person);
    await visit(f.person, f);
    await attach(testInfo, "restricted-enforce-task-detail-requests.json", await classified(rows));
    expect(rows.length).toBeGreaterThan(0);
    expect(await refusedRequests(rows)).toEqual([]);
    // His task's history is read and answered (PAR-14342); the page reads by id or identifier.
    for (const suffix of ["activity", "runs", "live-runs", "interactions"]) {
      const read = new RegExp(`^/api/issues/[^/]+/${suffix}$`);
      expect(rows.some((row) => read.test(row.path) && row.status === 200),
        `${suffix}: ${JSON.stringify(rows.map((row) => `${row.status} ${row.path}`))}`).toBe(true);
    }
  });

  test("stale session: switched to enforce on an open task, the page catches up quietly", async () => {
    test.setTimeout(120_000);
    await setMode(f, "report");
    const page = f.person;
    await page.goto(`${BASE}/${f.prefix}/issues/${f.taskId}`);
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
    await expectTaskShownInFull(page);
    expect(after.filter((row) => PANEL_ROUTE.test(row.path))).toEqual([]);
    expect(await refusedRequests(after)).toEqual([]);
  });

  test("visual QA of task detail as the restricted person at 1440 and 390", async ({ browser }, testInfo) => {
    await setMode(f, "enforce");
    const storageState = await f.person.context().storageState();
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ storageState, viewport: { width, height: width === 390 ? 844 : 900 } });
      const page = await context.newPage();
      await page.goto(`${BASE}/${f.prefix}/issues/${f.taskId}`);
      await expect(page.getByText(TASK).first()).toBeVisible();
      await settle(page);
      await expectTaskShownInFull(page);
      const file = testInfo.outputPath(`task-detail-${width}.png`);
      await page.screenshot({ path: file });
      await testInfo.attach(`task-detail-${width}`, { path: file, contentType: "image/png" });
      await context.close();
    }
  });
});
