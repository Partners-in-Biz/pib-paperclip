import { expect, test, type Page } from "@playwright/test";

/**
 * Planning Canvas op store (PAR-13934, plan PAR-13925 B.3, B.4, F).
 * Run: pnpm test:e2e:planning-canvas-ops   (builds the UI, boots a throwaway server)
 */
const VIEWPORT = '[data-testid="planning-canvas-viewport"]';
/** Node elements; the realtime overlay (C15) is a tagged sibling. */
const NODES = `${VIEWPORT} > div > div:not([data-testid])`;
const SAVE_STATE = '[data-testid="planning-canvas-save-state"]';

type Board = { companyId: string; issuePrefix: string; boardId: string };

async function seedBoard(page: Page): Promise<Board> {
  const company = await (await page.request.post("/api/companies", { data: { name: `Canvas Ops ${Date.now()}` } })).json();
  const created = await page.request.post(`/api/companies/${company.id}/planning-canvases`, {
    data: {
      title: "Ops board",
      description: "",
      data: {
        nodes: [{ id: "n1", kind: "sticky", x: 80, y: 80, width: 260, height: 180, zIndex: 2, color: "yellow", title: "Start", content: "Start body" }],
        connectors: [],
        strokes: [],
        viewport: { x: 40, y: 40, zoom: 1 },
      },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  return { companyId: company.id, issuePrefix: company.issuePrefix, boardId: (await created.json()).id };
}

async function openBoard(page: Page, board: Board) {
  await page.addInitScript((id) => localStorage.setItem("paperclip.selectedCompanyId", id), board.companyId);
  await page.goto(`/${board.issuePrefix}/planning-canvas`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(NODES)).toHaveCount(1);
  await expect(page.locator(SAVE_STATE)).toHaveAttribute("data-state", "saved");
}

async function editNode(page: Page) {
  const node = page.locator(NODES).first();
  await node.dblclick({ position: { x: 30, y: 30 } });
  return node;
}

async function serverNode(page: Page, board: Board) {
  const read = await (await page.request.get(`/api/companies/${board.companyId}/planning-canvases/${board.boardId}`)).json();
  return read.items.find((item: { key: string }) => item.key === "n1").data as { title: string; content: string };
}

test("two tabs edit different fields of one node and both survive", async ({ context, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const board = await seedBoard(page);
  const tabOne = page;
  const tabTwo = await context.newPage();
  await tabTwo.setViewportSize({ width: 1440, height: 900 });
  await openBoard(tabOne, board);
  await openBoard(tabTwo, board);

  await editNode(tabOne);
  await tabOne.getByPlaceholder("Title…").fill("Title from tab one");
  await editNode(tabTwo);
  await tabTwo.getByPlaceholder("Write idea…").fill("Body from tab two");

  await expect(tabOne.locator(SAVE_STATE)).toHaveAttribute("data-state", "saved");
  await expect(tabTwo.locator(SAVE_STATE)).toHaveAttribute("data-state", "saved");
  await expect(tabTwo.getByTestId("planning-canvas-conflict")).toHaveCount(0);
  await expect.poll(() => serverNode(page, board)).toEqual(expect.objectContaining({ title: "Title from tab one", content: "Body from tab two" }));

  for (const tab of [tabOne, tabTwo]) {
    await tab.reload({ waitUntil: "domcontentloaded" });
    const node = tab.locator(NODES).first();
    await expect(node).toContainText("Title from tab one");
    await expect(node).toContainText("Body from tab two");
  }
});

test("a lost response is retried with the same clientBatchId and does not conflict with itself", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const board = await seedBoard(page);
  const batchIds: string[] = [];
  let dropped = false;
  await page.route("**/planning-canvases/*/ops", async (route) => {
    batchIds.push(route.request().postDataJSON().clientBatchId);
    if (dropped) return route.continue();
    dropped = true;
    await route.fetch(); // the server applies the batch...
    await route.abort("connectionreset"); // ...and the response never arrives
  });
  await openBoard(page, board);

  await editNode(page);
  await page.getByPlaceholder("Write idea…").fill("Typed while the network dropped");
  await expect(page.locator(SAVE_STATE)).toHaveAttribute("data-state", "offline");
  await expect(page.locator(SAVE_STATE)).toHaveText("Offline, retrying");
  await expect(page.locator(SAVE_STATE)).toHaveAttribute("data-state", "saved", { timeout: 10_000 });

  expect(batchIds.length).toBeGreaterThanOrEqual(2);
  expect(batchIds[1]).toBe(batchIds[0]);
  await expect(page.getByTestId("planning-canvas-conflict")).toHaveCount(0);
  expect((await serverNode(page, board)).content).toBe("Typed while the network dropped");
});

test("a conflict on the same text keeps my text with Keep mine, Keep theirs and Copy to new node", async ({ context, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const board = await seedBoard(page);
  // No board socket (C15) here, so this tab edits before it hears of the other change.
  await page.routeWebSocket(/\/planning-canvases\/[^/]+\/ws$/, (ws) => ws.close());
  await openBoard(page, board);

  // Someone else changes the body after this tab loaded.
  const other = await context.request.post(`/api/companies/${board.companyId}/planning-canvases/${board.boardId}/ops`, {
    data: { ops: [{ op: "update", key: "n1", baseVersion: 1, set: { content: "Their body" } }] },
  });
  expect(other.ok(), await other.text()).toBe(true);

  await editNode(page);
  await page.getByPlaceholder("Write idea…").fill("My body, typed with care");
  const panel = page.getByTestId("planning-canvas-conflict");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("planning-canvas-conflict-mine")).toHaveText("My body, typed with care");
  await expect(panel.getByRole("button", { name: "Keep theirs" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Copy to new node" })).toBeVisible();
  await panel.getByRole("button", { name: "Keep mine" }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator(SAVE_STATE)).toHaveAttribute("data-state", "saved");
  await expect.poll(async () => (await serverNode(page, board)).content).toBe("My body, typed with care");
});
