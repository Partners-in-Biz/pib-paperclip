/**
 * The contained ML runner (PAR-10126 D5b). Built on its own to `dist/ml/runner.mjs` and the only code that loads
 * onnxruntime-node, which resolves from `dist/ml/node_modules` (a pruned linux-x64 CPU copy the build writes). The worker
 * bundle never imports this file, so the worker starts even when the native library is missing. Always started under the
 * containment line (`timeout -k`, `prlimit --as=6GiB --fsize=200MiB`, `nice -n 10`; T2 adds `runContained` tool "node").
 *
 *   node dist/ml/runner.mjs --selftest   load both models (hash-checked), run one zero frame through each, print one JSON line
 *   node dist/ml/runner.mjs track --in <file> --from <s> --to <s>   face boxes at 5 samples per second (`track.ts`)
 *
 * Exit codes are named (`EXIT`); on failure stdout holds `{"ok":false,"code":"<name>","error":"..."}`.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT, RunnerError, type ExitName } from "./errors.js";
import { parseTrackArgs, track } from "./track.js";

export { EXIT, RunnerError, type ExitName };

/** ONNX Runtime intra-op threads, the same 4 the ffmpeg runs use. */
export const THREADS = 4;


export interface ModelSpec {
  name: string;
  file: string;
  input: string;
  shape: number[];
}

/** The two small models shipped in `dist/ml/models` (see `ml-models/README.md`). */
export const MODELS: readonly ModelSpec[] = [
  { name: "yunet", file: "yunet.onnx", input: "input", shape: [1, 3, 640, 640] },
  { name: "selfie-segmentation", file: "selfie-segmentation.onnx", input: "pixel_values", shape: [1, 3, 256, 256] },
];


type Ort = typeof import("onnxruntime-node");

/** `dist/ml` when built (this file is `dist/ml/runner.mjs`). */
export function mlDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** `SHA256SUMS` lines (`<hex>  <file>`) as a file -> hash map. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{64}) [ *]?(\S+)$/.exec(line.trim());
    if (m) sums.set(m[2], m[1]);
  }
  return sums;
}

/** Loads onnxruntime-node from `<ml>/node_modules` only: a copy found anywhere else is not the one we ship. */
export function loadRuntime(ml: string): { ort: Ort; path: string } {
  const req = createRequire(join(ml, "runner.mjs"));
  let path: string;
  try {
    path = req.resolve("onnxruntime-node");
  } catch (e) {
    throw new RunnerError("runtime_missing", `onnxruntime-node not found beside ${ml}: ${(e as Error).message}`);
  }
  if (!path.startsWith(join(ml, "node_modules") + sep)) throw new RunnerError("runtime_missing", `onnxruntime-node resolved outside ${ml}/node_modules: ${path}`);
  try {
    return { ort: req("onnxruntime-node") as Ort, path };
  } catch (e) {
    throw new RunnerError("runtime_missing", `onnxruntime-node failed to load: ${(e as Error).message}`);
  }
}

/** Reads a model after checking its SHA-256 against `models/SHA256SUMS`. */
export function readModel(ml: string, spec: ModelSpec): { bytes: Buffer; sha256: string } {
  const dir = join(ml, "models");
  const file = join(dir, spec.file);
  const sumsFile = join(dir, "SHA256SUMS");
  if (!existsSync(file)) throw new RunnerError("model_missing", `${spec.file} is missing from ${dir}`);
  if (!existsSync(sumsFile)) throw new RunnerError("model_missing", `SHA256SUMS is missing from ${dir}`);
  const want = parseSums(readFileSync(sumsFile, "utf8")).get(spec.file);
  const bytes = readFileSync(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (!want) throw new RunnerError("model_bad", `${spec.file} has no line in SHA256SUMS`);
  if (sha256 !== want) throw new RunnerError("model_bad", `${spec.file} SHA-256 ${sha256} differs from SHA256SUMS ${want}`);
  return { bytes, sha256 };
}

function peakRssMb(): number | null {
  try {
    const m = /VmHWM:\s+(\d+)/.exec(readFileSync("/proc/self/status", "utf8"));
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

export async function selftest(ml = mlDir()) {
  const { ort, path } = loadRuntime(ml);
  const models = [];
  for (const spec of MODELS) {
    const { bytes, sha256 } = readModel(ml, spec);
    const t0 = performance.now();
    let session;
    try {
      session = await ort.InferenceSession.create(bytes, { intraOpNumThreads: THREADS, interOpNumThreads: 1 });
    } catch (e) {
      throw new RunnerError("model_bad", `${spec.file} failed to load: ${(e as Error).message}`);
    }
    const loadMs = performance.now() - t0;
    const size = spec.shape.reduce((a, b) => a * b, 1);
    const t1 = performance.now();
    let outputs: string[];
    try {
      const out = await session.run({ [spec.input]: new ort.Tensor("float32", new Float32Array(size), spec.shape) });
      outputs = Object.keys(out);
    } catch (e) {
      throw new RunnerError("model_bad", `${spec.file} failed one zero frame: ${(e as Error).message}`);
    } finally {
      await session.release();
    }
    models.push({ name: spec.name, sha256, inputs: [spec.input], outputs, loadMs: Math.round(loadMs), runMs: Math.round(performance.now() - t1) });
  }
  return { ok: true as const, runtime: { onnxruntime: ort.env.versions.node ?? ort.env.versions.common, path }, threads: THREADS, models, peakRssMb: peakRssMb() };
}

/** Face boxes for one range (`track.ts`); the YuNet model is hash-checked like the self-test. */
export async function runTrack(argv: string[], ml = mlDir()) {
  const args = parseTrackArgs(argv);
  const { ort } = loadRuntime(ml);
  const { bytes } = readModel(ml, MODELS[0]!);
  let session;
  try {
    session = await ort.InferenceSession.create(bytes, { intraOpNumThreads: THREADS, interOpNumThreads: 1 });
  } catch (e) {
    throw new RunnerError("model_bad", `${MODELS[0]!.file} failed to load: ${(e as Error).message}`);
  }
  try {
    return await track(args, { ort, session });
  } finally {
    await session.release();
  }
}

const USAGE = "usage: runner.mjs --selftest | track --in <file> --from <s> --to <s>\n";

export async function main(argv: string[]): Promise<number> {
  const mode = argv[0];
  if (!((mode === "--selftest" && argv.length === 1) || mode === "track")) {
    process.stderr.write(USAGE);
    return EXIT.usage;
  }
  try {
    const result = mode === "track" ? await runTrack(argv.slice(1)) : await selftest();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return EXIT.ok;
  } catch (e) {
    const code: ExitName = e instanceof RunnerError ? e.code : "model_bad";
    if (code === "usage") process.stderr.write(USAGE);
    process.stdout.write(`${JSON.stringify({ ok: false, code, error: (e as Error).message })}\n`);
    return EXIT[code];
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
