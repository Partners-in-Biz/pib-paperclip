import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createCanvas, getCanvas, saveCanvas } from "../src/canvas.js";
import { addComment, listComments, listVersions, restoreVersion, saveVersion } from "../src/canvas-versions.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const CO = "11111111-1111-4111-8111-111111111111";
const OTHER_CO = "22222222-2222-4222-8222-222222222222";
const USER = { userId: "owner-1" };

const available = await embeddedAvailable();
let pg: Pg;

beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);

afterAll(async () => {
  if (available) await pg.stop();
});

function makeCtx(): PluginContext {
  return {
    db: pg.db,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    projects: { get: async () => null },
  } as unknown as PluginContext;
}

const first = {
  nodes: [
    { id: "p", type: "prompt", position: { x: 0, y: 0 }, data: { text: "a fox in a field" } },
    { id: "i", type: "image", position: { x: 300, y: 0 }, data: { prompt: "make it dusk" } },
  ],
  edges: [{ id: "e1", source: "p", target: "i" }],
  viewport: { x: 0, y: 0, zoom: 1 },
};
const second = { nodes: [{ id: "q", type: "prompt", position: { x: 10, y: 10 }, data: { text: "something else" } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };

describe.skipIf(!available)("Canvas versions and card comments against real Postgres", () => {
  let ctx: PluginContext;
  beforeEach(async () => {
    await pg.reset();
    ctx = makeCtx();
  });

  it("saves a version, changes the board, and restoring gives the first board back", async () => {
    const made = await createCanvas(ctx, CO, { title: "Versions" }, USER);
    await saveCanvas(ctx, CO, { canvasId: made.id, baseRevision: 1, doc: first }, USER);
    const firstBoard = (await getCanvas(ctx, CO, made.id)).doc;
    const v = await saveVersion(ctx, CO, { canvasId: made.id, name: "  Before the change " }, USER);
    expect(v).toMatchObject({ name: "Before the change", revision: 2, cards: 2 });
    await saveCanvas(ctx, CO, { canvasId: made.id, baseRevision: 2, doc: second }, USER);
    expect((await getCanvas(ctx, CO, made.id)).doc.nodes.map((n) => n.id)).toEqual(["q"]);

    const out = await restoreVersion(ctx, CO, { canvasId: made.id, versionId: v.id, baseRevision: 3 }, USER);
    expect(out.revision).toBe(4);
    const back = await getCanvas(ctx, CO, made.id);
    expect(back.doc).toEqual(firstBoard);
    expect(back.revision).toBe(4);
    expect((await listVersions(ctx, CO, made.id)).map((x) => [x.name, x.revision, x.cards])).toEqual([["Before the change", 2, 2]]);
  });

  it("restore keeps the revision lock: a stale restore is refused", async () => {
    const made = await createCanvas(ctx, CO, { title: "Lock" }, USER);
    const v = await saveVersion(ctx, CO, { canvasId: made.id, name: "Empty" }, USER);
    await saveCanvas(ctx, CO, { canvasId: made.id, baseRevision: 1, doc: first }, USER);
    await expect(restoreVersion(ctx, CO, { canvasId: made.id, versionId: v.id, baseRevision: 1 }, USER)).rejects.toThrow(/since you opened it/);
    expect((await getCanvas(ctx, CO, made.id)).doc.nodes).toHaveLength(2);
  });

  it("keeps comments on a card, also after the card is removed and brought back", async () => {
    const made = await createCanvas(ctx, CO, { title: "Comments" }, USER);
    await saveCanvas(ctx, CO, { canvasId: made.id, baseRevision: 1, doc: first }, USER);
    const v = await saveVersion(ctx, CO, { canvasId: made.id, name: "With image" }, USER);
    await addComment(ctx, CO, { canvasId: made.id, cardId: "i", body: "Warmer light please" }, USER);
    await addComment(ctx, CO, { canvasId: made.id, cardId: "i", body: "Better" }, { userId: "member-2" });
    await addComment(ctx, CO, { canvasId: made.id, cardId: "p", body: "Other card" }, USER);
    await expect(addComment(ctx, CO, { canvasId: made.id, cardId: "nope", body: "x" }, USER)).rejects.toThrow(/not on the saved canvas/);
    await expect(addComment(ctx, CO, { canvasId: made.id, cardId: "i", body: "   " }, USER)).rejects.toThrow(/Write a comment/);

    // "Reload": a fresh read returns the thread, oldest first, with author and revision.
    const thread = await listComments(ctx, CO, made.id, "i");
    expect(thread.map((c) => [c.body, c.authorUserId, c.revision])).toEqual([["Warmer light please", "owner-1", 2], ["Better", "member-2", 2]]);
    expect(thread[0].createdAt).toBeTruthy();

    await saveCanvas(ctx, CO, { canvasId: made.id, baseRevision: 2, doc: second }, USER);
    expect(await listComments(ctx, CO, made.id, "i")).toHaveLength(2);
    await restoreVersion(ctx, CO, { canvasId: made.id, versionId: v.id, baseRevision: 3 }, USER);
    expect((await listComments(ctx, CO, made.id, "i")).map((c) => c.body)).toEqual(["Warmer light please", "Better"]);
  });

  it("keeps companies and canvases apart", async () => {
    const a = await createCanvas(ctx, CO, { title: "A", doc: first }, USER);
    const b = await createCanvas(ctx, CO, { title: "B", doc: first }, USER);
    const v = await saveVersion(ctx, CO, { canvasId: a.id, name: "A1" }, USER);
    await addComment(ctx, CO, { canvasId: a.id, cardId: "i", body: "on A" }, USER);
    expect(await listComments(ctx, CO, b.id, "i")).toEqual([]);
    expect(await listVersions(ctx, CO, b.id)).toEqual([]);
    await expect(restoreVersion(ctx, CO, { canvasId: b.id, versionId: v.id, baseRevision: 1 }, USER)).rejects.toThrow(/version was not found/);
    await expect(listVersions(ctx, OTHER_CO, a.id)).rejects.toThrow(/not found/);
    await expect(listComments(ctx, OTHER_CO, a.id, "i")).rejects.toThrow(/not found/);
    await expect(restoreVersion(ctx, OTHER_CO, { canvasId: a.id, versionId: v.id, baseRevision: 1 }, USER)).rejects.toThrow(/version was not found/);
    await expect(addComment(ctx, OTHER_CO, { canvasId: a.id, cardId: "i", body: "x" }, USER)).rejects.toThrow(/not found/);
    await expect(saveVersion(ctx, CO, { canvasId: a.id, name: "" }, USER)).rejects.toThrow(/version name/);
  });
});
