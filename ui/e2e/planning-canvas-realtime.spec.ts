import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

/**
 * Planning Canvas realtime UI (PAR-13942, plan PAR-13925 section E).
 * Run: pnpm test:e2e:planning-canvas-realtime   (builds the UI, boots a throwaway server)
 */
const VIEWPORT = '[data-testid="planning-canvas-viewport"]';
const NODES = `${VIEWPORT} > div > div:not([data-testid])`;
const SAVE_STATE = '[data-testid="planning-canvas-save-state"]';
const LIVE_STATE = '[data-testid="planning-canvas-live-state"]';

type Board = { companyId: string; issuePrefix: string; boardId: string };

async function seedBoard(request: APIRequestContext): Promise<Board> {
  const company = await (await request.post("/api/companies", { data: { name: `Canvas Realtime ${Date.now()}` } })).json();
  const created = await request.post(`/api/companies/${company.id}/planning-canvases`, {
    data: {
      title: "Realtime board",
      description: "",
      data: {
        nodes: [
          { id: "n1", kind: "sticky", x: 80, y: 80, width: 260, height: 180, zIndex: 2, color: "yellow", title: "Start", content: "Start body" },
          { id: "n2", kind: "sticky", x: 420, y: 80, width: 260, height: 180, zIndex: 3, color: "blue", title: "Second", content: "Second body" },
        ],
        connectors: [],
        strokes: [],
        viewport: { x: 40, y: 40, zoom: 1 },
      },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  return { companyId: company.id, issuePrefix: company.issuePrefix, boardId: (await created.json()).id };
}

const boardUrl = (board: Board) => `/api/companies/${board.companyId}/planning-canvases/${board.boardId}`;

async function item(request: APIRequestContext, board: Board, key: string) {
  const read = await (await request.get(boardUrl(board))).json();
  return read.items.find((row: { key: string }) => row.key === key) as { version: number; data: Record<string, unknown> };
}

async function update(request: APIRequestContext, board: Board, key: string, set: Record<string, unknown>, headers?: Record<string, string>) {
  const { version } = await item(request, board, key);
  const res = await request.post(`${boardUrl(board)}/ops`, { data: { ops: [{ op: "update", key, baseVersion: version, set }] }, headers });
  expect(res.ok(), await res.text()).toBe(true);
}

async function openBoard(page: Page, board: Board) {
  await page.addInitScript((id) => localStorage.setItem("paperclip.selectedCompanyId", id), board.companyId);
  await page.goto(`/${board.issuePrefix}/planning-canvas`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(NODES)).toHaveCount(2);
  await expect(page.locator(SAVE_STATE)).toHaveAttribute("data-state", "saved");
  await expect(page.locator(LIVE_STATE)).toHaveAttribute("data-state", "live");
}

async function twoBrowsers(browser: Browser, board: Board) {
  const pages: Page[] = [];
  for (let i = 0; i < 2; i += 1) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await openBoard(page, board);
    pages.push(page);
  }
  return pages as [Page, Page];
}

test("two browsers see each other's cursor and selection; presence goes out at no more than 20 Hz", async ({ browser, request }) => {
  const board = await seedBoard(request);
  const [one, two] = await twoBrowsers(browser, board);
  await expect(one.getByTestId("planning-canvas-avatar")).toHaveCount(1);
  await expect(two.getByTestId("planning-canvas-avatar")).toHaveCount(1);

  const frames: number[] = [];
  const cdp = await one.context().newCDPSession(one);
  await cdp.send("Network.enable");
  cdp.on("Network.webSocketFrameSent", (event) => {
    if (event.response.payloadData.includes('"type":"presence"')) frames.push(Date.now());
  });

  const box = (await one.locator(VIEWPORT).boundingBox())!;
  const started = Date.now();
  for (let i = 0; i < 120; i += 1) {
    await one.mouse.move(box.x + 300 + (i % 40) * 5, box.y + 400 + (i % 7) * 3);
    await one.waitForTimeout(8);
  }
  const elapsed = Date.now() - started;
  await expect(two.getByTestId("planning-canvas-remote-cursor")).toHaveCount(1);
  await one.waitForTimeout(200);
  const perSecond = frames.length / ((elapsed + 200) / 1000);
  console.log(`presence frames: ${frames.length} in ${elapsed + 200} ms (${perSecond.toFixed(1)}/s)`);
  expect(perSecond).toBeLessThanOrEqual(21);

  // A click selects n2 in browser one; browser two shows it as a coloured ring.
  await one.locator(NODES).nth(1).click({ position: { x: 20, y: 20 } });
  await expect(two.getByTestId("planning-canvas-remote-selection")).toHaveCount(1);
});

test("a remote op applies without a reload; a truncated ops.applied triggers a since fetch", async ({ browser, request }) => {
  const board = await seedBoard(request);
  const [one, two] = await twoBrowsers(browser, board);
  void one;
  let fullReads = 0;
  two.on("request", (req) => {
    if (req.url().endsWith(boardUrl(board))) fullReads += 1;
  });

  await update(request, board, "n1", { title: "Changed elsewhere" });
  await expect(two.locator(NODES).first()).toContainText("Changed elsewhere");

  const sinceFetch = two.waitForRequest((req) => req.url().includes(`${boardUrl(board)}?since=`));
  // Two 18,000-character bodies in one batch: the hub's message is over 32 KB, so it goes out truncated.
  const ops = [];
  for (const key of ["n1", "n2"]) ops.push({ op: "update", key, baseVersion: (await item(request, board, key)).version, set: { content: "x".repeat(18_000) } });
  const res = await request.post(`${boardUrl(board)}/ops`, { data: { ops } });
  expect(res.ok(), await res.text()).toBe(true);
  await sinceFetch;
  await expect.poll(async () => (await two.locator(NODES).nth(1).textContent())?.length ?? 0).toBeGreaterThan(18_000);
  expect(fullReads).toBe(0);
});

test("reconnect catches up with since", async ({ browser, request }) => {
  const board = await seedBoard(request);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  let first = true;
  let dropFirst: (() => Promise<void>) | null = null;
  await page.routeWebSocket(/\/planning-canvases\/[^/]+\/ws$/, (ws) => {
    const server = ws.connectToServer();
    if (first) {
      first = false;
      dropFirst = async () => {
        await server.close();
        await ws.close({ code: 1006 }).catch(() => ws.close());
      };
    }
  });
  await openBoard(page, board);
  await dropFirst!();
  await expect(page.locator(LIVE_STATE)).toHaveAttribute("data-state", "reconnecting");
  await expect(page.locator(LIVE_STATE)).toHaveText("Reconnecting…");
  await update(request, board, "n1", { title: "Missed while offline" });
  const since = page.waitForRequest((req) => req.url().includes(`${boardUrl(board)}?since=`));
  await expect(page.locator(LIVE_STATE)).toHaveAttribute("data-state", "live", { timeout: 15_000 });
  await since;
  await expect(page.locator(NODES).first()).toContainText("Missed while offline");
});

test("access.revoked closes the board with a message", async ({ browser, request }) => {
  const board = await seedBoard(request);
  const [, two] = await twoBrowsers(browser, board);
  const res = await request.delete(boardUrl(board));
  expect(res.ok(), await res.text()).toBe(true);
  const notice = two.getByTestId("planning-canvas-access-revoked");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("You no longer have access to this board");
  await two.screenshot({ path: test.info().outputPath("revoked-1440.png") });
  await notice.getByRole("button", { name: "Back to boards" }).click();
  await expect(notice).toHaveCount(0);
});

test("agent edits flash the changed node with the agent's name for 2 s", async ({ browser, request }) => {
  const board = await seedBoard(request);
  const sharing = await request.patch(`${boardUrl(board)}/sharing`, { data: { scope: "company", memberAccess: "edit" } });
  expect(sharing.ok(), await sharing.text()).toBe(true);
  const hire = await (
    await request.post(`/api/companies/${board.companyId}/agent-hires`, {
      data: { name: "Planner Bot", role: "engineer", title: "Planner", adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", ""] } },
    })
  ).json();
  if (hire.approval) await request.post(`/api/approvals/${hire.approval.id}/approve`, { data: { decisionNote: "e2e" } });
  const key = await (await request.post(`/api/agents/${hire.agent.id}/keys`, { data: { name: "canvas-e2e" } })).json();

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await openBoard(page, board);
  await update(request, board, "n2", { title: "Written by the agent" }, { Authorization: `Bearer ${key.token}` });
  const flash = page.getByTestId("planning-canvas-agent-flash");
  await expect(flash).toHaveCount(1);
  await expect(flash).toHaveAttribute("data-node-id", "n2");
  await expect(flash).toContainText("Planner Bot");
  await expect(page.locator(NODES).nth(1)).toContainText("Written by the agent");
  // No ghost presence: the agent never shows as a cursor or avatar.
  await expect(page.getByTestId("planning-canvas-remote-cursor")).toHaveCount(0);
  await expect(page.getByTestId("planning-canvas-avatar")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("agent-flash-1440.png") });
  await expect(flash).toHaveCount(0, { timeout: 4000 });
});
