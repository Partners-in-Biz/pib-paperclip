/**
 * The access test helper (PAR-12578 plan, 4.5 items 1 to 3). For tests only:
 * it reads files, so it is not exported from the kit's main entry
 * (`@partnersinbiz/pib-plugin-kit/access-testing`).
 *
 * One spec per guarded plugin calls `assertPluginAccess` with the sdk harness's
 * `ctx`, the plugin's `setup`, its manifest, its access table and its `src/`:
 *
 * 1. Registered keys. The helper wraps `ctx.actions.register`,
 *    `ctx.data.register` and `ctx.tools.register` before `setup()` runs and
 *    records every key. Every action and tool must have a table entry and must
 *    have been registered through the guard; every table row must be a
 *    registered key; data handlers must be exactly the named ones.
 * 2. Each manifest `apiRoutes` key has an `api:` row, and each `api:` row a route.
 * 3. Source check: no `.actions.register`, `.tools.register` or (outside the
 *    plugins with named data handlers) `.data.register` in `src/`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { GUARDED_HANDLER, type AccessTable } from "./guard.js";
import { ACCESS_ME_ACTION } from "./me.js";

/** The only data handlers a PiB plugin may register (4.4: they carry no caller). Studio 9, Voice 2, CRM 2. */
export const NAMED_DATA_HANDLERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "partnersinbiz.studio": ["overview", "assets", "asset", "client-summaries", "generations", "canvases", "canvas", "canvas-versions", "canvas-comments"],
  "partnersinbiz.voice": ["status", "agent-voice"],
  "partnersinbiz.crm": ["drive-folder", "drive-files"],
});

/** Section 4.5 item 3; the `agent.tools.register` capability string is not a call. */
export const REGISTER_CALL = /\.(actions|data|tools)\.register\b/g;
const GUARD_FILE = fileURLToPath(new URL("./guard.ts", import.meta.url));

export interface PluginAccessCheckInput {
  /** The sdk harness's `ctx` (`createTestHarness(...).ctx`). */
  ctx: PluginContext;
  /** The plugin's setup, e.g. `plugin.definition.setup`. Run once, with the registrations recorded. */
  setup: (ctx: PluginContext) => void | Promise<void>;
  manifest: { id: string; apiRoutes?: ReadonlyArray<{ routeKey: string }> };
  table: AccessTable;
  /** Absolute path of the plugin's `src/` for the source check; omitted: no source check. */
  srcDir?: string;
}

export interface RecordedRegistrations {
  actions: Map<string, { guarded: boolean }>;
  tools: Map<string, { guarded: boolean }>;
  data: string[];
}

const isGuarded = (handler: unknown) => typeof handler === "function" && (handler as unknown as Record<symbol, unknown>)[GUARDED_HANDLER] === true;

/** Runs `setup` with the three register calls wrapped; the handlers still reach the host as before. */
export async function recordRegistrations(ctx: PluginContext, setup: PluginAccessCheckInput["setup"]): Promise<RecordedRegistrations> {
  const out: RecordedRegistrations = { actions: new Map(), tools: new Map(), data: [] };
  const actions = ctx.actions.register;
  const tools = ctx.tools.register;
  const data = ctx.data.register;
  ctx.actions.register = (key, handler) => {
    out.actions.set(key, { guarded: isGuarded(handler) });
    return actions.call(ctx.actions, key, handler);
  };
  ctx.tools.register = (name, declaration, handler) => {
    out.tools.set(name, { guarded: isGuarded(handler) });
    return tools.call(ctx.tools, name, declaration, handler);
  };
  ctx.data.register = (key, handler) => {
    out.data.push(key);
    return data.call(ctx.data, key, handler);
  };
  try {
    await setup(ctx);
  } finally {
    ctx.actions.register = actions;
    ctx.tools.register = tools;
    ctx.data.register = data;
  }
  return out;
}

