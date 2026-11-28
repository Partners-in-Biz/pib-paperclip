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
 * 1.5. Receiver (PAR-15008): every plugin but Setup subscribes to Setup's
 *    `access.updated` in `setup()` (the guard does it), and with the harness a
 *    send is stored and confirmed with `access.synced`.
 *
 * Given the `harness` (and `onApiRequest` for a plugin with API routes), it then
 * calls every guarded action, tool and route with seeded people and runs.
 * "Today's result" means the guard handed the call to the plugin's handler
 * unchanged; the guard's probe answers in its place, so no handler runs.
 * 4. Switch absent or `off`: every call passes. `enforce`: an operator with no
 *    grant is refused (passes on an `ANY_MEMBER` row), the owner passes, an
 *    operator granted the row's permission passes, and with the row hidden he
 *    is refused.
 * 5. Tools under `enforce`: a run for the operator is refused, a run for the
 *    owner passes; a run with no person, a run not found and no run are refused.
 * 6. API routes under `enforce`: the owner and an agent on the owner's run pass;
 *    the operator and an agent on his run are refused; an unknown route key is
 *    refused.
 * 7. The acting person from the host (PAR-12608 4.10, H3): with the switch
 *    absent, a person core marks restricted is refused on every action, tool and
 *    route (not in Setup, which always has its own row). Under `enforce` a tool takes the host's person over the run it names
 *    (a key with no run and the owner passes; the owner's run sent for an
 *    operator is held to the operator); no person on the call is refused.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginApiRequestInput, PluginApiResponse, PluginContext } from "@paperclipai/plugin-sdk";
import type { TestHarness } from "@paperclipai/plugin-sdk/testing";
import { accessGrantScope, permissionKey } from "../permissions.js";
import { ACTING_PERSON_SQL } from "./acting-person.js";
import { ADMIN_ONLY, GUARDED_HANDLER, guardProbes, type AccessTable, type GuardProbe } from "./guard.js";
import { ACCESS_ME_ACTION } from "./me.js";
import { ACCESS_UPDATED_EVENT } from "./receiver.js";
import { SETUP_PLUGIN } from "../setup.js";
import { isRefusal, PERMISSION_DENIED } from "./refusal.js";
import { ACCESS_EVENTS, accessCompanyScope, parseAccessRow } from "./switch.js";

/**
 * The only data handlers a PiB plugin may register (4.4: they carry no caller). Studio 9, Voice 2. The CRM's two Drive
 * handlers became actions in stage B-3 (PAR-15205), so the CRM may register none.
 */
export const NAMED_DATA_HANDLERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "partnersinbiz.studio": ["overview", "assets", "asset", "client-summaries", "generations", "canvases", "canvas", "canvas-versions", "canvas-comments"],
  "partnersinbiz.voice": ["status", "agent-voice"],
});

/** Section 4.5 item 3; the `agent.tools.register` capability string is not a call. */
export const REGISTER_CALL = /\.(actions|data|tools)\.register\b/g;
const GUARD_FILE = fileURLToPath(new URL("./guard.ts", import.meta.url));

export interface PluginAccessCheckInput {
  /** The sdk harness's `ctx` (`createTestHarness(...).ctx`); taken from `harness` when that is given. */
  ctx?: PluginContext;
  /** The sdk harness; given, the behaviour checks (items 4 to 6) run too. */
  harness?: TestHarness;
  /** The plugin's `onApiRequest`, e.g. `plugin.definition.onApiRequest`; needed for the route checks. */
  onApiRequest?: (input: PluginApiRequestInput) => Promise<PluginApiResponse>;
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
  /** Event names `setup()` subscribed to with `ctx.events.on`. */
  events: string[];
}

const isGuarded = (handler: unknown) => typeof handler === "function" && (handler as unknown as Record<symbol, unknown>)[GUARDED_HANDLER] === true;

