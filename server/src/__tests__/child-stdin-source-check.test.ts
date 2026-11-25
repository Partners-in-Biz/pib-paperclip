import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Child stdin is a Socket: a write after the child died emits `error`, and with
 * no listener that kills the server (PAR-9291). Instead of listing call
 * patterns (which missed `?.end(` and aliases), this counts EVERY way of
 * reaching a child's stdin, per file, on source with comments stripped (a regex, not a call-pattern list):
 *   - `x.stdin` / `x?.stdin` / `x["stdin"]`
 *   - destructuring `{ stdin }` (an alias)
 *   - `stdio[0]`
 * A file's count must equal its entry in ALLOWED, so a new access in an
 * allowlisted file fails as well, and a file with no entry may have none.
 * Anyone adding an access must guard it (`packages/adapter-utils/src/child-stdin.ts`)
 * and then raise the count here with a reason.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ROOTS = ["server/src", "packages/adapter-utils/src", "packages/paperclip-runner/src"];
const HELPER = "packages/adapter-utils/src/child-stdin.ts";
const EXCLUDED_DIRS = new Set(["node_modules", "dist", "cli", "mock-core", "__tests__", "__snapshots__"]);

function isTestFile(name: string) {
  return /\.(test|spec)\.tsx?$/.test(name) || name.endsWith(".d.ts");
}

function walk(dir: string, out: string[]) {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (!EXCLUDED_DIRS.has(name)) walk(full, out);
    } else if (/\.ts$/.test(name) && !isTestFile(name)) {
      out.push(path.relative(repoRoot, full).split(path.sep).join("/"));
    }
  }
}

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const root of ROOTS) walk(path.join(repoRoot, root), files);
  const adaptersDir = path.join(repoRoot, "packages/adapters");
  for (const adapter of readdirSync(adaptersDir)) {
    walk(path.join(adaptersDir, adapter, "src/server"), files);
  }
  return files.filter((file) => file !== HELPER).sort();
}

/** Remove comments, leaving strings (remote script text) alone. */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") { out += next ?? ""; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
    } else if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else {
      if (c === '"' || c === "'" || c === "`") quote = c;
      out += c;
      i += 1;
    }
  }
  return out;
}

