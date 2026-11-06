import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { archiveCanvas, createCanvas, getCanvas } from "../src/canvas.js";
import { briefDoc } from "../src/canvas-brief.js";
import { configureShareDir, createShare, isShareId, listShares, refreshShares, renderSharePage, revokeShare, type Signer } from "../src/canvas-share.js";
import { STUDIO_TOOLS } from "../src/tools.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const CO = "11111111-1111-4111-8111-111111111111";
const OTHER_CO = "22222222-2222-4222-8222-222222222222";
const AGENT = { agentId: "agent-1" };
const USER = { userId: "owner-1" };
/** The fake storage provider: hands out obviously fake signed links and records each one. */
const signed: string[] = [];
const fakeSigner: Signer = async (companyId, assetId) => {
  signed.push(assetId);
  return `https://fake-r2.test/${companyId}/${assetId}?X-Amz-Expires=600`;
};

describe("briefDoc", () => {
  it("wires every prompt to its own image or video card and every reference to all of them", () => {
    const doc = briefDoc({ prompts: [{ text: "a fox", label: "Fox" }, { text: "a slow pan", kind: "video", ratio: "9:16" }], assetIds: ["a1", "a1", "a2"] });
    expect(doc.nodes.map((n) => `${n.id}:${n.type}`)).toEqual(["p1:prompt", "m1:image", "p2:prompt", "m2:video", "s1:source", "s2:source"]);
    expect(doc.nodes.find((n) => n.id === "m2")!.data).toEqual({ label: "Video 2", ratio: "9:16" });
    expect(doc.edges.map((e) => `${e.source}>${e.target}`)).toEqual(["p1>m1", "p2>m2", "s1>m1", "s1>m2", "s2>m1", "s2>m2"]);
  });

  it("refuses an empty, oversized or malformed brief", () => {
    expect(() => briefDoc({ prompts: [] })).toThrow(/prompts is required/);
    expect(() => briefDoc({ prompts: [{ text: " " }] })).toThrow(/Prompt 1 has no text/);
    expect(() => briefDoc({ prompts: [{ text: "x", kind: "song" }] })).toThrow(/kind must be/);
    expect(() => briefDoc({ prompts: Array(13).fill("x") })).toThrow(/at most 12/);
    expect(() => briefDoc({ prompts: ["x"], assetIds: "a1" })).toThrow(/assetIds/);
  });

  it("is declared as an agent tool that takes no spending fields", () => {
    const tool = STUDIO_TOOLS.find((t) => t.name === "canvas-create-from-brief")!;
    const props = Object.keys((tool.parametersSchema as { properties: object }).properties);
    expect(props).toEqual(["title", "prompts", "assetIds", "projectId", "client", "issueId"]);
    expect(tool.description).toMatch(/never generates or spends/);
  });
});

