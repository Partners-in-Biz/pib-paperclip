import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { archiveCanvas, createCanvas, getCanvas, listCanvases, saveCanvas } from "../src/canvas.js";
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
    state: { get: async () => null, set: async () => undefined, delete: async () => undefined },
    projects: { get: async (id: string) => (id === "project-own" ? { id, archivedAt: null } : null) },
  } as unknown as PluginContext;
}

async function addAsset(id: string, companyId: string, client: { kind: string; id: string } | null) {
  await pg.db.execute(
    `INSERT INTO ${pg.db.namespace}.assets (id, company_id, client_kind, client_ref, name, kind, source) VALUES ($1, $2, $3, $4, 'x.png', 'image', 'upload')`,
    [id, companyId, client?.kind ?? null, client?.id ?? null],
  );
}

const board = (assetId?: string) => ({
  nodes: [
    { id: "s", type: "source", position: { x: 0, y: 0 }, data: assetId ? { assetId } : {} },
    { id: "p", type: "prompt", position: { x: 0, y: 120 }, data: { text: "a fox in a field" } },
    { id: "i", type: "image", position: { x: 300, y: 60 }, data: { prompt: "make them meet" } },
  ],
  edges: [
    { id: "e1", source: "s", target: "i" },
    { id: "e2", source: "p", target: "i" },
  ],
  viewport: { x: 0, y: 0, zoom: 1 },
});

describe.skipIf(!available)("Studio canvases against real Postgres", () => {
  let ctx: PluginContext;
  beforeEach(async () => {
    await pg.reset();
    ctx = makeCtx();
  });

  it("creates, saves and reopens the same board", async () => {
    await addAsset("asset-own", CO, null);
    const made = await createCanvas(ctx, CO, { title: "Launch ideas", projectId: "project-own" }, USER);
    expect(made).toMatchObject({ title: "Launch ideas", revision: 1, cards: 0, client: null, projectId: "project-own" });
    const saved = await saveCanvas(ctx, CO, { canvasId: made.id, baseRevision: 1, doc: board("asset-own") }, USER);
    expect(saved.revision).toBe(2);
    const open = await getCanvas(ctx, CO, made.id);
    expect(open.doc.nodes.map((n) => n.id)).toEqual(["s", "p", "i"]);
    expect(open.doc.edges).toHaveLength(2);
    expect(open.cards).toBe(3);
    expect((await listCanvases(ctx, CO, {})).map((c) => c.id)).toEqual([made.id]);
    expect(await listCanvases(ctx, CO, { client: "own" })).toHaveLength(1);
    expect(await listCanvases(ctx, CO, { client: "company:acme" })).toHaveLength(0);
  });

  it("refuses a save from an older revision, so a second tab can't overwrite the first", async () => {
    const made = await createCanvas(ctx, CO, { title: "Two tabs" }, USER);
    await saveCanvas(ctx, CO, { canvasId: made.id, baseRevision: 1, doc: board() }, USER);
    await expect(saveCanvas(ctx, CO, { canvasId: made.id, baseRevision: 1, doc: { nodes: [], edges: [] } }, USER)).rejects.toThrow(/since you opened it \(now revision 2\)/);
    expect((await getCanvas(ctx, CO, made.id)).doc.nodes).toHaveLength(3);
    const both = await Promise.allSettled([1, 2].map(() => saveCanvas(ctx, CO, { canvasId: made.id, baseRevision: 2, doc: board() }, USER)));
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("keeps companies and clients apart", async () => {
    await addAsset("asset-acme", CO, { kind: "company", id: "acme" });
    await addAsset("asset-other-co", OTHER_CO, null);
    const made = await createCanvas(ctx, CO, { title: "Own work" }, USER);
    await expect(saveCanvas(ctx, CO, { canvasId: made.id, baseRevision: 1, doc: board("asset-acme") }, USER)).rejects.toThrow(/another client/);
    await expect(saveCanvas(ctx, CO, { canvasId: made.id, baseRevision: 1, doc: board("asset-other-co") }, USER)).rejects.toThrow(/not in this company/);
    await expect(getCanvas(ctx, OTHER_CO, made.id)).rejects.toThrow(/not found/);
    await expect(saveCanvas(ctx, OTHER_CO, { canvasId: made.id, baseRevision: 1, doc: board() }, USER)).rejects.toThrow(/not found/);
    await expect(createCanvas(ctx, CO, { title: "x", projectId: "project-elsewhere" }, USER)).rejects.toThrow(/Project project-elsewhere/);
    await expect(createCanvas(ctx, CO, { title: "  " }, USER)).rejects.toThrow(/name/);
  });

  it("archives a canvas out of the list", async () => {
    const made = await createCanvas(ctx, CO, { title: "Old" }, USER);
    await archiveCanvas(ctx, CO, made.id);
    expect(await listCanvases(ctx, CO, {})).toHaveLength(0);
    await expect(getCanvas(ctx, CO, made.id)).rejects.toThrow(/not found/);
  });
});
