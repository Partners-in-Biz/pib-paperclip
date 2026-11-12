/**
 * Access look-up, worker side: `access-check` (may a seat use a tool, is a
 * secret stored and on which seats, which seats hold a permission),
 * `access-request` (one child issue for the seat that decides access) and
 * `access-grant` (that seat carries its decision out).
 *
 * Grants and each seat's environment names are read live from the host. The
 * names of stored secrets, the tool profiles and the tool list are not visible
 * to a plugin, so a script on the server pushes a names-only inventory to the
 * `access-inventory` route (board key). A secret value never passes through
 * here: the Cockpit only ever sees names and ids.
 *
 * A tool grant is applied here (the Cockpit may write grants). Attaching a
 * stored secret to a seat is a board-only call, so a yes for a secret puts one
 * fixed-format line on the board's queue issue and the request closes by
 * itself once the secret shows on the seat.
 */
import type { PluginApiRequestInput, PluginApiResponse, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { createWorkIssue, toolFail, toolOk } from "@partnersinbiz/pib-plugin-kit";
import {
  ACCESS_TOOL_NAMES,
  INVENTORY_STALE_HOURS,
  bindLine,
  envNameFor,
  findSecrets,
  inventoryAgeHours,
  isUuid,
  mergeToolNames,
  neverGrant,
  neverGrantText,
  parseAccessSettings,
  parseInventory,
  parseRequestOriginId,
  profilesWithTool,
  requestOriginId,
  resolveTool,
  scopeVerdict,
  seatEnv,
  toolAnswer,
  validEnvName,
  type AccessInventory,
  type AccessSettings,
  type GrantRow,
  type InvSecret,
  type ParsedRequest,
  type ToolAnswer,
} from "./access-model.js";
import { ORIGIN, PLUGIN_KEY } from "./constants.js";
import { parseDecisionRights } from "./decision-rights-model.js";
import { message, type Env } from "./env.js";
import { recordRepair } from "./repairs.js";
import { redactSecrets } from "./watch-model.js";

export const ACCESS_TOOL_SET = new Set<string>(Object.values(ACCESS_TOOL_NAMES));

const GONE = new Set(["terminated", "archived", "deleted"]);
const CLOSED = new Set(["done", "cancelled"]);
const DECISION_LABEL = "access that already exists";

type Origin = `plugin:${string}`;

function inventoryKey(companyId: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: "access-lookup", stateKey: "inventory" };
}

function queuedKey(companyId: string, agentId: string, secretId: string, envName: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: "access-lookup", stateKey: `queued:${agentId}:${secretId}:${envName}` };
}

function fullName(tool: string): string {
  return `${PLUGIN_KEY}:${tool}`;
}

function params(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, max = 400): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function readInventory(env: Env, companyId: string): Promise<AccessInventory | null> {
  try {
    const raw = await env.ctx.state.get(inventoryKey(companyId));
    if (!raw || typeof raw !== "object") return null;
    const stored = raw as Partial<AccessInventory>;
    return parseInventory(stored, typeof stored.receivedAt === "string" ? stored.receivedAt : env.now().toISOString());
  } catch (error) {
    env.ctx.logger.info("Access: the inventory could not be read", { companyId, error: message(error) });
    return null;
  }
}

export async function readAccessSettings(env: Env, companyId: string): Promise<AccessSettings> {
  try {
    const config = await env.ctx.config.get(companyId);
    const rights = parseDecisionRights(config);
    return parseAccessSettings(config, rights.enabled ? rights.seats.access ?? rights.seats.other ?? null : null);
  } catch (error) {
    env.ctx.logger.info("Access: settings could not be read", { companyId, error: message(error) });
    return parseAccessSettings(null, null);
  }
}

interface Seat {
  id: string;
  name: string;
  title: string | null;
  status: string;
  adapterConfig?: unknown;
}

async function loadSeats(env: Env, companyId: string): Promise<Seat[]> {
  const rows = (await env.ctx.agents.list({ companyId, limit: 500 })) as unknown as Array<Record<string, unknown>>;
  return rows
    .filter((a) => !GONE.has(String(a.status ?? "")))
    .map((a) => ({ id: String(a.id), name: String(a.name ?? "Agent"), title: typeof a.title === "string" ? a.title : null, status: String(a.status ?? ""), adapterConfig: a.adapterConfig }));
}

type SeatLookup = { ok: true; seat: Seat } | { ok: false; reason: string };

/** The seat a tool call is about: the caller by default, else an agent id or a name. */
function findSeat(seats: readonly Seat[], typed: string, callerId: string): SeatLookup {
  const want = typed.trim();
  if (!want || want.toLowerCase() === "me") {
    const me = seats.find((s) => s.id === callerId);
    return me ? { ok: true, seat: me } : { ok: false, reason: "Your own seat was not found in this company." };
  }
  if (isUuid(want)) {
    const byId = seats.find((s) => s.id.toLowerCase() === want.toLowerCase());
    return byId ? { ok: true, seat: byId } : { ok: false, reason: `No active seat has the id ${want}.` };
  }
  const lower = want.toLowerCase();
  const exact = seats.filter((s) => s.name.toLowerCase() === lower || (s.title ?? "").toLowerCase() === lower);
  if (exact.length === 1) return { ok: true, seat: exact[0]! };
  const near = exact.length > 1 ? exact : seats.filter((s) => s.name.toLowerCase().includes(lower) || (s.title ?? "").toLowerCase().includes(lower));
  if (near.length === 1) return { ok: true, seat: near[0]! };
  if (near.length > 1) return { ok: false, reason: `More than one seat matches "${want}": ${near.slice(0, 6).map((s) => s.name).join(", ")}. Pass the exact name or the agent id.` };
  return { ok: false, reason: `No active seat is called "${want}". Pass the seat's name as it shows on the Agents page, or its agent id.` };
}

async function companyGrants(env: Env, companyId: string): Promise<GrantRow[]> {
  const rows = (await env.ctx.authorization.grants.list({ companyId, principalType: "agent" })) as unknown as Array<Record<string, unknown>>;
  return rows
    .filter((g) => typeof g.principalId === "string" && (g.principalType === undefined || g.principalType === "agent"))
    .map((g) => ({ principalId: String(g.principalId), permissionKey: String(g.permissionKey), scope: (g.scope as Record<string, unknown> | null) ?? null }));
}

async function seatGrants(env: Env, companyId: string, agentId: string): Promise<Array<{ permissionKey: string; scope: Record<string, unknown> | null }>> {
  const rows = (await env.ctx.authorization.grants.list({ companyId, principalType: "agent", principalId: agentId })) as unknown as Array<Record<string, unknown>>;
  return rows.map((g) => ({ permissionKey: String(g.permissionKey), scope: (g.scope as Record<string, unknown> | null) ?? null }));
}

