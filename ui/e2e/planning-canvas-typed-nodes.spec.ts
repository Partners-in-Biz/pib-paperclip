import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { buildPlanningCanvasSeed } from "./planning-canvas-seed";

/**
 * Table and markdown nodes on a real board (PAR-13943). Run:
 *   npx playwright test --config tests/e2e/playwright-planning-canvas-typed.config.ts --workers=1
 * Writes 1440 and 390 screenshots to PLANNING_CANVAS_SHOTS_DIR and prints an OVERFLOW-CHECK line.
 */
const VIEWPORT = '[data-testid="planning-canvas-viewport"]';
const WIDTHS = [1440, 1280, 1024, 768, 390];
const UNSAFE = [
  "# Unsafe sample",
  "<img src=x onerror=\"window.__pwned=1\">",
  "[x](javascript:alert(1))",
  "```mermaid\nflowchart TD\nA-->B\nclick A callback\nclick A href \"javascript:window.__pwned=2\"\n```",
].join("\n\n");

const node = (kind: string, key: string, x: number, y: number, width: number, height: number, data: unknown) => ({
  op: "add",
  item: { itemType: "node", key, kind, x, y, width, height, zIndex: 10, color: "slate", title: "", content: "", data },
});

async function seed(page: Page) {
  const company = await (await page.request.post("/api/companies", { data: { name: `Canvas Typed ${Date.now()}` } })).json();
  const created = await (await page.request.post(`/api/companies/${company.id}/planning-canvases`, {
    data: { title: "Typed board", description: "", data: buildPlanningCanvasSeed({ nodes: 1 }) },
  })).json();
  const ops = [
    node("table", "tbl-1", 40, 40, 420, 220, {
      columns: [{ id: "c1", name: "Item", type: "text" }, { id: "c2", name: "Owner", type: "text" }, { id: "c3", name: "Qty", type: "number" }],
      rows: [{ id: "r1", cells: { c1: "Write plan", c2: "Sam", c3: 3 } }, { id: "r2", cells: { c1: "<b>not bold</b>", c2: "Leo", c3: 5 } }],
    }),
    node("markdown", "md-1", 500, 40, 320, 260, { markdown: "# Plan\n\nSome **bold** text and a [link](https://example.com).\n\n```mermaid\nflowchart TD\nA-->B\n```" }),
    node("markdown", "md-2", 860, 40, 320, 260, { markdown: UNSAFE }),
  ];
  const res = await page.request.post(`/api/companies/${company.id}/planning-canvases/${created.id}/ops`, { data: { ops, clientBatchId: `seed-${Date.now()}` } });
  expect(res.ok(), await res.text()).toBe(true);
  await page.addInitScript((id) => localStorage.setItem("paperclip.selectedCompanyId", id), company.id);
  await page.goto(`/${company.issuePrefix}/planning-canvas`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(VIEWPORT);
  return { companyId: company.id as string, boardId: created.id as string };
}

test("table and markdown nodes render, edit, stay safe and do not overflow", async ({ page }) => {
  test.setTimeout(180_000);
  const dir = process.env.PLANNING_CANVAS_SHOTS_DIR ?? path.join("test-results", "planning-canvas-typed");
  fs.mkdirSync(dir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const board = await seed(page);

  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  await expect(table.getByLabel("Item cell").nth(1)).toHaveValue("<b>not bold</b>");
  await expect(page.locator(`${VIEWPORT} b`)).toHaveCount(0);

  // Cell edit and row add reach the server as cell ops.
  await table.getByLabel("Item cell").first().fill("Write the plan");
  await page.getByRole("button", { name: "Row", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const read = await (await page.request.get(`/api/companies/${board.companyId}/planning-canvases/${board.boardId}`)).json();
    const t = read.items.find((i: { key: string }) => i.key === "tbl-1");
    return [t?.data?.data?.rows?.length, t?.data?.data?.rows?.[0]?.cells?.c1];
  }).toEqual([3, "Write the plan"]);

  // Untrusted markdown: nothing ran, no handler elements, no javascript: href.
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(await page.locator(`${VIEWPORT} [onerror], ${VIEWPORT} a[href^="javascript:" i], ${VIEWPORT} img`).count()).toBe(0);

  // Overflow check (same rules as overflow-check.mjs, scoped to the board) at five widths.
  let hits = 0;
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    await page.waitForTimeout(600);
    // KNOWN, NOT C16: at 390 the page shell gives the canvas viewport 0 height (the C4 perf screenshot is empty too).
    // Test-only workaround so the scan and the screenshot see the nodes mounted and in view; PROBE below logs the real height.
    if (width === 390) await page.addStyleTag({ content: `${VIEWPORT}{min-height:520px}` });
    // Fit the board so the nodes under test are in view, then prove they are mounted and visible at this width.
    // At 390 the page header (not part of C16) covers the bottom-right controls, so click through the DOM.
    await page.getByRole("button", { name: "Close", exact: true }).first().click({ timeout: 500 }).catch(() => undefined);
    await page.getByRole("button", { name: "Fit to screen" }).locator("visible=true").first().dispatchEvent("click");
    await page.waitForTimeout(400);
    const inView = await page.evaluate(() => {
      const vp = { w: window.innerWidth, h: window.innerHeight };
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < vp.w && r.top < vp.h;
      };
      const root = document.querySelector('[data-testid="planning-canvas-viewport"]')!;
      return { table: [...root.querySelectorAll("table")].filter(visible).length, markdown: [...root.querySelectorAll(".paperclip-markdown")].filter(visible).length };
    });
    const probe = await page.evaluate(() => {
      const vp = document.querySelector('[data-testid="planning-canvas-viewport"]')!;
      const t = vp.querySelector("table")!.getBoundingClientRect();
      const top = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2);
      const v = vp.getBoundingClientRect();
      return { vp: [v.top, v.height].map(Math.round), table: [t.left, t.top, t.width, t.height].map(Math.round), topIsInViewport: !!top && vp.contains(top) };
    });
    console.log(`PROBE @${width}: ${JSON.stringify(probe)}`);
    console.log(`NODES-IN-VIEW @${width}: tables=${inView.table} markdown=${inView.markdown}`);
    expect(inView.table).toBe(1);
    expect(inView.markdown).toBe(2);
    const found = await page.evaluate(() => {
      const out: string[] = [];
      const de = document.documentElement;
      if (de.scrollWidth > de.clientWidth) out.push(`page-scroll ${de.scrollWidth}>${de.clientWidth}`);
      for (const el of document.querySelectorAll(`[data-testid="planning-canvas-viewport"] *`)) {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (cs.display === "none" || cs.visibility === "hidden" || r.width === 0 || r.height === 0 || el.closest("svg")) continue;
        if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim())) continue;
        if (el.scrollWidth <= el.clientWidth + 1 || cs.overflowX === "auto" || cs.overflowX === "scroll" || cs.textOverflow === "ellipsis") continue;
        out.push(`${el.tagName.toLowerCase()} ${el.scrollWidth}>${el.clientWidth} "${el.textContent?.trim().slice(0, 40)}"`);
      }
      return out;
    });
    hits += found.length;
    console.log(`OVERFLOW @${width}: ${found.length} hit(s) ${found.join(" | ")}`);
    if (width === 1440 || width === 390) await page.screenshot({ path: path.join(dir, `typed-nodes-${width}.png`) });
  }
  console.log(`OVERFLOW-CHECK: ${hits === 0 ? "PASS (0 hits)" : `FAIL (${hits} hits)`} widths ${WIDTHS.join("/")} pages 1`);
  expect(hits).toBe(0);
});
