/**
 * Studio media on Planning Canvas boards: the board-scope check (PAR-14280; plan PAR-14257 C "Interfaces", E "S1, 3",
 * G.1, G.2). Runs the real action handlers through the harness. A project board maps to its project's client; a
 * project without a client, a company board and a personal board map to own work only.
 */
import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { accessCompanyScope, accessGrantScope, MEMBER_RESTRICTED, permissionKey, PERMISSION_DENIED } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import { BOARD_CARDS_OFF, WRONG_BOARD } from "../src/board-scope.js";
import plugin from "../src/worker.js";

const CO = "a1600000-0000-4000-8000-000000000001";
const MEMBER = "a1600000-0000-4000-8000-000000000013";
const RESTRICTED = "a1600000-0000-4000-8000-000000000014";
const OUTSIDER = "a1600000-0000-4000-8000-000000000015";
const AGENT = "a1600000-0000-4000-8000-000000000021";
const CLIENT_A = "a1600000-0000-4000-8000-0000000000ca";
const CLIENT_B = "a1600000-0000-4000-8000-0000000000cb";
const PROJECT_A = "project-a";
const PROJECT_B = "project-b";
const PROJECT_NO_CLIENT = "project-own";

// The CRM link from a project to its client, as scope.ts reads it.
vi.mock("../src/scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/scope.js")>()),
  clientOfProject: async (_ctx: unknown, _co: string, projectId: string | null) =>
    projectId === PROJECT_A ? { kind: "company", id: CLIENT_A, name: "Acme" } : projectId === PROJECT_B ? { kind: "company", id: CLIENT_B, name: "Globex" } : null,
}));

const row = (id: string, client: string | null, status = "draft") => ({
  id, company_id: CO, client_kind: client ? "company" : null, client_ref: client, client_name: client === CLIENT_A ? "Acme" : client ? "Globex" : null,
  project_id: null, name: `${id}.png`, kind: "image", alt_text: null, status, source: "generated", generation_id: null,
  current_version: 1, created_at: new Date().toISOString(), r2_key: `studio/${CO}/${client ?? "own"}/${id}/v1.png`, mime: "image/png", bytes: 10,
  gen_prompt: null, gen_model: null, gen_credits: null,
});
const ROWS = [row("a-asset", CLIENT_A), row("b-asset", CLIENT_B), row("own-asset", null), row("own-archived", null, "archived"), row("a-archived", CLIENT_A, "archived")];

async function studio(opts: { cards?: boolean; accessMode?: "enforce" } = {}) {
  const at = new Date().toISOString();
  const member = (userId: string) => ({ id: `m-${userId}`, companyId: CO, principalType: "user" as const, principalId: userId, status: "active" as const, membershipRole: "member", grants: [], createdAt: at, updatedAt: at });
  const harness = createTestHarness({
    manifest,
    config: {
      r2: { accountId: "acct", bucket: "pib-private", accessKeyId: "AK", secretAccessKey: { type: "secret_ref", secretId: "sec-1" } },
      ...(opts.cards === undefined ? {} : { boards: { cards: opts.cards } }),
    },
  });
  harness.seed({ accessMembers: [member(MEMBER), member(RESTRICTED), member(OUTSIDER)] });
  const db = harness.ctx.db as { namespace: string; query: (sql: string, params?: unknown[]) => Promise<unknown[]> };
  db.namespace = "plugin_studio_test";
  db.query = async (sql, params = []) => {
    if (/FROM \S+\.assets a JOIN/.test(sql) && /a\.id = \$2/.test(sql)) return ROWS.filter((r) => r.id === params[1]);
    if (/FROM \S+\.assets a JOIN/.test(sql)) {
      // listAssets: the exact-scope filter of listWhere.
      if (/a\.client_ref IS NULL/.test(sql)) return ROWS.filter((r) => r.client_ref === null);
      if (/a\.client_kind = \$2 AND a\.client_ref = \$3/.test(sql)) return ROWS.filter((r) => r.client_kind === params[1] && r.client_ref === params[2]);
      return ROWS;
    }
    return [];
  };
  await plugin.definition.setup(harness.ctx);
  if (opts.accessMode) {
    await harness.ctx.state.set(accessCompanyScope(CO), { mode: opts.accessMode, rev: 1, userIds: [MEMBER], receivedAt: at });
    // The positive control: MEMBER holds Studio's view grant, OUTSIDER holds none.
    await harness.ctx.state.set(accessGrantScope(CO, MEMBER), { allow: [permissionKey("studio.work", "view")], scopeOverrides: { "studio.work": "all" } });
  }
  const as = (userId: string, restricted = false) => ({ companyId: CO, actor: { type: "user" as const, userId, onBehalfOfUserId: userId, onBehalfOfRestricted: restricted } });
  return { harness, as };
}

