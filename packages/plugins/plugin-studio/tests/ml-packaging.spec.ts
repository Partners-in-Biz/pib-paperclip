/**
 * ML runtime packaging (PAR-10126 D5b0a). Runs in CI: the installed onnxruntime-node has no CUDA/TensorRT file
 * (neverBuiltDependencies stops its install script), the vendored models match SHA256SUMS with licences beside them,
 * and the dist/ml guard fails on each bad case. After a build, the real dist/ml passes the guard; the contained
 * self-test runs on pib-vps only (CI skips real-process tests, PAR-10141).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs build script, no types
import { checkMlDist, ML_BUDGET, NATIVE_DIR, walk } from "../scripts/ml-dist-check.mjs";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const modelsDir = join(pkg, "ml-models");
const sumsFile = join(modelsDir, "SHA256SUMS");
const dist = join(pkg, "dist");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const check = (distDir: string, maxBytes?: number): string[] => checkMlDist({ distDir, sumsFile, maxBytes });

const sums = new Map(
  readFileSync(sumsFile, "utf8").trim().split("\n").map((l) => {
    const [h, f] = l.split(/\s+/);
    return [f, h] as const;
  }),
);

describe("installed onnxruntime-node", () => {
  it("has no CUDA or TensorRT file (the install script did not run)", () => {
    const dir = dirname(createRequire(join(pkg, "package.json")).resolve("onnxruntime-node/package.json"));
    const files = walk(dir) as string[];
    expect(files.some((f) => f.endsWith("linux/x64/libonnxruntime.so.1"))).toBe(true);
    expect(files.filter((f) => /cuda|tensorrt/i.test(f.slice(dir.length)))).toEqual([]);
  });

  it("is listed in neverBuiltDependencies in package.json and pnpm-workspace.yaml", () => {
    const root = join(pkg, "../../..");
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).pnpm.neverBuiltDependencies).toContain("onnxruntime-node");
    expect(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")).toMatch(/^neverBuiltDependencies:\n {2}- onnxruntime-node$/m);
  });
});

describe("ml-models", () => {
  it("SHA256SUMS lists the two models and every hash matches", () => {
    expect([...sums.keys()].sort()).toEqual(["selfie-segmentation.onnx", "yunet.onnx"]);
    for (const [f, h] of sums) expect(sha(readFileSync(join(modelsDir, f))), f).toBe(h);
  });

  it("has a licence beside every model and the runtime", () => {
    for (const f of readdirSync(modelsDir).filter((n) => n.endsWith(".onnx"))) expect(existsSync(join(modelsDir, f.replace(/\.onnx$/, ".LICENSE"))), f).toBe(true);
    expect(readFileSync(join(modelsDir, "yunet.LICENSE"), "utf8")).toMatch(/^MIT License/);
    expect(readFileSync(join(modelsDir, "selfie-segmentation.LICENSE"), "utf8")).toMatch(/Apache License\s+Version 2\.0/);
    expect(readFileSync(join(modelsDir, "onnxruntime.LICENSE"), "utf8")).toMatch(/Microsoft Corporation/);
  });
});

/** A minimal header the guard reads: ELF64, little-endian, the given e_machine. */
function elf(machine: number): Buffer {
  const b = Buffer.alloc(64);
  b.writeUInt32BE(0x7f454c46, 0);
  b[4] = 2;
  b[5] = 1;
  b.writeUInt16LE(machine, 18);
  return b;
}

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A dist folder that passes: worker.js, runner.mjs, two x86-64 binaries, the real models. */
function fixture(): string {
  const d = mkdtempSync(join(tmpdir(), "studio-ml-dist-"));
  tmps.push(d);
  writeFileSync(join(d, "worker.js"), "export default {};\n");
  const ml = join(d, "ml");
  mkdirSync(join(ml, NATIVE_DIR), { recursive: true });
  mkdirSync(join(ml, "models"));
  writeFileSync(join(ml, "runner.mjs"), "\n");
  for (const f of ["onnxruntime_binding.node", "libonnxruntime.so.1"]) writeFileSync(join(ml, NATIVE_DIR, f), elf(0x3e));
  for (const f of sums.keys()) cpSync(join(modelsDir, f), join(ml, "models", f));
  return d;
}

