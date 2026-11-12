/** Music action (PAR-10256 T2) against real Postgres: charge, refund rules, two-scope, slow job, caps, parallel, BYO audio. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { listAssets, recordStoredAsset, type StoreInput } from "../src/assets.js";
import { agentLimitKey, capCheck, COMPANY_SCOPE, currentPeriod, setCap, usageByClient } from "../src/ledger.js";
import { FAKE_MUSIC_MP3 } from "../src/music/fake-mp3.js";
import { STABLE_AUDIO_MONTHLY_USD_CAP } from "../src/music/stable-audio-price.js";
import { fakeMusic, type MusicGenerator, type MusicResult } from "../src/music/stable-audio.js";
import { applyOpsAction, createEditAction } from "../src/video-edit/actions.js";
import { addAudioOps } from "../src/video-edit/audio-ops.js";
import { musicAction, type MusicDeps } from "../src/video-edit/music.js";
import type { ProbeResult } from "../src/video-edit/probe.js";
import { runVideoEditTool } from "../src/video-edit/tools.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const CO = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const USER = { userId: "owner-1" };
const PROMPT = "warm lo-fi beat with soft piano, secret-launch-code";
const PERIOD = currentPeriod();

const available = await embeddedAvailable();
let pg: Pg;
beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);
afterAll(async () => {
  if (available) await pg.stop();
});

const T = (name: string) => `${pg.db.namespace}.${name}`;
const logs: string[] = [];
const makeCtx = (): PluginContext =>
  ({
    db: pg.db,
    logger: { info: (...a: unknown[]) => logs.push(JSON.stringify(a)), warn: (...a: unknown[]) => logs.push(JSON.stringify(a)), error: (...a: unknown[]) => logs.push(JSON.stringify(a)), debug: () => undefined },
    config: { get: async () => ({}) },
    state: { get: async () => null, set: async () => undefined, delete: async () => undefined },
    projects: { get: async () => null },
  }) as unknown as PluginContext;

const sound = (durationSec: number): ProbeResult => ({ durationSec, width: null, height: null, fps: null, videoCodec: null, audioCodec: "mp3", hasVideo: false, hasAudio: true, formatName: "mp3", sizeBytes: 18 }) as unknown as ProbeResult;
const refused = (charged: "no" | "maybe", httpStatus: number | null, code = "provider_error"): MusicResult => ({ ok: false, charged, httpStatus, code, message: `Stable Audio failed (${httpStatus}).`, ms: 7 });
const gen = (result: MusicResult | (() => Promise<MusicResult>)): MusicGenerator & { calls: number } => {
  const g = { key: "fake", model: "stable-audio-2.5", calls: 0, generate: async () => (g.calls++, typeof result === "function" ? result() : result) };
  return g;
};
const ok = (): MusicResult => ({ ok: true, audio: new Uint8Array(FAKE_MUSIC_MP3), mime: "audio/mpeg", ms: 4200 });

describe.skipIf(!available)("Music action against real Postgres", () => {
  let ctx: PluginContext;
  let stored: string[];
  let deps: (music?: MusicGenerator, over?: Partial<MusicDeps>) => MusicDeps;
  beforeEach(async () => {
    await pg.reset();
    logs.length = 0;
    ctx = makeCtx();
    stored = [];
    for (const co of [CO, OTHER]) await setCap(ctx, co, COMPANY_SCOPE, 1000, "owner-1");
    const store = async (input: StoreInput) => {
      const id = input.id!;
      await recordStoredAsset(ctx, { ...input, id, key: `studio/${input.companyId}/own/${id}/v1.mp3`, size: input.bytes.length, sha256: "x" });
      stored.push(id);
      return id;
    };
    deps = (music = fakeMusic(), over = {}) => ({ music, store, probe: async () => sound(30), ...over });
  });

  const rows = async (sql: string, params: unknown[] = []) => (await pg.db.query(sql, params)) as Record<string, unknown>[];
  const ledger = () => rows(`SELECT kind, credits::float AS credits FROM ${T("credit_ledger")} ORDER BY kind`);
  const gens = () => rows(`SELECT status, provider, model, error_code, error_message, asset_id, prompt, params, client_ref FROM ${T("generations")}`);
  const newEdit = async (companyId = CO, client?: string) => {
    const edit = await createEditAction(ctx, companyId, { title: "Spring ad" }, USER);
    if (client) await pg.db.execute(`UPDATE ${T("video_edits")} SET client_kind = 'company', client_ref = $2, client_name = $2 WHERE id = $1`, [edit.id, client]);
    return edit;
  };
  const p = (edit: { id: string; revision: number }, extra: Record<string, unknown> = {}) => ({ editId: edit.id, baseRevision: edit.revision, prompt: PROMPT, duration: 20, at: 2, ...extra });
  const useCap = async (credits: number, company = CO) => {
    const id = `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`;
    await pg.db.execute(`INSERT INTO ${T("generations")} (id, group_id, company_id, provider, model, prompt, period, estimated_credits) VALUES ($1, $1, $2, 'stability', 'm', 'p', $3, 1)`, [id, company, PERIOD]);
    await pg.db.execute(`INSERT INTO ${T("credit_ledger")} (generation_id, kind, company_id, period, credits) VALUES ($1, 'reserve', $2, $3, $4)`, [id, company, PERIOD, credits]);
  };

  it("succeeds within the wait: one row, one reserve of 1.28, an audio/mpeg asset in the edit's scope, a clip at `at`, no prompt in logs", async () => {
    const edit = await newEdit(CO, "client-a");
    const g = Object.assign(gen(ok()), {});
    const out = (await musicAction(ctx, CO, p(edit), USER, deps(g))) as Record<string, any>;
    expect(g.calls).toBe(1);
    expect(out).toMatchObject({ status: "succeeded", revision: edit.revision + 1, start: 2, creditsCharged: 1.28, usdCharged: 0.08 });
    expect(out.doc.tracks.find((t: any) => t.kind === "audio").clips).toEqual([expect.objectContaining({ id: out.clipId, assetId: out.assetId, start: 2, in: 0, out: 30 })]);
    expect(await ledger()).toEqual([{ kind: "reserve", credits: 1.28 }]);
    const [gen1] = await gens();
    expect(gen1).toMatchObject({ status: "succeeded", provider: "stability", model: "stable-audio-2.5", prompt: PROMPT, asset_id: out.assetId, client_ref: "client-a" });
    expect(gen1!.params).toEqual({ editId: edit.id, duration: 20, at: 2, licence: "stability-community" });
    const [asset] = await rows(`SELECT kind, client_ref FROM ${T("assets")} WHERE id = $1`, [out.assetId]);
    expect(asset).toEqual({ kind: "audio", client_ref: "client-a" });
    expect(logs.join("\n")).toContain('"outcome":"succeeded"');
    expect(logs.join("\n")).toContain('"ms":4200');
    expect(logs.join("\n")).not.toContain("secret-launch-code");
  });

  it("is invisible to another client: assets, generations, usageByClient and caps view", async () => {
    const a = await newEdit(CO, "client-a");
    await musicAction(ctx, CO, p(a), USER, deps());
    const clientB = { kind: "company", id: "client-b" } as const;
    expect(await listAssets(ctx, CO, { scope: clientB })).toEqual([]);
    expect((await listAssets(ctx, CO, { scope: { kind: "company", id: "client-a" } })).length).toBe(1);
    expect(await rows(`SELECT id FROM ${T("generations")} WHERE client_kind = 'company' AND client_ref = 'client-b'`)).toEqual([]);
    const byClient = await usageByClient(ctx, CO, PERIOD);
    expect(byClient.get("company:client-a")).toBe(1.28);
    expect(byClient.has("company:client-b")).toBe(false);
    await setCap(ctx, CO, "company:client-b", 50, "owner-1");
    expect((await capCheck(ctx, CO, clientB, PERIOD)).used).toBe(0);
    
  });

  for (const status of [400, 429]) {
    it(`charged "no" (${status}): failed, exactly one refund, net 0, "Nothing was charged."`, async () => {
      const edit = await newEdit();
      const err = await musicAction(ctx, CO, p(edit), USER, deps(gen(refused("no", status)))).catch((e) => e);
      expect(err).toMatchObject({ code: "provider_error", message: expect.stringContaining("Nothing was charged.") });
      expect(await ledger()).toEqual([{ kind: "refund", credits: -1.28 }, { kind: "reserve", credits: 1.28 }]);
      expect((await gens())[0]).toMatchObject({ status: "failed", asset_id: null });
    });
  }

  const maybes: Array<[string, MusicResult]> = [
    ["502", refused("maybe", 502)],
    ["200 with non-mp3 bytes", refused("maybe", 200)],
    ["timeout", refused("maybe", null, "provider_unknown")],
  ];
  for (const [label, result] of maybes) {
    it(`charged "maybe" (${label}): failed, no refund, counted by the cap`, async () => {
      const edit = await newEdit();
      const err = await musicAction(ctx, CO, p(edit), USER, deps(gen(result))).catch((e) => e);
      expect(err.message).toContain("may have been charged");
      expect(await ledger()).toEqual([{ kind: "reserve", credits: 1.28 }]);
      expect((await gens())[0]).toMatchObject({ status: "failed" });
      await expect(useCap(398.72).then(() => musicAction(ctx, CO, p(edit), USER, deps()))).rejects.toMatchObject({ code: "provider_cap_reached" });
    });
  }

  it("a store failure after the bytes arrived fails the row, keeps the charge and says so", async () => {
    const edit = await newEdit();
    const err = await musicAction(ctx, CO, p(edit), USER, deps(fakeMusic(), { store: async () => Promise.reject(new Error("r2 down")) })).catch((e) => e);
    expect(err).toMatchObject({ code: "store_failed", message: expect.stringContaining("charged") });
    expect(await ledger()).toEqual([{ kind: "reserve", credits: 1.28 }]);
    expect((await gens())[0]).toMatchObject({ status: "failed", error_code: "store_failed" });
  });

  it("a conditional settle that moves 0 rows does not refund (sweeper race)", async () => {
    const edit = await newEdit();
    const swept = gen(async () => {
      await pg.db.execute(`UPDATE ${T("generations")} SET status = 'failed', error_code = 'lost_submission'`);
      return refused("no", 429);
    });
    const err = await musicAction(ctx, CO, p(edit), USER, deps(swept)).catch((e) => e);
    expect(err.message).toContain("may have been charged");
    expect(await ledger()).toEqual([{ kind: "reserve", credits: 1.28 }]);
  });

  it("a slow job answers synthesizing within the wait; it later settles succeeded, in the Library, with no clip and the revision unchanged", async () => {
    const edit = await newEdit();
    let release!: (r: MusicResult) => void;
    const slow = gen(() => new Promise<MusicResult>((r) => (release = r)));
    let slept = -1;
    const out = (await musicAction(ctx, CO, p(edit), USER, deps(slow, { now: () => 1_000, sleep: async (ms) => void (slept = ms) }))) as Record<string, any>;
    expect(slept).toBe(20_000);
    expect(out).toMatchObject({ status: "synthesizing", message: expect.stringContaining("Don't start it again") });
    expect((await gens())[0]).toMatchObject({ status: "synthesizing" });
    release(ok());
    await expect.poll(async () => (await gens())[0]!.status).toBe("succeeded");
    expect(await listAssets(ctx, CO, { scope: null })).toHaveLength(1);
    const [e] = await rows(`SELECT revision FROM ${T("video_edits")} WHERE id = $1`, [edit.id]);
    expect(Number(e!.revision)).toBe(edit.revision);
    expect(await ledger()).toEqual([{ kind: "reserve", credits: 1.28 }]);
  });

  it("no key: not_configured, no row, no reserve, no fetch", async () => {
    const edit = await newEdit();
    let fetched = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (async () => (fetched++, new Response(null, { status: 500 }))) as typeof fetch;
    try {
      await expect(musicAction(ctx, CO, p(edit), USER, { store: deps().store })).rejects.toMatchObject({ code: "not_configured" });
    } finally {
      globalThis.fetch = real;
    }
    expect(fetched).toBe(0);
    expect(await gens()).toEqual([]);
    expect(await ledger()).toEqual([]);
  });

  it("cap reached: provider_cap_reached with no row, reserve or call; company cap and run limit use their own codes", async () => {
    const edit = await newEdit();
    await useCap(399.36);
    const g = gen(ok());
    await expect(musicAction(ctx, CO, p(edit), USER, deps(g))).rejects.toMatchObject({ code: "provider_cap_reached", message: expect.stringContaining(`USD ${STABLE_AUDIO_MONTHLY_USD_CAP}`) });
    expect(g.calls).toBe(0);
    expect(await gens()).toHaveLength(1); // only the seeded usage row
    expect(await ledger()).toHaveLength(1);

    await pg.reset();
    const edit2 = await newEdit();
    await setCap(ctx, CO, COMPANY_SCOPE, 0.01, "owner-1");
    const g2 = gen(ok());
    const e1 = await musicAction(ctx, CO, p(edit2), USER, deps(g2)).catch((e) => e);
    expect(e1.code).toBe("cap_reached");
    await setCap(ctx, CO, COMPANY_SCOPE, 1000, "owner-1");
    await setCap(ctx, CO, agentLimitKey("agent-1"), 0.01, "owner-1");
    const e2 = (await runVideoEditTool(ctx, "video-edit-music", p(edit2), { companyId: CO, agentId: "agent-1", runId: "run-1" }, { projectId: null }, { music: deps(g2) }).catch((e: unknown) => e)) as { code?: string };
    expect(e2.code).toBe("run_limit");
    expect(g2.calls).toBe(0);
    expect(await gens()).toEqual([]);
  });

  it("two parallel calls at 398.72 reserve exactly once, in one company and across two companies", async () => {
    await useCap(398.72);
    const a = await newEdit();
    const b = await newEdit();
    const same = await Promise.allSettled([musicAction(ctx, CO, p(a), USER, deps()), musicAction(ctx, CO, p(b), USER, deps())]);
    expect(same.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(same.filter((r) => r.status === "rejected")[0]).toMatchObject({ reason: { code: "provider_cap_reached" } });
    expect(await rows(`SELECT 1 FROM ${T("credit_ledger")} WHERE kind = 'reserve' AND credits = 1.28`)).toHaveLength(1);

    await pg.reset();
    for (const co of [CO, OTHER]) await setCap(ctx, co, COMPANY_SCOPE, 1000, "owner-1");
    await useCap(398.72);
    const c = await newEdit(CO);
    const d = await newEdit(OTHER);
    const two = await Promise.allSettled([musicAction(ctx, CO, p(c), USER, deps()), musicAction(ctx, OTHER, p(d), USER, deps())]);
    expect(two.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await rows(`SELECT 1 FROM ${T("credit_ledger")} WHERE kind = 'reserve' AND credits = 1.28`)).toHaveLength(1);
  });

  it("BYO music: with no key and the cap used up, adding a Library audio asset writes zero ledger rows", async () => {
    await useCap(400);
    const before = await ledger();
    const edit = await newEdit();
    await pg.db.execute(`INSERT INTO ${T("assets")} (id, company_id, name, kind, source) VALUES ('own-song', $1, 'song.mp3', 'audio', 'upload')`, [CO]);
    await pg.db.execute(`INSERT INTO ${T("asset_versions")} (asset_id, version, company_id, r2_key, mime, bytes, sha256) VALUES ('own-song', 1, $1, 'k', 'audio/mpeg', 3, 'x')`, [CO]);
    const made = addAudioOps(edit.doc, { id: "own-song", version: 1, seconds: 12 }, 0);
    if ("error" in made) throw new Error(made.error);
    const saved = await applyOpsAction(ctx, CO, { editId: edit.id, baseRevision: edit.revision, ops: made.ops }, USER);
    expect(saved.revision).toBe(edit.revision + 1);
    expect(await ledger()).toEqual(before);
    expect(await gens()).toHaveLength(1); // only the seeded usage row
  });
});
