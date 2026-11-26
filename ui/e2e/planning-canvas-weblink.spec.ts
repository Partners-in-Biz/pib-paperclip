import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { buildPlanningCanvasSeed } from "./planning-canvas-seed";

/**
 * Web link and YouTube cards on a real board (PAR-14425, plan PAR-14389 E D1b). Run:
 *   npx playwright test --config tests/e2e/playwright-planning-canvas-weblink.config.ts --workers=1
 * Seed "weblink-stress": nodes written through the ops route (not the paste UI), hostile forms,
 * a spoofing preview, long host and title. Writes 1440 and 390 screenshots to PLANNING_CANVAS_SHOTS_DIR.
 */
const VIEWPORT = '[data-testid="planning-canvas-viewport"]';
const WIDTHS = [1440, 1280, 1024, 768, 390];
const ID = "dQw4w9WgXcQ";
const NOCOOKIE = `https://www.youtube-nocookie.com/embed/${ID}`;
const YOUTUBE = /youtube|youtu\.be|ytimg|googlevideo|ggpht/i;
const LONG_HOST = "a-very-long-subdomain-name-for-stress-testing.example-company-with-a-long-name.co.za";

const node = (key: string, x: number, y: number, width: number, height: number, data: unknown) => ({
  op: "add",
  item: { itemType: "node", key, kind: "weblink", x, y, width, height, zIndex: 10, color: "slate", title: "", content: "", data },
});
const STORED = [
  node("yt-watch", 0, 0, 400, 300, { url: `https://www.youtube.com/watch?v=${ID}`, preview: { title: "A very long video title that keeps going well past the width of the card to test clamping", description: "", siteName: "YouTube", fetchedAt: "2026-11-26T00:00:00Z" } }),
  node("yt-embed", 440, 0, 400, 300, { url: `https://www.youtube.com/embed/${ID}?autoplay=1&mute=1&origin=https://evil.test` }),
  node("spoof", 880, 0, 300, 180, { url: "https://evil.test/login", preview: { title: "<b>accounts.google.com</b> Sign in", description: "<img src=x onerror=\"window.__pwned=1\"> Sign in to continue to your Google account and keep reading this long text", siteName: "Google", fetchedAt: "2026-11-26T00:00:00Z" } }),
  node("long-host", 0, 340, 300, 132, { url: `https://${LONG_HOST}/a/very/long/path/that/never/ends?with=query&and=more` }),
  node("plain", 340, 340, 300, 132, { url: "https://example.com" }),
  node("lookalike", 680, 340, 300, 132, { url: `https://youtube.com.evil.test/watch?v=${ID}` }),
  node("host-in-path", 0, 520, 300, 132, { url: `https://evil.test/youtube.com/watch?v=${ID}` }),
  node("port", 340, 520, 300, 132, { url: `https://www.youtube.com:8443/watch?v=${ID}` }),
  node("extra-char", 680, 520, 300, 132, { url: `https://www.youtube.com/watch?v=${ID}x` }),
];
const REFUSED = [`http://www.youtube.com/watch?v=${ID}`, `javascript:alert(1)//https://www.youtube.com/watch?v=${ID}`, `https://user@www.youtube.com/watch?v=${ID}`];

