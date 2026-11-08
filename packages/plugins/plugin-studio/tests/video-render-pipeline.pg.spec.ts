/**
 * The render pipeline (A7b) end to end against real Postgres: a fake R2 (stubbed fetch) and fake ffmpeg/ffprobe
 * scripts run through the real contained runner (timeout/prlimit/nice), then the same flow with real ffmpeg.
 */
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { assertOwnKey, MAX_ASSET_BYTES, type PrivateBucket } from "../src/storage.js";
import { AUDIO_ENCODER_ARGS } from "../src/video-edit/compile-audio.js";
import { ENCODER_ARGS } from "../src/video-edit/compile-video.js";
import { createRenderExecutor, verifyOutput } from "../src/video-edit/render-pipeline.js";
import { enqueueRender, getRender } from "../src/video-edit/render-queue.js";
import { createRenderRunner } from "../src/video-edit/runner.js";
import type { ProbeResult } from "../src/video-edit/probe.js";
import { PREVIEW_FILE, previewKeyFor, proxyArgs } from "../src/video-edit/proxy.js";
import { LIMITS } from "../src/video-edit/timeline.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const CO = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const BUCKET: PrivateBucket = { accountId: "acct", bucket: "b", accessKeyId: "k", secretAccessKey: "s" };
const bucket = async () => BUCKET;
const statfs = (async () => ({ bavail: 1e12, bsize: 1 })) as never;
const hasFfmpeg = ["/usr/bin/timeout", "/usr/bin/prlimit", "/usr/bin/nice"].every(existsSync) && spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

const available = await embeddedAvailable();
let pg: Pg;
let ctx: PluginContext;
let scratch: string;
let bins: { ffmpeg: string; ffprobe: string };
/** Fake R2: object key -> bytes. `puts` and `gets` record what the pipeline did. */
let r2: Map<string, Uint8Array<ArrayBuffer>>;
let puts: string[];
let gets: string[];
/** PUTs to keys that match answer HTTP 500. */
let failPuts: RegExp | null;
let warns: Array<{ msg: string; meta: unknown }>;

const keyOf = (url: string) => decodeURIComponent(new URL(url).pathname).replace(/^\/b\//, "");

beforeAll(async () => {
  if (!available) return;
  pg = await startPg();
  ctx = { db: pg.db, logger: { info: () => undefined, warn: (msg: string, meta: unknown) => warns.push({ msg, meta }), error: () => undefined, debug: () => undefined } } as unknown as PluginContext;
}, 120_000);

afterAll(async () => {
  if (available) await pg.stop();
});

beforeEach(async () => {
  if (available) await pg.reset();
  scratch = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "pipeline-spec-"));
  vi.stubEnv("PIB_STUDIO_WORKDIR", join(scratch, "work"));
  r2 = new Map();
  puts = [];
  gets = [];
  failPuts = null;
  warns = [];
  vi.stubGlobal("fetch", async (url: string, init?: { method?: string; body?: Uint8Array }) => {
    const key = keyOf(url);
    if (init?.method === "PUT") {
      if (failPuts?.test(key)) return new Response(null, { status: 500 });
      puts.push(key);
      r2.set(key, new Uint8Array(init.body!));
      return new Response(null, { status: 200 });
    }
    gets.push(key);
    const body = r2.get(key);
    return body ? new Response(body, { status: 200, headers: { "content-length": String(body.length) } }) : new Response(null, { status: 404 });
  });
  // Fake tools. Inputs and outputs are JSON: {probe: <ffprobe json>, render?: <probe json of what ffmpeg will write>}.
  // The render run has a filter script; the preview run (no script) copies the render's probe, or fails on `failProxy`.
  const node = `#!${process.execPath}`;
  const ffmpeg = join(scratch, "fake-ffmpeg");
  const ffprobe = join(scratch, "fake-ffprobe");
  await writeFile(
    ffmpeg,
    `${node}
const fs = require("fs");
const args = process.argv.slice(2);
const inputs = args.flatMap((a, i) => (args[i - 1] === "-i" ? [a.replace(/^file:/, "")] : []));
const first = JSON.parse(fs.readFileSync(inputs[0], "utf8"));
if (!fs.existsSync("video.graph")) { process.stderr.write("no graph"); process.exit(1); }
if (first.failProxy && !args.includes("-filter_complex_script")) { process.stderr.write("proxy broke"); process.exit(1); }
fs.writeFileSync(args[args.length - 1].replace(/^file:/, ""), JSON.stringify({ probe: first.render ?? first.probe, failProxy: first.failProxy, args, graph: fs.readFileSync("video.graph", "utf8") }));
`,
  );
  await writeFile(ffprobe, `${node}\nconst fs = require("fs");\nconst a = process.argv[process.argv.length - 1].replace(/^file:/, "");\nprocess.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(a, "utf8")).probe));\n`);
  await chmod(ffmpeg, 0o755);
  await chmod(ffprobe, 0o755);
  bins = { ffmpeg, ffprobe };
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(scratch, { recursive: true, force: true });
});