/** Runs `setup` with the three register calls wrapped; the handlers still reach the host as before. */
export async function recordRegistrations(ctx: PluginContext, setup: PluginAccessCheckInput["setup"]): Promise<RecordedRegistrations> {
  const out: RecordedRegistrations = { actions: new Map(), tools: new Map(), data: [], events: [] };
  const actions = ctx.actions.register;
  const tools = ctx.tools.register;
  const data = ctx.data.register;
  const on = ctx.events.on;
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
  ctx.events.on = ((name: string, ...rest: unknown[]) => {
    const off = (on as (...args: unknown[]) => () => void).call(ctx.events, name, ...rest);
    out.events.push(name);
    return off;
  }) as typeof ctx.events.on;
  try {
    await setup(ctx);
  } finally {
    ctx.actions.register = actions;
    ctx.tools.register = tools;
    ctx.data.register = data;
    ctx.events.on = on;
  }
  return out;
}

/** Items 1 and 2 on recorded registrations. Each problem is one readable line. */
export function registrationProblems(input: Pick<PluginAccessCheckInput, "manifest" | "table">, rec: RecordedRegistrations): string[] {
  const { manifest, table } = input;
  const problems: string[] = [];
  const has = (key: string) => Object.hasOwn(table, key);
  if (!rec.actions.get(ACCESS_ME_ACTION)?.guarded) problems.push(`no access guard was created in setup (createAccessGuard registers "${ACCESS_ME_ACTION}")`);
  if (manifest.id !== SETUP_PLUGIN && !rec.events.includes(ACCESS_UPDATED_EVENT)) {
    problems.push(`setup does not subscribe to "${ACCESS_UPDATED_EVENT}", so Setup's access is never received or confirmed (createAccessGuard registers the receiver; is it given the plugin's ctx?)`);
  }
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

/** All checks; an empty list means the plugin passes. */
export async function checkPluginAccess(input: PluginAccessCheckInput): Promise<string[]> {
  const ctx = input.harness?.ctx ?? input.ctx;
  if (!ctx) throw new Error("checkPluginAccess needs the harness or its ctx");
  const rec = await recordRegistrations(ctx, input.setup);
  return [
    ...registrationProblems(input, rec),
    ...(input.srcDir ? sourceProblems(input.manifest.id, input.srcDir) : []),
    ...(input.harness ? await behaviourProblems({ ...input, harness: input.harness }, rec) : []),
  ];
}

const id = (n: number) => `a1500000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** The companies, people, agent and runs the behaviour checks seed. */
export const ACCESS_TEST_IDS = Object.freeze({
  absent: id(1), off: id(2), enforce: id(3), received: id(4),
  owner: id(11), operator: id(12), granted: id(13),
  agent: id(21), runOwner: id(31), runOperator: id(32), runNobody: id(33), runMissing: id(34),
});
const T = ACCESS_TEST_IDS;
const scopeKey = (s: { scopeId?: string; namespace?: string; stateKey: string }) => `${s.scopeId ?? ""}|${s.namespace ?? ""}|${s.stateKey}`;
const short = (v: unknown) => {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
};

type Kind = "action" | "tool" | "route";
/** What core sends as the acting person (H3); left out, the call is from a core older than H3. */
type HostPerson = { onBehalfOfUserId: string | null; onBehalfOfRestricted: boolean };
type Who = ({ user: string } | { run: string }) & { as?: HostPerson };
type Outcome = { reached: true } | { reached: false; refused: boolean; got: string };

/** Items 4 to 6 on the set-up harness. Each problem is one readable line. */
export async function behaviourProblems(input: PluginAccessCheckInput & { harness: TestHarness }, rec: RecordedRegistrations): Promise<string[]> {
  const { harness, table, manifest, onApiRequest } = input;
  const ctx = harness.ctx;
  const problems: string[] = [];
  const routes = (manifest.apiRoutes ?? []).map((r) => r.routeKey);
  if (routes.length && !onApiRequest) problems.push("the manifest has API routes but no onApiRequest was given to the access check (pass plugin.definition.onApiRequest)");
  const actions = [...rec.actions].filter(([k, r]) => r.guarded && k !== ACCESS_ME_ACTION).map(([k]) => k);
  const tools = [...rec.tools].filter(([, r]) => r.guarded).map(([k]) => k);

  const allow: string[] = [];
  const scopeOverrides: Record<string, "all"> = {};
  for (const e of Object.values(table)) {
    if (typeof e === "object" && "resource" in e) {
      allow.push(permissionKey(e.resource, e.action));
      scopeOverrides[e.resource] = "all";
    }
  }
  const at = new Date().toISOString();
  const rows = new Map<string, unknown>([
    [scopeKey(accessCompanyScope(T.off)), { mode: "off", rev: 1, userIds: [], receivedAt: at }],
    [scopeKey(accessCompanyScope(T.enforce)), { mode: "enforce", rev: 1, userIds: [], receivedAt: at }],
    [scopeKey(accessGrantScope(T.enforce, T.granted)), { allow, scopeOverrides }],
  ]);
  const runs = new Map<string, string | null>([[T.runOwner, T.owner], [T.runOperator, T.operator], [T.runNobody, null]]);
  const companies = [T.absent, T.off, T.enforce];
  const member = (companyId: string, userId: string, role: string) => ({ id: `m-${companyId}-${userId}`, companyId, principalType: "user" as const, principalId: userId, status: "active" as const, membershipRole: role, grants: [], createdAt: at, updatedAt: at });
  harness.seed({ accessMembers: companies.flatMap((co) => [member(co, T.owner, "owner"), member(co, T.operator, "member"), member(co, T.granted, "member")]) });

  let seen = 0;
  const probe: GuardProbe & { hidden: Set<string> } = { hidden: new Set(), reached: () => (seen++, { content: "access check", status: 200, body: null }) };
  const get = ctx.state.get;
  const query = ctx.db.query;
  // The harness keeps its capability checks: the plugin's own call goes first.
  ctx.state.get = async (scope) => {
    const v = await get.call(ctx.state, scope);
    const k = scopeKey(scope);
    return rows.has(k) ? rows.get(k) : v;
  };
  ctx.db.query = (async (sql: string, params?: unknown[]) => {
    const out = await query.call(ctx.db, sql, params);
    if (sql !== ACTING_PERSON_SQL) return out;
    const [runId, companyId, agentId] = params ?? [];
    const found = typeof runId === "string" && runs.has(runId) && companies.includes(companyId as string) && agentId === T.agent;
    return found ? [{ responsible_user_id: runs.get(runId), status: "running" }] : [];
  }) as typeof ctx.db.query;

  async function call(kind: Kind, name: string, companyId: string, who: Who): Promise<Outcome> {
    seen = 0;
    let result: unknown;
    try {
      if (kind === "action") {
        result = await harness.performAction(name, {}, { companyId, actor: { type: "user", userId: "user" in who ? who.user : null, ...who.as } });
      } else if (kind === "tool") {
        result = await harness.executeTool(name, {}, { agentId: T.agent, runId: "run" in who ? who.run : "", companyId, ...who.as });
      } else {
        const actor = { ...("user" in who ? { actorType: "user" as const, actorId: who.user, userId: who.user } : { actorType: "agent" as const, actorId: T.agent, agentId: T.agent, runId: who.run }), ...who.as };
        result = await onApiRequest!({ routeKey: name, method: "GET", path: `/${name}`, params: {}, query: {}, body: null, actor, companyId, headers: {} });
      }
    } catch (error) {
      if (seen) return { reached: true };
      return { reached: false, refused: false, got: `an error: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (seen) return { reached: true };
    const r = result as { error?: unknown; status?: unknown; body?: unknown } | null;
    const reason =
      kind === "action" ? (isRefusal(r) && r.code === PERMISSION_DENIED ? r.message : null)
      : kind === "tool" ? (typeof r?.error === "string" && r.error.startsWith("Access refused") ? r.error : null)
      : r?.status === 403 && isRefusal(r.body) ? r.body.message : null;
    if (reason !== null) return { reached: false, refused: true, got: `the refusal form ("${reason}")` };
    return { reached: false, refused: false, got: `${short(result)}, not through the access guard of ${manifest.id} (is createAccessGuard given pluginKey "${manifest.id}"?)` };
  }

  async function expectCall(label: string, want: "pass" | "refuse", kind: Kind, name: string, companyId: string, who: Who) {
    const o = await call(kind, name, companyId, who);
    if (want === "pass" ? o.reached : !o.reached && o.refused) return;
    const wanted = want === "pass" ? "today's result (the call reaches its handler)" : "the refusal form";
    problems.push(`${label}: expected ${wanted}, got ${o.reached ? "today's result (the call reached its handler)" : o.got}`);
  }

  const open = (key: string) => {
    const e = table[key];
    return typeof e === "object" && "anyMember" in e;
  };
  const noGrant = (key: string) => (open(key) ? "pass" : "refuse");
  const user = (u: string) => ({ user: u });
  const run = (r: string) => ({ run: r });
  const askRoutes = onApiRequest ? routes : [];
  guardProbes().set(manifest.id, probe);
  try {
    for (const [co, sw] of [[T.absent, "switch absent"], [T.off, "switch off"]] as const) {
      for (const a of actions) await expectCall(`action "${a}", ${sw}, operator with no grant`, "pass", "action", a, co, user(T.operator));
      for (const t of tools) await expectCall(`tool "${t}", ${sw}, run working for an operator with no grant`, "pass", "tool", t, co, run(T.runOperator));
      for (const r of askRoutes) await expectCall(`API route "${r}", ${sw}, operator with no grant`, "pass", "route", r, co, user(T.operator));
    }
    const E = T.enforce;
    for (const a of actions) {
      await expectCall(`action "${a}", enforce, operator with no grant`, noGrant(a), "action", a, E, user(T.operator));
      await expectCall(`action "${a}", enforce, owner`, "pass", "action", a, E, user(T.owner));
      if (table[a] !== ADMIN_ONLY) await expectCall(`action "${a}", enforce, operator granted its permission`, "pass", "action", a, E, user(T.granted));
      probe.hidden.add(a);
      await expectCall(`action "${a}" missing from the table, enforce, operator granted every permission`, "refuse", "action", a, E, user(T.granted));
      probe.hidden.delete(a);
    }
    for (const t of tools) {
      await expectCall(`tool "${t}", enforce, run working for an operator with no grant`, noGrant(`tool:${t}`), "tool", t, E, run(T.runOperator));
      await expectCall(`tool "${t}", enforce, run working for the owner`, "pass", "tool", t, E, run(T.runOwner));
      await expectCall(`tool "${t}", enforce, run with no person`, "refuse", "tool", t, E, run(T.runNobody));
      await expectCall(`tool "${t}", enforce, run that cannot be found`, "refuse", "tool", t, E, run(T.runMissing));
      await expectCall(`tool "${t}", enforce, no run`, "refuse", "tool", t, E, run(""));
    }
    for (const r of askRoutes) {
      await expectCall(`API route "${r}", enforce, owner`, "pass", "route", r, E, user(T.owner));
      await expectCall(`API route "${r}", enforce, agent on a run working for the owner`, "pass", "route", r, E, run(T.runOwner));
      await expectCall(`API route "${r}", enforce, operator with no grant`, noGrant(`api:${r}`), "route", r, E, user(T.operator));
      await expectCall(`API route "${r}", enforce, agent on a run working for an operator with no grant`, noGrant(`api:${r}`), "route", r, E, run(T.runOperator));
    }
    if (onApiRequest) await expectCall("unknown API route key, enforce, owner", "refuse", "route", "access-check-unknown-route", E, user(T.owner));
    const as = (person: string | null, restricted = false) => ({ as: { onBehalfOfUserId: person, onBehalfOfRestricted: restricted } });
    const marked = as(T.operator, true);
    // Setup is the source of the row and always has one ("nothing saved" is `off` at rev 0), so it has no absent switch.
    const absent = manifest.id === SETUP_PLUGIN ? null : T.absent;
    if (absent) for (const a of actions) await expectCall(`action "${a}", switch absent, operator marked restricted by core`, "refuse", "action", a, absent, { ...user(T.operator), ...marked });
    if (absent) for (const r of askRoutes) await expectCall(`API route "${r}", switch absent, operator marked restricted by core`, "refuse", "route", r, absent, { ...user(T.operator), ...marked });
    for (const t of tools) {
      if (absent) await expectCall(`tool "${t}", switch absent, run for an operator marked restricted by core`, "refuse", "tool", t, absent, { ...run(T.runOperator), ...marked });
      await expectCall(`tool "${t}", enforce, agent key with no run working for the owner (host's person)`, "pass", "tool", t, E, { ...run(""), ...as(T.owner) });
      await expectCall(`tool "${t}", enforce, the owner's run sent for an operator with no grant (host's person)`, noGrant(`tool:${t}`), "tool", t, E, { ...run(T.runOwner), ...as(T.operator) });
      await expectCall(`tool "${t}", enforce, the owner's run sent with no person (host's person)`, "refuse", "tool", t, E, { ...run(T.runOwner), ...as(null) });
    }
    for (const r of askRoutes) await expectCall(`API route "${r}", enforce, agent key with no run working for the owner (host's person)`, "pass", "route", r, E, { ...run(""), ...as(T.owner) });
    if (manifest.id !== SETUP_PLUGIN && rec.events.includes(ACCESS_UPDATED_EVENT)) problems.push(...(await receiveProblems(harness, manifest.id)));
  } finally {
    guardProbes().delete(manifest.id);
    ctx.state.get = get;
    ctx.db.query = query;
  }
  return problems;
}

