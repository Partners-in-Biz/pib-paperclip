/**
 * Studio's person path and restricted members (PAR-14274; plan PAR-14257 D row S1, I.3, G.2). A restricted member gets
 * no asset and no generation filed under a client; own work still works. Runs the real action handlers through the
 * harness, with the acting-person mark core sends (`onBehalfOfRestricted`: flagged AND the company on `enforce`).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { actingRestriction, MEMBER_RESTRICTED, MEMBER_RESTRICTION_UNAVAILABLE } from "@partnersinbiz/pib-plugin-kit";
import manifest from "../src/manifest.js";
import { PAGE_MODELS } from "../src/page.js";
import plugin from "../src/worker.js";

const CO = "a1600000-0000-4000-8000-000000000001";
const OWNER = "a1600000-0000-4000-8000-000000000011";
const ADMIN = "a1600000-0000-4000-8000-000000000012";
const MEMBER = "a1600000-0000-4000-8000-000000000013";
const RESTRICTED = "a1600000-0000-4000-8000-000000000014";
const AGENT = "a1600000-0000-4000-8000-000000000021";
const RUN = "a1600000-0000-4000-8000-000000000031";
const CLIENT = "a1600000-0000-4000-8000-0000000000c1";
const OWN_ASSET = "own-asset";
const CLIENT_ASSET = "client-asset";
const OWN_CANVAS = "a1600000-0000-4000-8000-0000000000b1";
const CLIENT_CANVAS = "a1600000-0000-4000-8000-0000000000b2";
/** A live share of the client's board, made earlier by someone allowed to. */
const CLIENT_SHARE = "abcdefghijklmnopqrstuvwx";
const GIVE = "a1600000-0000-4000-8000-0000000000f1";
const OWN_EDIT = "a1600000-0000-4000-8000-0000000000e1";
const CLIENT_EDIT = "a1600000-0000-4000-8000-0000000000e2";
const OWN_RENDER = "a1600000-0000-4000-8000-0000000000d1";
const CLIENT_RENDER = "a1600000-0000-4000-8000-0000000000d2";
const MODEL = PAGE_MODELS.find((m) => m.kind === "image" && m.minRefs === 0)!.id;

type Mode = "off" | "report" | "enforce";
type Caller = "owner" | "admin" | "member" | "restricted" | "agent";
const MODES: Mode[] = ["off", "report", "enforce"];
const CALLERS: Caller[] = ["owner", "admin", "member", "restricted", "agent"];
const USER: Record<Exclude<Caller, "agent">, string> = { owner: OWNER, admin: ADMIN, member: MEMBER, restricted: RESTRICTED };

beforeAll(() => {
  process.env.PIB_STUDIO_FAKE_PROVIDER = "1";
});
afterAll(() => {
  delete process.env.PIB_STUDIO_FAKE_PROVIDER;
});

const assetRow = (id: string, client: boolean) => ({
  id, company_id: CO, client_kind: client ? "company" : null, client_ref: client ? CLIENT : null, client_name: client ? "Acme" : null,
  project_id: null, name: id, kind: "image", alt_text: null, status: "draft", source: "upload", generation_id: null,
  current_version: 1, created_at: new Date().toISOString(), r2_key: `studio/${CO}/${client ? CLIENT : "own"}/${id}/v1.png`, mime: "image/png", bytes: 10,
});

const canvasRow = (id: string, client: boolean) => ({
  id, company_id: CO, client_kind: client ? "company" : null, client_ref: client ? CLIENT : null, client_name: client ? "Acme" : null,
  project_id: null, title: id, doc: { nodes: [], edges: [] }, revision: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
});

const editRow = (id: string, client: boolean) => ({
  id, company_id: CO, client_kind: client ? "company" : null, client_ref: client ? CLIENT : null, client_name: client ? "Acme" : null,
  project_id: null, title: id, doc: { tracks: [] }, revision: 1, source_asset_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
});

const renderRow = (id: string, client: boolean) => ({
  id, company_id: CO, client_kind: client ? "company" : null, client_ref: client ? CLIENT : null, edit_id: client ? CLIENT_EDIT : OWN_EDIT, edit_revision: 1,
  doc: { tracks: [] }, preset: "landscape", status: "queued", claim_token: null, pid: null, workdir: null, heartbeat_at: null, attempts: 0, error_kind: null,
  asset_id: null, preview_r2_key: null, error: null, stderr_tail: null, started_at: null, finished_at: null, created_at: new Date().toISOString(),
});

const genRow = (id: string, client: boolean) => ({
  id, group_id: id, status: "queued", model: "m", name: id, asset_id: null, estimated_credits: 1, error_message: null, created_at: new Date().toISOString(),
  client_kind: client ? "company" : null, client_ref: client ? CLIENT : null,
});