const probeJson = (duration: number, audio: boolean) => ({
  format: { duration: String(duration), format_name: "mov,mp4" },
  streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920 }, ...(audio ? [{ codec_type: "audio", codec_name: "aac" }] : [])],
});

async function addAsset(id: string, opts: { companyId?: string; client?: { kind: string; id: string } | null; key?: string; content?: Uint8Array<ArrayBuffer>; kind?: string; mime?: string } = {}) {
  const companyId = opts.companyId ?? CO;
  const key = opts.key ?? `studio/${companyId}/own/${id}/v1.mp4`;
  const content = opts.content ?? new TextEncoder().encode("{}");
  await pg.db.execute(
    `INSERT INTO ${pg.db.namespace}.assets (id, company_id, client_kind, client_ref, name, kind, source) VALUES ($1, $2, $3, $4, 'in.mp4', $5, 'upload')`,
    [id, companyId, opts.client?.kind ?? null, opts.client?.id ?? null, opts.kind ?? "video"],
  );
  await pg.db.execute(
    `INSERT INTO ${pg.db.namespace}.asset_versions (asset_id, version, company_id, r2_key, mime, bytes, sha256) VALUES ($1, 1, $2, $3, $4, $5, 'x')`,
    [id, companyId, key, opts.mime ?? "video/mp4", content.length],
  );
  r2.set(key, content);
}

/** A source whose fake probe says `source` and whose fake render will probe as `render`. */
const fakeSource = (source: { duration: number; audio: boolean }, render: { duration: number; audio: boolean }, failProxy = false) =>
  new TextEncoder().encode(JSON.stringify({ probe: probeJson(source.duration, source.audio), render: probeJson(render.duration, render.audio), failProxy }));

const doc = (assetId: string, out = 4) => ({ schemaVersion: 1, project: { size: "9:16", fps: 30 }, tracks: [{ id: "v", kind: "video", clips: [{ id: "c", assetId, version: 1, in: 0, out, start: 0 }] }] });

async function render(d: unknown, client: { kind: string; id: string } | null = null, options: Parameters<typeof createRenderExecutor>[0] = {}) {
  await pg.db.execute(`INSERT INTO ${pg.db.namespace}.video_edits (id, company_id, client_kind, client_ref, project_id, title, doc) VALUES ('edit-1', $1, $2, $3, 'proj-1', 'Spring ad', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`, [
    CO,
    client?.kind ?? null,
    client?.id ?? null,
  ]);
  const job = await enqueueRender(ctx, { companyId: CO, client, editId: "edit-1", editRevision: 3, doc: d, preset: "9:16" });
  const runner = createRenderRunner(ctx, { executor: createRenderExecutor({ bucket, statfs, run: { bins }, ...options }), heartbeatMs: 50 });
  expect((await runner.tick()).claimed).toBe(job.id);
  await runner.settled();
  return getRender(ctx, CO, job.id);
}

