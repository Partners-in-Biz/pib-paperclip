import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * Planning Canvas sharing UI evidence (PAR-13940): seeds stress boards, screenshots the share dialog,
 * board sections and project Canvas tab at 1440 and 390, then runs the shared overflow-check script.
 *   PLANNING_CANVAS_SPEC=planning-canvas-sharing.spec.ts pnpm test:e2e:planning-canvas-perf
 *   PLANNING_CANVAS_SHOTS_DIR=<dir>  OVERFLOW_CHECK_SCRIPT=<path to overflow-check.mjs>
 */
const LONG = "Bartholomew-Wolfeschlegelsteinhausen-quarterly-roadmap-and-dependency-planning-board-2026";

test("sharing UI: dialog, sections and project tab", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  const dir = path.resolve(process.env.PLANNING_CANVAS_SHOTS_DIR ?? path.join("test-results", "planning-canvas-sharing"));
  fs.mkdirSync(dir, { recursive: true });
  const company = await (await page.request.post("/api/companies", { data: { name: `Canvas Share ${Date.now()}` } })).json();
  const project = await (await page.request.post(`/api/companies/${company.id}/projects`, { data: { name: LONG.slice(0, 60) } })).json();
  const make = async (title: string) => {
    const res = await page.request.post(`/api/companies/${company.id}/planning-canvases`, { data: { title, description: "" } });
    expect(res.ok(), await res.text()).toBe(true);
    return res.json();
  };
  const mine = await make("Mine personal");
  const shared = await make(LONG);
  const proj = await make("Project board " + LONG.slice(0, 30));
  const archived = await make("Archived board");
  const share = (b: { id: string }, body: object) => page.request.patch(`/api/companies/${company.id}/planning-canvases/${b.id}/sharing`, { data: body });
  expect((await share(shared, { scope: "company", memberAccess: "edit" })).ok()).toBe(true);
  expect((await share(proj, { scope: "project", projectId: project.id, memberAccess: "comment" })).ok()).toBe(true);
  expect((await page.request.post(`/api/companies/${company.id}/planning-canvases/${archived.id}/archive`, { data: {} })).ok()).toBe(true);

  await page.addInitScript((id) => localStorage.setItem("paperclip.selectedCompanyId", id), company.id);
  const canvasPath = `/${company.issuePrefix}/planning-canvas`;
  const tabPath = `/${company.issuePrefix}/projects/${project.urlKey ?? project.id}/canvas`;

  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(`${canvasPath}?board=${mine.id}`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Select canvas board").waitFor();
    await page.getByRole("button", { name: "Share", exact: true }).click();
    const dialog = page.getByTestId("planning-canvas-share-dialog");
    await dialog.getByLabel("Who can open this board").selectOption("company");
    await expect(dialog.getByLabel("Access level")).toHaveValue("edit");
    await expect(dialog.getByTestId("planning-canvas-share-text-note")).toContainText("Everyone with access will see all text on this board.");
    await page.screenshot({ path: path.join(dir, `share-dialog-widen-${width}.png`) });
    await page.keyboard.press("Escape");
    const groups = await page.locator('select[aria-label="Select canvas board"] optgroup').evaluateAll((els) => els.map((e) => (e as HTMLOptGroupElement).label));
    expect(groups).toEqual(["Mine", "Company", "Project"]);
    await page.getByRole("button", { name: "Archived boards" }).click();
    await expect(page.getByTestId("planning-canvas-archived-section")).toContainText("Archived board");
    await page.screenshot({ path: path.join(dir, `board-sections-archived-${width}.png`) });
    await page.keyboard.press("Escape");
    await page.goto(tabPath, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("project-canvas-tab")).toContainText("Project board");
    await page.screenshot({ path: path.join(dir, `project-canvas-tab-${width}.png`) });
  }

  const script = process.env.OVERFLOW_CHECK_SCRIPT;
  if (script) {
    let out = "";
    try {
      out = execFileSync("node", [script, "--base", baseURL!, "--paths", `${canvasPath},${tabPath}`, "--out", path.join(dir, "overflow")], { encoding: "utf8", cwd: path.resolve(".") });
    } catch (e) {
      out = String((e as { stdout?: string }).stdout ?? e);
    }
    fs.writeFileSync(path.join(dir, "overflow-check.txt"), out);
    expect(out).toContain("OVERFLOW-CHECK: PASS (0 hits)");
  }
});