/** Items 1 and 2 on recorded registrations. Each problem is one readable line. */
export function registrationProblems(input: Omit<PluginAccessCheckInput, "ctx" | "setup" | "srcDir">, rec: RecordedRegistrations): string[] {
  const { manifest, table } = input;
  const problems: string[] = [];
  const has = (key: string) => Object.hasOwn(table, key);
  if (!rec.actions.get(ACCESS_ME_ACTION)?.guarded) problems.push(`no access guard was created in setup (createAccessGuard registers "${ACCESS_ME_ACTION}")`);
  for (const [key, r] of rec.actions) {
    if (key === ACCESS_ME_ACTION && r.guarded) continue;
    if (!r.guarded) problems.push(`action "${key}" is registered directly, not through the access guard (use guard.action)`);
    if (!has(key)) problems.push(`action "${key}" has no row in the access table (unmapped action)`);
  }
  for (const [name, r] of rec.tools) {
    if (!r.guarded) problems.push(`tool "${name}" is registered directly, not through the access guard (use guard.tool)`);
    if (!has(`tool:${name}`)) problems.push(`tool "${name}" has no row "tool:${name}" in the access table (unmapped tool)`);
  }
  const routes = new Set((manifest.apiRoutes ?? []).map((r) => r.routeKey));
  for (const route of routes) {
    if (!has(`api:${route}`)) problems.push(`manifest API route "${route}" has no row "api:${route}" in the access table`);
  }
  for (const key of Object.keys(table)) {
    if (key.startsWith("api:")) {
      if (!routes.has(key.slice(4))) problems.push(`table row "${key}" names no manifest API route (stale row)`);
    } else if (key.startsWith("tool:")) {
      if (!rec.tools.has(key.slice(5))) problems.push(`table row "${key}" names no registered tool (stale row)`);
    } else if (!rec.actions.has(key) || key === ACCESS_ME_ACTION) {
      problems.push(`table row "${key}" names no registered action (stale row)`);
    }
  }
  const named = NAMED_DATA_HANDLERS[manifest.id] ?? [];
  for (const key of new Set(rec.data)) {
    if (!named.includes(key)) problems.push(`data handler "${key}" is not one of the named data handlers of ${manifest.id} (extra data handler; register an action through the guard instead)`);
  }
  for (const key of named) {
    if (!rec.data.includes(key)) problems.push(`named data handler "${key}" of ${manifest.id} was not registered (remove it from NAMED_DATA_HANDLERS)`);
  }
  return problems;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.(spec|test)\./.test(name) ? [path] : [];
  });
}

/** Item 3: every register call in `srcDir`, as `file:line` lines. Comment lines are skipped. */
export function sourceProblems(pluginKey: string, srcDir: string): string[] {
  const dataAllowed = Object.hasOwn(NAMED_DATA_HANDLERS, pluginKey);
  const problems: string[] = [];
  for (const file of sourceFiles(srcDir)) {
    if (file === GUARD_FILE) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
      for (const m of line.matchAll(REGISTER_CALL)) {
        if (m[1] === "tools" && /["'`]agent\.tools\.register["'`]/.test(line)) continue;
        if (m[1] === "data" && dataAllowed) continue;
        problems.push(`${relative(srcDir, file)}:${i + 1} calls ${m[0]} directly: ${line.trim()}`);
      }
    });
  }
  return problems;
}

/** All three checks; an empty list means the plugin passes. */
export async function checkPluginAccess(input: PluginAccessCheckInput): Promise<string[]> {
  const rec = await recordRegistrations(input.ctx, input.setup);
  return [...registrationProblems(input, rec), ...(input.srcDir ? sourceProblems(input.manifest.id, input.srcDir) : [])];
}

/** Throws one error listing every problem. */
export async function assertPluginAccess(input: PluginAccessCheckInput): Promise<void> {
  const problems = await checkPluginAccess(input);
  if (problems.length) throw new Error(`Access check failed for ${input.manifest.id}:\n- ${problems.join("\n- ")}`);
}