type OutRow = { id: string; source: string; source_ref: string; name: string; project_id: string; kind: string; r2_key: string; bytes: string };
const assetRows = async () => (await pg.db.query(
  `SELECT a.id, a.source, a.source_ref, a.name, a.project_id, a.kind, v.r2_key, v.bytes FROM ${pg.db.namespace}.assets a JOIN ${pg.db.namespace}.asset_versions v ON v.asset_id = a.id WHERE a.source = 'edit'`,
)) as OutRow[];
const workFolders = async () => readdir(join(scratch, "work", "renders")).catch(() => [] as string[]);

describe("verifyOutput", () => {
  const p = (duration: number, video: boolean, audio: boolean) => ({ durationSec: duration, hasVideo: video, hasAudio: audio }) as ProbeResult;
  it("checks video, duration within 0.1 s, and audio iff the edit has sound", () => {
    expect(verifyOutput(p(10.1, true, true), { duration: 10, audio: true })).toBeNull();
    expect(verifyOutput(p(9.9, true, false), { duration: 10, audio: false })).toBeNull();
    expect(verifyOutput(p(10.2, true, true), { duration: 10, audio: true })).toMatch(/lasts 10.200 s/);
    expect(verifyOutput(p(10, false, true), { duration: 10, audio: true })).toMatch(/no video/);
    expect(verifyOutput(p(10, true, false), { duration: 10, audio: true })).toMatch(/lost its sound/);
    expect(verifyOutput(p(10, true, true), { duration: 10, audio: false })).toMatch(/sound the edit does not/);
  });

  it("size estimate: the longest render at the encoder's rate caps stays under 200 MB (A9 checks it live)", () => {
    const rate = (args: readonly string[], flag: string) => Number(args[args.indexOf(flag) + 1]!.replace(/M$/, "e6").replace(/k$/, "e3"));
    const bytes = ((rate(ENCODER_ARGS, "-maxrate") + rate(AUDIO_ENCODER_ARGS, "-b:a")) * LIMITS.maxDuration) / 8;
    expect(bytes).toBeLessThan(MAX_ASSET_BYTES * 0.75);
  });
});

