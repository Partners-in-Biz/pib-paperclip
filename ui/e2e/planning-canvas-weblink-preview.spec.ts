import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { buildPlanningCanvasSeed } from "./planning-canvas-seed";

/**
 * "Get preview" on web link cards (PAR-14426, plan PAR-14389 E D3). Run:
 *   npx playwright test --config tests/e2e/playwright-planning-canvas-weblink-preview.config.ts --workers=1
 * The throwaway server runs with `PLANNING_CANVAS_UNFURL` unset (off, the release state), so the
 * first click gets the real "off" answer. The other states are mocked at the browser (`page.route`)
 * so nothing leaves the test box; the saved preview goes through the real ops route.
 * Seed "weblink-preview-stress": a long host, a long preview, an empty card and a YouTube card.
 */
const VIEWPORT = '[data-testid="planning-canvas-viewport"]';
const WIDTHS = [1440, 1280, 1024, 768, 390];
const LONG_HOST = "a-very-long-subdomain-name-for-stress-testing.example-company-with-a-long-name.co.za";
const LONG_PREVIEW = {
  title: "<b>A preview title</b> that is far too long for the card and keeps going past two lines of text on purpose",
  description: "A description long enough to wrap over more than three lines of the card, so the clamp is visible in the screenshot at every width we check here.",
  siteName: "Example",
  fetchedAt: "2026-11-26T00:00:00.000Z",
};

const node = (key: string, x: number, y: number, width: number, height: number, data: unknown) => ({
  op: "add",
  item: { itemType: "node", key, kind: "weblink", x, y, width, height, zIndex: 10, color: "slate", title: "", content: "", data },
});
const STORED = [
  node("off", 0, 0, 300, 132, { url: "https://example.com/off" }),
  node("saved", 340, 0, 300, 132, { url: "https://example.com/saved" }),
  node("empty", 680, 0, 300, 132, { url: "https://example.org/no-preview" }),
  node("busy", 0, 180, 300, 132, { url: `https://${LONG_HOST}/a/very/long/path?with=query` }),
  node("video", 340, 180, 300, 200, { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
];

async function seed(page: Page) {
  const company = await (await page.request.post("/api/companies", { data: { name: `Canvas Preview ${Date.now()}` } })).json();
  const created = await (await page.request.post(`/api/companies/${company.id}/planning-canvases`, {
    data: { title: "Preview board", description: "", data: buildPlanningCanvasSeed({ nodes: 1 }) },
  })).json();
  const res = await page.request.post(`/api/companies/${company.id}/planning-canvases/${created.id}/ops`, { data: { ops: STORED, clientBatchId: `seed-${Date.now()}` } });
  expect(res.ok(), await res.text()).toBe(true);
  await page.addInitScript((id) => localStorage.setItem("paperclip.selectedCompanyId", id), company.id);
  return { company, boardId: created.id as string };
}

async function fitAndZoom(page: Page) {
  await page.getByRole("button", { name: "Fit to screen" }).locator("visible=true").first().dispatchEvent("click");
  await page.waitForTimeout(400);
  const vpBox = (await page.locator(VIEWPORT).boundingBox())!;
  const zoomPercent = async () => Number((await page.getByTitle("Reset zoom to 100%").locator("visible=true").first().textContent())!.replace("%", ""));
  for (let i = 0; i < 12 && (await zoomPercent()) < 40; i += 1) {
    await page.mouse.move(vpBox.x + vpBox.width / 2, vpBox.y + vpBox.height / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -100);
    await page.keyboard.up("Control");
    await page.waitForTimeout(80);
  }
}

test("Get preview: real off answer, mocked preview saved through ops, no preview, rate limit", async ({ page }) => {
  test.setTimeout(180_000);
  const dir = process.env.PLANNING_CANVAS_SHOTS_DIR ?? path.join("test-results", "planning-canvas-weblink-preview");
  fs.mkdirSync(dir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const { company, boardId } = await seed(page);
  const card = (key: string) => page.locator(`${VIEWPORT} [data-canvas-item="${key}"]`);
  const unfurlBodies: unknown[] = [];

  await page.goto(`/${company.issuePrefix}/planning-canvas`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(VIEWPORT);
  await fitAndZoom(page);
  await expect(card("off").getByRole("button", { name: "Get preview" })).toBeVisible();
  await expect(card("video").getByRole("button", { name: "Get preview" })).toHaveCount(0);

  // The release state: the switch is off on the server, so the real answer hides the button.
  await card("off").getByRole("button", { name: "Get preview" }).click();
  await expect(card("off").getByTestId("weblink-preview-notice")).toHaveText("Link previews are switched off.");
  await expect(card("off").getByRole("button", { name: "Get preview" })).toHaveCount(0);

  // Mocked server answers by node; the request body carries only the node key.
  await page.route("**/planning-canvases/*/unfurl", async (route) => {
    const body = route.request().postDataJSON() as { nodeId: string };
    unfurlBodies.push(body);
    if (body.nodeId === "saved") return route.fulfill({ json: { preview: LONG_PREVIEW } });
    if (body.nodeId === "empty") return route.fulfill({ json: { preview: null } });
    return route.fulfill({ status: 429, json: { error: "Too many link previews; try again later", code: "canvas_unfurl_rate_limited" } });
  });
  await card("saved").getByRole("button", { name: "Get preview" }).click();
  await expect(card("saved")).toContainText(LONG_PREVIEW.title);
  await card("empty").getByRole("button", { name: "Get preview" }).click();
  await expect(card("empty").getByTestId("weblink-preview-notice")).toHaveText("No preview for this link.");
  await card("busy").getByRole("button", { name: "Get preview" }).click();
  await expect(card("busy").getByTestId("weblink-preview-notice")).toHaveText("Too many previews this hour. Try again later.");
  expect(unfurlBodies).toEqual([{ nodeId: "saved" }, { nodeId: "empty" }, { nodeId: "busy" }]);
  // Preview HTML is text; the host shown is still the host of the url.
  expect(await page.locator(`${VIEWPORT} b`).count()).toBe(0);
  await expect(card("saved").locator("[data-weblink-host] span")).toHaveText("example.com");

  // The browser saved the answer through the ops route: the server has it on the node.
  await expect.poll(async () => {
    const read = await (await page.request.get(`/api/companies/${company.id}/planning-canvases/${boardId}`)).json();
    return read.items.find((i: { key: string }) => i.key === "saved")?.data?.preview?.title ?? null;
  }).toBe(LONG_PREVIEW.title);

  let hits = 0;
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    await page.waitForTimeout(600);
    // Same test-only workaround as the typed-nodes spec: at 390 the shell gives the viewport 0 height.
    if (width === 390) await page.addStyleTag({ content: `${VIEWPORT}{min-height:520px}` });
    await page.getByRole("button", { name: "Close", exact: true }).first().click({ timeout: 500 }).catch(() => undefined);
    await fitAndZoom(page);
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
    if (width === 1440 || width === 390) await page.screenshot({ path: path.join(dir, `weblink-preview-${width}.png`) });
  }
  console.log(`OVERFLOW-CHECK: ${hits === 0 ? "PASS (0 hits)" : `FAIL (${hits} hits)`} widths ${WIDTHS.join("/")} pages 1`);
  expect(hits).toBe(0);
});
