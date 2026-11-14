// TEMPORARY probe (Leo, PAR-11217, rule PAR-10158). Not committed. Flat colour per input kind x graded variant: overlay Y
// with the pre-fit against the same graph without it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { compileVideo, GRAPH_FILE, inputKey, type CompileInputs } from "../src/video-edit/compile-video.js";
import { normalizeEdit } from "../src/video-edit/timeline.js";

const dir = mkdtempSync(join(tmpdir(), "p11217-col-"));
const ff = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { cwd: dir });
const COLOUR = "0xC07040";

it("colour probe", () => {
  ff(["-f", "lavfi", "-i", `color=c=${COLOUR}:s=1080x1920:r=30:d=1,format=rgb24,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`, "-c:v", "libx264", "-qp", "0", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "v.mp4"]);
  ff(["-f", "lavfi", "-i", `color=c=${COLOUR}:s=600x600:d=1`, "-frames:v", "1", "i.png"]);
  ff(["-f", "lavfi", "-i", `color=c=${COLOUR}:s=800x800:d=1`, "-frames:v", "1", "-q:v", "1", "i.jpg"]);
  ff(["-f", "lavfi", "-i", "color=c=black:s=1080x1920:r=30:d=1", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", "b.mp4"]);
  const inputs: CompileInputs = {
    [inputKey("b", 1)]: { path: "b.mp4", kind: "video" },
    [inputKey("v", 1)]: { path: "v.mp4", kind: "video" },
    [inputKey("png", 1)]: { path: "i.png", kind: "image" },
    [inputKey("jpg", 1)]: { path: "i.jpg", kind: "image" },
  };
  const variants: Record<string, Record<string, unknown>> = {
    look: { look: { id: "warm" } },
    adjust: { adjust: { saturation: 1.5, contrast: 1.1 } },
    keyedUngraded: { chromaKey: { color: "#0000FF", similarity: 0.05, blend: 0, spill: 0.5 } },
  };
  const rows: string[] = [];
  for (const asset of ["v", "png", "jpg"]) {
    for (const [name, extra] of Object.entries(variants)) {
      const doc = normalizeEdit({ project: { size: "9:16", fps: 30 }, tracks: [
        { id: "m", kind: "video", clips: [{ id: "b", assetId: "b", version: 1, start: 0, in: 0, out: 0.5 }] },
        { id: "o", kind: "overlay", clips: [{ id: "o", assetId: asset, version: 1, start: 0, in: 0, out: 0.5, ...(asset === "v" ? {} : { duration: 0.5 }), transform: { x: 0, y: 0, scale: 0.5, rotate: 0 }, ...extra }] },
      ] });
      const yuv: number[][] = [];
      for (const strip of [false, true]) {
        const c = compileVideo(doc, inputs, "out.mp4");
        for (const f of c.files) writeFileSync(join(dir, f.name), f.name === GRAPH_FILE && strip ? f.content.replace(/scale=w='min\(iw,[^']+\)':h='min\(ih,[^']+\)':force_original_aspect_ratio=decrease:force_divisible_by=2,/g, "") : f.content);
        const g = c.files.find((f) => f.name === GRAPH_FILE)!.content;
        if (!strip && !g.includes("min(iw")) throw new Error(`no prefit for ${asset}/${name}`);
        ff([...c.args.slice(0, c.args.indexOf("-c:v")), "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", "-t", "0.2", "o.mp4"].filter((a) => a !== "out.mp4"));
        const raw = execFileSync("ffmpeg", ["-v", "error", "-i", "o.mp4", "-vf", "select=eq(n\\,2),crop=2:2:540:960", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "yuv444p", "-"], { cwd: dir });
        yuv.push([raw[0]!, raw[4]!, raw[8]!]);
      }
      const d = Math.max(...yuv[0]!.map((v, i) => Math.abs(v - yuv[1]![i]!)));
      rows.push(`${asset}/${name}: prefit ${yuv[0]} without ${yuv[1]} maxdiff ${d}${d > 2 ? " FAIL" : ""}`);
    }
  }
  console.log("COLOUR\n" + rows.join("\n"));
}, 300_000);