describe("dist/ml guard", () => {
  it("passes a clean fixture", () => {
    expect(check(fixture())).toEqual([]);
  });

  it("fails on a CUDA or TensorRT file", () => {
    const d = fixture();
    writeFileSync(join(d, "ml", NATIVE_DIR, "libonnxruntime_providers_cuda.so"), elf(0x3e));
    writeFileSync(join(d, "ml", "node_modules/onnxruntime-node/libonnxruntime_providers_tensorrt.txt"), "x");
    const p = check(d);
    expect(p.filter((x) => x.includes("CUDA/TensorRT"))).toHaveLength(2);
  });

  it("fails on a non-linux-x64 binary (other folder, or an arm64 ELF in the x64 folder)", () => {
    const d = fixture();
    const darwin = join(d, "ml", "node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64");
    mkdirSync(darwin, { recursive: true });
    writeFileSync(join(darwin, "onnxruntime_binding.node"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
    expect(check(d).join("\n")).toMatch(/darwin\/arm64\/onnxruntime_binding\.node is not a linux-x64 binary/);
    const d2 = fixture();
    writeFileSync(join(d2, "ml", NATIVE_DIR, "libonnxruntime.so.1"), elf(0xb7)); // EM_AARCH64
    expect(check(d2).join("\n")).toMatch(/linux\/x64\/libonnxruntime\.so\.1 is not a linux-x64 binary/);
  });

  it("fails on a model whose SHA-256 differs from SHA256SUMS, and on a missing or unlisted model", () => {
    const d = fixture();
    const y = join(d, "ml/models/yunet.onnx");
    writeFileSync(y, Buffer.concat([readFileSync(y), Buffer.from([0])]));
    expect(check(d).join("\n")).toMatch(/yunet\.onnx SHA-256 [0-9a-f]{64} differs from ml-models\/SHA256SUMS/);
    rmSync(y);
    writeFileSync(join(d, "ml/models/extra.onnx"), "x");
    const p = check(d).join("\n");
    expect(p).toMatch(/yunet\.onnx is missing/);
    expect(p).toMatch(/models\/extra\.onnx is not listed/);
  });

  it("fails when dist/ml is over 60 MB", () => {
    expect(ML_BUDGET).toBe(60 * 1024 * 1024);
    const d = fixture();
    const big = join(d, "ml/node_modules/onnxruntime-node/dist/padding.js");
    mkdirSync(dirname(big), { recursive: true });
    writeFileSync(big, "");
    truncateSync(big, ML_BUDGET + 1); // sparse: logical size counts, no disk used
    expect(check(d).join("\n")).toMatch(/dist\/ml is \d+ bytes, over the 62914560 budget/);
  });

  it("fails when dist/worker.js names onnxruntime, or dist/ml or its binaries are missing", () => {
    const d = fixture();
    writeFileSync(join(d, "worker.js"), 'import "onnxruntime-node";\n');
    rmSync(join(d, "ml", NATIVE_DIR, "libonnxruntime.so.1"));
    const p = check(d).join("\n");
    expect(p).toMatch(/dist\/worker\.js contains "onnxruntime"/);
    expect(p).toMatch(/libonnxruntime\.so\.1 is missing/);
    rmSync(join(d, "ml"), { recursive: true });
    expect(check(d)).toContain("dist/ml is missing");
  });
});

const built = existsSync(join(dist, "ml/runner.mjs"));

describe.skipIf(!built)("built dist/ml (after pnpm build)", () => {
  it("passes the guard: runner, linux-x64 CPU binaries only, pinned models, no onnxruntime in the worker", () => {
    expect(check(dist)).toEqual([]);
    expect(readFileSync(join(dist, "worker.js"), "utf8")).not.toContain("onnxruntime");
    const native = (walk(join(dist, "ml")) as string[]).filter((f) => /\.(node|so(\.\d+)*)$/.test(f)).map((f) => f.slice(join(dist, "ml").length + 1)).sort();
    expect(native).toEqual([`${NATIVE_DIR}libonnxruntime.so.1`, `${NATIVE_DIR}onnxruntime_binding.node`]);
    for (const f of ["node_modules/onnxruntime-node/LICENSE", "node_modules/onnxruntime-node/ThirdPartyNotices.txt", "node_modules/onnxruntime-common/LICENSE", "models/yunet.LICENSE", "models/selfie-segmentation.LICENSE", "models/SHA256SUMS"]) {
      expect(existsSync(join(dist, "ml", f)), f).toBe(true);
    }
  });

  // Real process: the production containment line (ffmpeg.ts head), then node. CI skips it (PAR-10141); pasted from pib-vps.
  it.skipIf(!!process.env.CI || !existsSync("/usr/bin/prlimit"))("runner --selftest loads both models under the containment line and exits 0", () => {
    const argv = ["-k", "30", "120", "/usr/bin/prlimit", `--as=${6 * 1024 ** 3}`, "--fsize=209715200", "--", "/usr/bin/nice", "-n", "10", process.execPath, join(dist, "ml/runner.mjs"), "--selftest"];
    const r = spawnSync("/usr/bin/timeout", argv, { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.runtime.path).toContain(join(dist, "ml/node_modules/onnxruntime-node"));
    expect(out.models.map((m: { name: string }) => m.name)).toEqual(["yunet", "selfie-segmentation"]);
  });

  it.skipIf(!!process.env.CI)("runner exits with named codes: usage 2, model_bad 5 on a changed model", () => {
    expect(spawnSync(process.execPath, [join(dist, "ml/runner.mjs")], { encoding: "utf8" }).status).toBe(2);
    const copy = mkdtempSync(join(tmpdir(), "studio-ml-run-"));
    tmps.push(copy);
    cpSync(join(dist, "ml"), copy, { recursive: true });
    writeFileSync(join(copy, "models/yunet.onnx"), "not a model");
    const r = spawnSync(process.execPath, [join(copy, "runner.mjs"), "--selftest"], { encoding: "utf8" });
    expect(r.status).toBe(5);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, code: "model_bad" });
  });
});