describe("renderSharePage", () => {
  it("escapes card text and has no script, form or editing control", () => {
    const html = renderSharePage({
      title: "<b>Launch</b>",
      doc: { nodes: [{ id: "p", type: "prompt", position: { x: 0, y: 0 }, data: { text: "</p><script>alert(1)</script>" } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
      previews: {},
      expiresAt: "2026-11-13T10:00:00.000Z",
    });
    expect(html).toContain("&lt;b&gt;Launch&lt;/b&gt;");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/<script|<form|<button|<input|<textarea/i);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("link expires Fri, 13 Nov 2026 10:00 UTC");
  });
});

const available = await embeddedAvailable();
let pg: Pg;

beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);

afterAll(async () => {
  if (available) await pg.stop();
  configureShareDir(undefined);
});

describe.skipIf(!available)("Studio canvas brief and share links against real Postgres", () => {
  let ctx: PluginContext;
  let dir: string;
  beforeEach(async () => {
    await pg.reset();
    signed.length = 0;
    dir = mkdtempSync(join(tmpdir(), "studio-share-"));
    configureShareDir(dir);
    ctx = {
      db: pg.db,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
      projects: { get: async (id: string) => (id === "project-own" ? { id, archivedAt: null } : null) },
    } as unknown as PluginContext;
  });

  async function addAsset(id: string, companyId: string, kind = "image") {
    await pg.db.execute(`INSERT INTO ${pg.db.namespace}.assets (id, company_id, name, kind, source) VALUES ($1, $2, 'x.png', $3, 'upload')`, [id, companyId, kind]);
  }

  async function briefBoard() {
    await addAsset("ref-1", CO);
    pg.statements.length = 0;
    const doc = briefDoc({ prompts: [{ text: "a fox <in> a field" }, { text: "pan", kind: "video" }], assetIds: ["ref-1"] });
    return createCanvas(ctx, CO, { title: "Fox launch", projectId: "project-own", doc }, AGENT);
  }

  it("a brief becomes a saved board a person can open, and nothing is generated or charged", async () => {
    const made = await briefBoard();
    expect(made).toMatchObject({ title: "Fox launch", cards: 5, revision: 1, projectId: "project-own" });
    const open = await getCanvas(ctx, CO, made.id);
    expect(open.doc.edges).toHaveLength(4);
    const writes = pg.statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s));
    expect(writes.every((s) => /\.canvases\b/.test(s))).toBe(true);
    await addAsset("other-co", OTHER_CO);
    await expect(createCanvas(ctx, CO, { title: "x", doc: briefDoc({ prompts: ["x"], assetIds: ["other-co"] }) }, AGENT)).rejects.toThrow(/not in this company/);
  });

  it("a share link publishes a read-only page with short preview links, and revoking deletes it", async () => {
    const board = await briefBoard();
    const share = await createShare(ctx, CO, { canvasId: board.id }, USER, fakeSigner);
    expect(isShareId(share.id)).toBe(true);
    expect(share.path).toBe(`s/${share.id}.html`);
    const file = join(dir, `${share.id}.html`);
    const html = readFileSync(file, "utf8");
    expect(html).toContain("Fox launch");
    expect(html).toContain("a fox &lt;in&gt; a field");
    expect(html).toContain(`https://fake-r2.test/${CO}/ref-1?X-Amz-Expires=600`);
    expect(html).not.toMatch(/<script|<button|<input/i);
    expect(signed).toEqual(["ref-1"]);
    expect(await listShares(ctx, CO, board.id)).toHaveLength(1);
    await expect(revokeShare(ctx, OTHER_CO, { shareId: share.id })).rejects.toThrow(/not found/);

    await revokeShare(ctx, CO, { shareId: share.id });
    expect(existsSync(file)).toBe(false);
    expect(await listShares(ctx, CO, board.id)).toEqual([]);
    await refreshShares(ctx, fakeSigner);
    expect(existsSync(file)).toBe(false);
  });

  it("a revoke that lands while the job is writing the page still takes the page down", async () => {
    const board = await briefBoard();
    const share = await createShare(ctx, CO, { canvasId: board.id }, USER, fakeSigner);
    const file = join(dir, `${share.id}.html`);
    rmSync(file);
    // The job reads the share as live, then the revoke runs (and deletes nothing) while it signs previews.
    const revokingSigner = async (companyId: string, assetId: string) => {
      await revokeShare(ctx, CO, { shareId: share.id });
      return fakeSigner(companyId, assetId);
    };
    expect(await refreshShares(ctx, revokingSigner)).toEqual({ written: 0, removed: 0 });
    expect(existsSync(file)).toBe(false);
  });

  it("the job rewrites missing pages and deletes expired, archived and stray ones", async () => {
    const board = await briefBoard();
    const keep = await createShare(ctx, CO, { canvasId: board.id }, USER, fakeSigner);
    const old = await createShare(ctx, CO, { canvasId: board.id, days: 1 }, USER, fakeSigner);
    await pg.db.execute(`UPDATE ${pg.db.namespace}.canvas_shares SET expires_at = now() - interval '1 minute' WHERE id = $1`, [old.id]);
    rmSync(join(dir, `${keep.id}.html`));
    writeFileSync(join(dir, "abcdefghijklmnopqrstuvwx.html"), "stray");
    expect(await refreshShares(ctx, fakeSigner)).toEqual({ written: 1, removed: 2 });
    expect(readdirSync(dir)).toEqual([`${keep.id}.html`]);

    await archiveCanvas(ctx, CO, board.id);
    await refreshShares(ctx, fakeSigner);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a bad lifetime and another company's canvas", async () => {
    const board = await briefBoard();
    await expect(createShare(ctx, CO, { canvasId: board.id, days: 31 }, USER, fakeSigner)).rejects.toThrow(/1 to 30 days/);
    await expect(createShare(ctx, OTHER_CO, { canvasId: board.id }, USER, fakeSigner)).rejects.toThrow(/not found/);
  });
});