/** The rows a list query asks for: own work only (`client_ref IS NULL`), one client's, or every scope. */
function inScope<T extends { client_ref: string | null }>(sql: string, rows: T[]): T[] {
  if (/client_ref IS NULL/.test(sql)) return rows.filter((row) => !row.client_ref);
  if (/client_kind = \$/.test(sql)) return rows.filter((row) => row.client_ref);
  return rows;
}

/** Studio with storage set up, a company cap, one own and one client asset and canvas, and the CRM client Acme. */
/** Where the overview finds a client row; `only` keeps a client row in that source alone (PAR-14298). */
type ClientSource = "crm" | "assets" | "caps" | "history";

async function studio(only?: ClientSource) {
  const has = (source: ClientSource) => only === undefined || only === source;
  const at = new Date().toISOString();
  const member = (userId: string, role: string) => ({ id: `m-${userId}`, companyId: CO, principalType: "user" as const, principalId: userId, status: "active" as const, membershipRole: role, grants: [], createdAt: at, updatedAt: at });
  const harness = createTestHarness({
    manifest,
    config: { r2: { accountId: "acct", bucket: "pib-private", accessKeyId: "AK", secretAccessKey: { type: "secret_ref", secretId: "sec-1" } } },
  });
  harness.seed({ accessMembers: [member(OWNER, "owner"), member(ADMIN, "admin"), member(MEMBER, "member"), member(RESTRICTED, "member")] });
  const db = harness.ctx.db as { namespace: string; query: (sql: string, params?: unknown[]) => Promise<unknown[]>; execute: (sql: string, params?: unknown[]) => Promise<{ rowCount: number }> };
  db.namespace = "plugin_studio_test"; // Studio's table() takes only a host-style namespace
  const writes: string[] = [];
  db.query = async (sql, params = []) => {
    // Lists (PAR-14298): the library, its status counts, page progress, boards, video edits and renders.
    if (/ORDER BY a\.created_at/.test(sql)) return inScope(sql, [assetRow(OWN_ASSET, false), ...(has("assets") ? [assetRow(CLIENT_ASSET, true)] : [])]);
    if (/GROUP BY a\.status/.test(sql)) return [{ status: "draft", n: inScope(sql, [assetRow(OWN_ASSET, false), assetRow(CLIENT_ASSET, true)]).length }];
    if (/a\.client_ref IS NOT NULL LIMIT 1/.test(sql)) return [{ one: 1 }];
    if (/FROM \S+\.generations WHERE company_id = \$1 AND group_id IN/.test(sql)) {
      const asked = JSON.parse(String(params[1])) as string[];
      return inScope(sql, [genRow("own-group", false), genRow("client-group", true)]).filter((row) => asked.includes(row.group_id));
    }
    if (/FROM \S+\.canvases WHERE company_id = \$1/.test(sql)) return inScope(sql, [canvasRow(OWN_CANVAS, false), canvasRow(CLIENT_CANVAS, true)]);
    if (/FROM \S+\.video_edits WHERE id = \$1/.test(sql)) return params[0] === OWN_EDIT ? [editRow(OWN_EDIT, false)] : params[0] === CLIENT_EDIT ? [editRow(CLIENT_EDIT, true)] : [];
    if (/FROM \S+\.video_edits WHERE company_id = \$1/.test(sql)) return inScope(sql, [editRow(OWN_EDIT, false), editRow(CLIENT_EDIT, true)]);
    if (/FROM \S+\.video_renders WHERE id = \$1/.test(sql)) return params[0] === OWN_RENDER ? [renderRow(OWN_RENDER, false)] : params[0] === CLIENT_RENDER ? [renderRow(CLIENT_RENDER, true)] : [];
    if (/FROM \S+\.crm_companies WHERE company_id = \$1/.test(sql) && params.length === 1) return has("crm") ? [{ id: CLIENT, name: "Acme", domain: null, lifecycle: "customer" }] : [];
    if (/FROM \S+\.assets a JOIN/.test(sql)) return params[1] === OWN_ASSET ? [assetRow(OWN_ASSET, false)] : params[1] === CLIENT_ASSET ? [assetRow(CLIENT_ASSET, true)] : [];
    if (/crm_companies/.test(sql) && params.includes(CLIENT)) return [{ id: CLIENT, name: "Acme", domain: null, lifecycle: "customer" }];
    if (/FROM \S+\.canvases WHERE id = \$1/.test(sql)) return params[0] === OWN_CANVAS ? [canvasRow(OWN_CANVAS, false)] : params[0] === CLIENT_CANVAS ? [canvasRow(CLIENT_CANVAS, true)] : [];
    if (/SELECT canvas_id FROM \S+\.canvas_shares/.test(sql)) return params[0] === CLIENT_SHARE ? [{ canvas_id: CLIENT_CANVAS }] : [];
    if (/credit_limit_changes/.test(sql)) return has("history") ? [{ scope_key: `company:${CLIENT}`, old_credits: null, new_credits: 100, changed_by: OWNER, created_at: at }] : [];
    if (/credit_limits/.test(sql)) return [{ scope_key: "company", monthly_credits: 100, updated_by: OWNER, updated_at: at }, ...(has("caps") ? [{ scope_key: `company:${CLIENT}`, monthly_credits: 100, updated_by: OWNER, updated_at: at }] : [])];
    return [];
  };
  db.execute = async (sql) => {
    writes.push(sql);
    return { rowCount: 1 };
  };
  const configReads = vi.spyOn(harness.ctx.config, "get");
  await plugin.definition.setup(harness.ctx);
  configReads.mockClear();
  // Drive, brand kit and Social all go out over the event bus: a refused call must emit nothing.
  const emit = vi.spyOn(harness.ctx.events, "emit");
  emit.mockClear();
  // The access guard's own `access.request` is not client data; anything else is.
  const emits = () => emit.mock.calls.map(([type]) => String(type)).filter((type) => !type.startsWith("access."));
  return { harness, writes, configReads, emits };
}

