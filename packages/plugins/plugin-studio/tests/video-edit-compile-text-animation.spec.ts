/**
 * PAR-10174 (D4d1): animated text through ASS. The ASS per preset is snapshotted; real ffmpeg renders check that the
 * text centre at 3 times per preset lands where `text-animation.ts` says (within 1% of the frame), that typewriter and
 * wordByWord show k of n units, and that an animated clip at rest sits where drawtext draws the same clip, per font.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ASS_FACE } from "../src/video-edit/compile-text.js";
import { CompileError, compileVideo, GRAPH_FILE, inputKey, type CompiledVideo } from "../src/video-edit/compile-video.js";
import { FONTS } from "../src/video-edit/fonts.js";
import { revealUnits, textAnimationAt } from "../src/video-edit/text-animation.js";
import { normalizeEdit, TEXT_ANIMATIONS, type EditDoc, type TextClip } from "../src/video-edit/timeline.js";

const edit = (tracks: unknown[]) => normalizeEdit({ project: { size: "9:16", fps: 30 }, tracks });
const video = (out: number) => ({ id: "v", kind: "video", clips: [{ id: "c1", assetId: "a", version: 1, start: 0, in: 0, out }] });
const textTrack = (...clips: unknown[]) => ({ id: "t", kind: "text", clips });
const inputs = { [inputKey("a", 1)]: { path: "a.mp4", kind: "video" as const, hasAudio: false } };
const compile = (doc: EditDoc) => compileVideo(doc, inputs, "out.mp4", { fontsDir: "/f" });
const file = (r: CompiledVideo, name: string) => r.files.find((f) => f.name === name)?.content;
const graph = (r: CompiledVideo) => file(r, GRAPH_FILE) ?? "";
const clipsOf = (doc: EditDoc) => doc.tracks.flatMap((t) => (t.kind === "text" ? t.clips : [])) as TextClip[];

function errorOf(fn: () => unknown): CompileError {
  try {
    fn();
  } catch (e) {
    if (e instanceof CompileError) return e;
    throw e;
  }
  throw new Error("expected a CompileError");
}

describe("animated text compiles to ASS", () => {
  const title = (extra: Record<string, unknown> = {}) => ({ id: "x1", start: 1, duration: 2, text: "Go {now}", color: "#ff8800", fadeIn: 0.25, ...extra });

  for (const preset of TEXT_ANIMATIONS) {
    it(`${preset}: ASS document`, () => {
      const r = compile(edit([video(4), textTrack(title({ animation: { in: preset, inDuration: 0.6, out: preset, outDuration: 0.4 } }))]));
      expect(file(r, "text-x1.ass")).toMatchSnapshot();
    });
  }

  it("draws an animated clip with the ass filter; a plain clip beside it keeps its drawtext byte for byte", () => {
    const plain = { id: "p1", start: 0, duration: 1, text: "Plain" };
    const animated = compile(edit([video(4), textTrack(plain, title({ animation: { in: "pop" } }))]));
    const alone = compile(edit([video(4), textTrack(plain)]));
    const drawtext = graph(alone).match(/\[\w+\](drawtext=[^\n]*)\[tx0\]/)?.[1];
    expect(drawtext).toBeTruthy();
    expect(graph(animated)).toContain(`${drawtext},ass=filename=text-x1.ass:fontsdir=/f[tx0]`);
    expect(animated.files.map((f) => f.name)).toEqual(expect.arrayContaining(["text-p1.txt", "text-x1.ass"]));
    expect(file(animated, "text-x1.txt")).toBeUndefined();
    expect(animated.args).toEqual(alone.args);
  });

  it("refuses keyframes on an animated clip, and what drawtext refuses", () => {
    const lin = [{ t: 0, value: 0, ease: "linear" }, { t: 1, value: 50, ease: "linear" }];
    expect(errorOf(() => compile(edit([video(4), textTrack(title({ animation: { in: "pop" }, keyframes: { x: lin } }))]))).message).toBe("unsupported_feature:text_animation_keyframes");
    expect(errorOf(() => compile(edit([video(4), textTrack(title({ animation: { in: "pop" }, transform: { rotate: 10 } }))]))).message).toBe("unsupported_feature:text_rotate");
  });

  it("ASS_FACE matches the bundled bold TTFs (OS/2 winAscent, winDescent, capHeight; head unitsPerEm)", () => {
    for (const [id, face] of Object.entries(ASS_FACE)) {
      const ttf = readFileSync(join(import.meta.dirname, "../fonts", FONTS[id as keyof typeof FONTS].bold));
      const table = (tag: string) => {
        for (let i = 0; i < ttf.readUInt16BE(4); i++) if (ttf.toString("latin1", 12 + 16 * i, 16 + 16 * i) === tag) return ttf.readUInt32BE(20 + 16 * i);
        throw new Error(`no ${tag}`);
      };
      const os2 = table("OS/2");
      expect({ upem: ttf.readUInt16BE(table("head") + 18), winAscent: ttf.readUInt16BE(os2 + 74), winDescent: ttf.readUInt16BE(os2 + 76), capHeight: ttf.readInt16BE(os2 + 88) }).toEqual(face);
    }
  });
});

const hasLibass = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout?.includes(" ass ") ?? false;

describe.skipIf(!hasLibass)("animated text with real ffmpeg", () => {
  const W = 1080;
  const H = 1920;
  const FPS = 30;
  const run = (dir: string, args: string[]) => spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], { cwd: dir, encoding: "utf8", maxBuffer: 1 << 28 });
  /** Renders `doc` over a black clip and returns the gray frames at the given frame numbers. */
  function frames(doc: EditDoc, seconds: number, at: number[]): Buffer[] {
    const dir = mkdtempSync(join(tmpdir(), "studio-text-anim-"));
    try {
      expect(run(dir, ["-f", "lavfi", "-i", `color=black:size=${W}x${H}:rate=${FPS}`, "-t", String(seconds), "-pix_fmt", "yuv420p", "a.mp4"]).status).toBe(0);
      const r = compileVideo(doc, inputs, "out.mp4");
      for (const f of r.files) writeFileSync(join(dir, f.name), f.content);
      const out = spawnSync("ffmpeg", [...r.args.slice(0, 3), "-loglevel", "error", ...r.args.slice(3)], { cwd: dir, encoding: "utf8" });
      expect(out.stderr).toBe("");
      const select = at.map((n) => `eq(n\\,${n})`).join("+");
      const p = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", "out.mp4", "-vf", `select='${select}'`, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { cwd: dir, maxBuffer: 1 << 28 });
      const px = p.stdout as Buffer;
      expect(px.length).toBe(W * H * at.length);
      return at.map((_, i) => px.subarray(i * W * H, (i + 1) * W * H));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  /** Ink box of pixels brighter than `min`, plus the runs of inked columns (gaps narrower than `gap` px are joined). */
  function ink(px: Buffer, min = 40, gap = 1) {
    let [x0, x1, y0, y1] = [W, -1, H, -1];
    const cols = new Uint8Array(W);
    for (let i = 0; i < px.length; i++) {
      if (px[i]! <= min) continue;
      const x = i % W;
      const y = (i - x) / W;
      cols[x] = 1;
      [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
    }
    let runs = 0;
    let last = -Infinity;
    for (let x = 0; x < W; x++) if (cols[x]) {
      if (x - last > gap) runs++;
      last = x;
    }
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0 + 1, x0, runs };
  }

  it("text centre at 3 times per preset matches text-animation.ts within 1% of the frame", () => {
    const motion = TEXT_ANIMATIONS.filter((a) => a !== "typewriter" && a !== "wordByWord");
    const doc = edit([video(2 * motion.length), textTrack(...motion.map((a, i) => ({ id: `t${i}`, start: 2 * i, duration: 2, text: "HOH", fontSize: 160, color: "#FFFFFF", animation: { in: a, inDuration: 0.9, out: a, outDuration: 0.6 } })))]);
    const times = [0.3, 0.6, 1.7];
    const at = motion.flatMap((_, i) => times.map((t) => Math.round((2 * i + t) * FPS)));
    const got = frames(doc, 2 * motion.length, at);
    const clips = clipsOf(doc);
    motion.forEach((preset, i) => times.forEach((t, j) => {
      const want = textAnimationAt(clips[i]!, { width: W, height: H }, t);
      const seen = ink(got[i * times.length + j]!);
      expect(Math.abs(seen.cx - want.x), `${preset} x at ${t}s`).toBeLessThan(W * 0.01);
      expect(Math.abs(seen.cy - want.y), `${preset} y at ${t}s`).toBeLessThan(H * 0.01);
    }));
  }, 300_000);

  it("typewriter shows k of n characters and wordByWord k of n words, entering and leaving; the line never shifts", () => {
    const doc = edit([video(6), textTrack(
      { id: "tw", start: 0, duration: 3, text: "HHHHHH", fontSize: 120, color: "#FFFFFF", animation: { in: "typewriter", inDuration: 1.2, out: "typewriter", outDuration: 1.2 } },
      { id: "wb", start: 3, duration: 3, text: "HH HH HH HH", fontSize: 120, color: "#FFFFFF", animation: { in: "wordByWord", inDuration: 1.2, out: "wordByWord", outDuration: 1.2 } },
    )]);
    const times = [0.1, 0.5, 1.5, 2.3, 2.5];
    const got = frames(doc, 6, [...times.map((t) => Math.round(t * FPS)), ...times.map((t) => Math.round((3 + t) * FPS))]);
    const [tw, wb] = clipsOf(doc);
    const counts = [tw!, wb!].map((clip, c) => {
      const n = revealUnits(clip.text, c ? "word" : "char").units.length;
      const left = ink(got[c * times.length + 2]!).x0; // at rest, every unit shows
      return times.map((t, j) => {
        const seen = ink(got[c * times.length + j]!, 40, c ? 30 : 1);
        expect(Math.abs(seen.x0 - left), `${clip.id} left edge at ${t}s`).toBeLessThan(2);
        const want = textAnimationAt(clip, { width: W, height: H }, t, n).shown ?? n;
        expect(seen.runs, `${clip.id} at ${t}s`).toBe(want);
        return want;
      });
    });
    expect(counts).toEqual([[1, 3, 6, 4, 3], [1, 2, 4, 3, 2]]);
  }, 300_000);

  it("at rest an animated clip sits where drawtext draws the same clip, for each bundled font", () => {
    const fonts = ["sans", "serif", "rounded"];
    const base = { duration: 1, text: "HOH", fontSize: 140, color: "#FFFFFF", transform: { x: 60, y: -200 } };
    const doc = edit([video(2 * fonts.length), textTrack(...fonts.flatMap((font, i) => [
      { ...base, id: `p${i}`, font, start: 2 * i },
      { ...base, id: `a${i}`, font, start: 2 * i + 1, animation: { in: "pop", inDuration: 0.1 } },
    ]))]);
    const got = frames(doc, 2 * fonts.length, fonts.flatMap((_, i) => [Math.round((2 * i + 0.5) * FPS), Math.round((2 * i + 1.5) * FPS)]));
    // 3 px: above the 0.5 px pixel-centre noise floor, below the smallest calibration term (rounded's lift is 5 px at
    // fontSize 140, serif's 14.8 px), so dropping the lift or the (winAscent + winDescent) / upem size factor fails.
    const PX = 3;
    fonts.forEach((font, i) => {
      const [plain, animated] = [ink(got[2 * i]!), ink(got[2 * i + 1]!)];
      expect(Math.abs(animated.cx - plain.cx), `${font} x`).toBeLessThan(PX);
      expect(Math.abs(animated.cy - plain.cy), `${font} y`).toBeLessThan(PX);
      expect(Math.abs(animated.w / plain.w - 1), `${font} width`).toBeLessThan(0.02);
    });
  }, 300_000);
});
