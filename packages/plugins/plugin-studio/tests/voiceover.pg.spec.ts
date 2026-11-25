/** Voiceover action and ledger (PAR-8407 T3) against real Postgres: charge, refunds, placement and the sweeper. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { recordStoredAsset, type StoreInput } from "../src/assets.js";
import { processQueue, resetQueueStateForTests, SYNTH_LOST_AFTER_MS } from "../src/generation.js";
import { agentLimitKey, COMPANY_SCOPE, setCap } from "../src/ledger.js";
import { fakeProvider } from "../src/provider.js";
import { addAudioOps } from "../src/ui/editor/audio-track.js";
import { createEditAction } from "../src/video-edit/actions.js";
import * as shared from "../src/video-edit/audio-ops.js";
import type { ProbeResult } from "../src/video-edit/probe.js";
import { fakeTextToSpeech, type TextToSpeech } from "../src/video-edit/tts.js";
import { runVideoEditTool } from "../src/video-edit/tools.js";
import { voiceoverAction, type VoiceoverDeps } from "../src/video-edit/voiceover.js";
import { ttsCredits } from "../src/video-edit/tts-price.js";
import { StudioError } from "../src/errors.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const CO = "11111111-1111-4111-8111-111111111111";
const USER = { userId: "owner-1" };
const SCRIPT = "Welcome to the spring sale. Everything is twenty percent off this week.";
const C = ttsCredits(SCRIPT.length);

const available = await embeddedAvailable();
let pg: Pg;

beforeAll(async () => {
  if (available) pg = await startPg();
}, 120_000);

afterAll(async () => {
  if (available) await pg.stop();
});

const T = (name: string) => `${pg.db.namespace}.${name}`;

function makeCtx(): PluginContext {
  return {
    db: pg.db,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    config: { get: async () => ({}) },
    state: { get: async () => null, set: async () => undefined, delete: async () => undefined },
    projects: { get: async () => null },
  } as unknown as PluginContext;
}

const sound = (durationSec: number): ProbeResult => ({ durationSec, width: null, height: null, fps: null, videoCodec: null, audioCodec: "mp3", hasVideo: false, hasAudio: true, formatName: "mp3", sizeBytes: 18 }) as unknown as ProbeResult;

describe.skipIf(!available)("Voiceover against real Postgres", () => {
  let ctx: PluginContext;
  let stored: string[];
  let deps: (over?: Partial<VoiceoverDeps>) => VoiceoverDeps & { tts: ReturnType<typeof fakeTextToSpeech> };
  beforeEach(async () => {
    await pg.reset();
    resetQueueStateForTests();
    ctx = makeCtx();
    stored = [];
    await setCap(ctx, CO, COMPANY_SCOPE, 10, "owner-1");
    const store = async (input: StoreInput) => {
      const id = input.id!;
      await recordStoredAsset(ctx, { ...input, id, key: `studio/${CO}/own/${id}/v1.mp3`, size: input.bytes.length, sha256: "x" });
      stored.push(id);
      return id;
    };
    deps = (over = {}) => ({ tts: fakeTextToSpeech(), store, probe: async () => sound(4.5), ...over }) as VoiceoverDeps & { tts: ReturnType<typeof fakeTextToSpeech> };
  });

  const rows = async (sql: string, params: unknown[] = []) => (await pg.db.query(sql, params)) as Record<string, unknown>[];
  const ledger = () => rows(`SELECT kind, credits::float AS credits FROM ${T("credit_ledger")} ORDER BY kind`);
  const gens = () => rows(`SELECT status, provider, model, error_code, asset_id, prompt FROM ${T("generations")}`);
  const newEdit = () => createEditAction(ctx, CO, { title: "Spring ad" }, USER);

  it("speaks the script, stores a kind audio asset and puts it on the audio track at `at`, with one reserve row", async () => {
    const edit = await newEdit();
    const d = deps();
    const out = await voiceoverAction(ctx, CO, { editId: edit.id, baseRevision: edit.revision, script: SCRIPT, voice: "Ara", at: 2 }, USER, d);
    expect(d.tts.calls).toEqual([{ text: SCRIPT, voice: "ara", language: "en" }]);
    expect(out).toMatchObject({ revision: edit.revision + 1, start: 2, creditsCharged: C });
    const track = out.doc.tracks.find((t) => t.kind === "audio")!;
    expect(track.clips).toEqual([expect.objectContaining({ id: out.clipId, assetId: out.assetId, start: 2, in: 0, out: 4.5 })]);
    const [asset] = await rows(`SELECT kind, source, generation_id FROM ${T("assets")} WHERE id = $1`, [out.assetId]);
    expect(asset).toEqual({ kind: "audio", source: "generated", generation_id: out.assetId });
    expect(await ledger()).toEqual([{ kind: "reserve", credits: C }]); // no adjust
    const [gen] = await gens();
    expect(gen).toMatchObject({ status: "succeeded", provider: "xai", model: "grok-tts", asset_id: out.assetId });
    expect(String(gen!.prompt)).not.toContain("spring"); // the script is not kept as the prompt
  });

  it("uses the same addAudioOps as the editor", () => {
    expect(addAudioOps).toBe(shared.addAudioOps);
  });

  it("refuses over the ceiling, over the monthly cap and over the run limit before calling the provider", async () => {
    const edit = await newEdit();
    const params = { editId: edit.id, baseRevision: edit.revision, script: SCRIPT };
    let d = deps({ ceiling: 0.001 });
    await expect(voiceoverAction(ctx, CO, params, USER, d)).rejects.toMatchObject({ code: "over_ceiling" });
    await setCap(ctx, CO, COMPANY_SCOPE, 0.01, "owner-1");
    await expect(voiceoverAction(ctx, CO, params, USER, d = deps())).rejects.toMatchObject({ code: "cap_reached" });
    expect(d.tts.calls).toEqual([]);
    await setCap(ctx, CO, COMPANY_SCOPE, 10, "owner-1");
    await setCap(ctx, CO, agentLimitKey("agent-1"), 0.01, "owner-1");
    const run = deps();
    await expect(runVideoEditTool(ctx, "video-edit-voiceover", params, { companyId: CO, agentId: "agent-1", runId: "run-1" }, { projectId: null }, { voiceover: run })).rejects.toMatchObject({ code: "run_limit" });
    expect(run.tts.calls).toEqual([]);
    expect(await gens()).toEqual([]);
    expect(await ledger()).toEqual([]);
  });

  const failing: Array<[string, (d: VoiceoverDeps) => VoiceoverDeps]> = [
    ["the provider errors", (d) => ({ ...d, tts: { ...d.tts!, synthesize: async () => Promise.reject(new StudioError("Text to speech failed (500).", "provider_error")) } as TextToSpeech })],
    ["the answer is not MP3", (d) => ({ ...d, tts: { key: "xai", model: "grok-tts", voices: ["eve"], synthesize: () => import("../src/video-edit/tts.js").then((m) => m.xaiTextToSpeech("k", async () => new Response("<html>", { status: 200 })).synthesize({ text: "x", voice: "eve", language: "en" })) } })],
    ["storing throws", (d) => ({ ...d, store: async () => Promise.reject(new Error("R2 down")) })],
  ];
  for (const [why, make] of failing) {
    it(`refunds and fails the row when ${why}`, async () => {
      const edit = await newEdit();
      await expect(voiceoverAction(ctx, CO, { editId: edit.id, baseRevision: edit.revision, script: SCRIPT }, USER, make(deps()))).rejects.toThrow(/Nothing was charged/);
      expect(await ledger()).toEqual([{ kind: "refund", credits: -C }, { kind: "reserve", credits: C }]);
      expect((await gens())[0]).toMatchObject({ status: "failed", asset_id: null });
    });
  }

  it("keeps the charge and names the asset when it cannot be placed", async () => {
    const edit = await newEdit();
    const err = await voiceoverAction(ctx, CO, { editId: edit.id, baseRevision: edit.revision, script: SCRIPT }, USER, deps({ probe: async () => sound(0) })).then(() => new Error("placed"), (e: Error & { code?: string }) => e);
    expect(err).toMatchObject({ code: "voiceover_not_placed" });
    expect(stored).toHaveLength(1);
    expect(String(err.message)).toContain(stored[0]!);
    expect(await ledger()).toEqual([{ kind: "reserve", credits: C }]);
    expect((await gens())[0]).toMatchObject({ status: "succeeded", asset_id: stored[0] });
  });

  it("the Higgsfield queue never picks a synthesizing row; one stale over 10 minutes fails without a refund", async () => {
    const insert = (id: string, ageMs: number) =>
      pg.db.execute(
        `INSERT INTO ${T("generations")} (id, group_id, company_id, provider, model, prompt, status, period, estimated_credits, created_at, updated_at)
         VALUES ($1, $1, $2, 'xai', 'grok-tts', 'Voiceover', 'synthesizing', '2026-11', 0.5, now() - $3::interval, now() - $3::interval)`,
        [id, CO, `${Math.round(ageMs / 1000)} seconds`],
      );
    await insert("fresh", 60_000);
    await insert("stale", SYNTH_LOST_AFTER_MS + 60_000);
    await pg.db.execute(`INSERT INTO ${T("credit_ledger")} (generation_id, kind, company_id, period, credits) VALUES ('stale', 'reserve', $1, '2026-11', 0.5)`, [CO]);
    const provider = fakeProvider();
    const totals = await processQueue(ctx, { provider: async () => provider, download: async () => new Uint8Array(), now: () => Date.now() });
    expect(provider.submitted()).toBe(0);
    expect(totals).toMatchObject({ submitted: 0, failed: 1 });
    const byId = Object.fromEntries((await rows(`SELECT id, status, error_code FROM ${T("generations")}`)).map((r) => [r.id, r]));
    expect(byId.fresh).toMatchObject({ status: "synthesizing" });
    expect(byId.stale).toMatchObject({ status: "failed", error_code: "lost_submission" });
    expect(await ledger()).toEqual([{ kind: "reserve", credits: 0.5 }]); // no refund
  });
});