/** The actor core sends: the mark is true only for a flagged person in a company on `enforce` (kill switch off). */
function actorFor(caller: Caller, mode: Mode) {
  const mark = caller === "restricted" && mode === "enforce";
  if (caller === "agent") return { type: "agent" as const, userId: null, agentId: AGENT, runId: RUN, onBehalfOfUserId: RESTRICTED, onBehalfOfRestricted: mark };
  return { type: "user" as const, userId: USER[caller], onBehalfOfUserId: USER[caller], onBehalfOfRestricted: mark };
}

const request = (client: boolean) => ({ model: MODEL, prompt: "a lighthouse at dusk", ...(client ? { client: `company:${CLIENT}` } : {}) });
/** Lip-sync on the client's own portrait: the same generate path, so the same rule. */
const lipsync = { portraitAssetId: CLIENT_ASSET, line: "Hello there", client: `company:${CLIENT}` };
const refused = (code: string) => expect.objectContaining({ ok: false, refused: true, code });

describe("Studio person path: restricted members get no client media or client generation (PAR-14274)", () => {
  const cells = CALLERS.flatMap((caller) => MODES.map((mode) => ({ caller, mode })));

  it.each(cells)("$caller, member restriction $mode", async ({ caller, mode }) => {
    const { harness, writes, configReads } = await studio();
    const as = { companyId: CO, actor: actorFor(caller, mode) };
    const act = (key: string, params: Record<string, unknown>) => harness.performAction(key, params, as);

    if (caller === "agent") {
      // Today's answer in every mode: agents use the tools, never the page's actions.
      for (const [key, params] of [["asset-url", { assetId: CLIENT_ASSET }], ["asset-urls", { assetIds: [CLIENT_ASSET] }], ["estimate", request(true)], ["generate", request(true)]] as const) {
        expect(await act(key, params), key).toEqual(refused("forbidden"));
      }
      expect(writes).toEqual([]);
      return;
    }

    const blocked = caller === "restricted" && mode === "enforce";
    // Own work: signed and generated for everyone, a restricted member included.
    expect(await act("asset-url", { assetId: OWN_ASSET })).toEqual({ url: expect.stringContaining(`/own/${OWN_ASSET}/`) });
    expect(await act("estimate", request(false))).toMatchObject({ model: MODEL, creditsEach: expect.any(Number) });

    if (blocked) {
      configReads.mockClear();
      expect(await act("asset-url", { assetId: CLIENT_ASSET })).toEqual(refused(MEMBER_RESTRICTED));
      const batch = (await act("asset-urls", { assetIds: [OWN_ASSET, CLIENT_ASSET] })) as { urls: Record<string, string>; withheld?: string[]; failed: string[]; error: string | null };
      expect(Object.keys(batch.urls)).toEqual([OWN_ASSET]);
      expect(batch).toMatchObject({ withheld: [CLIENT_ASSET], failed: [], error: null });
      configReads.mockClear();
      expect(await act("estimate", request(true))).toEqual(refused(MEMBER_RESTRICTED));
      expect(await act("generate", request(true))).toEqual(refused(MEMBER_RESTRICTED));
      // Refused before any price, provider or reserve: no settings read and nothing written.
      expect(configReads).not.toHaveBeenCalled();
      // The Layout card's bytes and lip-sync go through the same rule.
      expect(await act("asset-data", { assetId: CLIENT_ASSET })).toEqual(refused(MEMBER_RESTRICTED));
      expect(await act("studio-lipsync", lipsync)).toEqual(refused(MEMBER_RESTRICTED));
      expect(writes).toEqual([]);
    } else {
      expect(await act("asset-url", { assetId: CLIENT_ASSET })).toEqual({ url: expect.stringContaining(`/${CLIENT}/${CLIENT_ASSET}/`) });
      const batch = (await act("asset-urls", { assetIds: [OWN_ASSET, CLIENT_ASSET] })) as { urls: Record<string, string>; withheld?: string[] };
      expect(Object.keys(batch.urls).sort()).toEqual([CLIENT_ASSET, OWN_ASSET].sort());
      expect(batch.withheld).toBeUndefined();
      expect(await act("estimate", request(true))).toMatchObject({ model: MODEL, creditsEach: expect.any(Number) });
      expect(await act("generate", request(true))).toMatchObject({ status: "queued", client: { kind: "company", id: CLIENT } });
      expect(writes.some((sql) => /INSERT INTO \S+\.generations/.test(sql))).toBe(true);
      expect(await act("studio-lipsync", lipsync)).toMatchObject({ status: "queued", client: { kind: "company", id: CLIENT } });
    }
    // Own-work generation still queues for a restricted member.
    expect(await act("generate", request(false))).toMatchObject({ status: "queued", client: null });
  });

  it("kill switch on: core marks nobody restricted, so a flagged member under enforce gets today's answer", async () => {
    const { harness } = await studio();
    const as = { companyId: CO, actor: { type: "user" as const, userId: RESTRICTED, onBehalfOfUserId: RESTRICTED, onBehalfOfRestricted: false } };
    expect(await harness.performAction("asset-url", { assetId: CLIENT_ASSET }, as)).toEqual({ url: expect.stringContaining(CLIENT_ASSET) });
    expect(await harness.performAction("generate", request(true), as)).toMatchObject({ status: "queued" });
  });

  describe("core's answer is missing (the restriction read failed): client work refused, nothing signed or reserved", () => {
    const as = { companyId: CO, actor: { type: "user" as const, userId: MEMBER } };

    it("refuses client media and client generation with MEMBER_RESTRICTION_UNAVAILABLE", async () => {
      const { harness, writes, configReads } = await studio();
      expect(await harness.performAction("asset-url", { assetId: CLIENT_ASSET }, as)).toEqual(refused(MEMBER_RESTRICTION_UNAVAILABLE));
      expect(await harness.performAction("asset-urls", { assetIds: [OWN_ASSET, CLIENT_ASSET] }, as)).toEqual(refused(MEMBER_RESTRICTION_UNAVAILABLE));
      configReads.mockClear();
      expect(await harness.performAction("estimate", request(true), as)).toEqual(refused(MEMBER_RESTRICTION_UNAVAILABLE));
      expect(await harness.performAction("generate", request(true), as)).toEqual(refused(MEMBER_RESTRICTION_UNAVAILABLE));
      expect(configReads).not.toHaveBeenCalled();
      expect(await harness.performAction("asset-data", { assetId: CLIENT_ASSET }, as)).toEqual(refused(MEMBER_RESTRICTION_UNAVAILABLE));
      expect(await harness.performAction("studio-lipsync", lipsync, as)).toEqual(refused(MEMBER_RESTRICTION_UNAVAILABLE));
      expect(writes).toEqual([]);
    });

    it("still signs own work, where the answer does not matter", async () => {
      const { harness } = await studio();
      expect(await harness.performAction("asset-url", { assetId: OWN_ASSET }, as)).toEqual({ url: expect.stringContaining(OWN_ASSET) });
      expect(await harness.performAction("asset-urls", { assetIds: [OWN_ASSET] }, as)).toMatchObject({ urls: { [OWN_ASSET]: expect.any(String) } });
    });
  });

  it("the kit reads core's mark: missing is unavailable, never 'not restricted'", () => {
    expect(actingRestriction({ onBehalfOfUserId: "u", onBehalfOfRestricted: true })).toBe("restricted");
    expect(actingRestriction({ onBehalfOfUserId: "u", onBehalfOfRestricted: false })).toBe("unrestricted");
    expect(actingRestriction({ onBehalfOfUserId: null })).toBe("unrestricted");
    expect(actingRestriction({})).toBe("unavailable");
    expect(actingRestriction(null)).toBe("unavailable");
  });
});

