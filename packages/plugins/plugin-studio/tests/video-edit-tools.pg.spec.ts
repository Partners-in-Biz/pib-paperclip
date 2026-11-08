/** Video edit agent tools (PAR-8276 A8b): schemas, and create -> apply-ops -> render -> render-status end to end with fake ffmpeg. */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import type { PrivateBucket } from "../src/storage.js";
import { STUDIO_TOOLS } from "../src/tools.js";
import { createRenderExecutor } from "../src/video-edit/render-pipeline.js";
import { createRenderRunner } from "../src/video-edit/runner.js";
import { isVideoEditTool, runVideoEditTool, VIDEO_EDIT_TOOL_NAMES } from "../src/video-edit/tools.js";
import { embeddedAvailable, startPg, type Pg } from "./helpers/pg.js";

const CO = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const BUCKET: PrivateBucket = { accountId: "acct", bucket: "b", accessKeyId: "k", secretAccessKey: "s" };

describe("video edit tool declarations", () => {
  const tools = STUDIO_TOOLS.filter((t) => t.name.startsWith("video-edit-"));
  it("declares the eight tools, registered through the manifest", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...VIDEO_EDIT_TOOL_NAMES].sort());
    expect(manifest.tools).toBe(STUDIO_TOOLS);
    expect(manifest.capabilities).toContain("agent.tools.register");
    expect(new Set(STUDIO_TOOLS.map((t) => t.name)).size).toBe(STUDIO_TOOLS.length);
    for (const t of tools) expect(isVideoEditTool(t.name)).toBe(true);
    expect(isVideoEditTool("studio-usage")).toBe(false);
  });

  it("has strict schemas with the right required fields", () => {
    const by = Object.fromEntries(tools.map((t) => [t.name, t.parametersSchema as { required: string[]; additionalProperties: boolean; properties: Record<string, { enum?: string[]; items?: { properties?: { op?: { enum: string[] } } } }> }]));
    for (const t of tools) expect(by[t.name]!.additionalProperties).toBe(false);
    expect(by["video-edit-create"]!.required).toEqual(["title"]);
    expect(by["video-edit-get"]!.required).toEqual(["editId"]);
    expect(by["video-edit-list"]!.required).toEqual([]);
    expect(by["video-edit-apply-ops"]!.required).toEqual(["editId", "baseRevision", "ops"]);
    expect(by["video-edit-apply-ops"]!.properties.ops!.items!.properties!.op!.enum).toContain("split");
    expect(by["video-edit-render"]!.required).toEqual(["editId"]);
    expect(by["video-edit-render-status"]!.required).toEqual(["renderId"]);
    expect(by["video-edit-cancel-render"]!.required).toEqual(["renderId"]);
    expect(by["video-edit-delete"]!.required).toEqual(["editId"]);
  });

  it("takes no spending or company fields", () => {
    for (const t of tools) expect(Object.keys((t.parametersSchema as { properties: object }).properties).filter((k) => /company|credit|cap|limit(?!$)|cost/i.test(k))).toEqual([]);
  });
});

const available = await embeddedAvailable();
let pg: Pg;
let ctx: PluginContext;
let scratch: string;
let bins: { ffmpeg: string; ffprobe: string };
let r2: Map<string, Uint8Array<ArrayBuffer>>;

beforeAll(async () => {
  if (!available) return;
  pg = await startPg();
  ctx = {
    db: pg.db,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    state: { get: async () => null, set: async () => undefined, delete: async () => undefined },
    projects: { get: async () => null },
  } as unknown as PluginContext;
}, 120_000);

afterAll(async () => {
  if (available) await pg.stop();
});

