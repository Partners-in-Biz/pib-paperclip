#!/usr/bin/env node
// Planning Canvas 404 sweep (plan PAR-13925 section D, C3).
//
// Lists every handler in server/src/routes/planning-canvas*.ts with its method,
// path and the guard symbols its body calls, and every server or package file
// outside the canvas code that names the `planning_canvas*` tables. The output
// goes in the PR; `server/src/__tests__/planning-canvas-access-routes.test.ts`
// runs the same functions and fails when a handler has no guard or an unknown
// reader appears.
//
// Usage: node scripts/planning-canvas-route-sweep.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUTES_DIR = path.join(REPO_ROOT, "server/src/routes");
const ROUTE = /router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
const NEXT_ROUTE = /\brouter\.(get|post|put|patch|delete|use)\(/;

/** Calls that decide who may reach a handler. `planningCanvasForRequest(db, req, "<level>")` also names its level. */
export const PLANNING_CANVAS_GUARDS = [
  "planningCanvasForRequest",
  "planningCanvasCompany",
  "boardUserId",
  "forbidden",
  "planningCanvasNotFound",
];

/** Handlers of every `routes/planning-canvas*.ts` file, with their guard symbols. */
export function sweepPlanningCanvasRoutes(routesDir = ROUTES_DIR) {
  const rows = [];
  for (const file of readdirSync(routesDir).filter((name) => /^planning-canvas.*\.ts$/.test(name)).sort()) {
    const source = readFileSync(path.join(routesDir, file), "utf8");
    for (const match of source.matchAll(ROUTE)) {
      if (match[2].startsWith("/companies/:companyId/planning-canvases") === false) continue;
      const start = (match.index ?? 0) + match[0].length;
      const rest = source.slice(start);
      const next = rest.search(NEXT_ROUTE);
      const body = next < 0 ? rest : rest.slice(0, next);
      const guards = PLANNING_CANVAS_GUARDS.filter((name) => new RegExp(`\\b${name}\\(`).test(body));
      const level = /planningCanvasForRequest\(db,\s*req,\s*"(\w+)"\)/.exec(body)?.[1] ?? null;
      rows.push({ file, method: match[1].toUpperCase(), path: `/api${match[2]}`, level, guards });
    }
  }
  return rows;
}

/** Code allowed to read or write the canvas tables (plan section I, plus C3). */
export const PLANNING_CANVAS_KNOWN_READERS = [
  /^packages\/db\/src\/schema\/(index|planning_canvas[a-z_]*)\.ts$/,
  /^packages\/db\/src\/migrations\//,
  /^packages\/db\/src\/planning-canvas-items-migration\.test\.ts$/,
  // The shared contract names the tables in comments only; it has no database access.
  /^packages\/shared\/src\/(types|validators)\/planning-canvas(\.test)?\.ts$/,
  /^server\/src\/services\/planning-canvas[a-z-]*(\.test)?\.ts$/,
  /^server\/src\/services\/planning-canvases[a-z-]*(\.test)?\.ts$/,
  /^server\/src\/routes\/planning-canvas[a-z-]*\.ts$/,
  /^server\/src\/__tests__\/planning-canvas[a-z-]*\.test\.ts$/,
  /^scripts\/planning-canvas-[a-z-]*\.(ts|mjs)$/,
];

const TABLE_NAMES = /\bplanning_canvas(es|_items|_comments|_agent_grants|_op_batches)\b|\bplanningCanvas(es|Items|Comments|AgentGrants|OpBatches)\b/;

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js|sql)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Files in server/, packages/ (not ui/) and scripts/ that name a canvas table, split into known and unknown. */
export function sweepPlanningCanvasReaders(root = REPO_ROOT) {
  const files = ["server/src", "packages", "scripts", "cli/src"]
    .map((dir) => path.join(root, dir))
    .filter((dir) => { try { return statSync(dir).isDirectory(); } catch { return false; } })
    .flatMap((dir) => walk(dir, []));
  const known = [];
  const unknown = [];
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (!TABLE_NAMES.test(readFileSync(file, "utf8"))) continue;
    (PLANNING_CANVAS_KNOWN_READERS.some((pattern) => pattern.test(relative)) ? known : unknown).push(relative);
  }
  return { known: known.sort(), unknown: unknown.sort() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rows = sweepPlanningCanvasRoutes();
  console.log("| File | Method | Path | Level | Guards |");
  console.log("|---|---|---|---|---|");
  for (const row of rows) {
    console.log(`| ${row.file} | ${row.method} | ${row.path} | ${row.level ?? "-"} | ${row.guards.join(", ") || "NONE"} |`);
  }
  const readers = sweepPlanningCanvasReaders();
  console.log(`\nReaders of the planning_canvas tables: ${readers.known.length} known, ${readers.unknown.length} unknown`);
  for (const file of readers.unknown) console.log(`UNKNOWN ${file}`);
  if (rows.some((row) => !row.guards.includes("planningCanvasForRequest") && !row.guards.includes("planningCanvasCompany")) || readers.unknown.length > 0) {
    process.exitCode = 1;
  }
}