function names(seats: readonly Seat[], max = 8): string {
  const shown = seats.slice(0, max).map((s) => s.name).join(", ");
  return seats.length > max ? `${shown} and ${seats.length - max} more` : shown;
}

function who(seat: Seat, callerId: string): string {
  return seat.id === callerId ? `You (${seat.name})` : seat.name;
}

/** "have" for the caller ("You (Dev) have"), "has" for a named seat. */
function has(seat: Seat, callerId: string): string {
  return seat.id === callerId ? "have" : "has";
}

function clock(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

interface World {
  companyId: string;
  callerId: string;
  seats: Seat[];
  grants: GrantRow[];
  inventory: AccessInventory | null;
  settings: AccessSettings;
  decider: Seat | null;
  now: Date;
}

async function loadWorld(env: Env, run: Pick<ToolRunContext, "agentId" | "companyId">): Promise<World> {
  const companyId = run.companyId;
  const [seats, grants, inventory, settings] = await Promise.all([loadSeats(env, companyId), companyGrants(env, companyId), readInventory(env, companyId), readAccessSettings(env, companyId)]);
  const decider = settings.seatAgentId ? seats.find((s) => s.id === settings.seatAgentId) ?? null : null;
  return { companyId, callerId: run.agentId, seats, grants, inventory, settings, decider, now: env.now() };
}

function inventoryNote(world: World, what: string): string {
  if (!world.inventory) return ` The server has not sent the list of ${what} yet, so this answer is from the grants alone.`;
  const age = inventoryAgeHours(world.inventory, world.now);
  return age !== null && age >= INVENTORY_STALE_HOURS ? ` The list of ${what} was read ${age} hours ago (${clock(world.inventory.generatedAt)}), so a change since then does not show.` : "";
}

/** What to do when access is missing: ask the deciding seat, or the owner when no seat can decide it. */
function howToAsk(world: World, seat: Seat, kind: "tool" | "secret", name: string): string {
  if (!world.decider) return `No seat is set to decide access in this company, so ask the owner: ask-owner, kind grant, with the exact name.`;
  if (seat.id === world.decider.id) return `${world.decider.name} decides access for other seats, never for its own: ask the owner with ask-owner (kind grant).`;
  return `${world.decider.name} decides this (${DECISION_LABEL}); it does not go to the owner. Call ${ACCESS_TOOL_NAMES.request} with kind "${kind}", name "${name}", the issue that needs it and the error you got.`;
}

// ---------------------------------------------------------------------------
// access-check
// ---------------------------------------------------------------------------

interface ToolCheck {
  content: string;
  data: Record<string, unknown>;
  verdict: ToolAnswer["verdict"] | "not-found" | "never";
  toolName: string | null;
}

function checkTool(world: World, seat: Seat, typed: string): ToolCheck {
  const found = resolveTool(typed, world.inventory?.tools ?? []);
  if (!found.ok) {
    const hint = found.suggestions.length ? ` Close names: ${found.suggestions.join(", ")}.` : "";
    return { content: `${found.reason}${hint}`, data: { tool: typed, found: false, suggestions: found.suggestions }, verdict: "not-found", toolName: null };
  }
  const tool = found.name;
  const answer = toolAnswer({ toolName: tool, agentId: seat.id, companyId: world.companyId, grants: world.grants, profiles: world.inventory?.profiles ?? [] });
  const data: Record<string, unknown> = { tool, seat: { id: seat.id, name: seat.name }, allowed: answer.verdict === "allow", verdict: answer.verdict, via: answer.via, profile: answer.profile };
  const subject = who(seat, world.callerId);
  if (answer.verdict === "allow") {
    const how =
      answer.via === "profile"
        ? `the tool profile "${answer.profile}" allows it`
        : answer.via === "grant-named"
          ? "its tools grant names this tool"
          : answer.via === "grant-plugin-tools"
            ? "its tools grant covers every plugin tool"
            : "its tools grant has no limit";
    return {
      content: `Yes. ${subject} may use ${tool}: ${how}. Call it by this full name. If a call still fails, the cause is not access: quote the exact error on the issue.${answer.via === "profile" ? inventoryNote(world, "tool profiles") : ""}`,
      data,
      verdict: "allow",
      toolName: tool,
    };
  }
  const never = neverGrant([tool], world.settings.neverGrant);
  const holders = world.seats.filter((s) => s.id !== seat.id && toolAnswer({ toolName: tool, agentId: s.id, companyId: world.companyId, grants: world.grants, profiles: world.inventory?.profiles ?? [] }).verdict === "allow");
  const profiles = profilesWithTool(world.inventory?.profiles ?? [], tool);
  data.seatsWithIt = holders.map((s) => ({ id: s.id, name: s.name }));
  data.profilesWithIt = profiles.map((p) => p.name);
  const have = holders.length ? ` Seats that can use it now: ${names(holders)}.` : " No other seat can use it either.";
  const inProfiles = profiles.length ? ` Tool profiles that include it: ${profiles.map((p) => `"${p.name}"`).join(", ")}.` : "";
  if (never) {
    data.ownerOnly = true;
    return { content: `No. ${subject} cannot use ${tool}, and only the owner can give it, because ${neverGrantText(never)}. Ask with ask-owner (kind grant).${have}`, data, verdict: "never", toolName: tool };
  }
  const unclear = answer.verdict === "unclear" || !world.inventory;
  if (unclear) {
    data.verdict = "unclear";
    const why = answer.unclearProfiles.length ? ` A tool profile may apply that cannot be judged from here (${answer.unclearProfiles.map((p) => `"${p}"`).join(", ")}).` : "";
    return {
      content: `Unclear. ${subject} ${has(seat, world.callerId)} no tools grant that covers ${tool}.${why}${inventoryNote(world, "tool profiles")} Try the tool once by its full name. If the call is refused, ${howToAsk(world, seat, "tool", tool).replace(/^[A-Z]/, (c) => c.toLowerCase())}${have}`,
      data,
      verdict: "unclear",
      toolName: tool,
    };
  }
  return {
    content: `No. ${subject} ${has(seat, world.callerId)} no grant and no tool profile for ${tool}.${have}${inProfiles} ${howToAsk(world, seat, "tool", tool)}${inventoryNote(world, "tool profiles")}`,
    data,
    verdict: "deny",
    toolName: tool,
  };
}

function attachedTo(world: World, secret: InvSecret): Array<{ seat: Seat; env: string }> {
  const out: Array<{ seat: Seat; env: string }> = [];
  for (const seat of world.seats) {
    for (const ref of seatEnv(seat).refs) if (ref.secretId === secret.id) out.push({ seat, env: ref.env });
  }
  return out;
}

function checkSecret(world: World, seat: Seat, typed: string): { content: string; data: Record<string, unknown> } {
  const subject = who(seat, world.callerId);
  const lower = typed.toLowerCase();
  const envHits = world.seats
    .map((s) => ({ seat: s, envs: [...seatEnv(s).refs.map((r) => r.env), ...seatEnv(s).plain].filter((name) => name.toLowerCase().includes(lower.replace(/[^a-z0-9]+/g, "_")) || name.toLowerCase().includes(lower)) }))
    .filter((hit) => hit.envs.length > 0);
  const envText = envHits.length ? ` Seats with an environment name like it: ${envHits.slice(0, 8).map((h) => `${h.seat.name} (${h.envs.slice(0, 3).join(", ")})`).join("; ")}.` : "";
  if (!world.inventory) {
    return {
      content: `The names of the company's stored secrets are not available right now (the server has not sent the list), so it cannot be said whether "${typed}" is stored.${envText || " No seat has an environment name like it."} Say so on your issue for ${world.decider?.name ?? "the Operator"} instead of asking the owner.`,
      data: { secret: typed, known: false, seatsWithEnvName: envHits.map((h) => ({ seat: h.seat.name, env: h.envs })) },
    };
  }
  const matches = findSecrets(typed, world.inventory.secrets, 6);
  const checked = `${world.inventory.secrets.length} names checked, list read ${clock(world.inventory.generatedAt)}`;
  if (matches.length === 0) {
    return {
      content: `No. The company holds no stored secret matching "${typed}" (${checked}).${envText} If the work truly needs a credential the company does not hold, that is a hard stop: ask the owner with ask-owner (kind grant, hardStop logins) and say exactly which login or key.`,
      data: { secret: typed, stored: false, matches: [], seatsWithEnvName: envHits.map((h) => ({ seat: h.seat.name, env: h.envs })) },
    };
  }
  const rows = matches.map((secret) => {
    const attached = attachedTo(world, secret);
    const never = neverGrant([secret.name, secret.key, secret.description], world.settings.neverGrant);
    return { secret, attached, never, mine: attached.find((a) => a.seat.id === seat.id) ?? null };
  });
  const lines = rows.map((row) => {
    const where = row.attached.length ? `attached to ${row.attached.slice(0, 8).map((a) => `${a.seat.name} as ${a.env}`).join(", ")}${row.attached.length > 8 ? ` and ${row.attached.length - 8} more` : ""}` : "attached to no seat";
    return `- "${row.secret.name}"${row.secret.key && row.secret.key !== row.secret.name ? ` (key ${row.secret.key})` : ""}: ${where}${row.never ? "; owner only" : ""}`;
  });
  const top = rows[0]!;
  let next: string;
  if (top.mine) next = `${subject} already ${has(seat, world.callerId)} "${top.secret.name}": it is in the environment variable ${top.mine.env} of the seat's runs. Read it from there; never print it.`;
  else if (top.never) next = `${subject} ${seat.id === world.callerId ? "do" : "does"} not have "${top.secret.name}", and only the owner can attach it, because ${neverGrantText(top.never)}. Ask with ask-owner (kind grant, hardStop logins).`;
  else next = `${subject} ${seat.id === world.callerId ? "do" : "does"} not have "${top.secret.name}". ${howToAsk(world, seat, "secret", top.secret.name)}`;
  const age = inventoryAgeHours(world.inventory, world.now);
  const stale = age !== null && age >= INVENTORY_STALE_HOURS ? ` The list is ${age} hours old.` : "";
  return {
    content: `Yes. The company holds ${matches.length === 1 ? "a stored secret" : `${matches.length} stored secrets`} matching "${typed}" (${checked}). Names only, never a value:\n${lines.join("\n")}\n${next}${stale}`,
    data: {
      secret: typed,
      stored: true,
      matches: rows.map((row) => ({ id: row.secret.id, name: row.secret.name, key: row.secret.key, attachedTo: row.attached.map((a) => ({ seat: a.seat.name, agentId: a.seat.id, env: a.env })), ownerOnly: Boolean(row.never) })),
      seatHasIt: Boolean(top.mine),
    },
  };
}

function checkPermission(world: World, seat: Seat, typed: string): { content: string; data: Record<string, unknown> } {
  const key = typed.trim().toLowerCase();
  const byId = new Map(world.seats.map((s) => [s.id, s]));
  const rows = world.grants.filter((g) => g.permissionKey.toLowerCase() === key && byId.has(g.principalId));
  const inUse = [...new Set(world.grants.map((g) => g.permissionKey))].sort();
  if (rows.length === 0) {
    const near = inUse.filter((k) => k.toLowerCase().includes(key.split(":")[0] ?? key) || key.includes(k.toLowerCase().split(":")[0] ?? k)).slice(0, 8);
    return {
      content: `No seat holds "${typed}".${near.length ? ` Close permissions in use: ${near.join(", ")}.` : ` Permissions in use: ${inUse.slice(0, 20).join(", ")}.`}`,
      data: { permission: typed, holders: [], permissionsInUse: inUse },
    };
  }
  const holders = rows.map((g) => ({ seat: byId.get(g.principalId)!, limited: g.scope && Object.keys(g.scope).length > 0 ? g.scope : null }));
  const mine = holders.some((h) => h.seat.id === seat.id);
  const list = holders
    .sort((a, b) => a.seat.name.localeCompare(b.seat.name))
    .slice(0, 30)
    .map((h) => (h.limited ? `${h.seat.name} (limited)` : h.seat.name))
    .join(", ");
  const subject = who(seat, world.callerId);
  const queue = world.settings.boardQueueIssue ? ` A permission is a board setting: put one line on ${world.settings.boardQueueIssue} saying which seat needs it and for which task.` : " A permission is a board setting, so say on your issue which seat needs it and why.";
  return {
    content: `${holders.length} seat${holders.length === 1 ? " holds" : "s hold"} ${rows[0]!.permissionKey}: ${list}${holders.length > 30 ? ` and ${holders.length - 30} more` : ""}. ${subject} ${mine ? (seat.id === world.callerId ? "hold it" : "holds it") : seat.id === world.callerId ? "do not hold it" : "does not hold it"}.${mine ? "" : ` If the work belongs to a seat that holds it, hand the work over.${queue}`}`,
    data: { permission: rows[0]!.permissionKey, holders: holders.map((h) => ({ agentId: h.seat.id, name: h.seat.name, scope: h.limited })), seatHoldsIt: mine },
  };
}

/** With no question: what the seat has now (its tools grant, its profiles, its secrets by name, its permissions). */
function seatSummary(world: World, seat: Seat): { content: string; data: Record<string, unknown> } {
  const subject = who(seat, world.callerId);
  const mine = world.grants.filter((g) => g.principalId === seat.id);
  const toolGrants = mine.filter((g) => g.permissionKey === "tools:use");
  const named = toolGrants.flatMap((g) => (Array.isArray(g.scope?.toolNames) ? (g.scope!.toolNames as unknown[]).filter((n): n is string => typeof n === "string") : []));
  const wide = toolGrants.some((g) => scopeVerdict(g.scope, "any.plugin:any-tool", seat.id) === "allow");
  const profiles = (world.inventory?.profiles ?? []).filter((p) => p.active && p.bindings.some((b) => b.targetType === "agent" && b.targetId === seat.id));
  const profileTools = profiles.flatMap((p) => p.entries.filter((e) => e.selectorType === "tool_name" && e.effect === "include" && e.toolName).map((e) => e.toolName!));
  const env = seatEnv(seat);
  const secretName = (id: string) => world.inventory?.secrets.find((sec) => sec.id === id)?.name ?? null;
  const permissions = [...new Set(mine.filter((g) => g.permissionKey !== "tools:use").map((g) => g.permissionKey))].sort();
  const toolsLine = wide
    ? "every plugin tool (its tools grant is not limited to named tools)"
    : named.length || profileTools.length
      ? `${[...new Set([...named, ...profileTools])].sort().slice(0, 40).join(", ")}${named.length + profileTools.length > 40 ? " and more" : ""}`
      : "no plugin tool";
  const lines = [
    `${subject}, as it stands now:`,
    `- Plugin tools: ${toolsLine}.${profiles.length ? ` Tool profiles: ${profiles.map((p) => `"${p.name}"`).join(", ")}.` : ""}`,
    `- Stored secrets attached (the value is in the environment variable of the seat's runs): ${env.refs.length ? env.refs.map((r) => `${r.env}${secretName(r.secretId) && secretName(r.secretId) !== r.env ? ` ("${secretName(r.secretId)}")` : ""}`).join(", ") : "none"}.`,
    `- Permissions: ${permissions.length ? permissions.join(", ") : "none beyond the defaults"}.`,
    `Ask about one thing with tool, secret or permission (and seat for another seat).${inventoryNote(world, "tool profiles and secret names")}`,
  ];
  return {
    content: lines.join("\n"),
    data: { seat: { id: seat.id, name: seat.name }, allPluginTools: wide, tools: [...new Set([...named, ...profileTools])].sort(), profiles: profiles.map((p) => p.name), secrets: env.refs.map((r) => ({ env: r.env, name: secretName(r.secretId) })), permissions, inventoryReadAt: world.inventory?.generatedAt ?? null },
  };
}

export async function accessCheck(env: Env, run: Pick<ToolRunContext, "agentId" | "companyId">, raw: unknown): Promise<ToolResult> {
  const p = params(raw);
  const tool = str(p.tool, 200);
  const secret = str(p.secret, 160);
  const permission = str(p.permission, 120);
  const world = await loadWorld(env, run);
  const found = findSeat(world.seats, str(p.seat, 120), run.agentId);
  if (!found.ok) return toolFail(found.reason) as ToolResult;
  if (!tool && !secret && !permission) {
    const summary = seatSummary(world, found.seat);
    return toolOk(summary.content, summary.data) as ToolResult;
  }
  const parts: string[] = [];
  const data: Record<string, unknown> = { seat: { id: found.seat.id, name: found.seat.name }, inventoryReadAt: world.inventory?.generatedAt ?? null };
  if (tool) {
    const answer = checkTool(world, found.seat, tool);
    parts.push(answer.content);
    data.toolAnswer = answer.data;
  }
  if (secret) {
    const answer = checkSecret(world, found.seat, secret);
    parts.push(answer.content);
    data.secretAnswer = answer.data;
  }
  if (permission) {
    const answer = checkPermission(world, found.seat, permission);
    parts.push(answer.content);
    data.permissionAnswer = answer.data;
  }
  return toolOk(parts.join("\n\n"), data) as ToolResult;
}

// ---------------------------------------------------------------------------
// access-request
// ---------------------------------------------------------------------------

interface IssueLike {
  id: string;
  identifier?: string | null;
  title?: string | null;
  status: string;
  priority?: string | null;
  projectId?: string | null;
  parentId?: string | null;
  assigneeAgentId?: string | null;
  originKind?: string | null;
  originId?: string | null;
}

async function issueHrefBase(env: Env, companyId: string): Promise<string> {
  const company = await env.ctx.companies.get(companyId).catch(() => null);
  return company?.issuePrefix ? `/${company.issuePrefix}/issues/` : "/issues/";
}

function quoted(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

type Wanted =
  | { ok: false; reason: string }
  | { ok: true; kind: "tool"; toolName: string; found: string; label: string }
  | { ok: true; kind: "secret"; secret: InvSecret; envName: string; found: string; label: string };

/** What exactly is asked for, or why it is refused. Shared by the request and the grant. */
function wanted(world: World, seat: Seat, kind: string, name: string, envTyped: string): Wanted {
  if (kind === "tool") {
    const check = checkTool(world, seat, name);
    if (check.verdict === "not-found") return { ok: false, reason: check.content };
    if (check.verdict === "allow") return { ok: false, reason: `Not needed: the access already exists. ${check.content}` };
    if (check.verdict === "never") return { ok: false, reason: check.content };
    return { ok: true, kind: "tool", toolName: check.toolName!, found: check.content, label: `tool ${check.toolName}` };
  }
  if (kind !== "secret") return { ok: false, reason: 'kind must be "tool" or "secret".' };
  if (!world.inventory) return { ok: false, reason: `The names of the company's stored secrets are not available right now (the server has not sent the list), so the request cannot name the secret. Say on your issue which credential you need; ${world.decider?.name ?? "the Operator"} picks it up.` };
  const lower = name.toLowerCase();
  const matches = findSecrets(name, world.inventory.secrets, 6);
  const exact = matches.filter((s) => s.id === lower || s.name.toLowerCase() === lower || s.key.toLowerCase() === lower);
  if (matches.length === 0) return { ok: false, reason: `The company holds no stored secret matching "${name}", so there is nothing to attach. A credential the company does not hold is a hard stop: ask the owner with ask-owner (kind grant, hardStop logins).` };
  if (exact.length !== 1 && matches.length > 1) return { ok: false, reason: `${matches.length} stored secrets match "${name}". Pass the exact name of one: ${matches.map((s) => `"${s.name}"`).join(", ")}.` };
  const secret = exact[0] ?? matches[0]!;
  const never = neverGrant([secret.name, secret.key, secret.description], world.settings.neverGrant);
  if (never) return { ok: false, reason: `"${secret.name}" is not for an agent to give: ${neverGrantText(never)}. Only the owner can attach it: ask with ask-owner (kind grant, hardStop logins).` };
  const env = seatEnv(seat);
  const has = env.refs.find((r) => r.secretId === secret.id);
  if (has) return { ok: false, reason: `Not needed: ${seat.name} already has "${secret.name}" attached, as the environment variable ${has.env}. Read it from there in the seat's run; never print it.` };
  const envName = envTyped || envNameFor(secret);
  if (!validEnvName(envName)) return { ok: false, reason: `envName must be an environment variable name in capitals, like ${envNameFor(secret)}.` };
  if (env.refs.some((r) => r.env === envName) || env.plain.includes(envName)) return { ok: false, reason: `${seat.name} already has an environment variable called ${envName} with something else in it. Pass another envName.` };
  const attached = attachedTo(world, secret);
  const found = `The company holds "${secret.name}"; it is ${attached.length ? `attached to ${names(attached.map((a) => a.seat))}` : "attached to no seat"}, not to ${seat.name}.`;
  return { ok: true, kind: "secret", secret, envName, found, label: `secret "${secret.name}"` };
}

export async function accessRequest(env: Env, run: Pick<ToolRunContext, "agentId" | "companyId">, raw: unknown): Promise<ToolResult> {
  const p = params(raw);
  const { ctx } = env;
  const companyId = run.companyId;
  const kind = str(p.kind, 10);
  const name = str(p.name, 200);
  const errorText = redactSecrets(str(p.error, 800));
  const why = redactSecrets(str(p.why, 400));
  if (!str(p.issueId, 80) || !name || !errorText) return toolFail("Pass issueId (the task that needs the access), kind, name (the exact tool or secret name) and error (the text of the error you got).") as ToolResult;
  const issue = (await ctx.issues.get(str(p.issueId, 80), companyId).catch(() => null)) as IssueLike | null;
  if (!issue) return toolFail(`Issue ${str(p.issueId, 80)} was not found in this company. Pass the task that needs the access (id or identifier).`) as ToolResult;
  if (CLOSED.has(String(issue.status))) return toolFail(`Issue ${issue.identifier ?? issue.id} is closed. Ask on the open task that needs the access.`) as ToolResult;
  const world = await loadWorld(env, run);
  const found = findSeat(world.seats, str(p.seat, 120), run.agentId);
  if (!found.ok) return toolFail(found.reason) as ToolResult;
  const seat = found.seat;
  const want = wanted(world, seat, kind, name, str(p.envName, 64));
  if (!want.ok) return toolFail(want.reason) as ToolResult;
  if (!world.decider || GONE.has(world.decider.status)) return toolFail(`No seat is set to decide access in this company, so this goes to the owner: ask-owner, kind grant, naming ${want.label} and the seat ${seat.name}.`) as ToolResult;
  const decider = world.decider;
  if (seat.id === decider.id) return toolFail(`${decider.name} decides access for other seats, never for its own. Ask the owner: ask-owner, kind grant, naming ${want.label}.`) as ToolResult;

  const asker = world.seats.find((s) => s.id === run.agentId);
  const askerName = asker?.name ?? "An agent";
  const base = await issueHrefBase(env, companyId);
  const ref = issue.identifier ?? issue.id;
  const originId = want.kind === "tool" ? requestOriginId({ kind: "tool", seatAgentId: seat.id, toolName: want.toolName }) : requestOriginId({ kind: "secret", seatAgentId: seat.id, secretId: want.secret.id, envName: want.envName });
  const thing = want.kind === "tool" ? `Tool: \`${want.toolName}\`` : `Stored secret: "${want.secret.name}" (key \`${want.secret.key}\`, id \`${want.secret.id}\`), to be attached as \`${want.envName}\``;
  const title = `Access request: ${seat.name} needs ${want.kind === "tool" ? `the tool ${want.toolName}` : `the stored secret "${want.secret.name}"`}`.slice(0, 180);
  const need = [`- Task that needs it: [${ref}](${base}${ref})${issue.title ? `: ${issue.title}` : ""}`, ...(why ? [`- Why: ${why}`] : []), "- The error they got:", quoted(errorText)].join("\n");
  const description = [
    `**${askerName} asks for access for ${seat.id === run.agentId ? "its own seat" : seat.name}.** You decide this class (${DECISION_LABEL}); it does not go to the owner.`,
    "",
    `- Seat: ${seat.name} (\`${seat.id}\`)`,
    `- ${thing}`,
    need,
    `- What access-check found: ${want.found}`,
    "",
    "**How to decide**",
    `1. Say yes when the seat's task needs it. Never a payment or banking credential and never a personal login: the tool refuses those and they go to the owner.`,
    `2. Call \`${fullName(ACCESS_TOOL_NAMES.grant)}\` with \`requestIssueId\` (this issue), \`decision\` ("yes" or "no") and \`reason\` (one line). ${want.kind === "tool" ? "A yes takes effect at once and closes this issue, which wakes the asker." : `A yes puts one line on ${world.settings.boardQueueIssue ?? "the board's queue"} for the board to attach it; this issue closes by itself when the secret shows on the seat.`}`,
    "3. A no names the one thing that would change it.",
  ].join("\n");

  let requestId: string | null = null;
  let requestIdentifier: string | null = null;
  let created = false;
  try {
    const open = ((await ctx.issues.list({ companyId, originKind: ORIGIN.access as Origin, originId, limit: 10 })) as unknown as IssueLike[]).find((i) => !CLOSED.has(String(i.status)));
    if (open) {
      requestId = open.id;
      requestIdentifier = open.identifier ?? null;
      if (open.parentId !== issue.id) {
        await ctx.issues.createComment(open.id, `**Another task needs the same access.**\n\n${need}`, companyId, { authorAgentId: run.agentId });
        await ctx.issues.requestWakeup(open.id, companyId, { reason: `${askerName} needs the same access for ${ref}.`, idempotencyKey: `access:${open.id}:${issue.id}` }).catch(() => undefined);
      }
    } else {
      const made = await createWorkIssue(ctx, {
        companyId,
        title,
        description,
        assigneeAgentId: decider.id,
        parentId: issue.id,
        ...(issue.projectId ? { projectId: issue.projectId } : {}),
        priority: (issue.priority ?? "medium") as "critical" | "high" | "medium" | "low",
        originKind: ORIGIN.access as Origin,
        originId,
        wake: true,
        wakeReason: `Access request from ${askerName} on ${ref}.`,
      });
      requestId = made.id;
      created = true;
      requestIdentifier = (await ctx.issues.get(made.id, companyId).catch(() => null))?.identifier ?? null;
    }
  } catch (error) {
    ctx.logger.info("Access: the request issue could not be opened", { companyId, issueId: issue.id, error: message(error) });
    return toolFail(`The request could not be opened (${message(error)}). Say on ${ref} exactly what you need and assign the next step to ${decider.name}.`) as ToolResult;
  }

  let blocked = false;
  try {
    const relations = await ctx.issues.relations.get(issue.id, companyId);
    const blockedBy = new Set((relations.blockedBy ?? []).map((b) => b.id));
    blockedBy.add(requestId);
    await ctx.issues.update(issue.id, { status: "blocked", blockedByIssueIds: [...blockedBy] }, companyId);
    blocked = true;
  } catch (error) {
    ctx.logger.info("Access: the asking issue was not marked blocked", { companyId, issueId: issue.id, error: message(error) });
  }
  const requestRef = requestIdentifier ?? requestId;
  await ctx.issues
    .createComment(issue.id, `**Access request with ${decider.name}** ([${requestRef}](${base}${requestRef})): ${want.label} for ${seat.name}. This is ${DECISION_LABEL}, so it does not go to the owner.`, companyId, { authorAgentId: run.agentId })
    .catch((error) => ctx.logger.info("Access: the request comment was not posted", { issueId: issue.id, error: message(error) }));
  await recordRepair(ctx, companyId, { kind: "access_request", targetKind: "issue", targetId: issue.id, action: `request_${want.kind}`, outcome: created ? "opened" : "joined", detail: `${seat.name}: ${want.label} -> ${decider.name} (${requestRef})`, actor: `agent:${run.agentId}` }).catch(() => undefined);

  return toolOk(
    `${created ? "Asked" : "Already asked:"} ${decider.name} ${created ? "on" : "has it on"} ${requestRef}. ${blocked ? `${ref} is blocked on it and you are woken when it is decided.` : `${ref} could not be marked blocked: set it to blocked on ${requestRef} yourself.`} End your run now. Do not ask the owner and do not open a second request.`,
    { requestIssueId: requestId, requestIssue: requestRef, decidedBy: { agentId: decider.id, name: decider.name }, created, blocked, kind: want.kind, name: want.kind === "tool" ? want.toolName : want.secret.name, ...(want.kind === "secret" ? { envName: want.envName } : {}) },
  ) as ToolResult;
}

// ---------------------------------------------------------------------------
// access-grant
// ---------------------------------------------------------------------------

async function applyToolGrant(env: Env, companyId: string, seat: Seat, toolName: string): Promise<{ ok: true; changed: boolean } | { ok: false; reason: string }> {
  const existing = await seatGrants(env, companyId, seat.id);
  const merged = mergeToolNames(existing, [toolName], seat.id);
  if (merged.conflict) return { ok: false, reason: merged.conflict };
  if (!merged.changed) return { ok: true, changed: false };
  await env.ctx.authorization.grants.set({ companyId, principalType: "agent", principalId: seat.id, grants: merged.grants as Parameters<typeof env.ctx.authorization.grants.set>[0]["grants"] });
  const after = await seatGrants(env, companyId, seat.id);
  const allowed = after.some((g) => g.permissionKey === "tools:use" && scopeVerdict(g.scope, toolName, seat.id) === "allow");
  const kept = existing.filter((g) => g.permissionKey !== "tools:use").every((g) => after.some((a) => a.permissionKey === g.permissionKey));
  if (!allowed || !kept) return { ok: false, reason: "The grant was saved but did not read back as expected. Nothing else was changed; say so on the issue for the board." };
  return { ok: true, changed: true };
}

export async function accessGrant(env: Env, run: Pick<ToolRunContext, "agentId" | "companyId">, raw: unknown): Promise<ToolResult> {
  const p = params(raw);
  const { ctx } = env;
  const companyId = run.companyId;
  const world = await loadWorld(env, run);
  if (!world.decider) return toolFail("No seat is set to decide access in this company (Cockpit settings, Who decides). Until one is, access goes to the owner with ask-owner.") as ToolResult;
  const decider = world.decider;
  if (run.agentId !== decider.id) return toolFail(`Only ${decider.name} decides access. If you need access, call ${ACCESS_TOOL_NAMES.request}; if you were asked to give it, hand the request to ${decider.name}.`) as ToolResult;
  const decision = str(p.decision, 5).toLowerCase() || "yes";
  const reason = redactSecrets(str(p.reason, 300));
  if (decision !== "yes" && decision !== "no") return toolFail('decision must be "yes" or "no".') as ToolResult;
  if (!reason) return toolFail("Pass reason: one line on why (for a no, the one thing that would change it).") as ToolResult;

  let request: IssueLike | null = null;
  let parsed: ParsedRequest | null = null;
  let task: IssueLike | null = null;
  if (str(p.requestIssueId, 80)) {
    request = (await ctx.issues.get(str(p.requestIssueId, 80), companyId).catch(() => null)) as IssueLike | null;
    if (!request || request.originKind !== ORIGIN.access) return toolFail(`${str(p.requestIssueId, 80)} is not an access request. Pass the request issue (its title starts with "Access request"), or pass seat, kind, name and issueId to give access with no request.`) as ToolResult;
    if (CLOSED.has(String(request.status))) return toolFail(`${request.identifier ?? request.id} is already decided and closed.`) as ToolResult;
    parsed = parseRequestOriginId(request.originId);
    if (!parsed) return toolFail(`${request.identifier ?? request.id} does not say what was asked for. Pass seat, kind, name and issueId instead.`) as ToolResult;
    task = request.parentId ? ((await ctx.issues.get(request.parentId, companyId).catch(() => null)) as IssueLike | null) : null;
  } else {
    if (!str(p.issueId, 80)) return toolFail("Pass requestIssueId (the access request), or seat, kind, name and issueId (the task the access is for).") as ToolResult;
    task = (await ctx.issues.get(str(p.issueId, 80), companyId).catch(() => null)) as IssueLike | null;
    if (!task) return toolFail(`Issue ${str(p.issueId, 80)} was not found. Pass the task the access is for.`) as ToolResult;
  }
  const seatLookup = findSeat(world.seats, parsed ? parsed.seatAgentId : str(p.seat, 120) || "none", run.agentId);
  if (!seatLookup.ok) return toolFail(parsed ? `The seat the request names is no longer active. Close the request with a comment.` : `Pass seat: the seat that gets the access. ${seatLookup.reason}`) as ToolResult;
  const seat = seatLookup.seat;
  if (seat.id === decider.id) return toolFail(`${decider.name} cannot give access to its own seat. Ask the owner with ask-owner (kind grant).`) as ToolResult;
  const kind = parsed ? parsed.kind : str(p.kind, 10);
  const name = parsed ? (parsed.kind === "tool" ? parsed.toolName : parsed.secretId) : str(p.name, 200);
  if (!name) return toolFail("Pass name: the exact tool or secret name.") as ToolResult;

  const taskRef = task ? task.identifier ?? task.id : null;
  const requestRef = request ? request.identifier ?? request.id : null;
  const say = async (issueId: string, body: string) =>
    ctx.issues.createComment(issueId, body, companyId, { authorAgentId: run.agentId }).catch((error) => ctx.logger.info("Access: a comment was not posted", { issueId, error: message(error) }));
  const close = async (note: string) => {
    if (!request) return;
    await say(request.id, note);
    await ctx.issues.update(request.id, { status: "done" }, companyId).catch((error) => ctx.logger.info("Access: the request was not closed", { issueId: request!.id, error: message(error) }));
  };
  const log = async (action: string, outcome: string, detail: string) =>
    recordRepair(ctx, companyId, { kind: "access_grant", targetKind: "agent", targetId: seat.id, action, outcome, detail, actor: `agent:${run.agentId}` }).catch(() => undefined);

  if (decision === "no") {
    const what = kind === "tool" ? `the tool ${name}` : "the stored secret";
    await close(`DECISION (${DECISION_LABEL}): no, ${reason}`);
    if (task) await say(task.id, `**Access not given** by ${decider.name}: ${seat.name} does not get ${what}. ${reason}`);
    if (task && !request) await ctx.issues.requestWakeup(task.id, companyId, { reason: `Access decided: no.`, idempotencyKey: `access-no:${task.id}:${seat.id}:${name}` }).catch(() => undefined);
    await log(`deny_${kind}`, "no", `${seat.name}: ${name}. ${reason}`);
    return toolOk(`Recorded: no. ${requestRef ? `${requestRef} is closed and the asker is woken.` : `${taskRef} has the answer.`}`, { decision: "no", seat: seat.name, kind, name }) as ToolResult;
  }

  const want = wanted(world, seat, kind, name, parsed?.kind === "secret" ? parsed.envName : str(p.envName, 64));
  if (!want.ok) {
    // Already there (granted by hand, or attached since the request): the request is settled, not refused.
    if (/^Not needed:/.test(want.reason)) {
      await close(`DECISION (${DECISION_LABEL}): yes, ${reason}\n\nNothing to change: ${want.reason.replace(/^Not needed: /, "")}`);
      if (task) await say(task.id, `**Access is in place** for ${seat.name}: ${want.reason.replace(/^Not needed: /, "")}`);
      return toolOk(`Nothing to change: ${want.reason.replace(/^Not needed: /, "")}${requestRef ? ` ${requestRef} is closed.` : ""}`, { decision: "yes", changed: false, seat: seat.name, kind, name }) as ToolResult;
    }
    return toolFail(want.reason) as ToolResult;
  }

  if (want.kind === "tool") {
    let applied: Awaited<ReturnType<typeof applyToolGrant>>;
    try {
      applied = await applyToolGrant(env, companyId, seat, want.toolName);
    } catch (error) {
      return toolFail(`The grant could not be saved (${message(error)}). Nothing was changed.`) as ToolResult;
    }
    if (!applied.ok) {
      const queue = world.settings.boardQueueIssue ? ` Put one line on ${world.settings.boardQueueIssue} for the board: "${seat.name} needs ${want.toolName} for ${taskRef ?? "its task"}".` : "";
      return toolFail(`${applied.reason}${queue}`) as ToolResult;
    }
    const line = `ACCESS GRANTED: ${seat.name} may use \`${want.toolName}\` (named in its tools grant)${taskRef ? ` for ${taskRef}` : ""}. Decided by ${decider.name}: ${reason}`;
    await close(`DECISION (${DECISION_LABEL}): yes, ${reason}\n\n${line}`);
    if (task) await say(task.id, `${line}\n\nCall it by its full name. It works from the seat's next run.`);
    if (task && !request) await ctx.issues.requestWakeup(task.id, companyId, { reason: `Access granted: ${want.toolName}.`, idempotencyKey: `access-yes:${task.id}:${seat.id}:${want.toolName}` }).catch(() => undefined);
    await log("grant_tool", "granted", `${seat.name}: ${want.toolName}${taskRef ? ` for ${taskRef}` : ""}. ${reason}`);
    return toolOk(`Granted. ${seat.name} may now use ${want.toolName}.${requestRef ? ` ${requestRef} is closed, which wakes the asker.` : ""} The line is on ${taskRef ?? requestRef}.`, { decision: "yes", changed: true, seat: seat.name, kind: "tool", name: want.toolName }) as ToolResult;
  }

  // A stored secret: attaching it is a board-only call, so the board's queue gets one line.
  const queueRef = world.settings.boardQueueIssue;
  const queue = queueRef ? ((await ctx.issues.get(queueRef, companyId).catch(() => null)) as IssueLike | null) : null;
  if (!queue || CLOSED.has(String(queue.status))) {
    return toolFail(`Attaching a stored secret is a board-only call and no open board queue issue is set (Cockpit settings, Access, Board queue issue${queueRef ? `: ${queueRef} was not found or is closed` : ""}). Nothing was changed. Say on ${requestRef ?? taskRef} that the decision is yes and that the board must attach "${want.secret.name}" to ${seat.name} as ${want.envName}.`) as ToolResult;
  }
  const marker = queuedKey(companyId, seat.id, want.secret.id, want.envName);
  const already = await ctx.state.get(marker).catch(() => null);
  const line = bindLine({ agentId: seat.id, envName: want.envName, secretId: want.secret.id, seatName: seat.name, secretName: want.secret.name, taskRef: taskRef ?? requestRef ?? "its task", requestRef, deciderName: decider.name, reason });
  const queuedAt = typeof already === "string" && Number.isFinite(Date.parse(already)) && world.now.getTime() - Date.parse(already) < 24 * 3_600_000 ? already : null;
  if (!queuedAt) {
    try {
      await ctx.issues.createComment(queue.id, line, companyId, { authorAgentId: run.agentId });
      await ctx.state.set(marker, world.now.toISOString()).catch(() => undefined);
    } catch (error) {
      return toolFail(`The line could not be posted on ${queueRef} (${message(error)}). Nothing was changed.`) as ToolResult;
    }
  }
  const waits = `The board attaches it from ${queueRef}; that is not a question for the owner. This closes by itself once "${want.secret.name}" shows on ${seat.name} as ${want.envName}.`;
  if (request) {
    await say(request.id, `DECISION (${DECISION_LABEL}): yes, ${reason}\n\nACCESS APPROVED: ${seat.name} gets the stored secret "${want.secret.name}" as \`${want.envName}\`${taskRef ? ` for ${taskRef}` : ""}. ${waits}`);
    await ctx.issues.update(request.id, { status: "blocked", blockedByIssueIds: [queue.id] }, companyId).catch((error) => ctx.logger.info("Access: the request was not parked on the board queue", { issueId: request!.id, error: message(error) }));
  }
  if (task) await say(task.id, `ACCESS APPROVED: ${seat.name} gets the stored secret "${want.secret.name}" as \`${want.envName}\`. Decided by ${decider.name}: ${reason}. ${waits}`);
  await log("approve_secret", queuedAt ? "already_queued" : "queued", `${seat.name}: "${want.secret.name}" as ${want.envName}${taskRef ? ` for ${taskRef}` : ""}. ${reason}`);
  return toolOk(
    `Approved. ${queuedAt ? `The line was already on ${queueRef} (since ${clock(queuedAt)}).` : `One line is on ${queueRef} for the board to attach "${want.secret.name}" to ${seat.name} as ${want.envName}.`} ${requestRef ? `${requestRef} waits on ${queueRef} and closes by itself when it is attached.` : ""} Nothing more for you to do.`,
    { decision: "yes", queued: !queuedAt, boardQueue: queueRef, seat: seat.name, kind: "secret", name: want.secret.name, envName: want.envName },
  ) as ToolResult;
}

export async function runAccessTool(env: Env, name: string, raw: unknown, run: ToolRunContext): Promise<ToolResult> {
  try {
    if (name === ACCESS_TOOL_NAMES.check) return await accessCheck(env, run, raw);
    if (name === ACCESS_TOOL_NAMES.request) return await accessRequest(env, run, raw);
    if (name === ACCESS_TOOL_NAMES.grant) return await accessGrant(env, run, raw);
    return toolFail(`Unknown tool ${name}`) as ToolResult;
  } catch (error) {
    env.ctx.logger.info("Access tool failed", { name, error: message(error) });
    return toolFail(`${name} failed: ${message(error)}`) as ToolResult;
  }
}

// ---------------------------------------------------------------------------
// The inventory route and what runs when a fresh one arrives
// ---------------------------------------------------------------------------

/**
 * Closes requests whose access is now in place: a secret that shows on the
 * seat (the board attached it), or a tool the seat can now call. Closing the
 * request wakes the task that waited on it.
 */
export async function settleAccessRequests(env: Env, companyId: string): Promise<string[]> {
  const { ctx } = env;
  const open = ((await ctx.issues.list({ companyId, originKind: ORIGIN.access as Origin, limit: 200 })) as unknown as IssueLike[]).filter((i) => !CLOSED.has(String(i.status)));
  if (open.length === 0) return [];
  const [seats, grants, inventory] = await Promise.all([loadSeats(env, companyId), companyGrants(env, companyId), readInventory(env, companyId)]);
  const settled: string[] = [];
  for (const issue of open) {
    const parsed = parseRequestOriginId(issue.originId);
    const seat = parsed ? seats.find((s) => s.id === parsed.seatAgentId) : null;
    if (!parsed || !seat) continue;
    let note: string | null = null;
    if (parsed.kind === "secret") {
      const ref = seatEnv(seat).refs.find((r) => r.secretId === parsed.secretId);
      const secretName = inventory?.secrets.find((s) => s.id === parsed.secretId)?.name ?? "the stored secret";
      if (ref) note = `**Attached.** ${seat.name} now has "${secretName}" as the environment variable \`${ref.env}\`. It is there from the seat's next run; read it from the environment and never print it.`;
    } else if (toolAnswer({ toolName: parsed.toolName, agentId: seat.id, companyId, grants, profiles: inventory?.profiles ?? [] }).verdict === "allow") {
      note = `**In place.** ${seat.name} can now use \`${parsed.toolName}\`.`;
    }
    if (!note) continue;
    try {
      await ctx.issues.createComment(issue.id, note, companyId);
      await ctx.issues.update(issue.id, { status: "done" }, companyId);
      settled.push(issue.identifier ?? issue.id);
    } catch (error) {
      ctx.logger.info("Access: a settled request was not closed", { issueId: issue.id, error: message(error) });
    }
  }
  return settled;
}

/**
 * Keeps the look-up tools callable. A seat whose tools grant names its tools
 * (the memory-only seats) cannot see a new tool until its name is added, so
 * `access-check` and `access-request` are added to every such grant, and
 * `access-grant` to the deciding seat. Only grants that already name tools are
 * touched (a seat with no tools grant gets none), and only these names are
 * added.
 */
export async function ensureLookupTools(env: Env, companyId: string, settings: AccessSettings): Promise<string[]> {
  if (!settings.grantLookupTools) return [];
  const { ctx } = env;
  const [seats, grants] = await Promise.all([loadSeats(env, companyId), companyGrants(env, companyId)]);
  const changed: string[] = [];
  for (const seat of seats) {
    const isDecider = seat.id === settings.seatAgentId;
    const mine = grants.filter((g) => g.principalId === seat.id && g.permissionKey === "tools:use");
    if (mine.length === 0 && !isDecider) continue;
    const needed = [fullName(ACCESS_TOOL_NAMES.check), fullName(ACCESS_TOOL_NAMES.request), ...(isDecider ? [fullName(ACCESS_TOOL_NAMES.grant)] : [])];
    if (needed.every((tool) => mine.some((g) => scopeVerdict(g.scope, tool, seat.id) === "allow"))) continue;
    try {
      const existing = await seatGrants(env, companyId, seat.id);
      const merged = mergeToolNames(existing, needed, seat.id);
      if (merged.conflict || !merged.changed) continue;
      await ctx.authorization.grants.set({ companyId, principalType: "agent", principalId: seat.id, grants: merged.grants as Parameters<typeof ctx.authorization.grants.set>[0]["grants"] });
      changed.push(seat.name);
      await recordRepair(ctx, companyId, { kind: "access_grant", targetKind: "agent", targetId: seat.id, action: "grant_lookup_tools", outcome: "granted", detail: `${seat.name}: ${needed.join(", ")}`, actor: "cockpit" }).catch(() => undefined);
    } catch (error) {
      ctx.logger.info("Access: the look-up tools were not added to a seat", { companyId, agentId: seat.id, error: message(error) });
    }
  }
  return changed;
}

/** POST /access-inventory (board key): the names-only lists from the server script. */
export async function handleAccessInventory(env: Env, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  const body = input.body && typeof input.body === "object" && !Array.isArray(input.body) ? (input.body as Record<string, unknown>) : {};
  if (typeof body.companyId !== "string" || body.companyId.trim() !== input.companyId) return { status: 400, body: { error: "companyId is required and must match the company the route resolved" } };
  let inventory: AccessInventory;
  try {
    inventory = parseInventory(body.inventory, env.now().toISOString());
  } catch (error) {
    return { status: 400, body: { error: message(error) } };
  }
  await env.ctx.state.set(inventoryKey(input.companyId), inventory);
  const settings = await readAccessSettings(env, input.companyId);
  const lookupToolsAddedTo = await ensureLookupTools(env, input.companyId, settings).catch((error) => {
    env.ctx.logger.info("Access: look-up tools pass failed", { companyId: input.companyId, error: message(error) });
    return [] as string[];
  });
  const settled = await settleAccessRequests(env, input.companyId).catch((error) => {
    env.ctx.logger.info("Access: settle pass failed", { companyId: input.companyId, error: message(error) });
    return [] as string[];
  });
  return { status: 200, body: { ok: true, secrets: inventory.secrets.length, tools: inventory.tools.length, profiles: inventory.profiles.length, generatedAt: inventory.generatedAt, lookupToolsAddedTo, settled } };
}