describe.skipIf(!available)("Render pipeline against real Postgres (fake ffmpeg)", () => {
  it("downloads inputs by their rows, compiles, runs, verifies, uploads and records the asset", async () => {
    await addAsset("src-a", { content: fakeSource({ duration: 10, audio: true }, { duration: 4.05, audio: true }) });
    const done = await render(doc("src-a"));
    const key = `studio/${CO}/own/${done.id}/v1.mp4`;
    const preview = `studio/${CO}/own/${done.id}/${PREVIEW_FILE}`;
    expect(done).toMatchObject({ status: "succeeded", assetId: done.id, errorKind: null, previewR2Key: preview });
    expect(gets).toEqual([`studio/${CO}/own/src-a/v1.mp4`]);
    expect(puts).toEqual([key, preview]);
    expect(() => assertOwnKey(CO, done.previewR2Key!)).not.toThrow();
    const proxy = JSON.parse(new TextDecoder().decode(r2.get(preview)));
    expect(proxy.args).not.toContain("-filter_complex_script");
    expect(proxy.args).toEqual(expect.arrayContaining(["libx264", "file:out.mp4", `file:${PREVIEW_FILE}`]));
    expect(warns).toEqual([]);
    const out = JSON.parse(new TextDecoder().decode(r2.get(key)));
    expect(out.args).toContain("-filter_complex_script");
    expect(out.args).toContain("[aout]");
    expect(out.graph).toContain("trim=");
    const rows = await assetRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: done.id, source: "edit", source_ref: done.id, kind: "video", r2_key: key, project_id: "proj-1", name: "Spring ad (rev 3)" });
    expect(Number(rows[0].bytes)).toBe(r2.get(key)!.length);
    expect(await workFolders()).toEqual([]);
  });

  it("a render that fails verification is deleted: no upload, no asset row, failed deterministic", async () => {
    // The source has sound, so the edit has sound; the output comes back silent and 0.5 s short.
    await addAsset("src-a", { content: fakeSource({ duration: 10, audio: true }, { duration: 3.5, audio: false }) });
    const done = await render(doc("src-a"));
    expect(done).toMatchObject({ status: "failed", errorKind: "deterministic", assetId: null, attempts: 1 });
    expect(done.error).toMatch(/lasts 3.500 s; the edit lasts 4.000 s/);
    expect(puts).toEqual([]);
    expect(await assetRows()).toEqual([]);
    expect(await workFolders()).toEqual([]);
  });

  it("an audio-kind clip on the audio track is downloaded, probed and mixed in: the edit has sound", async () => {
    await addAsset("mute", { content: fakeSource({ duration: 10, audio: false }, { duration: 4, audio: true }) });
    await addAsset("vo", { kind: "audio", mime: "audio/mpeg", key: `studio/${CO}/own/vo/v1.mp3`, content: fakeSource({ duration: 6, audio: true }, { duration: 4, audio: true }) });
    const d = { ...doc("mute"), tracks: [...doc("mute").tracks, { id: "a", kind: "audio", clips: [{ id: "vo1", assetId: "vo", version: 1, in: 0, out: 4, start: 0 }] }] };
    const done = await render(d);
    expect(done).toMatchObject({ status: "succeeded", errorKind: null });
    expect(gets).toEqual([`studio/${CO}/own/mute/v1.mp4`, `studio/${CO}/own/vo/v1.mp3`]);
    const out = JSON.parse(new TextDecoder().decode(r2.get(`studio/${CO}/own/${done.id}/v1.mp4`)));
    expect(out.args).toContain("[aout]");
    expect(out.args.some((a: string) => a.endsWith("in-1.mp3"))).toBe(true);
    expect(out.args).not.toContain("-an");
  });

  it("an audio-kind asset with no readable sound fails deterministic before ffmpeg runs", async () => {
    await addAsset("mute", { content: fakeSource({ duration: 10, audio: false }, { duration: 4, audio: false }) });
    await addAsset("vo", { kind: "audio", mime: "audio/wav", key: `studio/${CO}/own/vo/v1.wav`, content: fakeSource({ duration: 6, audio: false }, { duration: 4, audio: false }) });
    const d = { ...doc("mute"), tracks: [...doc("mute").tracks, { id: "a", kind: "audio", clips: [{ id: "vo1", assetId: "vo", version: 1, in: 0, out: 4, start: 0 }] }] };
    const done = await render(d);
    expect(done).toMatchObject({ status: "failed", errorKind: "deterministic" });
    expect(done.error).toMatch(/no sound Studio can read/);
    expect(puts).toEqual([]);
  });

  it("a silent edit must render silent", async () => {
    await addAsset("mute", { content: fakeSource({ duration: 10, audio: false }, { duration: 4, audio: true }) });
    const done = await render(doc("mute"));
    expect(done).toMatchObject({ status: "failed", errorKind: "deterministic" });
    expect(done.error).toMatch(/sound the edit does not/);
    expect(puts).toEqual([]);
  });

  it("refuses inputs outside the render's company or client, and keys outside the Studio folder, before any download", async () => {
    await addAsset("other-co", { companyId: OTHER, content: fakeSource({ duration: 10, audio: true }, { duration: 4, audio: true }) });
    await addAsset("client-b", { client: { kind: "company", id: "b" }, key: `studio/${CO}/company-b/client-b/v1.mp4` });
    await addAsset("escape", { key: `billing/${CO}/x/escape/v1.mp4` });
    expect(await render(doc("other-co"))).toMatchObject({ status: "failed", errorKind: "deterministic", error: expect.stringMatching(/not in this edit's library/) });
    await pg.db.execute(`DELETE FROM ${pg.db.namespace}.video_renders`);
    expect(await render(doc("client-b"))).toMatchObject({ status: "failed", errorKind: "deterministic", error: expect.stringMatching(/not in this edit's library/) });
    await pg.db.execute(`DELETE FROM ${pg.db.namespace}.video_renders`);
    expect(await render(doc("escape"))).toMatchObject({ status: "failed", errorKind: "deterministic", error: expect.stringMatching(/outside this company's Studio folder/) });
    expect(gets).toEqual([]);
    expect(puts).toEqual([]);
  });

  it("a version the timeline names that does not exist is refused", async () => {
    await addAsset("src-a", { content: fakeSource({ duration: 10, audio: true }, { duration: 4, audio: true }) });
    const d = doc("src-a");
    (d.tracks[0].clips[0] as { version: number }).version = 2;
    expect(await render(d)).toMatchObject({ status: "failed", errorKind: "deterministic", error: expect.stringMatching(/version 2/) });
  });

  it("a client render reads that client's inputs and stores under the client's folder", async () => {
    const client = { kind: "company", id: "acme" };
    await addAsset("src-c", { client, key: `studio/${CO}/company-acme/src-c/v1.mp4`, content: fakeSource({ duration: 10, audio: true }, { duration: 4, audio: true }) });
    const done = await render(doc("src-c"), client);
    expect(done.status).toBe("succeeded");
    expect(puts).toEqual([`studio/${CO}/company-acme/${done.id}/v1.mp4`, `studio/${CO}/company-acme/${done.id}/${PREVIEW_FILE}`]);
    expect(done.previewR2Key).toBe(`studio/${CO}/company-acme/${done.id}/${PREVIEW_FILE}`);
  });

  it("a failed preview proxy is logged and the render still succeeds with no preview key", async () => {
    await addAsset("src-a", { content: fakeSource({ duration: 10, audio: true }, { duration: 4, audio: true }, true) });
    const done = await render(doc("src-a"));
    expect(done).toMatchObject({ status: "succeeded", assetId: done.id, errorKind: null, error: null, previewR2Key: null, attempts: 1 });
    expect(puts).toEqual([`studio/${CO}/own/${done.id}/v1.mp4`]);
    expect((await assetRows())[0]).toMatchObject({ id: done.id, source: "edit" });
    expect(warns).toEqual([{ msg: "Studio render preview failed", meta: expect.objectContaining({ renderId: done.id }) }]);
    expect(await workFolders()).toEqual([]);
  });

  it("a failed preview upload is logged and the render still succeeds with no preview key", async () => {
    await addAsset("src-a", { content: fakeSource({ duration: 10, audio: true }, { duration: 4, audio: true }) });
    failPuts = /\/preview-720p\.mp4$/;
    const done = await render(doc("src-a"));
    expect(done).toMatchObject({ status: "succeeded", assetId: done.id, error: null, previewR2Key: null });
    expect(r2.has(`studio/${CO}/own/${done.id}/v1.mp4`)).toBe(true);
    expect(warns).toEqual([{ msg: "Studio render preview upload failed", meta: expect.objectContaining({ renderId: done.id, error: expect.stringMatching(/HTTP 500/) }) }]);
  });

  it("the preview key sits in the render's own asset folder and passes assertOwnKey; ffmpeg gets an args array", () => {
    const key = `studio/${CO}/company-acme/r-1/v1.mp4`;
    expect(previewKeyFor(CO, key)).toBe(`studio/${CO}/company-acme/r-1/${PREVIEW_FILE}`);
    expect(() => assertOwnKey(CO, previewKeyFor(CO, key))).not.toThrow();
    expect(() => previewKeyFor(CO, `billing/${CO}/x/r-1/v1.mp4`)).toThrow(/outside/);
    expect(() => previewKeyFor(OTHER, key)).toThrow(/outside/);
    const args = proxyArgs("out.mp4", PREVIEW_FILE);
    expect(args.slice(0, 2)).toEqual(["-i", "file:out.mp4"]);
    expect(args.at(-1)).toBe(`file:${PREVIEW_FILE}`);
    expect(args).toEqual(expect.arrayContaining(["-map", "0:a?", "libx264", "+faststart"]));
  });

  it("a retry after the asset was recorded does not render again", async () => {
    await addAsset("src-a", { content: fakeSource({ duration: 10, audio: true }, { duration: 4, audio: true }) });
    const first = await render(doc("src-a"));
    const executor = createRenderExecutor({ bucket, statfs, run: { bins } });
    const control = { signal: new AbortController().signal, started: async () => true, uploading: async () => true };
    gets.length = 0;
    expect(await executor(ctx, { ...first, claimToken: "t" }, control)).toEqual({ assetId: first.id });
    expect(gets).toEqual([]);
  });
});

describe.skipIf(!available || !hasFfmpeg)("Render pipeline with real ffmpeg", () => {
  it("a silent video plus the MP3 fixture on the audio track renders with sound", async () => {
    const src = join(scratch, "mute.mp4");
    const made = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-an", src]);
    expect(made.status).toBe(0);
    await addAsset("mute", { content: new Uint8Array(await readFile(src)) });
    const mp3 = new Uint8Array(await readFile(join(import.meta.dirname, "fixtures", "tone.mp3")));
    await addAsset("vo", { kind: "audio", mime: "audio/mpeg", key: `studio/${CO}/own/vo/v1.mp3`, content: mp3 });
    const d = { ...doc("mute", 0.5), tracks: [...doc("mute", 0.5).tracks, { id: "a", kind: "audio", clips: [{ id: "vo1", assetId: "vo", version: 1, in: 0, out: 0.5, start: 0 }] }] };
    const done = await render(d, null, { run: {} });
    expect(done).toMatchObject({ status: "succeeded", errorKind: null });
    const file = join(scratch, "out-vo.mp4");
    await writeFile(file, r2.get(`studio/${CO}/own/${done.id}/v1.mp4`)!);
    const probe = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", file]).stdout.toString());
    expect(probe.streams.some((s: { codec_type: string }) => s.codec_type === "audio")).toBe(true);
  }, 120_000);

  // The longest edit (180 s) at 1080x1920 through the whole pipeline: ~30 s on pib-vps (4 threads), well under 200 MB.
  it("renders a 180 s testsrc+sine edit into a verified 1080x1920 MP4 with sound, under 200 MB", async () => {
    const src = join(scratch, "src.mp4");
    const made = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "181", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", src]);
    expect(made.status).toBe(0);
    await addAsset("real", { content: new Uint8Array(await readFile(src)) });
    const done = await render(doc("real", LIMITS.maxDuration), null, { run: {} });
    expect(done).toMatchObject({ status: "succeeded", errorKind: null });
    const out = r2.get(`studio/${CO}/own/${done.id}/v1.mp4`)!;
    const file = join(scratch, "out.mp4");
    await writeFile(file, out);
    const probe = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]).stdout.toString());
    const video = probe.streams.find((s: { codec_type: string }) => s.codec_type === "video");
    expect(video).toMatchObject({ width: 1080, height: 1920, codec_name: "h264" });
    expect(probe.streams.some((s: { codec_type: string }) => s.codec_type === "audio")).toBe(true);
    expect(Math.abs(Number(probe.format.duration) - LIMITS.maxDuration)).toBeLessThanOrEqual(0.1);
    expect(out.length).toBeLessThan(MAX_ASSET_BYTES);
    expect((await assetRows())[0]).toMatchObject({ id: done.id, source: "edit", source_ref: done.id });
    // The 720p proxy: short side 720, H.264, with the sound.
    expect(done.previewR2Key).toBe(`studio/${CO}/own/${done.id}/${PREVIEW_FILE}`);
    const pfile = join(scratch, "preview.mp4");
    await writeFile(pfile, r2.get(done.previewR2Key!)!);
    const pprobe = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", pfile]).stdout.toString());
    expect(pprobe.streams.find((s: { codec_type: string }) => s.codec_type === "video")).toMatchObject({ width: 720, height: 1280, codec_name: "h264" });
    expect(pprobe.streams.some((s: { codec_type: string }) => s.codec_type === "audio")).toBe(true);
    expect(Math.abs(Number(pprobe.format.duration) - LIMITS.maxDuration)).toBeLessThanOrEqual(0.1);
  }, 300_000);
});
