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
import { ENCODER_ARGS, inputKey, type CompileInputs } from "../src/video-edit/compile-video.js";
import { DEFAULT_AS_LIMIT_BYTES, FSIZE_BYTES, pidsInGroup, TIMEOUT_SEC } from "../src/video-edit/ffmpeg.js";
import { createRenderExecutor, INTERMEDIATE_FSIZE_BYTES, PASS_CONCURRENCY, renderPasses, verifyOutput, type PassOptions } from "../src/video-edit/render-pipeline.js";
import { enqueueRender, getRender } from "../src/video-edit/render-queue.js";
import { cmdlineNames, createRenderRunner, RenderFailure } from "../src/video-edit/runner.js";
import type { ProbeResult } from "../src/video-edit/probe.js";
import { PREVIEW_FILE, previewKeyFor, proxyArgs } from "../src/video-edit/proxy.js";
import { LIMITS, normalizeEdit } from "../src/video-edit/timeline.js";
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
  // Each case copies fake media and runs the pipeline against Postgres; on the loaded CI runner some take ~5 s, over vitest's default (PAR-9343).
  vi.setConfig({ testTimeout: 30_000 });
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
    const control = { signal: new AbortController().signal, started: async () => true, passEnded: () => undefined, uploading: async () => true };
    gets.length = 0;
    expect(await executor(ctx, { ...first, claimToken: "t" }, control)).toEqual({ assetId: first.id });
    expect(gets).toEqual([]);
  });
});

/**
 * Multi-pass (PAR-10466): a fake ffmpeg run by the real `runContained` (timeout, prlimit, nice, own group) logs, per run,
 * its pass, pgid, prlimit limits, the `timeout` seconds of its parent and the work folder listing, then writes a JSON
 * "media" file whose probe follows its args (`-t`, `-an`, `.wav`). `mp.json` steers it: sleep, fail, drift, mute, linger.
 */
