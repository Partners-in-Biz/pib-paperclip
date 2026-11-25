import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { buildPlanningCanvasSeed } from "./planning-canvas-seed";

/**
 * Visual QA for the kanban and timeline filter row (PAR-14256). Seeds stress data (very long
 * project, agent and goal names, 5 statuses, a parent chip, an empty result) next to normal nodes,
 * screenshots 1440 and 390, and scans the board for overflow at five widths. Run:
 *   PLANNING_CANVAS_SPEC=planning-canvas-filters.spec.ts pnpm test:e2e:planning-canvas-perf
 *   PLANNING_CANVAS_SHOTS_DIR=<dir>  OVERFLOW_CHECK_SCRIPT=<path to overflow-check.mjs>
 */
const VIEWPORT = '[data-testid="planning-canvas-viewport"]';
const FILTERS = '[role="group"][aria-label="Filters"]';
const WIDTHS = [1440, 1280, 1024, 768, 390];
const LONG_PROJECT = "Bartholomew-Wolfeschlegelsteinhausen-quarterly-roadmap-2026-EMEA";
const LONG_AGENT = "Maximiliana Wolfeschlegelsteinhausenbergerdorff Principal Platform Reliability Engineer";
const LONG_GOAL = "Grow recurring revenue across every Southern African region by forty percent before the end of 2027";
// Five statuses no seeded child has, so the stress nodes show the empty result.
const FIVE = ["backlog", "in_review", "blocked", "cancelled", "done"];

const node = (kind: string, key: string, title: string, x: number, y: number, width: number, height: number, data: unknown) => ({
  op: "add",
  item: { itemType: "node", key, kind, x, y, width, height, zIndex: 10, color: "slate", title, content: "", data },
});

async function post<T>(page: Page, url: string, data: object): Promise<T> {
  const res = await page.request.post(url, { data });
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
  return res.json();
}

async function seed(page: Page) {
  const company = await post<{ id: string; issuePrefix: string }>(page, "/api/companies", { name: `Canvas Filters ${Date.now()}` });
  const c = `/api/companies/${company.id}`;
  const agent = async (name: string) => {
    const a = await post<{ id: string }>(page, `${c}/agents`, {
      name, role: "general", adapterType: "process", adapterConfig: { command: "false" }, runtimeConfig: { heartbeat: { enabled: false } },
    });
    expect((await page.request.post(`/api/agents/${a.id}/pause`)).ok()).toBe(true);
    return a;
  };
  const longAgent = await agent(LONG_AGENT);
  const sam = await agent("Sam");
  const project = await post<{ id: string }>(page, `${c}/projects`, { name: LONG_PROJECT });
  const goal = await post<{ id: string }>(page, `${c}/goals`, { title: LONG_GOAL });
  const parent = await post<{ id: string; identifier: string }>(page, `${c}/issues`, { title: "Parent epic", status: "todo", projectId: project.id });
  const child = (title: string, status: string, assigneeAgentId: string) =>
    post(page, `${c}/issues`, { title, status, projectId: project.id, goalId: goal.id, parentId: parent.id, assigneeAgentId });
  await child("Write the migration plan for the regional pricing tables", "todo", longAgent.id);
  await child("Review the roll-out checklist", "in_progress", sam.id);
  await child("Ship the dashboard", "todo", sam.id);

  const stress = { kind: "issues", limit: 100, filter: { projectId: project.id, assigneeAgentId: longAgent.id, goalId: goal.id, parentId: parent.id, status: FIVE } };
  const normal = { kind: "issues", limit: 100, filter: {} };
  const board = await post<{ id: string }>(page, `${c}/planning-canvases`, { title: "Filters board", description: "", data: buildPlanningCanvasSeed({ nodes: 0 }) });
  const ops = [
    node("kanban", "kb-stress", "Kanban stress (empty result)", 0, 0, 640, 360, { source: stress, groupBy: "status", collapsed: [] }),
    node("kanban", "kb-normal", "Kanban normal", 680, 0, 640, 360, { source: normal, groupBy: "status", collapsed: [] }),
    node("timeline", "tl-stress", "Timeline stress (empty result)", 0, 400, 480, 280, { source: stress, scale: "week" }),
    node("timeline", "tl-normal", "Timeline normal", 520, 400, 480, 280, { source: { ...normal, filter: { parentId: parent.id } }, scale: "week" }),
  ];
  const res = await page.request.post(`${c}/planning-canvases/${board.id}/ops`, { data: { ops, clientBatchId: `seed-${Date.now()}` } });
  expect(res.ok(), await res.text()).toBe(true);
  await page.addInitScript((id) => localStorage.setItem("paperclip.selectedCompanyId", id), company.id);
  const boardPath = `/${company.issuePrefix}/planning-canvas?board=${board.id}`;
  await page.goto(boardPath, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(VIEWPORT);
  return { boardPath, parent };
}

const zoomLevel = async (page: Page) =>
  Number((await page.getByTitle("Reset zoom to 100%").locator("visible=true").first().textContent())!.replace("%", ""));

/** Fit the board, then ctrl+wheel toward the given node's top-left corner until the zoom reaches `target`. */
async function fitAndZoom(page: Page, title: string, target: number) {
  await page.getByRole("button", { name: "Fit to screen" }).locator("visible=true").first().dispatchEvent("click");
  await page.waitForTimeout(400);
  const vp = (await page.locator(VIEWPORT).boundingBox())!;
  // From 768 up the tool rail sits on the left (about 60px); below it moves to the bottom.
  const left = vp.x + (page.viewportSize()!.width >= 768 ? 72 : 8);
  for (let i = 0; i < 24 && (await zoomLevel(page)) < target; i += 1) {
    const box = (await nodeCard(page, title).boundingBox())!;
    await page.mouse.move(Math.max(box.x + 2, left), Math.max(box.y + 2, vp.y + 4));
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -60);
    await page.keyboard.up("Control");
    await page.waitForTimeout(80);
  }
  // Pan (plain wheel) so the node's top-left corner sits just inside the canvas.
  await page.waitForTimeout(300);
  const box = (await nodeCard(page, title).boundingBox())!;
  await page.mouse.move(vp.x + vp.width / 2, vp.y + vp.height / 2);
  await page.mouse.wheel(box.x - left, box.y - (vp.y + 8));
  await page.waitForTimeout(500);
}

