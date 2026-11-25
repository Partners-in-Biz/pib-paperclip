import fs from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { buildPlanningCanvasSeed, splitPlanningCanvasSeed } from "./planning-canvas-seed";

/**
 * Planning Canvas performance harness (PAR-13933 C4, tightened in PAR-13948 C17; plan PAR-13925 section F).
 *
 * Run: pnpm test:e2e:planning-canvas-perf   (builds the UI, boots a throwaway server)
 *   PLANNING_CANVAS_PERF_WRITE_BASELINE=1  rewrite planning-canvas-perf.baseline.json instead of asserting
 *   PLANNING_CANVAS_SHOTS_DIR=<dir>        where the screenshots go
 *   PLANNING_CANVAS_TRACE_DIR=<dir>        where the CDP traces go
 *
 * Step time = wheel event dispatched -> second animation frame after it. Pan: 60 steps, zoom: 20 steps.
 * Untraced figure (the C4 baseline script): one warm-up pass, then the median of five per-pass p95s.
 * Traced figure (C17): three more runs under a CDP trace, each with its own p95 and its longest
 * renderer main-thread task. At 5,000 nodes every figure is held to 1.2x the 500-node baseline
 * measured on e33502365, and no traced task may pass 200 ms.
 */
const PAN_STEPS = 60;
const ZOOM_STEPS = 20;
const PASSES = 5;
const TRACED_RUNS = 3;
const BUDGET_FACTOR = 1.2;
const LONG_TASK_MAX_MS = 200;
const DOM_ITEM_MAX = 300;
const BASELINE_FILE = path.join(import.meta.dirname, "planning-canvas-perf.baseline.json");
const VIEWPORT_SELECTOR = '[data-testid="planning-canvas-viewport"]';
const ITEM_SELECTOR = `${VIEWPORT_SELECTOR} [data-canvas-item]`;
const WIDTHS = [1440, 1280, 1024, 768, 390];
const TRACE_CATEGORIES = ["devtools.timeline", "v8.execute", "disabled-by-default-devtools.timeline"];

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}
const round = (v: number) => Number(v.toFixed(2));