/**
 * The rest of the person path's client work (PAR-14290): approving into Social, Drive, giving to an agent, the brand
 * kit and share links of a client's board. Each action is refused for a restricted member and when core's answer is
 * missing, before any read of the client's data, any event to another plugin or any write.
 */
const CLIENT_WORK: Array<[string, Record<string, unknown>]> = [
  ["review", { assetId: CLIENT_ASSET, decision: "approved" }],
  ["drive-save", { assetId: CLIENT_ASSET }],
  ["give-prepare", { assetId: CLIENT_ASSET }],
  ["give-record", { assetId: CLIENT_ASSET, giveId: GIVE, issueId: "PAR-1" }],
  ["give-discard", { assetId: CLIENT_ASSET, giveId: GIVE }],
  ["brand-kit", { client: `company:${CLIENT}` }],
  ["drive-list", { client: `company:${CLIENT}` }],
  ["drive-import", { client: `company:${CLIENT}`, fileId: "1AbCdEfGhIjKlMnOp" }],
  ["drive-thumbs", { client: `company:${CLIENT}`, fileIds: ["1AbCdEfGhIjKlMnOp"] }],
  ["canvas-share-list", { canvasId: CLIENT_CANVAS }],
  ["canvas-share-create", { canvasId: CLIENT_CANVAS }],
  ["canvas-share-revoke", { shareId: CLIENT_SHARE }],
];

