import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STICKER_PACK_ENTRIES } from "../src/providers/registry.js";
import { compileVideo, inputKey, sourceKey, type CompileInputs } from "../src/video-edit/compile-video.js";
import { runContained } from "../src/video-edit/ffmpeg.js";
import { editStickers } from "../src/video-edit/render-pipeline.js";
import { STICKER_PACKS, stickerIds, type StickerPack } from "../src/video-edit/sticker-packs.js";
import { stickerFile, stickerRelPath, stickersDir } from "../src/video-edit/stickers.js";
import { normalizeEdit, type EditDoc } from "../src/video-edit/timeline.js";

const sticker = (pack: string, id: string, extra: Record<string, unknown> = {}) => ({ id: `s-${id}`, sticker: { pack, id }, in: 0, out: 1, start: 0, ...extra });
const doc = (...clips: unknown[]) =>
  normalizeEdit({ project: { size: "9:16", fps: 30 }, tracks: [{ id: "v", kind: "video", clips: [{ id: "b", assetId: "base", version: 1, start: 0, in: 0, out: 1 }] }, { id: "o", kind: "overlay", clips }] });

describe("sticker lookup", () => {
  it("resolves a manifest id to <pack>/<id>.png under the bundled folder", () => {
    expect(stickerRelPath({ pack: "noto-emoji", id: "fire" })).toBe("noto-emoji/fire.png");
    expect(stickerFile({ pack: "pib-shapes", id: "circle" }, "/dist/stickers")).toBe("/dist/stickers/pib-shapes/circle.png");
  });

  it("refuses traversal, unknown ids and packs, and non-own keys before any path is built", () => {
    for (const ref of [
      { pack: "noto-emoji", id: "../../etc/passwd" },
      { pack: "noto-emoji", id: "fire/../../x" },
      { pack: "../stickers", id: "fire" },
      { pack: "noto-emoji", id: "fire.png" },
      { pack: "noto-emoji", id: "__proto__" },
      { pack: "noto-emoji", id: "constructor" },
      { pack: "pib-shapes", id: "fire" }, // an id of the other pack
      { pack: "giphy", id: "fire" },
      { pack: "noto-emoji" },
      null,
      "noto-emoji/fire",
    ]) expect(() => stickerFile(ref, "/dist/stickers"), JSON.stringify(ref)).toThrow(/Unknown sticker/);
  });
});

describe("bundled sticker files", () => {
  const dir = stickersDir();
  it("holds exactly the manifest: one 256 px RGBA PNG per id, nothing else in a pack folder", () => {
    for (const pack of STICKER_PACKS) {
      const files = readdirSync(join(dir, pack)).sort();
      expect(files).toEqual(stickerIds(pack).map((id) => `${id}.png`).sort());
      for (const f of files) {
        const png = readFileSync(join(dir, pack, f));
        expect(png.subarray(0, 8).toString("hex"), f).toBe("89504e470d0a1a0a");
        expect([png.readUInt32BE(16), png.readUInt32BE(20), png[25]], `${pack}/${f} width, height, colour type`).toEqual([256, 256, 6]);
      }
    }
    expect(stickerIds("noto-emoji")).toHaveLength(150);
  });

  it("ships its licences and stays inside the 8 MB bundle budget (it is copied to dist/ and dist/ui/)", () => {
    expect(readFileSync(join(dir, "LICENSE"), "utf8")).toMatch(/SIL OPEN FONT LICENSE/i);
    expect(readFileSync(join(dir, "APACHE-2.0.txt"), "utf8")).toMatch(/Apache License/);
    let bytes = 0;
    const walk = (d: string): void => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(join(d, e.name)); else bytes += statSync(join(d, e.name)).size; } };
    walk(dir);
    expect(bytes * 2).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});

