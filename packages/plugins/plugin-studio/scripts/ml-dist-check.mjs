// The dist/ml checks of bundle-size-guard.mjs (PAR-10126 D5b): a check, not an exemption. Its own module so
// tests/ml-packaging.spec.ts can prove each failure on a fixture folder.
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** dist/ml cap: the linux-x64 CPU runtime is ~48 MB, the two models 0.7 MB. Raise only with a reason. */
export const ML_BUDGET = 60 * 1024 * 1024;
/** The only folder a native binary may sit in (binding.js loads ../bin/napi-v6/<platform>/<arch>/). */
export const NATIVE_DIR = "node_modules/onnxruntime-node/bin/napi-v6/linux/x64/";
const NATIVE_FILE = /\.(node|so(\.\d+)*|dylib|dll|exe)$/i;
const EM_X86_64 = 0x3e;

export function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** ELF64, little-endian, x86-64 (e_machine at byte 18). */
function isElfX64(file) {
  const fd = openSync(file, "r");
  const h = Buffer.alloc(20);
  try {
    if (readSync(fd, h, 0, 20, 0) !== 20) return false;
  } finally {
    closeSync(fd);
  }
  return h.readUInt32BE(0) === 0x7f454c46 && h[4] === 2 && h[5] === 1 && h.readUInt16LE(18) === EM_X86_64;
}

/**
 * Returns the problems (empty = pass). Fails on a CUDA/TensorRT file, a native binary outside the linux-x64 folder or
 * not an x86-64 ELF, a model whose SHA-256 differs from ml-models/SHA256SUMS (or is missing or unlisted), dist/ml over
 * `maxBytes`, or a worker bundle that names onnxruntime (only dist/ml/runner.mjs may load it).
 */
export function checkMlDist({ distDir, sumsFile, maxBytes = ML_BUDGET }) {
  const problems = [];
  const ml = join(distDir, "ml");
  if (readFileSync(join(distDir, "worker.js"), "utf8").includes("onnxruntime")) problems.push('dist/worker.js contains "onnxruntime"; only dist/ml/runner.mjs may load it');
  let files;
  try {
    files = walk(ml);
  } catch {
    return [...problems, "dist/ml is missing"];
  }
  if (!files.includes(join(ml, "runner.mjs"))) problems.push("dist/ml/runner.mjs is missing");
  let total = 0;
  for (const f of files) {
    const rel = relative(ml, f).split(sep).join("/");
    total += statSync(f).size;
    if (/cuda|tensorrt/i.test(rel)) problems.push(`dist/ml/${rel} is a CUDA/TensorRT file`);
    if (NATIVE_FILE.test(rel) && (!rel.startsWith(NATIVE_DIR) || !isElfX64(f))) problems.push(`dist/ml/${rel} is not a linux-x64 binary in ${NATIVE_DIR}`);
  }
  for (const want of ["onnxruntime_binding.node", "libonnxruntime.so.1"]) {
    if (!files.includes(join(ml, NATIVE_DIR, want))) problems.push(`dist/ml/${NATIVE_DIR}${want} is missing`);
  }
  if (total > maxBytes) problems.push(`dist/ml is ${total} bytes, over the ${maxBytes} budget`);
  const sums = new Map();
  for (const line of readFileSync(sumsFile, "utf8").split("\n")) {
    const m = /^([0-9a-f]{64}) [ *]?(\S+)$/.exec(line.trim());
    if (m) sums.set(m[2], m[1]);
  }
  if (sums.size === 0) problems.push("ml-models/SHA256SUMS lists no model");
  for (const [name, want] of sums) {
    const p = join(ml, "models", name);
    if (!files.includes(p)) {
      problems.push(`dist/ml/models/${name} is missing`);
      continue;
    }
    const got = createHash("sha256").update(readFileSync(p)).digest("hex");
    if (got !== want) problems.push(`dist/ml/models/${name} SHA-256 ${got} differs from ml-models/SHA256SUMS ${want}`);
  }
  for (const f of files) {
    if (!f.endsWith(".onnx")) continue;
    const rel = relative(join(ml, "models"), f).split(sep).join("/");
    if (!sums.has(rel)) problems.push(`dist/ml/${relative(ml, f).split(sep).join("/")} is not listed in ml-models/SHA256SUMS`);
  }
  return problems;
}

/** Total bytes under dist/ml, for the PASS line. */
export function mlBytes(distDir) {
  return walk(join(distDir, "ml")).reduce((n, f) => n + statSync(f).size, 0);
}
