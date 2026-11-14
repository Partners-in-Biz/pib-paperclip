// TEMPORARY probe (Leo, PAR-11217). Not committed. Dumps the worst-case plan's pass graphs.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { compileVideo, inputKey, type CompileInputs } from "../src/video-edit/compile-video.js";
import { planRender } from "../src/video-edit/render-plan.js";
import { normalizeEdit } from "../src/video-edit/timeline.js";
import { pipTransform } from "../src/ui/editor/layer-panel.js";

const OUT = process.env.DUMP_DIR!;
const SRC = process.env.SRC_DIR!;
const W = 1080, H = 1920;
const N = Number(process.env.CLIPS ?? 6), LEN = Number(process.env.LEN ?? 30);
const clip = (id: string, assetId: string, start: number, out: number, extra: Record<string, unknown> = {}) => ({ id, assetId, version: 1, start, in: 0, out, ...extra });

it("dump", () => {
  const feats = { look: { id: "teal-orange", intensity: 0.6 }, adjust: { brightness: 0.1, contrast: 1.2, saturation: 0.8, temperature: 4000, blur: 10, vignette: 0.5 } };
  const t = pipTransform({ width: W, height: H }, "bottom-right", "M");
  const frame = { borderWidth: 6, borderColor: "#FF0000", cornerRadius: 20 };
  const base: unknown[] = [], mult: unknown[] = [], key: unknown[] = [];
  for (let i = 0; i < N; i++) {
    base.push(clip("b" + i, "wb", i * LEN, LEN, { ...feats }));
    mult.push(clip("m" + i, "wo", i * LEN, LEN, { blendMode: "multiply", transform: t, frame, fadeIn: 0.5, adjust: { brightness: 0.1, vignette: 0.3 }, look: { id: "mono" } }));
    key.push(clip("k" + i, "wg", i * LEN, LEN, { chromaKey: { color: "#00B140", similarity: 0.15, blend: 0.05, spill: 0.3 }, transform: { ...t, x: -t.x }, frame: { cornerRadius: 20, borderWidth: 4, borderColor: "#FFFFFF" } }));
  }
  const V = process.env.VARIANT ?? "both";
  const doc = normalizeEdit({ project: { size: "9:16", fps: 30 }, tracks: [{ id: "v", kind: "video", clips: base }, ...(V === "key" ? [] : [{ id: "om", kind: "overlay", clips: mult }]), ...(V === "mult" ? [] : [{ id: "ok", kind: "overlay", clips: key }])] });
  const sources = Object.fromEntries(["wb", "wo", "wg"].map((n) => [inputKey(n, 1), { path: join(SRC, n + ".mp4"), kind: "video" }])) as CompileInputs;
  mkdirSync(OUT, { recursive: true });
  const plan = planRender(doc, sources, { workdir: OUT, passBudget: Number(process.env.BUDGET ?? 10) });
  if (plan.kind !== "multi") {
    const c = compileVideo(doc, sources, "out.mp4");
    writeFileSync(join(OUT, "single.json"), JSON.stringify(c));
    console.log("PLAN", plan.kind, plan.weight);
    return;
  }
  for (const p of plan.passes) {
    const c = compileVideo(p.doc, p.sources, p.output, { intermediate: true, origin: p.origin });
    writeFileSync(join(OUT, `${p.id}.json`), JSON.stringify(c));
    console.log("PASS", p.id, p.kind, p.weight, p.output);
  }
  writeFileSync(join(OUT, "final.json"), JSON.stringify(compileVideo(plan.final.doc, plan.final.sources, "out.mp4")));
  console.log("PLAN", plan.kind, plan.weight, plan.passes.map((p) => p.id));
});