describe("render inputs and registry", () => {
  it("editStickers lists each (pack, id) once, in first-use order; library clips are not stickers", () => {
    const d = doc(sticker("noto-emoji", "fire"), sticker("pib-shapes", "star", { id: "x", start: 1 }), sticker("noto-emoji", "fire", { id: "y", start: 2 }));
    expect(editStickers(d)).toEqual([{ pack: "noto-emoji", id: "fire" }, { pack: "pib-shapes", id: "star" }]);
    expect(editStickers(doc())).toEqual([]);
  });

  it("editStickers refuses a ref outside the manifest even if it got past normalizeEdit", () => {
    const d = doc(sticker("noto-emoji", "fire"));
    (d.tracks[1]!.clips[0] as unknown as { sticker: unknown }).sticker = { pack: "noto-emoji", id: "../x" };
    expect(() => editStickers(d)).toThrow(/not in the bundled packs/);
  });

  it("registry kind stickers lists each pack with its closed id list", () => {
    expect(STICKER_PACK_ENTRIES.map((p) => p.key)).toEqual([...STICKER_PACKS]);
    for (const p of STICKER_PACK_ENTRIES) expect(p.ids).toEqual(stickerIds(p.key as StickerPack));
  });
});

describe("a sticker renders (pixel probe)", () => {
  let work = "";
  const W = 1080;
  const H = 1920;
  beforeAll(() => { work = mkdtempSync(join(tmpdir(), "pib-sticker-")); });
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  const ffmpeg = async (args: string[]) => {
    const res = await runContained(["-hide_banner", "-loglevel", "error", "-nostdin", ...args], { cwd: work, timeoutSec: 300 }).done;
    expect(res.stderrTail).toBe("");
    expect(res.outcome).toBe("ok");
  };

  /** Mean RGB of the 8 px boxes at the frame centre and top-left corner of frame 5, rendering the sticker from `file`. */
  async function probe(ref: { pack: "pib-shapes"; id: string }, file: string, out: string): Promise<{ centre: number[]; corner: number[] }> {
    const inputs: CompileInputs = {
      [inputKey("base", 1)]: { path: join(work, "base.mp4"), kind: "video" },
      [sourceKey({ sticker: ref })]: { path: file, kind: "image", width: 256, height: 256 },
    };
    const compiled = compileVideo(doc(sticker(ref.pack, ref.id)), inputs, out);
    expect(compiled.args.join(" ")).toContain(`-i file:${file}`);
    for (const f of compiled.files) writeFileSync(join(work, f.name), f.content);
    await ffmpeg(compiled.args.filter((a) => a !== "-hide_banner" && a !== "-nostdin"));
    const r = spawnSync("ffmpeg", ["-v", "error", "-i", out, "-vf", "select='eq(n,5)',scale=in_color_matrix=bt709:in_range=tv,format=rgb24", "-frames:v", "1", "-f", "rawvideo", "-"], { cwd: work, maxBuffer: 1 << 24 });
    expect(r.stdout.length).toBe(W * H * 3);
    const mean = (x0: number, y0: number, n = 8) => {
      const s = [0, 0, 0];
      for (let y = y0; y < y0 + n; y++) for (let x = x0; x < x0 + n; x++) for (let c = 0; c < 3; c++) s[c]! += r.stdout[(y * W + x) * 3 + c]!;
      return s.map((v) => v / (n * n));
    };
    return { centre: mean(W / 2 - 4, H / 2 - 4), corner: mean(4, 4) };
  }

  it("pib-shapes plus: the bundled PNG shows at the centre like a same-colour solid PNG does, the base stays at the corner", async () => {
    await ffmpeg(["-f", "lavfi", "-i", "color=c=0xc07030:s=108x192:r=30:d=1", "-vf", "format=rgb24,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-colorspace", "bt709", "-color_range", "tv", "-c:v", "libx264", "-qp", "0", "-y", "base.mp4"]);
    // The reference is the plus colour (#2ec4b6) as a plain PNG through the same graph, so the render's own colour path cancels out.
    await ffmpeg(["-f", "lavfi", "-i", "color=c=0x2ec4b6:s=256x256:d=1", "-frames:v", "1", "-y", "solid.png"]);
    const ref = { pack: "pib-shapes", id: "plus" } as const;
    const shown = await probe(ref, stickerFile(ref), "out.mp4");
    const solid = await probe(ref, join(work, "solid.png"), "solid.mp4");
    shown.centre.forEach((v, i) => expect(Math.abs(v - solid.centre[i]!), `centre got ${shown.centre.map(Math.round)} want ${solid.centre.map(Math.round)}`).toBeLessThanOrEqual(2));
    // The base is untouched away from the sticker, and the sticker is clearly not the base colour.
    expect(shown.corner).toEqual(solid.corner);
    expect(Math.max(...shown.centre.map((v, i) => Math.abs(v - shown.corner[i]!)))).toBeGreaterThan(40);
  }, 120_000);
});
