import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assText, assTime, captionAss, captionLines, filterValue, textFileContent } from "../src/video-edit/compile-text.js";
import { CompileError, compileVideo, GRAPH_FILE, inputKey, type CompiledVideo } from "../src/video-edit/compile-video.js";
import { FONT_IDS, FONTS, fontId, fontsDir } from "../src/video-edit/fonts.js";
import { normalizeEdit } from "../src/video-edit/timeline.js";

const FONTS_DIR = "/opt/studio/fonts";
const inputs = { [inputKey("a", 1)]: { path: "in/a.mp4", kind: "video" as const } };
const edit = (tracks: unknown[], size = "9:16") => normalizeEdit({ project: { size, fps: 30 }, tracks });
const video = { id: "v", kind: "video", clips: [{ id: "c1", assetId: "a", version: 1, start: 0, in: 0, out: 4 }] };
const textTrack = (...clips: unknown[]) => ({ id: "t", kind: "text", clips });
const captionTrack = (...clips: unknown[]) => ({ id: "cap", kind: "caption", clips });
const words = (...list: [string, number, number][]) => list.map(([text, start, end]) => ({ text, start, end }));
const compile = (tracks: unknown[], fonts = FONTS_DIR) => compileVideo(edit(tracks), inputs, "out.mp4", { fontsDir: fonts });
const file = (r: CompiledVideo, name: string) => r.files.find((f) => f.name === name)?.content ?? "";

function errorOf(fn: () => unknown): CompileError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CompileError) return error;
    throw error;
  }
  throw new Error("expected a CompileError");
}

describe("compile text snapshots", () => {
  it("text clip: drawtext via textfile + bundled bold fontfile, centred, timed, faded", () => {
    const r = compile([video, textTrack({ id: "h1", start: 0.5, duration: 2, text: "Big sale\nToday only", font: "serif", color: "#ffcc00", fontSize: 80, fadeIn: 0.3, fadeOut: 0.5, transform: { y: -400, scale: 1.5 } })]);
    expect(r).toMatchSnapshot();
    const graph = file(r, GRAPH_FILE);
    expect(graph).toContain("drawtext=fontfile=/opt/studio/fonts/Lora-Bold.ttf:textfile=text-h1.txt:expansion=none:fontsize=120:fontcolor=0xFFCC00");
    expect(graph).toContain("x=(w-text_w)/2+0:y=(h-text_h)/2-400:enable='between(t,0.5,2.5)'");
    expect(graph).toContain("alpha='if(lt(t,0.8),(t-0.5)/0.3,if(gt(t,2),(2.5-t)/0.5,1))'");
    expect(graph).not.toContain("Big sale");
    expect(file(r, "text-h1.txt")).toBe("Big sale\nToday only");
  });

  it("caption track: one ASS file with all three styles, drawn with fontsdir after the text track", () => {
    const r = compile([
      video,
      textTrack({ id: "h1", start: 0, duration: 1, text: "Hi" }),
      captionTrack(
        { id: "p", start: 0, style: "plain", words: words(["plain", 0, 0.4], ["words", 0.4, 0.8]) },
        { id: "b", start: 1, style: "bold", words: words(["BOLD", 0, 0.5], ["tiktok", 0.5, 1]) },
        { id: "k", start: 2.5, style: "karaoke", words: words(["sing", 0, 0.333], ["along", 0.5, 1.2]) },
      ),
    ]);
    expect(r).toMatchSnapshot();
    const graph = file(r, GRAPH_FILE);
    expect(graph).toContain("[tx0]ass=filename=captions-cap.ass:fontsdir=/opt/studio/fonts[tx1]");
    expect(graph).toContain("[tx1]format=yuv420p,setsar=1[vout]");
    const ass = file(r, "captions-cap.ass");
    expect(ass).toContain("PlayResX: 1080\nPlayResY: 1920");
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:00.80,plain,,0,0,0,,plain words");
    expect(ass).toContain("Dialogue: 0,0:00:01.00,0:00:02.00,bold,,0,0,0,,BOLD tiktok");
    expect(ass).toContain("Dialogue: 0,0:00:02.50,0:00:03.70,karaoke,,0,0,0,,{\\k50}sing {\\k70}along");
  });

  it("no text or caption tracks: graph unchanged, no extra files, fonts never looked up", () => {
    const r = compileVideo(edit([video, textTrack(), captionTrack()]), inputs, "out.mp4", {});
    expect(r.files.map((f) => f.name)).toEqual([GRAPH_FILE]);
    expect(file(r, GRAPH_FILE)).not.toMatch(/drawtext|ass=/);
  });

  it("text over black when there is no video track", () => {
    const r = compile([textTrack({ id: "t1", start: 0, duration: 2, text: "Only text" })]);
    expect(file(r, GRAPH_FILE)).toContain("[blk0]drawtext=");
  });
});