// `.stdin` / `?.stdin`, `["stdin"]`, `stdio[0]`, and a destructured `{ stdin }`.
const STDIN_ACCESS = /\.stdin\b|\[["']stdin["']\]|\bstdio\[0\]|\{[^{}?;]*\bstdin\b[^{}?;]*\}\s*=(?![=>])/g;

export function countStdinAccesses(source: string): number {
  return (stripComments(source).match(STDIN_ACCESS) ?? []).length;
}

const ALLOWED: Record<string, { count: number; reason: string }> = {
  "packages/adapter-utils/src/command-managed-runtime.ts": { count: 1, reason: "not a write: an `opts.stdin` option passed on to the exec layer" },
  "packages/adapter-utils/src/execution-target.ts": { count: 10, reason: "2 option reads; the rest is remote script text (listener at the poll tail, process.stdin of the remote script), not a server child" },
  "packages/adapter-utils/src/git-workspace-sync.ts": { count: 4, reason: "guarded: listener at line 1028 precedes end/write at 1044-1051" },
  "packages/adapter-utils/src/sandbox-callback-bridge.ts": { count: 4, reason: "not a write: remote bridge script reads its own process.stdin and has an error listener" },
  "packages/adapter-utils/src/server-utils.ts": { count: 4, reason: "guarded: `const stdin = child.stdin` alias at 4998 writes with a failure callback; 4845 is a stdio option" },
  "packages/adapter-utils/src/ssh.ts": { count: 6, reason: "guarded via writeChildStdin (PAR-9713); the rest are option reads and a stdio option" },
  "packages/adapters/codex-local/src/server/quota.ts": { count: 3, reason: "guarded: error listener at 505 precedes write/end" },
  "packages/adapters/hermes/src/server/execute.ts": { count: 1, reason: "not a write: an `options.stdin` option passed on" },
  "packages/paperclip-runner/src/drivers/acpx/antigravity-auth.ts": { count: 2, reason: "guarded: error listener at 214 (write at 175 is sent later)" },
  "packages/paperclip-runner/src/drivers/acpx/antigravity-models.ts": { count: 2, reason: "guarded: error listener at 127 (write at 96 is sent later)" },
  "packages/paperclip-runner/src/drivers/acpx/antigravity-process.ts": { count: 1, reason: "end() with no data on a probe child; nothing is written" },
  "packages/paperclip-runner/src/drivers/codex/app-server-transport.ts": { count: 3, reason: "guarded: error listener at 482 precedes the write at 621; 611 is a read of writableLength" },
  "packages/paperclip-runner/src/drivers/copilot-metadata-probe.ts": { count: 4, reason: "guarded: error listener at 136; end() at 119 writes no data" },
  "packages/paperclip-runner/src/provider-events.ts": { count: 1, reason: "not a write: reads `params.stdin` for a byte count" },
  "server/src/services/environment-execution-target.ts": { count: 1, reason: "not a write: an `commandInput.stdin` option passed on" },
  "server/src/services/environment-runtime.ts": { count: 2, reason: "not a write: `input.stdin` options passed on" },
  "server/src/services/git-restore-point.ts": { count: 2, reason: "guarded: sink.stdin error listener at line 130 right after the pipe (the input write uses writeChildStdin)" },
  "server/src/services/local-ai-browser-login.ts": { count: 2, reason: "guarded: guardChildStdin at spawn; the write is gated on `writable`" },
  "server/src/services/native-runtime/artifact-transfer.ts": { count: 4, reason: "guarded: listener at 97; 60 is remote script text" },
  "server/src/services/photon/media.ts": { count: 4, reason: "guarded: listener at 135; 106 is a script string" },
  "server/src/services/plugin-worker-manager.ts": { count: 7, reason: "guarded: listener at 3100 at spawn; the other lines read `writable` or write after it" },
  "server/src/services/railway-ssh.ts": { count: 2, reason: "guarded: listener at 86 precedes end" },
  "server/src/services/remote-workspace-snapshot-archive.ts": { count: 3, reason: "guarded inline (script text cannot import): listener, then end" },
  "server/src/services/skill-source-git-snapshot.ts": { count: 2, reason: "guarded: listener at 159 precedes end" },
  "server/src/services/tool-gateway.ts": { count: 5, reason: "guarded: guardChildStdin at spawn; writes are gated on `writable` and an `exited` flag" },
  "server/src/services/workspace-compaction.ts": { count: 3, reason: "guarded: listener at 66 precedes the ends" },
};

describe("child stdin source check", () => {
  it("counts the three escape shapes the old pattern list missed", () => {
    expect(countStdinAccesses("child.stdin?.end(x)")).toBe(1);
    expect(countStdinAccesses("const s = child.stdin; s.write(x)")).toBe(1);
    expect(countStdinAccesses("const { stdin } = child;")).toBe(1);
    expect(countStdinAccesses('child["stdin"].write(x)')).toBe(1);
    expect(countStdinAccesses("const x = opts.stdio[0];")).toBe(1);
    expect(countStdinAccesses("// child.stdin.write(x)\n/* a.stdin */ const a = 'http://x';")).toBe(0);
  });

  it("matches the counted allowlist for every non-test source file", () => {
    const actual: Record<string, number> = {};
    for (const file of sourceFiles()) {
      const count = countStdinAccesses(readFileSync(path.join(repoRoot, file), "utf8"));
      if (count > 0) actual[file] = count;
    }
    const problems: string[] = [];
    for (const [file, count] of Object.entries(actual)) {
      const allowed = ALLOWED[file];
      if (!allowed) problems.push(`${file}: ${count} stdin access(es), file is not allowlisted. Guard it with child-stdin.ts, then add it with a reason.`);
      else if (allowed.count !== count) problems.push(`${file}: ${count} stdin access(es), allowlist says ${allowed.count}. Guard the new access, then update the count.`);
    }
    for (const [file, { count }] of Object.entries(ALLOWED)) {
      if (!actual[file]) problems.push(`${file}: allowlisted for ${count} but has none. Remove the entry.`);
    }
    expect(problems).toEqual([]);
  });
});
