/**
 * Generate on a board card (PAR-14281): the worker's real `estimate`, `generate` and `board-generation` actions through
 * the harness, and the card's own logic (board-generate.ts). Postgres behaviour is in board-generation.pg.spec.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { inputKeysOf, utcDayStart } from "../src/board-generation.js";
import { STUDIO_ACCESS_TABLE } from "../src/access-table.js";
import { STUDIO_GENERATE_CARD, STUDIO_MEDIA_CARD, STUDIO_PLUGIN_KEY } from "../src/plugin-key.js";
import {
  BOARD_MODELS, estimateFromReply, GENERATE_CARD_SIZE, inputCandidates, newGenerateCardOp, outputNodeOp, propsFromSettings, queueStateFromReply, resolveInputs, saveSettingsOp, settingsFromProps, type BoardNode,
} from "../src/ui/board-generate.js";

const CO = "b2600000-0000-4000-8000-000000000001";
const MEMBER = "b2600000-0000-4000-8000-000000000011";
const VIEWER = "b2600000-0000-4000-8000-000000000012";
const MODEL = BOARD_MODELS.find((m) => m.kind === "image" && m.minRefs === 0)!.id;

beforeAll(() => {
  process.env.PIB_STUDIO_FAKE_PROVIDER = "1";
});
afterAll(() => {
  delete process.env.PIB_STUDIO_FAKE_PROVIDER;
});

async function studio(boards: Record<string, unknown> | "throws", opts: { usedToday?: number; genRow?: Record<string, unknown> } = {}) {
  const at = new Date().toISOString();
  const member = (userId: string, role: string) => ({ id: `m-${userId}`, companyId: CO, principalType: "user" as const, principalId: userId, status: "active" as const, membershipRole: role, grants: [], createdAt: at, updatedAt: at });
  const harness = createTestHarness({ manifest, config: { r2: { accountId: "acct", bucket: "pib-private", accessKeyId: "AK", secretAccessKey: { type: "secret_ref", secretId: "sec-1" } }, ...(boards === "throws" ? {} : { boards }) } });
  harness.seed({ accessMembers: [member(MEMBER, "member"), member(VIEWER, "viewer")] });
  const db = harness.ctx.db as { namespace: string; query: (sql: string, params?: unknown[]) => Promise<unknown[]>; execute: (sql: string, params?: unknown[]) => Promise<{ rowCount: number }> };
  db.namespace = "plugin_studio_test";
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  db.query = async (sql, params = []) => {
    if (/SELECT COUNT\(\*\) AS n FROM \S+\.generations/.test(sql)) return [{ n: opts.usedToday ?? 0 }];
    if (/credit_limits/.test(sql)) return [{ scope_key: "company", monthly_credits: 100, updated_by: MEMBER, updated_at: at }];
    if (/FROM \S+\.generations WHERE company_id = \$1 AND id = \$2/.test(sql)) return opts.genRow && params[1] === opts.genRow.id ? [opts.genRow] : [];
    return [];
  };
  db.execute = async (sql, params = []) => {
    writes.push({ sql, params });
    return { rowCount: 1 };
  };
  await plugin.definition.setup(harness.ctx);
  if (boards === "throws") vi.spyOn(harness.ctx.config, "get").mockRejectedValue(new Error("settings store down"));
  const as = (userId: string) => ({ companyId: CO, actor: { type: "user" as const, userId, onBehalfOfUserId: userId, onBehalfOfRestricted: false } });
  return { harness, writes, as };
}

const card = { model: MODEL, prompt: "a lighthouse at dusk", boardScope: { projectId: null }, inputKeys: ["node-a"] };
const refused = (code: string) => expect.objectContaining({ ok: false, refused: true, code });

describe("board generation through the worker's actions", () => {
  it("a member's click queues a board row with the person and the inputs, charged to own work on a company board", async () => {
    const { harness, writes, as } = await studio({ generate: true });
    expect(await harness.performAction("estimate", card, as(MEMBER))).toMatchObject({ creditsTotal: expect.any(Number), dailyLimit: 20, usedToday: 0, client: null });
    const out = await harness.performAction("generate", card, as(MEMBER));
    expect(out).toMatchObject({ status: "queued", client: null });
    const insert = writes.find((w) => /INSERT INTO \S+\.generations/.test(w.sql))!;
    expect(insert.params.slice(-3)).toEqual(["board", MEMBER, JSON.stringify(["node-a"])]);
  });

  it("a viewer cannot estimate or generate", async () => {
    const { harness, writes, as } = await studio({ generate: true });
    expect(await harness.performAction("estimate", card, as(VIEWER))).toEqual(refused("forbidden"));
    expect(await harness.performAction("generate", card, as(VIEWER))).toEqual(refused("forbidden"));
    expect(writes).toEqual([]);
  });

  it("the switch off (the default) and a throwing settings read refuse with board_generation_off", async () => {
    for (const boards of [{}, { generate: false }, "throws"] as const) {
      const { harness, writes, as } = await studio(boards);
      expect(await harness.performAction("generate", card, as(MEMBER)), JSON.stringify(boards)).toEqual(refused("board_generation_off"));
      expect(writes).toEqual([]);
    }
  });

  it("at the daily limit the click is refused with its own code and nothing is written", async () => {
    const { harness, writes, as } = await studio({ generate: true, boardGenerationDailyLimit: 3 }, { usedToday: 3 });
    expect(await harness.performAction("generate", card, as(MEMBER))).toEqual(refused("board_daily_limit"));
    expect(writes).toEqual([]);
  });

  it("a client picked by hand, and a malformed board scope, are refused", async () => {
    const { harness, as } = await studio({ generate: true });
    expect(await harness.performAction("generate", { ...card, client: "company:acme" }, as(MEMBER))).toEqual(refused("bad_board_scope"));
    expect(await harness.performAction("generate", { ...card, boardScope: "x" }, as(MEMBER))).toEqual(refused("bad_board_scope"));
  });

  it("an output card sees its own generation's state and nothing of another board's", async () => {
    const own = { id: "gen-1", status: "submitted", asset_id: null, client_kind: null, client_ref: null, error_message: null, model: MODEL };
    const { harness, as } = await studio({ generate: true }, { genRow: own });
    expect(await harness.performAction("board-generation", { boardScope: { projectId: null }, generationId: "gen-1" }, as(MEMBER))).toEqual({ id: "gen-1", status: "submitted", assetId: null, model: MODEL, error: null });
    const client = { ...own, client_kind: "company", client_ref: "acme" };
    const other = await studio({ generate: true }, { genRow: client });
    expect(await other.harness.performAction("board-generation", { boardScope: { projectId: null }, generationId: "gen-1" }, other.as(MEMBER))).toEqual(refused("wrong_board"));
  });

  it("the new action and slot are registered", () => {
    expect(STUDIO_ACCESS_TABLE["board-generation"]).toBeDefined();
    expect(manifest.ui?.slots?.find((s) => s.id === STUDIO_GENERATE_CARD)).toMatchObject({ type: "canvasNode", exportName: "StudioGenerateCard" });
  });
});

describe("board generation helpers", () => {
  it("inputKeysOf keeps at most 8 unique keys and refuses anything else", () => {
    expect(inputKeysOf(undefined)).toEqual([]);
    expect(inputKeysOf(["a", " a ", "b"])).toEqual(["a", "b"]);
    expect(() => inputKeysOf("a")).toThrow(/list/);
    expect(() => inputKeysOf([""])).toThrow(/node key/);
    expect(() => inputKeysOf(Array.from({ length: 9 }, (_, i) => `k${i}`))).toThrow(/at most 8/);
  });

  it("the day starts at midnight UTC", () => {
    expect(utcDayStart(Date.parse("2026-11-25T23:59:59+02:00"))).toBe("2026-11-25T00:00:00.000Z");
    expect(utcDayStart(Date.parse("2026-11-26T01:00:00+02:00"))).toBe("2026-11-25T00:00:00.000Z");
  });
});

describe("the generate card's logic", () => {
  const media = (key: string, assetId: string | null, extra: Partial<BoardNode> = {}): BoardNode => ({ key, kind: "embed", data: { title: key, data: { plugin: STUDIO_PLUGIN_KEY, type: STUDIO_MEDIA_CARD, assetId } }, ...extra });
  const items: BoardNode[] = [
    { key: "gen", kind: "embed", data: { x: 100, y: 50, width: 360, data: { plugin: STUDIO_PLUGIN_KEY, type: STUDIO_GENERATE_CARD } } },
    media("m1", "asset-1"),
    media("m2", null),
    media("m3", "asset-3", { deletedAt: "2026-11-25T00:00:00Z" }),
    { key: "sticky", kind: "sticky", data: { title: "note" } },
    { key: "arrow", kind: null, data: {} },
  ];

  it("settings round-trip through flat props, and bad props fall back", () => {
    const s = settingsFromProps({ prompt: "p", kind: "video", model: "nope", inputKeys: JSON.stringify(["a", "b"]) });
    expect(s.kind).toBe("video");
    expect(BOARD_MODELS.find((m) => m.id === s.model)?.kind).toBe("video");
    expect(settingsFromProps(propsFromSettings(s))).toEqual(s);
    expect(settingsFromProps({ inputKeys: "{not json" }).inputKeys).toEqual([]);
    expect(settingsFromProps(undefined)).toMatchObject({ prompt: "", kind: "image", inputKeys: [], lastGenerationId: null });
    expect(new TextEncoder().encode(JSON.stringify(propsFromSettings({ ...s, prompt: "x".repeat(5000), inputKeys: Array.from({ length: 8 }, () => "k".repeat(100)) }))).length).toBeLessThanOrEqual(2048);
  });

  it("only live Studio media cards with a file can be inputs; arrows and other nodes never are", () => {
    expect(inputCandidates(items, "gen")).toEqual([{ key: "m1", title: "m1", assetId: "asset-1" }]);
    expect(resolveInputs(items, "gen", ["m1", "m2", "arrow"])).toEqual({ assetIds: ["asset-1"], missing: ["m2", "arrow"] });
  });

  it("the output is its own studio-media card next to the generate card; settings save on the card's own node", () => {
    const op = outputNodeOp({ generationId: "gen-123", title: "t", kind: "image", at: { x: 500, y: 50 } });
    expect(op.item.data).toEqual({ plugin: STUDIO_PLUGIN_KEY, type: STUDIO_MEDIA_CARD, props: { generationId: "gen-123" } });
    expect(op.item.data).not.toHaveProperty("assetId");
    expect(saveSettingsOp("gen", settingsFromProps({}))).toMatchObject({ op: "update", key: "gen", set: { data: { plugin: STUDIO_PLUGIN_KEY, type: STUDIO_GENERATE_CARD } } });
  });

  it("\"Add generate card\" places one empty generate embed node with default props (PAR-14817)", () => {
    const op = newGenerateCardOp({ x: 80, y: 112 }, "gen-new");
    const first = BOARD_MODELS.find((m) => m.kind === "image")?.id ?? "";
    expect(op).toEqual({
      op: "add",
      item: {
        itemType: "node", key: "gen-new", kind: "embed", x: 80, y: 112, width: GENERATE_CARD_SIZE.width, height: GENERATE_CARD_SIZE.height, zIndex: 1, color: "slate",
        title: "Generate with Studio", content: "",
        data: { plugin: STUDIO_PLUGIN_KEY, type: STUDIO_GENERATE_CARD, props: { prompt: "", kind: "image", model: first, inputKeys: "[]" } },
      },
    });
    expect(op.item.data).not.toHaveProperty("assetId");
    // The card reads its props back as the defaults, with no inputs and no last generation.
    expect(settingsFromProps(op.item.data.props)).toEqual({ prompt: "", kind: "image", model: first, inputKeys: [], lastGenerationId: null });
    expect(newGenerateCardOp({ x: 0, y: 0 }).item.key).toMatch(/^studio-generate-[a-z0-9]+$/);
    expect(newGenerateCardOp({ x: 0, y: 0 }).item.key).not.toBe(newGenerateCardOp({ x: 0, y: 0 }).item.key);
  });

  it("reads the estimate's payer and the queue states", () => {
    expect(estimateFromReply({ creditsTotal: 2, dailyLimit: 20, usedToday: 3, client: { kind: "company", id: "acme" }, clientName: "Acme" })).toEqual({ creditsTotal: 2, dailyLimit: 20, usedToday: 3, payer: "Acme", client: "company:acme" });
    expect(estimateFromReply({ creditsTotal: 1, client: null }).payer).toBe("Own work");
    expect(queueStateFromReply({ status: "storing" }).status).toBe("running");
    expect(queueStateFromReply({ status: "succeeded", assetId: "a" })).toEqual({ status: "succeeded", assetId: "a", error: null });
  });
});