describe("Studio person path: the remaining client work is closed to restricted members (PAR-14290)", () => {
  const restricted = { type: "user" as const, userId: RESTRICTED, onBehalfOfUserId: RESTRICTED, onBehalfOfRestricted: true };
  const unmarked = { type: "user" as const, userId: MEMBER };

  it.each(CLIENT_WORK)("%s: refused for a restricted member, nothing read, sent or written", async (key, params) => {
    const { harness, writes, configReads, emits } = await studio();
    expect(await harness.performAction(key, params, { companyId: CO, actor: restricted })).toEqual(refused(MEMBER_RESTRICTED));
    expect(configReads).not.toHaveBeenCalled();
    expect(emits()).toEqual([]);
    expect(writes).toEqual([]);
  });

  it.each(CLIENT_WORK)("%s: refused with MEMBER_RESTRICTION_UNAVAILABLE when core's answer is missing", async (key, params) => {
    const { harness, writes, configReads, emits } = await studio();
    expect(await harness.performAction(key, params, { companyId: CO, actor: unmarked })).toEqual(refused(MEMBER_RESTRICTION_UNAVAILABLE));
    expect(configReads).not.toHaveBeenCalled();
    expect(emits()).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("own work still works for a restricted member", async () => {
    const { harness } = await studio();
    const as = { companyId: CO, actor: restricted };
    expect(await harness.performAction("review", { assetId: OWN_ASSET, decision: "rejected" }, as)).toMatchObject({ changed: true, asset: { id: OWN_ASSET, status: "rejected" } });
    expect(await harness.performAction("brand-kit", { client: "own" }, as)).toMatchObject({ client: null, kit: null });
    expect(await harness.performAction("give-discard", { assetId: OWN_ASSET, giveId: GIVE }, as)).toEqual({ removed: 0 });
    expect(await harness.performAction("canvas-share-list", { canvasId: OWN_CANVAS }, as)).toEqual({ shares: [] });
  });

  it.each(MODES)("everyone else keeps today's answer on client work (member restriction %s)", async (mode) => {
    const { harness } = await studio();
    const as = { companyId: CO, actor: actorFor(mode === "enforce" ? "member" : "restricted", mode) };
    expect(await harness.performAction("review", { assetId: CLIENT_ASSET, decision: "rejected" }, as)).toMatchObject({ changed: true, asset: { id: CLIENT_ASSET } });
    expect(await harness.performAction("give-discard", { assetId: CLIENT_ASSET, giveId: GIVE }, as)).toEqual({ removed: 0 });
    expect(await harness.performAction("canvas-share-list", { canvasId: CLIENT_CANVAS }, as)).toEqual({ shares: [] });
  });
});

/**
 * Page data, client boards and video edits (PAR-14298). The host now passes the acting person to page data
 * (PAR-14297). A restricted member's lists hold own work only and one client row is refused; with core's answer
 * missing a list is refused only when a client row would be in it. Boards and video edits are checked against their
 * client before anything is read for the page, run or written.
 */
const marked = { onBehalfOfUserId: RESTRICTED, onBehalfOfRestricted: true };
const allowed = { onBehalfOfUserId: MEMBER, onBehalfOfRestricted: false };
const rejectsWith = (code: string) => expect.objectContaining({ code });
const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id).sort();

describe("Studio page data: a restricted member gets no client rows (PAR-14298)", () => {
  it("lists hold own work only; one client row and a client filter are refused", async () => {
    const { harness } = await studio();
    const get = <T>(key: string, params: Record<string, unknown> = {}) => harness.getData<T>(key, { companyId: CO, ...params }, { actor: marked });

    const library = await get<{ assets: Array<{ id: string }>; counts: Record<string, number> }>("assets");
    expect(ids(library.assets)).toEqual([OWN_ASSET]);
    expect(library.counts.all).toBe(1);
    await expect(get("assets", { client: `company:${CLIENT}` })).rejects.toEqual(rejectsWith(MEMBER_RESTRICTED));

    await expect(get("asset", { assetId: CLIENT_ASSET })).rejects.toEqual(rejectsWith(MEMBER_RESTRICTED));
    expect(await get("asset", { assetId: OWN_ASSET })).toMatchObject({ asset: { id: OWN_ASSET } });

    const progress = await get<{ generations: Array<{ id: string }> }>("generations", { groupIds: ["own-group", "client-group"] });
    expect(ids(progress.generations)).toEqual(["own-group"]);

    expect(await get("client-summaries")).toMatchObject({ clients: [] });

    expect(ids((await get<{ canvases: Array<{ id: string }> }>("canvases")).canvases)).toEqual([OWN_CANVAS]);
    await expect(get("canvases", { client: `company:${CLIENT}` })).rejects.toEqual(rejectsWith(MEMBER_RESTRICTED));
    for (const key of ["canvas", "canvas-versions", "canvas-comments"]) {
      await expect(get(key, { canvasId: CLIENT_CANVAS, cardId: "c1" }), key).rejects.toEqual(rejectsWith(MEMBER_RESTRICTED));
      await expect(get(key, { canvasId: OWN_CANVAS, cardId: "c1" }), key).resolves.toBeTruthy();
    }

    const page = await get<{ clients: unknown[]; assets: Array<{ id: string }>; caps: Array<{ scopeKey: string }>; history: unknown[]; clientUsage: unknown[] }>("overview");
    expect(page.clients).toEqual([]);
    expect(ids(page.assets)).toEqual([OWN_ASSET]);
    expect(page.caps.map((cap) => cap.scopeKey)).not.toContain(`company:${CLIENT}`);
    expect(page.history).toEqual([]);
    expect(page.clientUsage).toEqual([]);
  });

  it("core's answer missing: a list is refused when a client row would be in it, own work still loads", async () => {
    const { harness } = await studio();
    // No actor: what an older host sends.
    const get = <T>(key: string, params: Record<string, unknown> = {}) => harness.getData<T>(key, { companyId: CO, ...params });
    const unavailable = rejectsWith(MEMBER_RESTRICTION_UNAVAILABLE);

    await expect(get("assets")).rejects.toEqual(unavailable);
    await expect(get("assets", { client: `company:${CLIENT}` })).rejects.toEqual(unavailable);
    expect(ids((await get<{ assets: Array<{ id: string }> }>("assets", { client: "own" })).assets)).toEqual([OWN_ASSET]);

    await expect(get("asset", { assetId: CLIENT_ASSET })).rejects.toEqual(unavailable);
    expect(await get("asset", { assetId: OWN_ASSET })).toMatchObject({ asset: { id: OWN_ASSET } });

    await expect(get("generations", { groupIds: ["own-group", "client-group"] })).rejects.toEqual(unavailable);
    expect(ids((await get<{ generations: Array<{ id: string }> }>("generations", { groupIds: ["own-group"] })).generations)).toEqual(["own-group"]);

    await expect(get("client-summaries")).rejects.toEqual(unavailable);

    await expect(get("canvases")).rejects.toEqual(unavailable);
    expect(ids((await get<{ canvases: Array<{ id: string }> }>("canvases", { client: "own" })).canvases)).toEqual([OWN_CANVAS]);
    for (const key of ["canvas", "canvas-versions", "canvas-comments"]) {
      await expect(get(key, { canvasId: CLIENT_CANVAS, cardId: "c1" }), key).rejects.toEqual(unavailable);
      await expect(get(key, { canvasId: OWN_CANVAS, cardId: "c1" }), key).resolves.toBeTruthy();
    }

    await expect(get("overview")).rejects.toEqual(unavailable);
  });

  it.each<ClientSource>(["crm", "assets", "caps", "history"])("core's answer missing: overview is refused when only its %s names a client", async (source) => {
    const { harness } = await studio(source);
    await expect(harness.getData("overview", { companyId: CO })).rejects.toEqual(rejectsWith(MEMBER_RESTRICTION_UNAVAILABLE));
  });

  it.each(MODES)("everyone else keeps today's page data (member restriction %s)", async (mode) => {
    const { harness } = await studio();
    const actor = mode === "enforce" ? allowed : { onBehalfOfUserId: RESTRICTED, onBehalfOfRestricted: false };
    const get = <T>(key: string, params: Record<string, unknown> = {}) => harness.getData<T>(key, { companyId: CO, ...params }, { actor });

    expect(ids((await get<{ assets: Array<{ id: string }> }>("assets")).assets)).toEqual([CLIENT_ASSET, OWN_ASSET].sort());
    expect(await get("asset", { assetId: CLIENT_ASSET })).toMatchObject({ asset: { id: CLIENT_ASSET } });
    expect(ids((await get<{ generations: Array<{ id: string }> }>("generations", { groupIds: ["own-group", "client-group"] })).generations)).toEqual(["client-group", "own-group"]);
    expect(await get("client-summaries")).toMatchObject({ clients: [{ scopeKey: `company:${CLIENT}`, name: "Acme" }] });
    expect(ids((await get<{ canvases: Array<{ id: string }> }>("canvases")).canvases)).toEqual([OWN_CANVAS, CLIENT_CANVAS].sort());
    expect(await get("canvas", { canvasId: CLIENT_CANVAS })).toMatchObject({ id: CLIENT_CANVAS });
    const page = await get<{ clients: unknown[]; caps: Array<{ scopeKey: string }> }>("overview");
    expect(page.clients).toEqual([{ scopeKey: `company:${CLIENT}`, name: "Acme" }]);
    expect(page.caps.map((cap) => cap.scopeKey)).toContain(`company:${CLIENT}`);
  });

  it("a cap change answers with the overview the person may see", async () => {
    const { harness } = await studio();
    // A contrived owner with core's mark, to show the answer goes through the same rule as the page data.
    const as = { companyId: CO, actor: { type: "user" as const, userId: OWNER, onBehalfOfUserId: OWNER, onBehalfOfRestricted: true } };
    for (const [key, params] of [["set-cap", { scopeKey: "company", monthlyCredits: 100 }], ["set-balance", { usd: 10 }], ["set-agent-limit", { agentId: AGENT, credits: 5 }]] as const) {
      expect(await harness.performAction(key, params, as), key).toMatchObject({ clients: [] });
    }
  });

  it("the local board (no person behind the call) keeps today's page data", async () => {
    const { harness } = await studio();
    const board = await harness.getData<{ clients: unknown[] }>("overview", { companyId: CO }, { actor: { onBehalfOfUserId: null } });
    expect(board.clients).toHaveLength(1);
  });
});

/** Every client board and video edit action, with params that point at the client's board, edit or render. */
const BOARD_AND_EDIT_WORK: Array<[string, Record<string, unknown>]> = [
  ["canvas-create", { title: "Launch", client: `company:${CLIENT}` }],
  ["canvas-save", { canvasId: CLIENT_CANVAS, baseRevision: 1, doc: { nodes: [], edges: [] } }],
  ["canvas-archive", { canvasId: CLIENT_CANVAS }],
  ["canvas-version-save", { canvasId: CLIENT_CANVAS, name: "First" }],
  ["canvas-version-restore", { canvasId: CLIENT_CANVAS, versionId: "v1", baseRevision: 1 }],
  ["canvas-comment-add", { canvasId: CLIENT_CANVAS, cardId: "c1", body: "Looks good" }],
  ["canvas-text-drafts", { canvasId: CLIENT_CANVAS }],
  ["canvas-text-draft-taken", { canvasId: CLIENT_CANVAS, cardId: "c1" }],
  ["layout-save", { canvasId: CLIENT_CANVAS, cardId: "c1", base64: "iVBORw0KGgo=" }],
  ["video-edit-list", { client: `company:${CLIENT}` }],
  ["video-edit-get", { editId: CLIENT_EDIT }],
  ["video-edit-render-status", { renderId: CLIENT_RENDER }],
  ["video-edit-create", { title: "Cut", client: `company:${CLIENT}` }],
  // From the library's "Edit video": the client's own clip, checked before it is probed.
  ["video-edit-create", { assetIds: [CLIENT_ASSET] }],
  ["video-edit-apply-ops", { editId: CLIENT_EDIT, baseRevision: 1, ops: [] }],
  ["video-edit-caption", { editId: CLIENT_EDIT, clipId: "c1" }],
  ["video-edit-detect-beats", { editId: CLIENT_EDIT, clipId: "c1" }],
  ["video-edit-cut-to-beat", { editId: CLIENT_EDIT, clipId: "c1" }],
  ["video-edit-cut-silences", { editId: CLIENT_EDIT, clipId: "c1" }],
  ["video-edit-voiceover", { editId: CLIENT_EDIT, script: "Hello" }],
  ["video-edit-music", { editId: CLIENT_EDIT, prompt: "calm piano" }],
  ["video-edit-render", { editId: CLIENT_EDIT }],
  ["video-edit-cancel-render", { renderId: CLIENT_RENDER }],
  ["video-edit-versions-list", { editId: CLIENT_EDIT }],
  ["video-edit-version-save", { editId: CLIENT_EDIT, name: "First" }],
  ["video-edit-restore", { editId: CLIENT_EDIT, versionId: "v1", baseRevision: 1 }],
  ["video-edit-delete", { editId: CLIENT_EDIT }],
];

describe("Studio person path: client boards and video edits are closed to restricted members (PAR-14298)", () => {
  const restricted = { type: "user" as const, userId: RESTRICTED, ...marked };
  const unmarked = { type: "user" as const, userId: MEMBER };

  it.each(BOARD_AND_EDIT_WORK)("%s: refused for a restricted member, nothing sent or written", async (key, params) => {
    const { harness, writes, configReads, emits } = await studio();
    const stateWrites = vi.spyOn(harness.ctx.state, "set");
    expect(await harness.performAction(key, params, { companyId: CO, actor: restricted })).toEqual(refused(MEMBER_RESTRICTED));
    expect(configReads).not.toHaveBeenCalled();
    expect(emits()).toEqual([]);
    expect(writes).toEqual([]);
    expect(stateWrites).not.toHaveBeenCalled();
  });

  it.each(BOARD_AND_EDIT_WORK)("%s: refused with MEMBER_RESTRICTION_UNAVAILABLE when core's answer is missing", async (key, params) => {
    const { harness, writes, configReads, emits } = await studio();
    expect(await harness.performAction(key, params, { companyId: CO, actor: unmarked })).toEqual(refused(MEMBER_RESTRICTION_UNAVAILABLE));
    expect(configReads).not.toHaveBeenCalled();
    expect(emits()).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("own boards and own video edits still work for a restricted member", async () => {
    const { harness } = await studio();
    const as = { companyId: CO, actor: restricted };
    expect(await harness.performAction("canvas-text-drafts", { canvasId: OWN_CANVAS }, as)).toEqual({ drafts: {} });
    expect(await harness.performAction("canvas-archive", { canvasId: OWN_CANVAS }, as)).toEqual({ id: OWN_CANVAS, archived: true });
    expect(ids(((await harness.performAction("video-edit-list", {}, as)) as { edits: Array<{ id: string }> }).edits)).toEqual([OWN_EDIT]);
    expect(await harness.performAction("video-edit-render-status", { renderId: OWN_RENDER }, as)).toMatchObject({ id: OWN_RENDER });
    expect(await harness.performAction("video-edit-versions-list", { editId: OWN_EDIT }, as)).toEqual({ versions: [] });
  });

  it("core's answer missing: the video edit list is refused when a client's edit is in it, own work still lists", async () => {
    const { harness } = await studio();
    const as = { companyId: CO, actor: unmarked };
    expect(await harness.performAction("video-edit-list", {}, as)).toEqual(refused(MEMBER_RESTRICTION_UNAVAILABLE));
    expect(ids(((await harness.performAction("video-edit-list", { client: "own" }, as)) as { edits: Array<{ id: string }> }).edits)).toEqual([OWN_EDIT]);
  });

  it.each(MODES)("everyone else keeps today's answer on client boards and edits (member restriction %s)", async (mode) => {
    const { harness } = await studio();
    const as = { companyId: CO, actor: actorFor(mode === "enforce" ? "member" : "restricted", mode) };
    expect(await harness.performAction("canvas-text-drafts", { canvasId: CLIENT_CANVAS }, as)).toEqual({ drafts: {} });
    expect(await harness.performAction("canvas-archive", { canvasId: CLIENT_CANVAS }, as)).toEqual({ id: CLIENT_CANVAS, archived: true });
    expect(ids(((await harness.performAction("video-edit-list", {}, as)) as { edits: Array<{ id: string }> }).edits)).toEqual([OWN_EDIT, CLIENT_EDIT].sort());
    expect(await harness.performAction("video-edit-render-status", { renderId: CLIENT_RENDER }, as)).toMatchObject({ id: CLIENT_RENDER });
    expect(await harness.performAction("video-edit-versions-list", { editId: CLIENT_EDIT }, as)).toEqual({ versions: [] });
  });

  it("agents keep today's answer: the page's board and edit actions are people's only", async () => {
    const { harness, writes } = await studio();
    const as = { companyId: CO, actor: actorFor("agent", "enforce") };
    for (const [key, params] of BOARD_AND_EDIT_WORK) expect(await harness.performAction(key, params, as), key).toEqual(refused("forbidden"));
    expect(writes).toEqual([]);
  });
});