beforeEach(async () => {
  if (available) await pg.reset();
  scratch = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "edit-tools-spec-"));
  vi.stubEnv("PIB_STUDIO_WORKDIR", join(scratch, "work"));
  r2 = new Map();
  vi.stubGlobal("fetch", async (url: string, init?: { method?: string; body?: Uint8Array }) => {
    const key = decodeURIComponent(new URL(url).pathname).replace(/^\/b\//, "");
    if (init?.method === "PUT") {
      r2.set(key, new Uint8Array(init.body!));
      return new Response(null, { status: 200 });
    }
    const body = r2.get(key);
    return body ? new Response(body, { status: 200, headers: { "content-length": String(body.length) } }) : new Response(null, { status: 404 });
  });
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
fs.writeFileSync(args[args.length - 1].replace(/^file:/, ""), JSON.stringify({ probe: first.render }));
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

const probeJson = (duration: number) => ({
  format: { duration: String(duration), format_name: "mov,mp4" },
  streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920 }, { codec_type: "audio", codec_name: "aac" }],
});

async function addAsset(id: string, companyId = CO) {
  const key = `studio/${companyId}/own/${id}/v1.mp4`;
  const content = new TextEncoder().encode(JSON.stringify({ probe: probeJson(10), render: probeJson(3.5) }));
  await pg.db.execute(`INSERT INTO ${pg.db.namespace}.assets (id, company_id, name, kind, source) VALUES ($1, $2, 'in.mp4', 'video', 'upload')`, [id, companyId]);
  await pg.db.execute(`INSERT INTO ${pg.db.namespace}.asset_versions (asset_id, version, company_id, r2_key, mime, bytes, sha256) VALUES ($1, 1, $2, $3, 'video/mp4', $4, 'x')`, [id, companyId, key, content.length]);
  r2.set(key, content);
}

const run = { companyId: CO, agentId: "agent-1" };
const call = (name: string, params: Record<string, unknown>, companyId = CO) => runVideoEditTool(ctx, name, params, { ...run, companyId }, { projectId: null });

describe.skipIf(!available)("video edit tools end to end (fake ffmpeg)", () => {
  it("create -> apply-ops -> render -> render-status succeeded with an asset id", async () => {
    await addAsset("src-a");
    const clip = { id: "c1", assetId: "src-a", version: 1, in: 0, out: 4, start: 0 };
    const created = (await call("video-edit-create", { title: "Spring ad", doc: { schemaVersion: 1, project: { size: "9:16", fps: 30 }, tracks: [{ id: "v", kind: "video", clips: [clip] }] } })) as { id: string; revision: number };
    expect(created.revision).toBe(1);

    const applied = (await call("video-edit-apply-ops", { editId: created.id, baseRevision: 1, ops: [{ op: "trim", clipId: "c1", out: 3.5 }] })) as { revision: number; duration: number };
    expect(applied).toMatchObject({ revision: 2, duration: 3.5 });
    expect(await call("video-edit-apply-ops", { editId: created.id, baseRevision: 1, ops: [{ op: "trim", clipId: "c1", out: 3 }] }).catch((e) => String(e.message))).toMatch(/Someone saved/);
    expect(((await call("video-edit-get", { editId: created.id })) as { revision: number }).revision).toBe(2);
    expect(((await call("video-edit-list", {})) as { edits: unknown[] }).edits).toHaveLength(1);

    const queued = (await call("video-edit-render", { editId: created.id, baseRevision: 2 })) as { id: string; status: string };
    expect(queued.status).toBe("queued");
    expect(((await call("video-edit-render-status", { renderId: queued.id })) as { assetId: string | null }).assetId).toBeNull();

    const runner = createRenderRunner(ctx, { executor: createRenderExecutor({ bucket: async () => BUCKET, statfs: (async () => ({ bavail: 1e12, bsize: 1 })) as never, run: { bins } }), heartbeatMs: 50 });
    expect((await runner.tick()).claimed).toBe(queued.id);
    await runner.settled();

    const done = (await call("video-edit-render-status", { renderId: queued.id })) as { status: string; assetId: string };
    expect(done.status).toBe("succeeded");
    expect(done.assetId).toBeTruthy();
  });

  it("refuses another company's edit and render", async () => {
    const created = (await call("video-edit-create", { title: "Mine" })) as { id: string };
    await expect(call("video-edit-get", { editId: created.id }, OTHER)).rejects.toThrow();
    await expect(call("video-edit-render-status", { renderId: "nope" }, OTHER)).rejects.toThrow();
    expect(((await call("video-edit-list", {}, OTHER)) as { edits: unknown[] }).edits).toEqual([]);
  });
});
