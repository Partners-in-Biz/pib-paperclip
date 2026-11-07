/**
 * Every action the Studio page calls must be registered by the worker (PAR-8134). A merge once dropped
 * `drive-transfer` while the UI still polled it, which would have broken Drive transfers over 5 MiB on live.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

function matches(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((m) => m[1]!);
}

const worker = readFileSync(join(SRC, "worker.ts"), "utf8");
const registered = new Set([
  ...matches(worker, /\baction\(\s*"([a-z][a-z0-9-]*)"/g),
  ...matches(worker, /ctx\.actions\.register\(\s*"([a-z][a-z0-9-]*)"/g),
]);
const uiText = sourceFiles(join(SRC, "ui")).map((path) => readFileSync(path, "utf8")).join("\n");
const called = new Set(matches(uiText, /\b(?:usePluginAction|useAction|useStudioAction)\(\s*["']([a-z][a-z0-9-]*)["']/g));

describe("worker action registry", () => {
  it("registers drive-transfer, which the Drive save and import UI polls", () => {
    expect(registered.has("drive-transfer")).toBe(true);
    expect(registered.has("brand-kit")).toBe(true);
  });

  it("registers every action the UI calls", () => {
    expect(called.size).toBeGreaterThan(5);
    expect(called.has("drive-transfer")).toBe(true);
    const missing = [...called].filter((key) => !registered.has(key));
    expect(missing).toEqual([]);
  });
});
