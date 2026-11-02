#!/usr/bin/env node
// Lay out the fork-core overlay staging dir (PAR-6866).
//   build-info.json
//   @paperclipai/<pkg>/{package.json,dist/,...}   one per workspace package that has dist/
//   ui-dist/                                       ui build output (npm ships it at @paperclipai/server/ui-dist)
// Env: STAGING (output dir), FULL_SHA. Run from the repo root after `pnpm build`.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const staging = path.resolve(process.env.STAGING ?? "");
const fullSha = process.env.FULL_SHA ?? "";
if (!process.env.STAGING || !/^[0-9a-f]{40}$/.test(fullSha)) {
  throw new Error("STAGING and a 40-char FULL_SHA are required");
}

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

const workspace = JSON.parse(
  execFileSync("pnpm", ["-r", "ls", "--json", "--depth", "-1"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
);
const versions = new Map(workspace.map((p) => [p.name, p.version]));
// pnpm applies these publishConfig keys over the top level at pack time; they are not overrides.
const PUBLISH_ONLY = new Set(["access", "registry", "tag", "provenance", "directory", "linkDirectory", "executableFiles"]);

function toPublishedManifest(pkg) {
  const out = { ...pkg };
  for (const [key, value] of Object.entries(pkg.publishConfig ?? {})) {
    if (!PUBLISH_ONLY.has(key)) out[key] = value;
  }
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    if (!out[field]) continue;
    out[field] = Object.fromEntries(
      Object.entries(out[field]).map(([dep, spec]) => {
        if (typeof spec !== "string" || !spec.startsWith("workspace:")) return [dep, spec];
        const range = spec.slice("workspace:".length);
        const v = versions.get(dep) ?? "*";
        return [dep, range === "^" ? `^${v}` : range === "~" ? `~${v}` : range === "*" || range === "" ? v : range];
      }),
    );
  }
  return out;
}

const staged = [];
for (const pkg of workspace) {
  if (!pkg.name?.startsWith("@paperclipai/") || pkg.path === process.cwd()) continue;
  if (pkg.name === "@paperclipai/ui") continue; // shipped as the top-level ui-dist/ below
  const dist = path.join(pkg.path, "dist");
  if (!existsSync(dist)) continue;
  const manifest = JSON.parse(readFileSync(path.join(pkg.path, "package.json"), "utf8"));
  const dest = path.join(staging, pkg.name);
  mkdirSync(dest, { recursive: true });
  writeFileSync(path.join(dest, "package.json"), `${JSON.stringify(toPublishedManifest(manifest), null, 2)}\n`);
  // dist plus any other plain `files` entries the npm package ships (skills, catalog, generated, ...).
  const entries = new Set(["dist"]);
  for (const f of manifest.files ?? []) {
    const clean = String(f).replace(/\/+$/, "");
    if (clean && !/[*!]/.test(clean) && clean !== "ui-dist") entries.add(clean);
  }
  for (const entry of entries) {
    const src = path.join(pkg.path, entry);
    if (existsSync(src)) cpSync(src, path.join(dest, entry), { recursive: true, dereference: true });
  }
  staged.push(pkg.name);
}

const uiSrc = path.resolve("ui/dist");
if (!existsSync(path.join(uiSrc, "index.html"))) throw new Error(`ui build output missing: ${uiSrc}/index.html`);
cpSync(uiSrc, path.join(staging, "ui-dist"), { recursive: true, dereference: true });

writeFileSync(path.join(staging, "build-info.json"), `${JSON.stringify({ commit: fullSha })}\n`);

const required = ["server", "db", "shared", "adapter-utils", "plugin-sdk", "skills-catalog"].map((n) => `@paperclipai/${n}`);
const missing = required.filter((n) => !staged.includes(n));
if (missing.length) throw new Error(`required packages missing from overlay: ${missing.join(", ")}`);
if (!staged.includes("@paperclipai/hermes-paperclip-adapter")) console.warn("::warning::@paperclipai/hermes-paperclip-adapter not staged");
if (!staged.some((n) => n.startsWith("@paperclipai/adapter-"))) throw new Error("no @paperclipai/adapter-* packages staged");
const runner = path.join(staging, "@paperclipai/server/dist/vendor/paperclip-runner/bin/paperclip-runnerd");
if (!existsSync(runner)) throw new Error(`runner binary missing from overlay: ${runner}`);

console.log(`staged ${staged.length} packages:\n${staged.sort().map((n) => `  ${n}`).join("\n")}`);
