/**
 * Golden ffmpeg argv (PAR-8442): every compileVideo call the compile specs made on plain (v1) edits, captured from the
 * code before schema v2. Later compile tickets must keep these byte-identical; a deliberate change re-captures them.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileVideo, type CompileInputs, type CompileOptions } from "../src/video-edit/compile-video.js";
import { normalizeEdit } from "../src/video-edit/timeline.js";

interface GoldenCase { name: string; doc: unknown; inputs: CompileInputs; outputPath: string; options: CompileOptions; args: string[]; files: unknown[] }

const DIR = join(import.meta.dirname, "../src/video-edit/__fixtures__/golden-argv");
const sets = readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => ({ file: f, cases: JSON.parse(readFileSync(join(DIR, f), "utf8")) as GoldenCase[] }));

describe("golden ffmpeg argv for plain edits", () => {
  it("has captured cases for the video, audio and text compile specs", () => {
    expect(sets.map((s) => s.file).sort()).toEqual(["compile-audio.json", "compile-text.json", "compile-video.json"]);
    for (const s of sets) expect(s.cases.length).toBeGreaterThan(0);
  });

  for (const { file, cases } of sets) {
    describe(file, () => {
      for (const c of cases) {
        it(c.name, () => {
          const doc = normalizeEdit(c.doc);
          // The v1 document round-trips byte-identical through normalizeEdit (and so through a save).
          expect(JSON.stringify(doc)).toBe(JSON.stringify(c.doc));
          const out = compileVideo(doc, c.inputs, c.outputPath, c.options);
          expect(out.args).toEqual(c.args);
          expect(out.files).toEqual(c.files);
        });
      }
    });
  }
});
