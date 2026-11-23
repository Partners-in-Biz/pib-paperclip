import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { buildPlanningCanvasSeed } from "./planning-canvas-seed";

/**
 * Planning Canvas performance harness (PAR-13933, plan PAR-13925 section F).
 *
 * Run: pnpm test:e2e:planning-canvas-perf   (builds the UI, boots a throwaway server)
 *   PLANNING_CANVAS_PERF_WRITE_BASELINE=1  rewrite planning-canvas-perf.baseline.json instead of asserting
 *   PLANNING_CANVAS_SHOTS_DIR=<dir>        where the 1440 / 390 screenshots go
 *   PLANNING_CANVAS_TRACE_DIR=<dir>        where the CDP traces go
 *
 * Step time = wheel event dispatched -> second animation frame after it. Pan: 60 steps, zoom: 20
 * steps, five untraced passes after a warm-up; the figure is the median of the five p95 values. One extra
 * traced pass writes a CDP trace (not counted).
 */
const PAN_STEPS = 60;
const ZOOM_STEPS = 20;
const PASSES = 5;
const BUDGET_FACTOR = 1.2;
const BASELINE_FILE = path.join(import.meta.dirname, "planning-canvas-perf.baseline.json");
const VIEWPORT_SELECTOR = '[data-testid="planning-canvas-viewport"]';

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function openSeededBoard(page: Page, nodeCount: number) {
  const company = await (await page.request.post("/api/companies", { data: { name: `Canvas Perf ${Date.now()}` } })).json();
  const created = await page.request.post(`/api/companies/${company.id}/planning-canvases`, {
    data: { title: "Perf board", description: "", data: buildPlanningCanvasSeed({ nodes: nodeCount }) },
  });
  expect(created.ok(), await created.text()).toBe(true);
  await page.addInitScript((id) => localStorage.setItem("paperclip.selectedCompanyId", id), company.id);
  await page.goto(`/${company.issuePrefix}/planning-canvas`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(VIEWPORT_SELECTOR);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(page.locator(`${VIEWPORT_SELECTOR} > div > div`)).toHaveCount(nodeCount);
}

async function runPass(page: Page) {
  return page.evaluate(
    async ({ pan, zoom, selector }) => {
      const el = document.querySelector(selector)!;
      const rect = el.getBoundingClientRect();
      const times: number[] = [];
      const step = async (init: WheelEventInit) => {
        const start = performance.now();
        el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, ...init }));
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        times.push(performance.now() - start);
      };
      for (let i = 0; i < pan; i += 1) await step({ deltaX: i % 2 === 0 ? 40 : -40, deltaY: 24 });
      for (let i = 0; i < zoom; i += 1) await step({ ctrlKey: true, deltaY: i % 2 === 0 ? -100 : 100 });
      return times;
    },
    { pan: PAN_STEPS, zoom: ZOOM_STEPS, selector: VIEWPORT_SELECTOR },
  );
}

test("pan and zoom step time at 500 nodes stays within budget", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededBoard(page, 500);
  const traceDir = process.env.PLANNING_CANVAS_TRACE_DIR ?? path.join("test-results", "planning-canvas-perf");
  fs.mkdirSync(traceDir, { recursive: true });

  await runPass(page); // warm-up, not counted
  const p95s: number[] = [];
  for (let pass = 0; pass < PASSES; pass += 1) {
    const times = await runPass(page);
    expect(times).toHaveLength(PAN_STEPS + ZOOM_STEPS);
    p95s.push(percentile(times, 95));
  }
  await browser.startTracing(page, { path: path.join(traceDir, "trace-500.json"), categories: ["devtools.timeline", "v8.execute", "disabled-by-default-devtools.timeline"] });
  await runPass(page);
  await browser.stopTracing();
  const p95 = Number(percentile(p95s, 50).toFixed(2));
  console.log(`PLANNING-CANVAS-PERF nodes=500 p95StepMs=${p95} passes=${JSON.stringify(p95s.map((v) => Number(v.toFixed(2))))}`);

  if (process.env.PLANNING_CANVAS_PERF_WRITE_BASELINE === "1") {
    const prev = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify({ ...prev, p95StepMs: p95, passP95s: p95s.map((v) => Number(v.toFixed(2))) }, null, 2)}\n`);
    return;
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
  expect(baseline.p95StepMs, "baseline not recorded").toBeGreaterThan(0);
  expect(p95, `p95 step ${p95} ms exceeds ${BUDGET_FACTOR}x baseline ${baseline.p95StepMs} ms`).toBeLessThanOrEqual(baseline.p95StepMs * BUDGET_FACTOR);
});

test("screenshots at 1440 and 390 on the seeded board", async ({ page }) => {
  const dir = process.env.PLANNING_CANVAS_SHOTS_DIR ?? path.join("test-results", "planning-canvas-shots");
  fs.mkdirSync(dir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededBoard(page, 40);
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(dir, `planning-canvas-${width}.png`) });
  }
});

test("select, edit and drag still work on memoized nodes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededBoard(page, 40);
  const node = page.locator(`${VIEWPORT_SELECTOR} > div > div`).nth(1); // seed node 0001 (a sticky or shape, top row)
  await node.click({ position: { x: 20, y: 20 } });
  await expect(node).toHaveClass(/ring-blue-500/);
  await expect(node.getByRole("button", { name: /Connect from/ })).toHaveCount(4);
  const before = await node.boundingBox();
  await page.mouse.move(before!.x + 20, before!.y + 20);
  await page.mouse.down();
  await page.mouse.move(before!.x + 140, before!.y + 20, { steps: 6 });
  await page.mouse.up();
  const after = await node.boundingBox();
  expect(Math.abs(after!.x - before!.x)).toBeGreaterThan(60);
  await node.dblclick({ position: { x: 20, y: 20 } });
  await expect(node.locator("input, textarea").first()).toBeVisible();
});
