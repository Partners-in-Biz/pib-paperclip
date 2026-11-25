import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { buildPlanningCanvasSeed, splitPlanningCanvasSeed } from "./planning-canvas-seed";

/**
 * Keyboard map, cheat sheet, Outline and mobile bottom sheet (PAR-13949). Run:
 *   npx playwright test --config tests/e2e/playwright-planning-canvas-keyboard.config.ts --workers=1
 * Seed: buildPlanningCanvasSeed({ nodes: 520, longTitles: true }) (default PRNG seed 20261123), plus an empty board.
 */
const VIEWPORT = '[data-testid="planning-canvas-viewport"]';
const WIDTHS = [1440, 1280, 1024, 768, 390];
const tall = (w: number) => ({ width: w, height: w >= 1024 ? 900 : 844 });

async function openBoard(page: Page, company: { id: string; issuePrefix: string }, boardTitle: string) {
  await page.addInitScript((id) => localStorage.setItem("paperclip.selectedCompanyId", id), company.id);
  await page.goto(`/${company.issuePrefix}/planning-canvas`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(VIEWPORT);
  await page.locator("select[aria-label='Select canvas board']").selectOption({ label: boardTitle });
  await page.waitForTimeout(600);
}

test("keys, cheat sheet, Outline, bottom sheet and long-press on a 520-node board", async ({ page }) => {
  test.setTimeout(240_000);
  const dir = process.env.PLANNING_CANVAS_SHOTS_DIR ?? path.join("test-results", "planning-canvas-keyboard");
  fs.mkdirSync(dir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const company = await (await page.request.post("/api/companies", { data: { name: `Canvas Keys ${Date.now()}` } })).json();
  for (const [title, nodes] of [["Empty board", 0], ["Stress board", 520]] as const) {
    const { create, batches } = splitPlanningCanvasSeed(buildPlanningCanvasSeed({ nodes, longTitles: true }));
    const r = await page.request.post(`/api/companies/${company.id}/planning-canvases`, { data: { title, description: "", data: create } });
    expect(r.ok(), await r.text()).toBe(true);
    const board = await r.json();
    for (const [i, ops] of batches.entries()) {
      const res = await page.request.post(`/api/companies/${company.id}/planning-canvases/${board.id}/ops`, { data: { ops, clientBatchId: `seed-${title}-${i}` } });
      expect(res.ok(), (await res.text()).slice(0, 300)).toBe(true);
    }
  }
  await openBoard(page, company, "Stress board");

  await page.locator(VIEWPORT).click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Shift+?");
  const sheet = page.getByTestId("planning-canvas-cheat-sheet");
  await expect(sheet).toBeVisible();
  await page.screenshot({ path: path.join(dir, "cheat-sheet-1440.png") });
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  console.log("FLOW ?: cheat sheet opens and closes");

  await page.keyboard.press("o");
  const outline = page.getByTestId("planning-canvas-outline");
  await expect(outline).toBeVisible();
  const rows = outline.getByRole("button", { name: /^(Sticky note|Frame|Shape|Text):/ });
  expect(await rows.count()).toBeGreaterThan(50);
  await rows.nth(1).click();
  await expect(page.locator("[data-canvas-item]:focus")).toHaveCount(1);
  console.log(`FLOW outline: ${await rows.count()} rows shown; click focused ${await page.locator("[data-canvas-item]:focus").getAttribute("aria-label")}`);

  const focusedId = () => page.locator("[data-canvas-item]:focus").getAttribute("data-canvas-item");
  const first = await focusedId();
  await page.keyboard.press("Tab");
  await page.waitForTimeout(300);
  const second = await focusedId();
  expect(second && second !== first).toBeTruthy();
  const box = () => page.locator(`[data-canvas-item="${second}"]`).boundingBox();
  const b0 = await box();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await page.waitForTimeout(200);
  const b1 = await box();
  expect(b1!.x - b0!.x).toBeGreaterThan(0);
  expect(b1!.y - b0!.y).toBeGreaterThan(5);
  const before = await page.locator("[data-canvas-item]").count();
  await page.keyboard.press("Control+g");
  await expect.poll(() => page.locator("[data-canvas-item]").count()).toBeGreaterThanOrEqual(before);
  await page.keyboard.press("1");
  await expect(page.getByTitle("Reset zoom to 100%")).toHaveText("100%");
  await page.keyboard.press("0");
  await expect(page.getByTitle("Reset zoom to 100%")).not.toHaveText("100%");
  console.log("FLOW keys: Tab, arrow nudge, Shift+arrow, Ctrl+G, 1 and 0 verified");
  await page.screenshot({ path: path.join(dir, "stress-1440.png") });

  await page.setViewportSize(tall(390));
  await page.waitForTimeout(500);
  const rail = page.getByTestId("planning-canvas-tool-rail");
  const rb = await rail.boundingBox();
  expect(rb!.y + rb!.height).toBeGreaterThan(844 - 100); // pinned to the bottom edge, above the mobile nav
  expect(rb!.width).toBeGreaterThan(340);
  const ob = await outline.boundingBox();
  expect(ob!.width).toBeGreaterThan(340);
  await page.screenshot({ path: path.join(dir, "stress-390.png") });
  await page.locator(VIEWPORT).click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("o");
  await expect(outline).toBeHidden();
  await page.keyboard.press("0");
  const target = page.locator("[data-canvas-item]").first();
  const tb = (await target.boundingBox())!;
  const cx = tb.x + tb.width / 2;
  const cy = tb.y + Math.min(tb.height / 2, 20);
  const ev = (type: string) =>
    target.dispatchEvent(type, { pointerType: "touch", isPrimary: true, pointerId: 7, clientX: cx, clientY: cy, bubbles: true });
  await ev("pointerdown");
  await page.waitForTimeout(650);
  const menu = page.getByTestId("planning-canvas-context-menu");
  await expect(menu).toBeVisible();
  await ev("pointerup");
  await page.screenshot({ path: path.join(dir, "long-press-390.png") });
  console.log("FLOW long-press: menu opened after 650 ms touch hold");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  await openBoard(page, company, "Empty board");
  await page.keyboard.press("o");
  await expect(page.getByTestId("planning-canvas-outline")).toContainText("The board is empty.");
  await page.screenshot({ path: path.join(dir, "empty-390.png") });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, "empty-1440.png") });

  await openBoard(page, company, "Stress board");
  await page.locator(VIEWPORT).click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("o");
  let hits = 0;
  for (const mode of ["panels", "cheat-sheet"] as const) {
    if (mode === "cheat-sheet") await page.keyboard.press("Shift+?");
    for (const width of WIDTHS) {
      await page.setViewportSize(tall(width));
      await page.waitForTimeout(400);
      const found = await page.evaluate((m) => {
        const out: string[] = [];
        const de = document.documentElement;
        if (de.scrollWidth > de.clientWidth) out.push(`page-scroll ${de.scrollWidth}>${de.clientWidth}`);
        const sel = m === "panels" ? '[data-testid="planning-canvas-tool-rail"], [data-testid="planning-canvas-outline"], [data-testid="planning-canvas-outline"] *' : '[role="dialog"] *';
        for (const el of document.querySelectorAll(sel)) {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          if (cs.display === "none" || cs.visibility === "hidden" || r.width === 0 || el.closest("svg, .sr-only")) continue;
          if (el.hasAttribute("data-testid") && (r.right > window.innerWidth + 1 || r.left < -1)) out.push(`offscreen ${el.getAttribute("data-testid")} ${Math.round(r.left)}..${Math.round(r.right)}`);
          if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim())) continue;
          if (el.scrollWidth <= el.clientWidth + 1 || cs.overflowX === "auto" || cs.overflowX === "scroll" || cs.textOverflow === "ellipsis") continue;
          out.push(`${el.tagName.toLowerCase()} ${el.scrollWidth}>${el.clientWidth} "${el.textContent?.trim().slice(0, 40)}"`);
        }
        return out;
      }, mode);
      hits += found.length;
      console.log(`OVERFLOW ${mode} @${width}: ${found.length} hit(s) ${found.join(" | ")}`);
    }
  }
  console.log(`OVERFLOW-CHECK: ${hits === 0 ? "PASS (0 hits)" : `FAIL (${hits} hits)`} widths ${WIDTHS.join("/")} pages 1`);
  expect(hits).toBe(0);
});