const hasContainment = ["/usr/bin/timeout", "/usr/bin/prlimit", "/usr/bin/nice", "/proc/self/limits"].every(existsSync);
describe.skipIf(!hasContainment)("Multi-pass render (real runContained, fake ffmpeg)", () => {
  vi.setConfig({ testTimeout: 30_000 });
  type Run = { id: string; pid: number; pgid: number; fsize: string; as: string; timeout: string; ls: string[]; graph: boolean };
  let mpBins: { ffmpeg: string; ffprobe: string };
  const log = () => join(scratch, "mp.log");
  const runs = async (): Promise<Run[]> => (await readFile(log(), "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const steer = (cfg: Record<string, unknown>) => writeFile(join(scratch, "mp.json"), JSON.stringify(cfg));

  beforeEach(async () => {
    const ffmpeg = join(scratch, "mp-ffmpeg");
    await writeFile(
      ffmpeg,
      `#!${process.execPath}
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
const out = args[args.length - 1].replace(/^file:/, "");
const cfgFile = ${JSON.stringify(join(scratch, "mp.json"))};
const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, "utf8")) : {};
const graph = args.includes("-filter_complex_script");
const id = !graph ? "proxy" : path.isAbsolute(out) ? path.basename(path.dirname(out)) : "final";
const root = path.isAbsolute(out) ? path.dirname(path.dirname(out)) : process.cwd();
const stat = fs.readFileSync("/proc/self/stat", "utf8");
const pgid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
const limit = (name) => fs.readFileSync("/proc/self/limits", "utf8").split("\\n").find((l) => l.startsWith(name)).slice(26).trim().split(/\\s+/)[0];
const parent = fs.readFileSync("/proc/" + process.ppid + "/cmdline", "utf8").split("\\0");
fs.appendFileSync(${JSON.stringify(join(scratch, "mp.log"))}, JSON.stringify({ id, pid: process.pid, pgid, fsize: limit("Max file size"), as: limit("Max address space"), timeout: parent[3], ls: fs.readdirSync(root).sort(), graph: fs.existsSync("video.graph") }) + "\\n");
if (cfg.linger) require("child_process").spawn("sleep", ["30"], { stdio: "ignore" }).unref();
process.stderr.write("frame=1\\n");
setTimeout(() => {
  if (cfg.fail && cfg.fail[id]) { process.stderr.write("boom " + id); process.exit(1); }
  if (!graph) {
    const input = args[args.indexOf("-i") + 1].replace(/^file:/, "");
    fs.writeFileSync(out, JSON.stringify({ probe: JSON.parse(fs.readFileSync(input, "utf8")).probe }));
    return;
  }
  const t = Number(args[args.lastIndexOf("-t") + 1]) + ((cfg.drift && cfg.drift[id]) || 0);
  const audio = !args.includes("-an") && !(cfg.mute && cfg.mute[id]);
  const streams = [...(out.endsWith(".wav") ? [] : [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920 }]), ...(audio ? [{ codec_type: "audio", codec_name: "pcm_s16le" }] : [])];
  fs.writeFileSync(out, JSON.stringify({ probe: { format: { duration: String(t) }, streams } }));
}, (cfg.sleep && cfg.sleep[id]) || 20);
`,
    );
    await chmod(ffmpeg, 0o755);
    mpBins = { ffmpeg, ffprobe: bins.ffprobe };
  });

  const clips = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, assetId: "src-a", version: 1, in: 0, out: 1, start: i }));
  const mainDoc = (n: number) => ({ schemaVersion: 1, project: { size: "9:16", fps: 30 }, tracks: [{ id: "v", kind: "video", clips: clips(n) }] });

  /** `renderPasses` on an `n`-clip edit of one 1080x1920 source (weight 1 a clip) at pass budget 3, in a fresh folder. */
  async function passes(n: number, opts: { audio?: boolean; options?: PassOptions; onStart?: (k: number, pgid: number) => void; abort?: AbortController } = {}) {
    const dir = await mkdtemp(join(scratch, "render-"));
    await writeFile(join(dir, "in-0.mp4"), JSON.stringify({ probe: probeJson(10, !!opts.audio) }));
    const sources: CompileInputs = { [inputKey("src-a", 1)]: { path: join(dir, "in-0.mp4"), kind: "video", hasAudio: !!opts.audio, width: 1080, height: 1920 } };
    const abort = opts.abort ?? new AbortController();
    const kills: Array<[number, string]> = [];
    const started: Array<{ pgid: number; workdir: string; names: boolean; leftover: number[]; endedBefore: number }> = [];
    let ended = 0;
    const control = {
      signal: abort.signal,
      async started(info: { pgid: number; workdir: string }) {
        // The previous pass's group is empty by the time the next pass is up.
        const leftover = started.length ? await pidsInGroup(started[started.length - 1].pgid) : [];
        started.push({ ...info, names: await cmdlineNames(info.pgid, dir), leftover, endedBefore: ended });
        opts.onStart?.(started.length, info.pgid);
        return true;
      },
      passEnded: () => void (ended += 1),
    };
    // One pass at a time unless a test asks for more (the side-by-side chunk tests below).
    const options: PassOptions = { statfs, passConcurrency: 1, ...opts.options, plan: { passBudget: 3, ...opts.options?.plan }, run: {
        bins: mpBins,
        killImpl: (pid, sig) => {
          kills.push([pid, sig]);
          process.kill(pid, sig);
        },
        ...opts.options?.run,
      },
    };
    const result = await renderPasses(normalizeEdit(mainDoc(n)), sources, dir, control, options).then((r) => ({ ok: r }), (e: unknown) => ({ error: e as RenderFailure }));
    return { dir, result, started, ended: () => ended, kills, abort, runs: await runs(), left: await readdir(dir) };
  }

  it("AC1/5/6: passes run one at a time in dir/<pass-id>/, each pgid started then ended, intermediates go after use", async () => {
    await steer({ linger: true, sleep: { final: 300 } });
    const r = await passes(8);
    expect(r.result).toMatchObject({ ok: { plan: "multi", passes: ["chunk-0-0", "chunk-0-1", "chunk-0-2", "chunk-0-3", "chunk-1-0", "chunk-1-1"] } });
    expect(r.runs.map((x) => x.id)).toEqual(["chunk-0-0", "chunk-0-1", "chunk-0-2", "chunk-0-3", "chunk-1-0", "chunk-1-1", "final"]);
    // Every pass's own group went through started() (one per spawn), then passEnded(); none outlived its pass.
    expect(r.started.map((s) => s.pgid)).toEqual(r.runs.map((x) => x.pgid));
    expect(r.started.every((s) => s.workdir === r.dir && s.leftover.length === 0)).toBe(true);
    expect(r.ended()).toBe(7);
    for (const s of r.started) expect(await pidsInGroup(s.pgid)).toEqual([]);
    // The final pass of an edit with no music and no overlays names the work folder (absolute chunk paths).
    expect(r.started[6].names).toBe(true);
    expect(r.runs.every((x) => x.graph)).toBe(true);
    // chunk-1-0 read chunk-0-0/1: gone before chunk-1-1; the final pass only sees what it reads; nothing is left after.
    expect(r.runs[5].ls.filter((f) => f.startsWith("chunk-"))).toEqual(["chunk-0-2", "chunk-0-3", "chunk-1-0", "chunk-1-1"]);
    expect(r.runs[6].ls.filter((f) => f.startsWith("chunk-"))).toEqual(["chunk-1-0", "chunk-1-1"]);
    expect(r.left.filter((f) => f.startsWith("chunk-"))).toEqual([]);
    expect(r.left).toContain("out.mp4");
    // Intermediates may grow to INTERMEDIATE_FSIZE_BYTES (6 GiB), the delivery file to 200 MB; the address space cap is the same for all.
    expect(r.runs.map((x) => Number(x.fsize))).toEqual([...Array(6).fill(INTERMEDIATE_FSIZE_BYTES), FSIZE_BYTES]);
    expect(r.runs.every((x) => Number(x.as) === DEFAULT_AS_LIMIT_BYTES)).toBe(true);
  });

  it("PAR-10764: a multi-pass plan on a low disk fails disk_low before any pass spawns; single-pass is unchanged", async () => {
    await steer({});
    const low = (async () => ({ bavail: 10 * 1024 ** 3, bsize: 1 })) as never;
    const r = await passes(8, { options: { statfs: low } });
    expect(r.result).toMatchObject({ error: { code: "disk_low" } });
    expect(r.started).toEqual([]);
    expect(r.runs).toEqual([]);
    const ok = await passes(2, { options: { statfs: low } });
    expect(ok.result).toMatchObject({ ok: { plan: "single" } });
  });

  it("AC1: cancelling during pass 2 kills only that group and starts no later pass", async () => {
    await steer({ linger: true, sleep: { "chunk-0-1": 20_000 } });
    const abort = new AbortController();
    const r = await passes(4, { abort, onStart: (k) => void (k === 2 && setTimeout(() => abort.abort(new RenderFailure("The render claim was lost.", "infra", "cancelled")), 100)) });
    expect(r.result).toMatchObject({ error: { code: "cancelled", kind: "infra" } });
    expect(r.runs.map((x) => x.id)).toEqual(["chunk-0-0", "chunk-0-1"]);
    const [first, second] = r.started.map((s) => s.pgid);
    expect(r.kills.filter(([, sig]) => sig === "SIGTERM")).toEqual([[-second, "SIGTERM"]]);
    expect(r.kills.filter(([pid]) => pid === -first)).toEqual([[-first, "SIGKILL"]]); // its own exit sweep, before pass 2
    expect(await pidsInGroup(second)).toEqual([]);
    expect(r.ended()).toBe(2);
  });

  it("AC2: one deadline from the first spawn; each pass gets what is left, under 60 s left fails timeout without spawning", async () => {
    await steer({});
    let t = 1_000_000;
    const clock = { now: () => t };
    const ok = await passes(4, { options: clock, onStart: () => void (t += 500_000) });
    expect(ok.result).toMatchObject({ ok: { plan: "multi" } });
    expect(ok.runs.map((x) => Number(x.timeout))).toEqual([TIMEOUT_SEC, TIMEOUT_SEC - 500, TIMEOUT_SEC - 1000]);
    await rm(log(), { force: true });
    const late = await passes(4, { options: clock, onStart: () => void (t += 1_150_000) });
    expect(late.result).toMatchObject({ error: { code: "timeout", kind: "infra" } });
    expect(late.runs.map((x) => x.id)).toEqual(["chunk-0-0"]);
  });

  it("AC3: a failed pass ends the render with its own failure", async () => {
    await steer({ fail: { "chunk-0-1": true } });
    const r = await passes(4);
    expect(r.result).toMatchObject({ error: { code: "ffmpeg_failed", kind: "deterministic", stderrTail: expect.stringContaining("boom chunk-0-1") } });
    expect(r.runs.map((x) => x.id)).toEqual(["chunk-0-0", "chunk-0-1"]);
  });

  it("AC4: a pass output off by more than a frame, or with the wrong sound, fails verify_failed before the next pass", async () => {
    await steer({ drift: { "chunk-0-0": 0.1 } });
    const long = await passes(4);
    expect(long.result).toMatchObject({ error: { code: "verify_failed", kind: "deterministic", message: expect.stringMatching(/chunk-0-0: it lasts 2.100 s; the plan says 2.000 s/) } });
    expect(long.runs.map((x) => x.id)).toEqual(["chunk-0-0"]);
    await rm(log(), { force: true });
    await steer({ drift: { "chunk-0-0": 0.03 } }); // within one frame (1/30 s)
    expect((await passes(4)).result).toMatchObject({ ok: { plan: "multi" } });
    await rm(log(), { force: true });
    await steer({ mute: { "chunk-0-0": true } });
    const mute = await passes(4, { audio: true, options: { plan: { passBudget: 4 } } }); // 1.1 a clip: two to a chunk
    expect(mute.result).toMatchObject({ error: { code: "verify_failed", message: expect.stringMatching(/chunk-0-0: it lost its sound/) } });
    expect(mute.runs).toHaveLength(1);
  });

  it.skipIf(!available)("through the runner: a multi-pass render uploads one verified file; a failed pass leaves no work folder", async () => {
    await steer({});
    await addAsset("src-a", { content: new TextEncoder().encode(JSON.stringify({ probe: probeJson(10, false) })) });
    const done = await render(mainDoc(4), null, { run: { bins: mpBins }, plan: { passBudget: 3 } });
    expect(done).toMatchObject({ status: "succeeded", errorKind: null });
    expect(puts).toEqual([`studio/${CO}/own/${done.id}/v1.mp4`, `studio/${CO}/own/${done.id}/${PREVIEW_FILE}`]);
    // The two chunks run side by side (PASS_CONCURRENCY), in either order; then the final pass and the proxy.
    const ids = (await runs()).map((x) => x.id);
    expect(ids.slice(0, 2).sort()).toEqual(["chunk-0-0", "chunk-0-1"]);
    expect(ids.slice(2)).toEqual(["final", "proxy"]);
    expect(await workFolders()).toEqual([]);
    await pg.db.execute(`DELETE FROM ${pg.db.namespace}.video_renders`);
    await steer({ fail: { "chunk-0-1": true } });
    const failed = await render(mainDoc(4), null, { run: { bins: mpBins }, plan: { passBudget: 3 } });
    expect(failed).toMatchObject({ status: "failed", errorKind: "deterministic", attempts: 1 });
    expect(await workFolders()).toEqual([]);
  });

  it.skipIf(!available)("AC7: one input too heavy for any pass fails TooComplexError after the probe, before any ffmpeg run", async () => {
    await steer({});
    const uhd120 = { ...probeJson(10, false), streams: [{ codec_type: "video", codec_name: "h264", width: 3840, height: 2160, avg_frame_rate: "120/1" }] };
    await addAsset("src-a", { content: new TextEncoder().encode(JSON.stringify({ probe: uhd120 })) });
    for (let i = 0; i < 2; i++) {
      await pg.db.execute(`DELETE FROM ${pg.db.namespace}.video_renders`);
      const done = await render(mainDoc(1), null, { run: { bins: mpBins } });
      expect(done).toMatchObject({ status: "failed", errorKind: "deterministic", attempts: 1, error: "One clip is too large to render (resolution x frame rate). Use a smaller source." });
    }
    expect(await runs()).toEqual([]);
    expect(gets).toEqual([`studio/${CO}/own/src-a/v1.mp4`, `studio/${CO}/own/src-a/v1.mp4`]);
    expect(puts).toEqual([]);
  });

  it("PAR-11217: the chunks of one level run two at a time; the next level and the final pass wait for all of them", async () => {
    await steer({ linger: true, sleep: { "chunk-0-0": 300, "chunk-0-1": 300, "chunk-0-2": 300, "chunk-0-3": 300 } });
    const r = await passes(8, { options: { passConcurrency: PASS_CONCURRENCY } });
    expect(PASS_CONCURRENCY).toBe(2);
    expect(r.result).toMatchObject({ ok: { plan: "multi", passes: ["chunk-0-0", "chunk-0-1", "chunk-0-2", "chunk-0-3", "chunk-1-0", "chunk-1-1"] } });
    const ids = r.runs.map((x) => x.id);
    expect(ids.slice(0, 2).sort()).toEqual(["chunk-0-0", "chunk-0-1"]);
    expect(ids.at(-1)).toBe("final");
    const at = (id: string) => r.started[ids.indexOf(id)].endedBefore;
    // Both first chunks were up before either ended; a third waits for a free lane, level 1 for all of level 0.
    expect([at("chunk-0-0"), at("chunk-0-1")]).toEqual([0, 0]);
    expect(at("chunk-0-2")).toBeGreaterThanOrEqual(1);
    expect(Math.min(at("chunk-1-0"), at("chunk-1-1"))).toBe(4);
    expect(at("final")).toBe(6);
    expect(r.ended()).toBe(7);
    for (const s of r.started) expect(await pidsInGroup(s.pgid)).toEqual([]);
    expect(r.left.filter((f) => f.startsWith("chunk-"))).toEqual([]);
  });

  it("PAR-11217: a failed chunk cancels the one beside it and starts nothing more", async () => {
    await steer({ linger: true, fail: { "chunk-0-0": true }, sleep: { "chunk-0-0": 200, "chunk-0-1": 20_000 } });
    const r = await passes(8, { options: { passConcurrency: 2 } });
    expect(r.result).toMatchObject({ error: { code: "ffmpeg_failed", kind: "deterministic", stderrTail: expect.stringContaining("boom chunk-0-0") } });
    expect(r.runs.map((x) => x.id).sort()).toEqual(["chunk-0-0", "chunk-0-1"]);
    const sibling = r.started[r.runs.findIndex((x) => x.id === "chunk-0-1")].pgid;
    expect(r.kills).toContainEqual([-sibling, "SIGTERM"]);
    for (const s of r.started) expect(await pidsInGroup(s.pgid)).toEqual([]);
    expect(r.ended()).toBe(2);
  });

  it("AC8: an edit within the budget is today's single pass with today's encoder and limits", async () => {
    await steer({});
    const r = await passes(3);
    expect(r.result).toMatchObject({ ok: { plan: "single", passes: [] } });
    expect(r.runs).toMatchObject([{ id: "final", timeout: String(TIMEOUT_SEC), fsize: String(FSIZE_BYTES) }]);
    expect(ENCODER_ARGS).toContain("-crf");
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
