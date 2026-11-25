import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { buildPlanningCanvasSeed } from "./planning-canvas-seed";

/**
 * Blueprints UI on a real board (PAR-13947). Run:
 *   npx playwright test --config tests/e2e/playwright-planning-canvas-blueprints.config.ts --workers=1
 * Opens the dialog, applies a blueprint with one node switched off, proves the issues exist and the
 * new board's cards are live, scans five widths for overflow, writes 1440 and 390 screenshots.
 */
const VIEWPORT = '[data-testid="planning-canvas-viewport"]';
const WIDTHS = [1440, 1280, 1024, 768, 390];

test("blueprint gallery, preview and apply create issues and a live board", async ({ page }) => {
  test.setTimeout(180_000);
  const dir = process.env.PLANNING_CANVAS_SHOTS_DIR ?? path.join("test-results", "planning-canvas-blueprints");
  fs.mkdirSync(dir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const company = await (await page.request.post("/api/companies", { data: { name: `Canvas Blueprints ${Date.now()}` } })).json();
  const seeded = await page.request.post(`/api/companies/${company.id}/planning-canvases`, {
    data: { title: "Start board", description: "", data: buildPlanningCanvasSeed({ nodes: 1 }) },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  await page.addInitScript((id) => localStorage.setItem("paperclip.selectedCompanyId", id), company.id);
  await page.goto(`/${company.issuePrefix}/planning-canvas`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(VIEWPORT);

  await page.getByRole("button", { name: "Blueprints", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("radio")).toHaveCount(6);
  await expect(dialog.getByRole("img", { name: /Preview of the/ })).toBeVisible();

  let hits = 0;
  const scan = async (label: string) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
      await page.waitForTimeout(400);
      const found = await page.evaluate(() => {
        const out: string[] = [];
        const de = document.documentElement;
        if (de.scrollWidth > de.clientWidth) out.push(`page-scroll ${de.scrollWidth}>${de.clientWidth}`);
        for (const el of document.querySelectorAll('[role="dialog"] *')) {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          if (cs.display === "none" || cs.visibility === "hidden" || r.width === 0 || r.height === 0 || el.closest("svg, .sr-only")) continue;
          if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim())) continue;
          if (el.scrollWidth <= el.clientWidth + 1 || cs.overflowX === "auto" || cs.overflowX === "scroll" || cs.textOverflow === "ellipsis") continue;
          out.push(`${el.tagName.toLowerCase()} ${el.scrollWidth}>${el.clientWidth} "${el.textContent?.trim().slice(0, 40)}"`);
        }
        return out;
      });
      hits += found.length;
      console.log(`OVERFLOW ${label} @${width}: ${found.length} hit(s) ${found.join(" | ")}`);
      if (width === 1440 || width === 390) await page.screenshot({ path: path.join(dir, `blueprints-${label}-${width}.png`) });
    }
  };
  await scan("dialog");
  await page.setViewportSize({ width: 1440, height: 900 });

  const toggles = dialog.getByRole("list", { name: "Issues to create" }).getByRole("checkbox");
  const total = await toggles.count();
  expect(total).toBeGreaterThan(1);
  await toggles.first().click();
  const before = await (await page.request.get(`/api/companies/${company.id}/planning-canvases`)).json();
  await dialog.getByRole("button", { name: /^Create board/ }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });

  const boards = await (await page.request.get(`/api/companies/${company.id}/planning-canvases`)).json();
  expect(boards.length).toBe(before.length + 1);
  const created = boards.find((b: { id: string }) => !before.some((o: { id: string }) => o.id === b.id));
  const board = await (await page.request.get(`/api/companies/${company.id}/planning-canvases/${created.id}`)).json();
  const nodes = board.items.filter((i: { itemType: string }) => i.itemType === "node");
  expect(nodes.length).toBeGreaterThan(1);
  const issues = await (await page.request.get(`/api/companies/${company.id}/issues?limit=100`)).json();
  const list = Array.isArray(issues) ? issues : issues.items ?? [];
  console.log(`ISSUES-CREATED: ${list.length} (switched off: 1 of ${total}, parent issue: on)`);
  expect(list.length).toBe(total - 1 + 1);

  await page.waitForSelector(VIEWPORT);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const identifier = list.find((i: { identifier?: string }) => i.identifier)?.identifier as string | undefined;
  if (identifier) await expect(page.locator(VIEWPORT).getByText(identifier).first()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: path.join(dir, "blueprints-applied-1440.png") });
  console.log(`CARDS-LIVE: ${identifier ?? "n/a"} visible on the new board`);
  console.log(`OVERFLOW-CHECK: ${hits === 0 ? "PASS (0 hits)" : `FAIL (${hits} hits)`} widths ${WIDTHS.join("/")} pages 1`);
  expect(hits).toBe(0);
});