// Item ids by title, read once at 1440: below ~35% zoom a node renders as a blank placeholder (no title text).
const ids = new Map<string, string>();
const nodeCard = (page: Page, title: string) =>
  ids.has(title)
    ? page.locator(`${VIEWPORT} [data-canvas-item="${ids.get(title)}"]`).first()
    : page.locator(`${VIEWPORT} [data-canvas-item]`).filter({ hasText: title }).first();

/** Screenshot a node card by clipping the page (an element screenshot would scroll the canvas). */
async function shotCard(page: Page, title: string, file: string) {
  const b = (await nodeCard(page, title).boundingBox())!;
  const v = page.viewportSize()!;
  const x = Math.max(0, b.x - 4);
  const y = Math.max(0, b.y - 4);
  await page.screenshot({ path: file, clip: { x, y, width: Math.min(v.width, b.x + b.width + 4) - x, height: Math.min(v.height, b.y + b.height + 4) - y } });
}

const scan = (page: Page) =>
  page.evaluate(() => {
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
    // The filter row must stay inside its node card (no control past the card's right or bottom edge).
    for (const row of document.querySelectorAll('[role="group"][aria-label="Filters"]')) {
      const card = row.closest("[data-canvas-item]");
      if (!card) continue;
      const c = card.getBoundingClientRect();
      for (const ctl of row.children) {
        const r = ctl.getBoundingClientRect();
        if (r.right > c.right + 1 || r.bottom > c.bottom + 1) out.push(`filter-control-outside-card "${(ctl.textContent || ctl.getAttribute("aria-label") || "").trim().slice(0, 30)}"`);
      }
    }
    return out;
  });