function shotsDir() {
  const dir = process.env.PLANNING_CANVAS_SHOTS_DIR ?? path.join("test-results", "planning-canvas-shots");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Creates a company and a board holding the seed (first 500 nodes in the create body, the rest as ops) and opens it. */
async function openSeededBoard(page: Page, nodeCount: number, opts: { longTitles?: boolean } = {}) {
  const company = await (await page.request.post("/api/companies", { data: { name: `Canvas Perf ${Date.now()}` } })).json();
  const { create, batches } = splitPlanningCanvasSeed(buildPlanningCanvasSeed({ nodes: nodeCount, longTitles: opts.longTitles }));
  const created = await page.request.post(`/api/companies/${company.id}/planning-canvases`, {
    data: { title: "Perf board", description: "", data: create },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const board = await created.json();
  for (const [i, ops] of batches.entries()) {
    const res = await page.request.post(`/api/companies/${company.id}/planning-canvases/${board.id}/ops`, {
      data: { ops, clientBatchId: `seed-${i}` },
    });
    expect(res.ok(), (await res.text()).slice(0, 400)).toBe(true);
    const body = (await res.json()) as { results: Array<{ status: string }> };
    expect(body.results.filter((r) => r.status !== "applied")).toEqual([]);
  }
  await page.addInitScript((id) => localStorage.setItem("paperclip.selectedCompanyId", id), company.id);
  await page.goto(`/${company.issuePrefix}/planning-canvas`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(VIEWPORT_SELECTOR);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(page.locator(VIEWPORT_SELECTOR)).toHaveAttribute("data-node-count", String(nodeCount), { timeout: 60_000 });
  if (nodeCount > 0) await expect(page.locator(ITEM_SELECTOR).first()).toBeVisible();
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

/** The C4 baseline script: one warm-up pass, then the median of five untraced per-pass p95s. */
async function measureUntraced(page: Page) {
  await runPass(page);
  const p95s: number[] = [];
  for (let pass = 0; pass < PASSES; pass += 1) {
    const times = await runPass(page);
    expect(times).toHaveLength(PAN_STEPS + ZOOM_STEPS);
    p95s.push(percentile(times, 95));
  }
  return { p95: round(percentile(p95s, 50)), passes: p95s.map(round) };
}

/** Longest RunTask on a renderer main thread in a Chromium trace, in ms. */
function longestMainThreadTask(trace: Buffer) {
  type TraceEvent = { name: string; ph: string; pid: number; tid: number; dur?: number; args?: { name?: string } };
  const { traceEvents } = JSON.parse(trace.toString("utf8")) as { traceEvents: TraceEvent[] };
  const main = new Set(
    traceEvents.filter((e) => e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain").map((e) => `${e.pid}:${e.tid}`),
  );
  let longest = 0;
  for (const e of traceEvents) {
    if (e.name === "RunTask" && e.ph === "X" && main.has(`${e.pid}:${e.tid}`)) longest = Math.max(longest, (e.dur ?? 0) / 1000);
  }
  return round(longest);
}

/** Three runs of the same script, each under its own CDP trace (written to PLANNING_CANVAS_TRACE_DIR). */
async function tracedRuns(page: Page, browser: Browser, nodes: number) {
  const traceDir = process.env.PLANNING_CANVAS_TRACE_DIR ?? path.join("test-results", "planning-canvas-perf");
  fs.mkdirSync(traceDir, { recursive: true });
  const runs: Array<{ p95: number; longestTaskMs: number }> = [];
  for (let run = 1; run <= TRACED_RUNS; run += 1) {
    await browser.startTracing(page, { categories: TRACE_CATEGORIES });
    const times = await runPass(page);
    const trace = await browser.stopTracing();
    fs.writeFileSync(path.join(traceDir, `trace-${nodes}-run${run}.json`), trace);
    runs.push({ p95: round(percentile(times, 95)), longestTaskMs: longestMainThreadTask(trace) });
  }
  return runs;
}

function readBaseline() {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")) as { p95StepMs: number };
  expect(baseline.p95StepMs, "baseline not recorded").toBeGreaterThan(0);
  return baseline;
}

const zoomPercent = async (page: Page) => Number((await page.getByText(/^\d+%$/).first().textContent())!.replace("%", ""));

test("pan and zoom step time at 500 nodes stays within budget", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededBoard(page, 500);
  const { p95, passes } = await measureUntraced(page);
  const traced = await tracedRuns(page, browser, 500);
  console.log(`PLANNING-CANVAS-PERF nodes=500 p95StepMs=${p95} passes=${JSON.stringify(passes)} traced=${JSON.stringify(traced)}`);

  if (process.env.PLANNING_CANVAS_PERF_WRITE_BASELINE === "1") {
    const prev = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify({ ...prev, p95StepMs: p95, passP95s: passes }, null, 2)}\n`);
    return;
  }
  const baseline = readBaseline();
  expect(p95, `p95 step ${p95} ms exceeds ${BUDGET_FACTOR}x baseline ${baseline.p95StepMs} ms`).toBeLessThanOrEqual(baseline.p95StepMs * BUDGET_FACTOR);
});

test("5,000 nodes: at most 300 items in the DOM, pan and zoom within 1.2x the 500-node baseline, no long task", async ({ page, browser }) => {
  test.setTimeout(420_000);
  test.skip(process.env.PLANNING_CANVAS_PERF_WRITE_BASELINE === "1", "baseline mode measures 500 nodes only");
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededBoard(page, 5000);
  expect(await zoomPercent(page)).toBe(100);
  const domItems = await page.locator(ITEM_SELECTOR).count();
  console.log(`PLANNING-CANVAS-DOM nodes=5000 zoom=1 viewport=1440x900 dataCanvasItems=${domItems}`);
  expect(domItems).toBeLessThanOrEqual(DOM_ITEM_MAX);

  const { p95, passes } = await measureUntraced(page);
  const traced = await tracedRuns(page, browser, 5000);
  const baseline = readBaseline();
  const limit = round(baseline.p95StepMs * BUDGET_FACTOR);
  console.log(
    `PLANNING-CANVAS-PERF nodes=5000 p95StepMs=${p95} passes=${JSON.stringify(passes)} traced=${JSON.stringify(traced)} limit=${limit} baseline500=${baseline.p95StepMs}`,
  );
  expect(p95, `untraced p95 ${p95} ms > ${limit} ms`).toBeLessThanOrEqual(limit);
  for (const [i, run] of traced.entries()) {
    expect(run.p95, `traced run ${i + 1} p95 ${run.p95} ms > ${limit} ms`).toBeLessThanOrEqual(limit);
    expect(run.longestTaskMs, `traced run ${i + 1} has a ${run.longestTaskMs} ms task`).toBeLessThanOrEqual(LONG_TASK_MAX_MS);
  }
  // After the script (which ends near zoom 1) the board still holds only the culled set.
  expect(await page.locator(ITEM_SELECTOR).count()).toBeLessThanOrEqual(DOM_ITEM_MAX);
});

test("level of detail below zoom 0.4 renders plain cards", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededBoard(page, 5000);
  await expect(page.locator(`${ITEM_SELECTOR}[data-canvas-lod="full"]`).first()).toBeVisible();
  const box = (await page.locator(VIEWPORT_SELECTOR).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down("Control");
  for (let i = 0; i < 16; i += 1) {
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(30);
  }
  await page.keyboard.up("Control");
  await expect.poll(() => zoomPercent(page)).toBeLessThan(40);
  await expect(page.locator(`${ITEM_SELECTOR}[data-canvas-lod="full"]`)).toHaveCount(0);
  expect(await page.locator(`${ITEM_SELECTOR}[data-canvas-lod="low"]`).count()).toBeGreaterThan(0);
  await page.screenshot({ path: path.join(shotsDir(), "planning-canvas-5000-lod-1440.png") });
});

test("screenshots and overflow check with stress data (5,000 nodes with long titles, empty board)", async ({ page }) => {
  test.setTimeout(300_000);
  const dir = shotsDir();
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededBoard(page, 5000, { longTitles: true });
  let hits = 0;
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    await page.waitForTimeout(600);
    // KNOWN, NOT C17 (see planning-canvas-typed-nodes.spec.ts): at 390 the page shell gives the viewport 0 height.
    if (width === 390) await page.addStyleTag({ content: `${VIEWPORT_SELECTOR}{min-height:520px}` });
    await page.waitForTimeout(300);
    expect(await page.locator(ITEM_SELECTOR).count()).toBeGreaterThan(0);
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
    console.log(`OVERFLOW @${width}: ${found.length} hit(s) ${found.slice(0, 10).join(" | ")}`);
    if (width === 1440 || width === 390) await page.screenshot({ path: path.join(dir, `planning-canvas-5000-long-titles-${width}.png`) });
  }
  console.log(`OVERFLOW-CHECK: ${hits === 0 ? "PASS (0 hits)" : `FAIL (${hits} hits)`} widths ${WIDTHS.join("/")} seed=buildPlanningCanvasSeed({nodes:5000,longTitles:true})`);
  expect(hits).toBe(0);

  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededBoard(page, 0);
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(dir, `planning-canvas-empty-${width}.png`) });
  }
});

test("select, edit and drag still work on culled, memoized nodes (pointer events)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededBoard(page, 40);
  const node = page.locator(`${VIEWPORT_SELECTOR} [data-canvas-item="seed-node-0001"]`);
  await node.click({ position: { x: 20, y: 20 } });
  await expect(node).toHaveClass(/ring-blue-500/);
  await expect(node.getByRole("button", { name: /Connect from/ })).toHaveCount(4);
  // Grab low in the card: once a node is selected the selection toolbar covers the top of the board.
  const before = await node.boundingBox();
  const grabY = before!.y + before!.height - 30;
  await page.mouse.move(before!.x + 20, grabY);
  await page.mouse.down();
  await page.mouse.move(before!.x + 140, grabY, { steps: 6 });
  await page.mouse.up();
  const after = await node.boundingBox();
  expect(Math.abs(after!.x - before!.x)).toBeGreaterThan(60);
  await node.dblclick({ position: { x: 20, y: before!.height - 30 } });
  await expect(node.locator("input, textarea").first()).toBeVisible();
});

test("pinch zooms and two-finger drag pans on touch", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  await openSeededBoard(page, 40);
  const cdp = await context.newCDPSession(page);
  const box = (await page.locator(VIEWPORT_SELECTOR).boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", points: Array<[number, number]>) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const nodeBox = async () => (await page.locator(`${VIEWPORT_SELECTOR} [data-canvas-item="seed-node-0001"]`).boundingBox())!;

  // Pinch out: the fingers move apart from 80 px to 240 px, so the zoom roughly triples (capped at 200%).
  expect(await zoomPercent(page)).toBe(100);
  await touch("touchStart", [[cx - 40, cy], [cx + 40, cy]]);
  for (let i = 1; i <= 8; i += 1) await touch("touchMove", [[cx - 40 - i * 10, cy], [cx + 40 + i * 10, cy]]);
  await touch("touchEnd", []);
  await expect.poll(() => zoomPercent(page)).toBeGreaterThan(150);

  // Two-finger pan: both fingers move 120 px right and 60 px down at the same spacing; the zoom stays.
  const panBefore = await nodeBox();
  const zoomBefore = await zoomPercent(page);
  await touch("touchStart", [[cx - 40, cy], [cx + 40, cy]]);
  for (let i = 1; i <= 6; i += 1) await touch("touchMove", [[cx - 40 + i * 20, cy + i * 10], [cx + 40 + i * 20, cy + i * 10]]);
  await touch("touchEnd", []);
  await expect.poll(async () => Math.round((await nodeBox()).x - panBefore.x)).toBeGreaterThan(100);
  expect(Math.round((await nodeBox()).y - panBefore.y)).toBeGreaterThan(40);
  expect(await zoomPercent(page)).toBe(zoomBefore);
  await context.close();
});