describe("escaping", () => {
  const nasty = "a:b 'q' back\\slash 100% {curly} %{pts} [x],y;z\nline two";

  it("drawtext text never enters the graph; the textfile holds it verbatim, expansion off", () => {
    const r = compile([video, textTrack({ id: "e1", start: 0, duration: 1, text: nasty })]);
    const graph = file(r, GRAPH_FILE);
    for (const part of ["a:b", "'q'", "back\\slash", "100%", "{curly}", "%{pts}", "line two"]) expect(graph).not.toContain(part);
    expect(graph).toContain("expansion=none");
    expect(file(r, "text-e1.txt")).toBe(nasty);
  });

  it("textfile: CRLF becomes LF, trailing newlines dropped", () => {
    expect(textFileContent("one\r\ntwo\rthree\n\n")).toBe("one\ntwo\nthree");
  });

  it("filter values: option level then graph level", () => {
    expect(filterValue("C:\\it's")).toBe("C\\\\:\\\\\\\\it\\\\\\'s");
    expect(filterValue("/fonts/a,b;c[d]")).toBe("/fonts/a\\,b\\;c\\[d\\]");
    expect(filterValue("100%")).toBe("100%");
    expect(() => filterValue("a\nb")).toThrow(CompileError);
  });

  it("fonts dir with : ' , is escaped in fontfile and fontsdir", () => {
    const r = compile([video, textTrack({ id: "t1", start: 0, duration: 1, text: "x" }), captionTrack({ id: "c", start: 0, words: words(["x", 0, 1]) })], "/srv/it's:fonts,1");
    const graph = file(r, GRAPH_FILE);
    expect(graph).toContain("fontfile=/srv/it\\\\\\'s\\\\:fonts\\,1/Inter-Bold.ttf");
    expect(graph).toContain("fontsdir=/srv/it\\\\\\'s\\\\:fonts\\,1[");
  });

  it("ASS text: braces, backslashes, newlines and %/:/' handled", () => {
    expect(assText("{\\b1}x")).toBe("\\{\\\u2060b1\\}x");
    expect(assText("{bold}")).toBe("\\{bold\\}");
    expect(assText("a\\Nb")).toBe("a\\\u2060Nb");
    expect(assText("one\ntwo\r\nthree")).toBe("one\\Ntwo\\Nthree");
    expect(assText("it's 10:30 at 50%")).toBe("it's 10:30 at 50%");
  });

  it("ASS caption words with override codes cannot style the line", () => {
    const ass = captionAss(edit([]), [{ id: "c", start: 0, style: "plain", words: words(["{\\c&H0000FF&}red", 0, 1], ["new\nline", 1, 2]) }]);
    expect(ass).toContain(",,\\{\\\u2060c&H0000FF&\\}red new\\Nline");
    expect(ass).not.toMatch(/,,\{/);
  });
});

describe("caption timing", () => {
  it("assTime rounds to centiseconds", () => {
    expect(assTime(0)).toBe("0:00:00.00");
    expect(assTime(61.235)).toBe("0:01:01.24");
    expect(assTime(3725.5)).toBe("1:02:05.50");
  });

  it("lines break on length and on pauses over 0.7 s", () => {
    const w = words(["aaaa", 0, 0.2], ["bbbb", 0.2, 0.4], ["cccc", 0.4, 0.6], ["dddd", 1.5, 1.7]);
    expect(captionLines(w, 9).map((l) => l.map((x) => x.text).join(" "))).toEqual(["aaaa bbbb", "cccc", "dddd"]);
    expect(captionLines(w, 40).map((l) => l.length)).toEqual([3, 1]);
  });

  it("karaoke \\k parts add up to the line length (gaps go to the word before)", () => {
    const ass = captionAss(edit([]), [{ id: "k", start: 0, style: "karaoke", words: words(["a", 0.004, 0.333], ["b", 0.4, 0.666], ["c", 0.666, 1.004]) }]);
    const ks = [...ass.matchAll(/\\k(\d+)/g)].map((m) => Number(m[1]));
    expect(ks).toEqual([40, 26, 34]);
    expect(ks.reduce((a, b) => a + b, 0)).toBe(100);
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:01.00,karaoke");
  });
});

describe("unsupported text", () => {
  it("unknown font, rotate and crop fail as deterministic compile errors", () => {
    expect(errorOf(() => compile([textTrack({ id: "t", start: 0, duration: 1, text: "x", font: "comic" })])).message).toBe("unsupported_feature:text_font");
    expect(errorOf(() => compile([textTrack({ id: "t", start: 0, duration: 1, text: "x", transform: { rotate: 10 } })])).message).toBe("unsupported_feature:text_rotate");
    expect(errorOf(() => compile([textTrack({ id: "t", start: 0, duration: 1, text: "x", transform: { crop: { left: 0.1 } } })])).message).toBe("unsupported_feature:text_crop");
  });
});

describe("bundled fonts", () => {
  const dir = fontsDir();
  const pkg = join(import.meta.dirname, "..");

  it("maps every Layout font id to a regular and a bold OFL face that exist", () => {
    expect(FONT_IDS).toEqual(["sans", "serif", "rounded"]);
    expect(fontId(null)).toBe("sans");
    expect(fontId("rounded")).toBe("rounded");
    expect(fontId("Arial")).toBeUndefined();
    for (const id of FONT_IDS) for (const weight of ["regular", "bold"] as const) expect(statSync(join(dir, FONTS[id][weight])).size).toBeGreaterThan(50_000);
  });

  it("ships the OFL licence naming all three families", () => {
    const ofl = readFileSync(join(pkg, "fonts", "OFL.txt"), "utf8");
    expect(ofl).toContain("SIL OPEN FONT LICENSE Version 1.1");
    for (const name of ["Inter", "Lora", "Nunito"]) expect(ofl).toContain(`The ${name} Project Authors`);
  });

  it("the build copies fonts next to the worker and the UI", () => {
    const config = readFileSync(join(pkg, "esbuild.config.mjs"), "utf8");
    expect(config).toContain('new URL("./dist/fonts", import.meta.url)');
    expect(config).toContain('new URL("./dist/ui/fonts", import.meta.url)');
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout?.includes(" ass ") ?? false;
describe.skipIf(!hasFfmpeg)("real ffmpeg", () => {
  it("renders hostile text and all caption styles with the bundled fonts", () => {
    const work = mkdtempSync(join(tmpdir(), "studio-text-"));
    try {
      const src = join(work, "a.mp4");
      const gen = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc=s=320x240:r=30:d=2", "-pix_fmt", "yuv420p", src]);
      expect(gen.status).toBe(0);
      const doc = normalizeEdit({
        project: { size: "1:1", fps: 30 },
        tracks: [
          { id: "v", kind: "video", clips: [{ id: "c1", assetId: "a", version: 1, start: 0, in: 0, out: 2 }] },
          { id: "t", kind: "text", clips: [{ id: "x", start: 0, duration: 2, text: "a:b 'q' \\ 100% {c} %{pts}\nnext", font: "rounded", fadeIn: 0.5 }] },
          { id: "cap", kind: "caption", clips: [{ id: "k", start: 0, style: "karaoke", words: words(["{\\b0}hi", 0, 0.5], ["there", 0.5, 1.5]) }] },
        ],
      });
      const r = compileVideo(doc, { [inputKey("a", 1)]: { path: src, kind: "video" } }, "out.mp4", { fontsDir: fontsDir() });
      for (const f of r.files) writeFileSync(join(work, f.name), f.content);
      const run = spawnSync("ffmpeg", ["-v", "verbose", ...r.args], { cwd: work, encoding: "utf8" });
      expect(run.status, run.stderr.slice(-3000)).toBe(0);
      // libass picked the bundled faces from fontsdir, not a system fallback.
      expect(run.stderr).toMatch(/fontselect: \(Inter, 700, 0\) -> Inter-Bold,/);
      expect(existsSync(join(work, "out.mp4"))).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);
});