test("kanban and timeline filter row: stress data, empty result, no overflow", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  const dir = path.resolve(process.env.PLANNING_CANVAS_SHOTS_DIR ?? path.join("test-results", "planning-canvas-filters"));
  fs.mkdirSync(dir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const { boardPath, parent } = await seed(page);

  await expect(page.locator(`${VIEWPORT} ${FILTERS}`)).toHaveCount(4);
  const card = (title: string) => nodeCard(page, title);
  const row = (title: string) => card(title).locator(FILTERS);
  for (const title of ["Kanban stress", "Kanban normal", "Timeline stress", "Timeline normal"]) {
    ids.set(title, (await card(title).getAttribute("data-canvas-item"))!);
  }
  const stressKanban = row("Kanban stress");
  await expect(stressKanban.getByLabel("Filter by project").locator("option:checked")).toHaveText(LONG_PROJECT);
  await expect(stressKanban.getByRole("button", { name: "Filter by status" })).toHaveText("Status (5)");
  await expect(stressKanban.getByRole("button", { name: "Clear parent filter" })).toContainText(parent.identifier);
  await expect(stressKanban.getByLabel("Filter by assignee").locator("option:checked")).toHaveText(LONG_AGENT);
  await expect(stressKanban.getByLabel("Filter by goal").locator("option:checked")).toHaveText(LONG_GOAL);
  await expect(card("Kanban stress")).toContainText("0 issues");
  await expect(card("Timeline stress")).toContainText("0 issues");
  await expect(row("Timeline stress").getByRole("button", { name: "Filter by status" })).toHaveText("Status (5)");

  await page.getByRole("button", { name: "Dismiss announcement" }).click({ timeout: 3000 }).catch(() => undefined);
  let hits = 0;
  const check = async (label: string) => {
    const found = await scan(page);
    expect(await page.locator(`${VIEWPORT} ${FILTERS}`).count(), `filter rows rendered ${label}`).toBeGreaterThan(0);
    hits += found.length;
    console.log(`OVERFLOW ${label}: ${found.length} hit(s) ${found.join(" | ")}`);
  };
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    await page.waitForTimeout(600);
    // Same test-only workaround as the typed-nodes spec: at 390 the page shell gives the canvas 0 height.
    if (width === 390) await page.addStyleTag({ content: `${VIEWPORT}{min-height:520px}` });
    await fitAndZoom(page, "Kanban stress", width >= 1024 ? 70 : 45); // above LOD_ZOOM (0.4), where nodes render in full
    await check(`@${width}`);
    const shots = width === 1440 || width === 390;
    if (shots) await page.screenshot({ path: path.join(dir, `filters-board-${width}.png`) });
    if (width === 1440) {
      for (const [title, name] of [["Kanban stress", "kanban-stress"], ["Timeline stress", "timeline-stress"], ["Kanban normal", "kanban-normal"], ["Timeline normal", "timeline-normal"]] as const) {
        await shotCard(page, title, path.join(dir, `filters-${name}-${width}.png`));
      }
    }
    // Each stress node at 100% zoom, as a reader sees it.
    for (const [title, name] of [["Kanban stress", "kanban-stress"], ["Timeline stress", "timeline-stress"]] as const) {
      await fitAndZoom(page, title, 100);
      await check(`@${width} ${name} 100%`);
      if (shots) await page.screenshot({ path: path.join(dir, `filters-${name}-100pct-${width}.png`) });
    }
    if (!shots) continue;
    // Status popover open on the stress kanban.
    await fitAndZoom(page, "Kanban stress", 100);
    const statusButton = stressKanban.getByRole("button", { name: "Filter by status" });
    if (width === 390) {
      // On a phone the 640-wide node is wider than the screen: pan the status button into view.
      const b = (await statusButton.boundingBox())!;
      await page.mouse.wheel(b.x - 120, 0);
      await page.waitForTimeout(300);
    }
    await statusButton.dispatchEvent("click");
    await expect(stressKanban.getByRole("checkbox")).toHaveCount(7);
    await check(`@${width} status-open`);
    await page.screenshot({ path: path.join(dir, `filters-status-open-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(stressKanban.getByRole("checkbox")).toHaveCount(0);
  }
  console.log(`OVERFLOW-CHECK: ${hits === 0 ? "PASS (0 hits)" : `FAIL (${hits} hits)`} widths ${WIDTHS.join("/")} board ${boardPath}`);

  const script = process.env.OVERFLOW_CHECK_SCRIPT;
  if (script) {
    let out = "";
    try {
      out = execFileSync("node", [script, "--base", baseURL!, "--paths", boardPath, "--out", path.join(dir, "overflow")], { encoding: "utf8", cwd: path.resolve(".") });
    } catch (e) {
      out = String((e as { stdout?: string }).stdout ?? e);
    }
    fs.writeFileSync(path.join(dir, "overflow-check.txt"), out);
    console.log(out.split("\n").filter((l) => l.includes("OVERFLOW-CHECK")).join("\n"));
    expect(out).toContain("OVERFLOW-CHECK: PASS (0 hits)");
  }
  expect(hits).toBe(0);
});