const refused = (code: string) => expect.objectContaining({ ok: false, refused: true, code });
type Batch = { urls: Record<string, string>; refused?: string[]; removed?: string[]; withheld?: string[]; assets?: Record<string, { name: string; kind: string }> };
const board = (projectId: string | null) => ({ boardScope: { projectId } });

describe("Studio cards on boards: the board-scope check (PAR-14280)", () => {
  it("client A's file on client B's project board is refused on sign; on A's board it is shown", async () => {
    const { harness, as } = await studio();
    const act = (key: string, params: Record<string, unknown>) => harness.performAction(key, params, as(MEMBER));
    expect(await act("asset-url", { assetId: "a-asset", ...board(PROJECT_B) })).toEqual(refused(WRONG_BOARD));
    const onB = (await act("asset-urls", { assetIds: ["a-asset", "b-asset"], ...board(PROJECT_B) })) as Batch;
    expect(Object.keys(onB.urls)).toEqual(["b-asset"]);
    expect(onB.refused).toEqual(["a-asset"]);

    expect(await act("asset-url", { assetId: "a-asset", ...board(PROJECT_A) })).toEqual({ url: expect.stringContaining("/a-asset/") });
    const onA = (await act("asset-urls", { assetIds: ["a-asset"], ...board(PROJECT_A) })) as Batch;
    expect(onA.urls["a-asset"]).toContain("/a-asset/");
    expect(onA.assets?.["a-asset"]).toEqual({ name: "a-asset.png", kind: "image", mime: "image/png", altText: null });
    expect(onA.refused).toEqual([]);
  });

  it("company and personal boards (no project) show own work only: client media is refused", async () => {
    const { harness, as } = await studio();
    const act = (key: string, params: Record<string, unknown>) => harness.performAction(key, params, as(MEMBER));
    expect(await act("asset-url", { assetId: "a-asset", ...board(null) })).toEqual(refused(WRONG_BOARD));
    expect(await act("asset-url", { assetId: "own-asset", ...board(null) })).toEqual({ url: expect.stringContaining("/own-asset/") });
    // A missing projectId is a company board too: it can only narrow.
    expect(await act("asset-url", { assetId: "a-asset", boardScope: {} })).toEqual(refused(WRONG_BOARD));
  });

  it("is stricter than assertReachable: a project with no client passes no client file", async () => {
    const { harness, as } = await studio();
    const batch = (await harness.performAction("asset-urls", { assetIds: ["a-asset", "own-asset"], ...board(PROJECT_NO_CLIENT) }, as(MEMBER))) as Batch;
    expect(Object.keys(batch.urls)).toEqual(["own-asset"]);
    expect(batch.refused).toEqual(["a-asset"]);
  });

  it("own work on a client's project board is refused: the board stands for that client only", async () => {
    const { harness, as } = await studio();
    expect(await harness.performAction("asset-url", { assetId: "own-asset", ...board(PROJECT_A) }, as(MEMBER))).toEqual(refused(WRONG_BOARD));
  });

  it("an agent-written embed with a foreign id gets the same refusals: the check runs on draw, on the id alone", async () => {
    const { harness, as } = await studio();
    // What an agent wrote: an embed node pointing at client A's file, placed on client B's board.
    const node = { kind: "embed", data: { plugin: "partnersinbiz.studio", type: "studio-media", assetId: "a-asset", props: { note: "from agent" } } };
    const batch = (await harness.performAction("asset-urls", { assetIds: [node.data.assetId], ...board(PROJECT_B) }, as(MEMBER))) as Batch;
    expect(batch.urls).toEqual({});
    expect(batch.refused).toEqual(["a-asset"]);
    expect(await harness.performAction("asset-url", { assetId: node.data.assetId, ...board(null) }, as(MEMBER))).toEqual(refused(WRONG_BOARD));
    // Agents themselves never get a person's link.
    const agent = { companyId: CO, actor: { type: "agent" as const, userId: null, agentId: AGENT, runId: "run-1" } };
    expect(await harness.performAction("asset-urls", { assetIds: ["a-asset"], ...board(PROJECT_A) }, agent)).toEqual(refused("forbidden"));
  });

  it("a restricted member sees placeholders for client media, own-work media is shown", async () => {
    const { harness, as } = await studio();
    const act = (key: string, params: Record<string, unknown>) => harness.performAction(key, params, as(RESTRICTED, true));
    const onA = (await act("asset-urls", { assetIds: ["a-asset"], ...board(PROJECT_A) })) as Batch;
    expect(onA.urls).toEqual({});
    expect(onA.withheld).toEqual(["a-asset"]);
    expect(await act("asset-url", { assetId: "a-asset", ...board(PROJECT_A) })).toEqual(refused(MEMBER_RESTRICTED));
    const own = (await act("asset-urls", { assetIds: ["own-asset"], ...board(null) })) as Batch;
    expect(Object.keys(own.urls)).toEqual(["own-asset"]);
    expect(await act("board-library", board(PROJECT_A))).toEqual({ board: { kind: "client", name: null }, assets: [], withheld: true });
    expect(await act("board-library", board(null))).toMatchObject({ board: { kind: "own" }, assets: [{ id: "own-asset" }], withheld: false });
  });

  it("a person without Studio access is refused by the guard, so the card shows its placeholder", async () => {
    const { harness, as } = await studio({ accessMode: "enforce" });
    expect(await harness.performAction("asset-urls", { assetIds: ["own-asset"], ...board(null) }, as(OUTSIDER))).toEqual(refused(PERMISSION_DENIED));
    expect(await harness.performAction("board-library", board(null), as(OUTSIDER))).toEqual(refused(PERMISSION_DENIED));
    expect(await harness.performAction("asset-urls", { assetIds: ["own-asset"], ...board(null) }, as(MEMBER))).toMatchObject({ urls: { "own-asset": expect.any(String) } });
  });

  it("a deleted or archived file reads as removed, never as a signed link", async () => {
    const { harness, as } = await studio();
    const batch = (await harness.performAction("asset-urls", { assetIds: ["gone", "own-archived", "own-asset"], ...board(null) }, as(MEMBER))) as Batch;
    expect(Object.keys(batch.urls)).toEqual(["own-asset"]);
    expect(batch.removed).toEqual(["gone", "own-archived"]);
    expect(await harness.performAction("asset-url", { assetId: "own-archived", ...board(null) }, as(MEMBER))).toEqual(refused("unknown_asset"));
    // Studio's own page keeps today's answer: no board, no new fields.
    const page = (await harness.performAction("asset-urls", { assetIds: ["gone", "a-asset"] }, as(MEMBER))) as Batch;
    expect(Object.keys(page.urls)).toEqual(["a-asset"]);
    expect(page).not.toHaveProperty("removed");
    expect(page).not.toHaveProperty("refused");
  });

  it("the library lists only files that pass the board's scope, without archived ones", async () => {
    const { harness, as } = await studio();
    const act = (projectId: string | null) => harness.performAction("board-library", board(projectId), as(MEMBER));
    expect(await act(PROJECT_A)).toEqual({ board: { kind: "client", name: "Acme" }, assets: [expect.objectContaining({ id: "a-asset", kind: "image" })], withheld: false });
    expect(await act(PROJECT_B)).toMatchObject({ board: { kind: "client", name: "Globex" }, assets: [{ id: "b-asset" }] });
    expect(await act(null)).toMatchObject({ board: { kind: "own", name: null }, assets: [{ id: "own-asset" }] });
    expect(await act(PROJECT_NO_CLIENT)).toMatchObject({ board: { kind: "own" }, assets: [{ id: "own-asset" }] });
  });

  it("Studio's switch off: board calls are refused and cards become placeholders; the Studio page is unchanged", async () => {
    const { harness, as } = await studio({ cards: false });
    expect(await harness.performAction("asset-urls", { assetIds: ["own-asset"], ...board(null) }, as(MEMBER))).toEqual(refused(BOARD_CARDS_OFF));
    expect(await harness.performAction("asset-url", { assetId: "own-asset", ...board(null) }, as(MEMBER))).toEqual(refused(BOARD_CARDS_OFF));
    expect(await harness.performAction("board-library", board(null), as(MEMBER))).toEqual(refused(BOARD_CARDS_OFF));
    expect(await harness.performAction("asset-urls", { assetIds: ["own-asset"] }, as(MEMBER))).toMatchObject({ urls: { "own-asset": expect.any(String) } });
    const on = await studio({ cards: true });
    expect(await on.harness.performAction("asset-url", { assetId: "own-asset", ...board(null) }, on.as(MEMBER))).toEqual({ url: expect.any(String) });
  });

  it("a failed settings read counts as switched off, at every board call", async () => {
    const { harness, as } = await studio();
    (harness.ctx.config as { get: () => Promise<unknown> }).get = async () => {
      throw new Error("settings store down");
    };
    for (const [key, params] of [["asset-url", { assetId: "own-asset" }], ["asset-urls", { assetIds: ["own-asset"] }], ["board-library", {}]] as const) {
      expect(await harness.performAction(key, { ...params, ...board(null) }, as(MEMBER)), key).toEqual(refused(BOARD_CARDS_OFF));
    }
  });

  it("a malformed board scope is refused, never read as no board", async () => {
    const { harness, as } = await studio();
    for (const boardScope of ["project-a", [], { projectId: 5 }, { projectId: "  " }, null]) {
      expect(await harness.performAction("asset-url", { assetId: "a-asset", boardScope }, as(MEMBER)), JSON.stringify(boardScope)).toEqual(refused("bad_board_scope"));
    }
    expect(await harness.performAction("board-library", {}, as(MEMBER))).toEqual(refused("bad_board_scope"));
  });
});