/** Item 1.5 with the harness: one send from Setup is stored and confirmed (PAR-15008). */
async function receiveProblems(harness: TestHarness, pluginKey: string): Promise<string[]> {
  const ctx = harness.ctx;
  const companyId = T.received;
  const rev = 2;
  const confirmed: unknown[] = [];
  const emit = ctx.events.emit;
  ctx.events.emit = async (name, co, payload) => {
    // The plugin's own call goes first, so the harness keeps its capability check.
    await emit.call(ctx.events, name, co, payload);
    if (name === ACCESS_EVENTS.synced) confirmed.push(payload);
  };
  const problems: string[] = [];
  const label = `Setup's "${ACCESS_UPDATED_EVENT}" (rev ${rev})`;
  try {
    await harness.emit(ACCESS_UPDATED_EVENT, { companyId, rev, mode: "off", userIds: [], part: 1, parts: 1, grants: {} }, { companyId });
    const row = parseAccessRow(await ctx.state.get(accessCompanyScope(companyId)));
    if (row === null || row === "invalid" || row.rev !== rev) problems.push(`${label}: expected the company row at rev ${rev} in the plugin's state, got ${short(row)}`);
    const want = { companyId, rev, pluginKey };
    if (!confirmed.some((p) => JSON.stringify(p) === JSON.stringify(want))) problems.push(`${label}: expected "access.synced" ${short(want)}, got ${confirmed.length ? short(confirmed) : "no confirmation"}`);
  } catch (error) {
    problems.push(`${label}: the receive threw: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    ctx.events.emit = emit;
  }
  return problems;
}

/** Throws one error listing every problem. */
export async function assertPluginAccess(input: PluginAccessCheckInput): Promise<void> {
  const problems = await checkPluginAccess(input);
  if (problems.length) throw new Error(`Access check failed for ${input.manifest.id}:\n- ${problems.join("\n- ")}`);
}