async function seed(page: Page) {
  const company = await (await page.request.post("/api/companies", { data: { name: `Canvas Weblink ${Date.now()}` } })).json();
  const created = await (await page.request.post(`/api/companies/${company.id}/planning-canvases`, {
    data: { title: "Web link board", description: "", data: buildPlanningCanvasSeed({ nodes: 1 }) },
  })).json();
  const ops = `/api/companies/${company.id}/planning-canvases/${created.id}/ops`;
  const res = await page.request.post(ops, { data: { ops: STORED, clientBatchId: `seed-${Date.now()}` } });
  expect(res.ok(), await res.text()).toBe(true);
  for (const [i, url] of REFUSED.entries()) {
    const refused = await page.request.post(ops, { data: { ops: [node(`refused-${i}`, 0, 900, 300, 132, { url })], clientBatchId: `refused-${i}-${Date.now()}` } });
    expect(refused.status(), url).toBe(400);
  }
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

async function pasteText(page: Page, text: string) {
  await page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    const target = (document.activeElement as HTMLElement | null) ?? document.body;
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

test("web link cards: no YouTube before the click, exact frame URL, real host, paste and URL field", async ({ page, context }) => {
  test.setTimeout(180_000);
  const dir = process.env.PLANNING_CANVAS_SHOTS_DIR ?? path.join("test-results", "planning-canvas-weblink");
  fs.mkdirSync(dir, { recursive: true });
  const youtubeRequests: string[] = [];
  page.on("request", (req) => { if (YOUTUBE.test(new URL(req.url()).hostname)) youtubeRequests.push(req.url()); });
  // Nothing leaves the test box: YouTube answers with an empty page.
  await context.route((url) => YOUTUBE.test(url.hostname), (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>stub</title>" }));

  await page.setViewportSize({ width: 1440, height: 900 });
  const { company, boardId } = await seed(page);
  await page.goto(`/${company.issuePrefix}/planning-canvas`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(VIEWPORT);
  await fitAndZoom(page);
  await expect(page.locator(`${VIEWPORT} [data-weblink-host]`).first()).toBeVisible();
  await page.waitForTimeout(1500);

  // Before any click: no frame and not one request to YouTube.
  expect(await page.locator(`${VIEWPORT} iframe`).count()).toBe(0);
  expect(youtubeRequests).toEqual([]);
  // Only the two real YouTube forms get a player; every look-alike is a plain link card.
  await expect(page.getByRole("button", { name: "Play video" })).toHaveCount(2);
  const hosts = await page.locator(`${VIEWPORT} [data-weblink-host]`).evaluateAll((els) => els.map((e) => e.getAttribute("data-weblink-host")));
  expect(hosts.sort()).toEqual([LONG_HOST, "evil.test", "evil.test", "example.com", "www.youtube.com", "www.youtube.com", "www.youtube.com", "www.youtube.com", "youtube.com.evil.test"].sort());
  // The spoofing preview: host of url shown, preview HTML is text, nothing ran.
  const spoof = page.locator(`${VIEWPORT} [data-canvas-item="spoof"]`);
  await expect(spoof.locator("[data-weblink-host] span")).toHaveText("evil.test");
  await expect(spoof).toContainText("<b>accounts.google.com</b> Sign in");
  expect(await page.locator(`${VIEWPORT} b, ${VIEWPORT} img, ${VIEWPORT} [onerror]`).count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  const open = spoof.getByRole("link", { name: "Open" });
  await expect(open).toHaveAttribute("href", "https://evil.test/login");
  await expect(open).toHaveAttribute("target", "_blank");
  await expect(open).toHaveAttribute("rel", "noopener noreferrer");

  await page.screenshot({ path: path.join(dir, "weblink-1440-before-play.png") });

  // Click play on both players: each frame is exactly the nocookie embed of the id.
  for (let i = 0; i < 2; i += 1) await page.getByRole("button", { name: "Play video" }).first().click();
  const frames = page.locator(`${VIEWPORT} iframe`);
  await expect(frames).toHaveCount(2);
  for (const src of await frames.evaluateAll((els) => els.map((e) => e.getAttribute("src")))) expect(src).toBe(NOCOOKIE);
  await expect(frames.first()).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation allow-popups");
  await expect.poll(() => youtubeRequests.length).toBeGreaterThan(0);
  expect(youtubeRequests.every((u) => u === NOCOOKIE)).toBe(true);

  // Pan the cards out of the window: the players are removed.
  await page.evaluate(() => {
    const vp = document.querySelector('[data-testid="planning-canvas-viewport"]')!;
    vp.dispatchEvent(new WheelEvent("wheel", { deltaX: 0, deltaY: 6000, bubbles: true, cancelable: true }));
  });
  await expect(frames).toHaveCount(0);
  await fitAndZoom(page);

  const weblinkCount = async () => {
    const read = await (await page.request.get(`/api/companies/${company.id}/planning-canvases/${boardId}`)).json();
    return read.items.filter((i: { kind?: string; deletedAt?: string | null }) => i.kind === "weblink" && !i.deletedAt).length;
  };
  expect(await weblinkCount()).toBe(STORED.length);

  // Paste with nothing focused: one https link becomes a card; http gets the message.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await pasteText(page, "https://example.org/pasted");
  await expect.poll(weblinkCount).toBe(STORED.length + 1);
  await pasteText(page, "http://example.org/plain");
  await expect(page.getByText("Only https links can be cards")).toBeVisible();

  // Tool-rail URL field: paste into the field is the field's own; http shows the message; https adds a card.
  await page.getByRole("button", { name: "Add web link" }).click();
  const field = page.getByRole("dialog", { name: "Add web link" });
  const input = field.getByRole("textbox");
  await input.focus();
  await pasteText(page, "https://example.org/into-field");
  await input.fill("http://example.org/x");
  await field.getByRole("button", { name: "Add" }).click();
  await expect(field.getByRole("alert")).toHaveText("Only https links can be cards");
  await page.screenshot({ path: path.join(dir, "weblink-1440-field-error.png") });
  await input.fill(`https://youtu.be/${ID}`);
  await input.press("Enter");
  await expect(field).toHaveCount(0);
  await expect.poll(weblinkCount).toBe(STORED.length + 2);

  // Overflow check (same rules as overflow-check.mjs, scoped to the board) at five widths.
  let hits = 0;
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    await page.waitForTimeout(600);
    // Same test-only workaround as the typed-nodes spec: at 390 the shell gives the viewport 0 height.
    if (width === 390) await page.addStyleTag({ content: `${VIEWPORT}{min-height:520px}` });
    await page.getByRole("button", { name: "Close", exact: true }).first().click({ timeout: 500 }).catch(() => undefined);
    await fitAndZoom(page);
    const inView = await page.evaluate(() => {
      const vp = { w: window.innerWidth, h: window.innerHeight };
      return [...document.querySelectorAll('[data-testid="planning-canvas-viewport"] [data-weblink-host]')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < vp.w && r.top < vp.h;
      }).length;
    });
    console.log(`NODES-IN-VIEW @${width}: weblink=${inView}`);
    expect(inView).toBeGreaterThan(0);
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
    if (width === 1440 || width === 390) await page.screenshot({ path: path.join(dir, `weblink-${width}.png`) });
    if (width === 390) {
      // The URL field as a bottom sheet over the rail at 390, with its error state.
      await page.getByRole("button", { name: "Add web link" }).dispatchEvent("click");
      await page.getByRole("dialog", { name: "Add web link" }).getByRole("textbox").fill("http://example.org/a-long-plain-http-link-that-is-refused");
      await page.getByRole("dialog", { name: "Add web link" }).getByRole("button", { name: "Add" }).dispatchEvent("click");
      await expect(page.getByRole("dialog", { name: "Add web link" }).getByRole("alert")).toBeVisible();
      const de = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      console.log(`FIELD @390: page ${de[0]}/${de[1]}`);
      expect(de[0]).toBeLessThanOrEqual(de[1]);
      await page.screenshot({ path: path.join(dir, "weblink-390-field-error.png") });
    }
  }
  console.log(`OVERFLOW-CHECK: ${hits === 0 ? "PASS (0 hits)" : `FAIL (${hits} hits)`} widths ${WIDTHS.join("/")} pages 1`);
  expect(hits).toBe(0);
});
