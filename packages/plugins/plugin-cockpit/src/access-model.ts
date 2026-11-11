/**
 * Access look-up: the pure rules behind `access-check`, `access-request` and
 * `access-grant`. No node imports, no host calls.
 *
 * What a plugin can see by itself: every seat's permission grants (live) and
 * every seat's bound environment names (live, names only). What it cannot see:
 * the names of the company's stored secrets, the tool profiles and the list of
 * registered tools. Those come as a names-only inventory that a small script on
 * the server pushes in (see access.ts); a secret value is never part of it.
 *
 * The tool rules mirror the host's `tool-access-policy` (grant scope first,
 * then the seat's profiles). Where a rule cannot be judged from here the answer
 * is "unclear", never a guess.
 */

export const ACCESS_TOOL_NAMES = { check: "access-check", request: "access-request", grant: "access-grant" } as const;

export type Verdict = "allow" | "deny" | "unclear";

export interface InvSecret {
  id: string;
  name: string;
  key: string;
  description: string | null;
}

export interface InvProfileEntry {
  selectorType: string;
  effect: "include" | "exclude";
  toolName: string | null;
  /** The entry carries run-time conditions this code cannot judge. */
  conditional: boolean;
}

export interface InvProfile {
  id: string;
  key: string;
  name: string;
  active: boolean;
  defaultAction: "allow" | "deny";
  bindings: Array<{ targetType: string; targetId: string }>;
  entries: InvProfileEntry[];
}

export interface AccessInventory {
  /** When the server script read the lists (ISO). */
  generatedAt: string;
  /** When the Cockpit stored them (ISO). */
  receivedAt: string;
  secrets: InvSecret[];
  /** Full tool names, `<plugin key>:<tool>`. */
  tools: string[];
  profiles: InvProfile[];
}

export interface GrantRow {
  principalId: string;
  permissionKey: string;
  scope: Record<string, unknown> | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMITS = { secrets: 3000, tools: 6000, profiles: 400, entries: 600, bindings: 400 } as const;

export function isUuid(value: unknown): boolean {
  return typeof value === "string" && UUID.test(value.trim());
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "";
}

/**
 * Reads what the server script sent. Only names and ids are kept: any other
 * field (a value, a provider reference, metadata) is dropped here, so nothing
 * else can reach an agent through the inventory. Throws with a plain message
 * when the shape is wrong.
 */
export function parseInventory(raw: unknown, receivedAt: string): AccessInventory {
  const root = record(raw);
  if (!root) throw new Error("inventory must be an object");
  if (!Array.isArray(root.secrets) || !Array.isArray(root.tools) || !Array.isArray(root.profiles)) throw new Error("inventory needs secrets, tools and profiles lists");
  const generated = typeof root.generatedAt === "string" && Number.isFinite(Date.parse(root.generatedAt)) ? new Date(root.generatedAt).toISOString() : receivedAt;
  const secrets: InvSecret[] = [];
  for (const item of root.secrets.slice(0, LIMITS.secrets)) {
    const row = record(item);
    if (!row || !isUuid(row.id)) continue;
    const name = text(row.name, 160);
    if (!name) continue;
    secrets.push({ id: String(row.id).trim().toLowerCase(), name, key: text(row.key, 160) || name, description: text(row.description, 200) || null });
  }
  const tools = [...new Set(root.tools.slice(0, LIMITS.tools).map((t) => text(t, 200)).filter((t) => /^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/.test(t)))].sort();
  const profiles: InvProfile[] = [];
  for (const item of root.profiles.slice(0, LIMITS.profiles)) {
    const row = record(item);
    if (!row || !isUuid(row.id)) continue;
    const entries: InvProfileEntry[] = [];
    for (const e of Array.isArray(row.entries) ? row.entries.slice(0, LIMITS.entries) : []) {
      const entry = record(e);
      if (!entry) continue;
      const selectorType = text(entry.selectorType, 40);
      if (!selectorType) continue;
      entries.push({
        selectorType,
        effect: entry.effect === "exclude" ? "exclude" : "include",
        toolName: text(entry.toolName, 200) || null,
        conditional: entry.conditional === true || (entry.conditions !== null && entry.conditions !== undefined),
      });
    }
    const bindings: InvProfile["bindings"] = [];
    for (const b of Array.isArray(row.bindings) ? row.bindings.slice(0, LIMITS.bindings) : []) {
      const binding = record(b);
      const targetType = text(binding?.targetType, 40);
      const targetId = text(binding?.targetId, 80);
      if (targetType && targetId) bindings.push({ targetType, targetId });
    }
    profiles.push({
      id: String(row.id).trim().toLowerCase(),
      key: text(row.key ?? row.profileKey, 200),
      name: text(row.name, 160) || "Unnamed profile",
      active: row.active === true || row.status === "active",
      defaultAction: row.defaultAction === "allow" ? "allow" : "deny",
      bindings,
      entries,
    });
  }
  return { generatedAt: generated, receivedAt, secrets, tools, profiles };
}

/** Hours since the inventory was read on the server, rounded down; null when there is none. */
export function inventoryAgeHours(inventory: AccessInventory | null, now: Date): number | null {
  if (!inventory) return null;
  const at = Date.parse(inventory.generatedAt);
  return Number.isFinite(at) ? Math.max(0, Math.floor((now.getTime() - at) / 3_600_000)) : null;
}

/** Older than this and the answer says so: profiles and secret names may have changed. */
export const INVENTORY_STALE_HOURS = 6;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export type ToolLookup = { ok: true; name: string; known: boolean } | { ok: false; reason: string; suggestions: string[] };

/**
 * The full tool name for what the agent typed. A short name (`studio-usage`)
 * resolves when exactly one plugin has it. With no tool list (no inventory) a
 * full `<plugin>:<tool>` name is taken as written.
 */
export function resolveTool(input: string, known: readonly string[]): ToolLookup {
  const typed = input.trim();
  if (!typed) return { ok: false, reason: "Pass the tool name.", suggestions: [] };
  if (known.length === 0) {
    if (/^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/.test(typed)) return { ok: true, name: typed, known: false };
    return { ok: false, reason: `Pass the full tool name, "<plugin>:<tool>" (for example partnersinbiz.studio:studio-usage): the list of tools is not available right now, so "${typed}" cannot be looked up.`, suggestions: [] };
  }
  const lower = typed.toLowerCase();
  const exact = known.find((name) => name.toLowerCase() === lower);
  if (exact) return { ok: true, name: exact, known: true };
  const short = lower.includes(":") ? lower.split(":").pop() ?? lower : lower;
  const byShort = known.filter((name) => name.toLowerCase().endsWith(`:${short}`));
  if (!lower.includes(":") && byShort.length === 1) return { ok: true, name: byShort[0]!, known: true };
  const near = byShort.length > 0 ? byShort : known.filter((name) => name.toLowerCase().includes(short)).slice(0, 6);
  return {
    ok: false,
    reason: byShort.length > 1 ? `More than one plugin has a tool called "${typed}". Pass the full name.` : `No plugin tool is called "${typed}".`,
    suggestions: near.slice(0, 6),
  };
}

function strings(value: unknown): string[] | null {
  if (typeof value === "string") return value.trim() ? [value.trim()] : null;
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every((v) => typeof v === "string" && v.trim().length > 0) ? (value as string[]).map((v) => v.trim()) : null;
}

/** Selector keys the host accepts in a grant scope (singular; the plural form takes a list). */
const HOST_SCOPE_KEYS = new Set(["actorType", "agentId", "projectId", "routineId", "issueId", "gatewayId", "applicationId", "connectionId", "catalogEntryId", "applicationKey", "providerType", "toolName", "riskLevel"]);

/**
 * Whether one `tools:use` grant scope lets the seat call the plugin tool, as
 * the host decides it (`scopeAllowsTool`): no scope allows everything; an
 * `allow` list must name the tool; every selector must match. Selectors that
 * depend on the run (project, issue, risk level, connection) are "unclear".
 */
export function scopeVerdict(scope: Record<string, unknown> | null | undefined, toolName: string, agentId: string): Verdict {
  if (scope === null || scope === undefined) return "allow";
  if (typeof scope !== "object" || Array.isArray(scope)) return "deny";
  if (Object.keys(scope).length === 0) return "allow";
  let unclear = false;
  if (Object.hasOwn(scope, "allow")) {
    const values = strings(scope.allow);
    if (!values) return "deny";
    if (!values.includes(`tool:${toolName}`)) {
      if (values.some((v) => v.startsWith("connection:") || v.startsWith("application:"))) unclear = true;
      else return "deny";
    }
  }
  for (const [key, value] of Object.entries(scope)) {
    if (key === "allow") continue;
    const plural = !HOST_SCOPE_KEYS.has(key) && key.endsWith("s") && HOST_SCOPE_KEYS.has(key.slice(0, -1));
    const base = plural ? key.slice(0, -1) : key;
    if (!HOST_SCOPE_KEYS.has(base)) return "deny";
    const values = plural ? (Array.isArray(value) ? strings(value) : null) : typeof value === "string" ? strings(value) : null;
    if (!values) return "deny";
    if (base === "providerType") {
      if (!values.includes("paperclip_plugin")) return "deny";
    } else if (base === "toolName") {
      if (!values.includes(toolName)) return "deny";
    } else if (base === "agentId") {
      if (!values.includes(agentId)) return "deny";
    } else if (base === "actorType") {
      if (!values.includes("agent")) return "deny";
    } else {
      unclear = true;
    }
  }
  return unclear ? "unclear" : "allow";
}

export interface ToolAnswer {
  verdict: Verdict;
  /** How it is allowed. */
  via: "grant-all" | "grant-plugin-tools" | "grant-named" | "profile" | null;
  /** The profile that allows it, when `via` is "profile". */
  profile: string | null;
  /** Profiles that may apply but could not be judged (conditions, a project or issue binding). */
  unclearProfiles: string[];
}

function grantVia(scope: Record<string, unknown> | null): ToolAnswer["via"] {
  if (!scope || Object.keys(scope).length === 0) return "grant-all";
  return Object.hasOwn(scope, "toolName") || Object.hasOwn(scope, "toolNames") || Object.hasOwn(scope, "allow") ? "grant-named" : "grant-plugin-tools";
}

/** The seat's profiles as the host picks them: bound to the agent when any is, else bound to the company. */
function seatProfiles(profiles: readonly InvProfile[], agentId: string, companyId: string): InvProfile[] {
  const active = profiles.filter((p) => p.active);
  const forAgent = active.filter((p) => p.bindings.some((b) => b.targetType === "agent" && b.targetId === agentId));
  if (forAgent.length > 0) return forAgent;
  return active.filter((p) => p.bindings.some((b) => b.targetType === "company" && b.targetId === companyId));
}

function profileVerdict(profile: InvProfile, toolName: string): Verdict {
  const mine = profile.entries.filter((e) => e.selectorType === "tool_name" && e.toolName === toolName);
  if (mine.some((e) => e.effect === "exclude" && !e.conditional)) return "deny";
  const hazy = mine.some((e) => e.conditional) || profile.entries.some((e) => e.selectorType === "risk_level");
  if (mine.some((e) => e.effect === "include" && !e.conditional)) return hazy && mine.some((e) => e.effect === "exclude") ? "unclear" : "allow";
  if (profile.defaultAction === "allow") return hazy ? "unclear" : "allow";
  return hazy ? "unclear" : "deny";
}

/** May this seat call this plugin tool: its grants first, then its profiles. */
export function toolAnswer(input: { toolName: string; agentId: string; companyId: string; grants: readonly GrantRow[]; profiles: readonly InvProfile[] }): ToolAnswer {
  const { toolName, agentId, companyId } = input;
  const mine = input.grants.filter((g) => g.principalId === agentId && g.permissionKey === "tools:use");
  let unclearGrant = false;
  for (const grant of mine) {
    const verdict = scopeVerdict(grant.scope, toolName, agentId);
    if (verdict === "allow") return { verdict: "allow", via: grantVia(grant.scope), profile: null, unclearProfiles: [] };
    if (verdict === "unclear") unclearGrant = true;
  }
  const unclearProfiles: string[] = [];
  for (const profile of seatProfiles(input.profiles, agentId, companyId)) {
    const verdict = profileVerdict(profile, toolName);
    if (verdict === "allow") return { verdict: "allow", via: "profile", profile: profile.name, unclearProfiles: [] };
    if (verdict === "unclear") unclearProfiles.push(profile.name);
  }
  // A profile bound to a project, issue or routine applies only inside it.
  for (const profile of input.profiles) {
    if (!profile.active || unclearProfiles.includes(profile.name)) continue;
    const scoped = profile.bindings.some((b) => b.targetType === "project" || b.targetType === "issue" || b.targetType === "routine");
    if (scoped && profileVerdict(profile, toolName) !== "deny") unclearProfiles.push(profile.name);
  }
  return { verdict: unclearGrant || unclearProfiles.length > 0 ? "unclear" : "deny", via: null, profile: null, unclearProfiles };
}

/** Active profiles that include the tool by name, with the agent ids each is bound to. */
export function profilesWithTool(profiles: readonly InvProfile[], toolName: string): Array<{ name: string; agentIds: string[] }> {
  return profiles
    .filter((p) => p.active && profileVerdict(p, toolName) === "allow")
    .map((p) => ({ name: p.name, agentIds: p.bindings.filter((b) => b.targetType === "agent").map((b) => b.targetId) }));
}

export interface ToolGrantMerge {
  grants: Array<{ permissionKey: string; scope: Record<string, unknown> | null }>;
  changed: boolean;
  /** Set when the seat's tools grant is limited in a way this code must not widen. */
  conflict: string | null;
}

/**
 * The seat's grants with these tools added by name and nothing else. The host
 * keeps one `tools:use` grant per seat and a save replaces the whole set, so
 * every other grant is carried over untouched. No tools grant: a new one that
 * names only these tools. A grant that names tools: the names are added. Any
 * other limit (one connection, one project) is left alone, with `conflict`.
 */
export function mergeToolNames(existing: ReadonlyArray<{ permissionKey: string; scope: Record<string, unknown> | null }>, toolNames: readonly string[], agentId: string): ToolGrantMerge {
  const others = existing.filter((g) => g.permissionKey !== "tools:use").map((g) => ({ permissionKey: g.permissionKey, scope: g.scope ?? null }));
  const tools = existing.filter((g) => g.permissionKey === "tools:use").map((g) => ({ permissionKey: g.permissionKey, scope: g.scope ?? null }));
  const missing = toolNames.filter((name) => !tools.some((g) => scopeVerdict(g.scope, name, agentId) === "allow"));
  if (missing.length === 0) return { grants: [...others, ...tools], changed: false, conflict: null };
  if (tools.length === 0) return { grants: [...others, { permissionKey: "tools:use", scope: { toolNames: [...missing] } }], changed: true, conflict: null };
  const named = tools.find((g) => {
    const scope = g.scope ?? {};
    const keys = Object.keys(scope);
    const names = strings(scope.toolNames);
    const provider = scope.providerType === undefined || scope.providerType === "paperclip_plugin";
    return names !== null && provider && keys.every((k) => k === "toolNames" || k === "providerType");
  });
  if (!named || tools.length > 1) {
    return { grants: [...others, ...tools], changed: false, conflict: `The seat's tools grant is limited to ${JSON.stringify(tools[0]!.scope)}, which only the board can change.` };
  }
  const scope = { ...(named.scope ?? {}), toolNames: [...new Set([...(strings(named.scope?.toolNames) ?? []), ...missing])] };
  return { grants: [...others, { permissionKey: "tools:use", scope }], changed: true, conflict: null };
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Stored secrets whose name, key or description matches the words typed, best first (at most `limit`). */
export function findSecrets(query: string, secrets: readonly InvSecret[], limit = 8): InvSecret[] {
  const typed = query.trim().toLowerCase();
  const wanted = words(query);
  if (!typed || wanted.length === 0) return [];
  const scored: Array<{ secret: InvSecret; score: number }> = [];
  for (const secret of secrets) {
    const name = secret.name.toLowerCase();
    const key = secret.key.toLowerCase();
    let score = 0;
    if (secret.id === typed || name === typed || key === typed) score = 100;
    else if (name.includes(typed) || key.includes(typed)) score = 60;
    else {
      const own = new Set([...words(secret.name), ...words(secret.key)]);
      const all = new Set([...own, ...words(secret.description ?? "")]);
      if (wanted.every((w) => own.has(w))) score = 40;
      else if (wanted.every((w) => all.has(w) || [...all].some((o) => o.length >= 4 && w.length >= 4 && (o.startsWith(w) || w.startsWith(o))))) score = 20;
    }
    if (score > 0) scored.push({ secret, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.secret.name.localeCompare(b.secret.name)).slice(0, limit).map((s) => s.secret);
}

export interface SeatEnv {
  agentId: string;
  /** Environment names bound to a stored secret, with the secret's id. */
  refs: Array<{ env: string; secretId: string }>;
  /** Environment names set to a plain value (the value is never read). */
  plain: string[];
}

/** The environment names on a seat, from its adapter settings. Values are never read. */
export function seatEnv(agent: { id: string; adapterConfig?: unknown }): SeatEnv {
  const env = record(record(agent.adapterConfig)?.env) ?? {};
  const refs: SeatEnv["refs"] = [];
  const plain: string[] = [];
  for (const [name, entry] of Object.entries(env)) {
    const row = record(entry);
    if (row && row.type === "secret_ref" && typeof row.secretId === "string") refs.push({ env: name, secretId: row.secretId.toLowerCase() });
    else plain.push(name);
  }
  return { agentId: agent.id, refs, plain: plain.sort() };
}

const MONEY_WORDS = new Set([
  "bank", "banks", "banking", "fnb", "absa", "nedbank", "capitec", "investec", "standardbank", "tymebank", "iban", "swift",
  "payfast", "payflex", "peach", "ozow", "yoco", "stripe", "paypal", "paystack", "snapscan", "zapper", "wise", "revolut",
  "payment", "payments", "pay", "payout", "payouts", "card", "cards", "cvv", "merchant", "eft", "debit", "sars", "efiling", "payroll", "wallet", "treasury",
]);
const PERSONAL_WORDS = new Set(["personal", "private", "icloud", "appleid", "1password", "bitwarden", "lastpass", "keychain"]);

export type NeverReason = "money" | "personal" | "listed";

/**
 * Access that the deciding seat may never give: a payment or banking
 * credential, a personal login, or anything on the company's never-grant list
 * (plain text, matched anywhere in the name). It errs towards refusing: a name
 * that only looks like one of these still goes to the owner.
 */
export function neverGrant(names: ReadonlyArray<string | null | undefined>, denyList: readonly string[]): { reason: NeverReason; match: string } | null {
  const joined = names.filter((n): n is string => typeof n === "string" && n.length > 0);
  for (const pattern of denyList) {
    const p = pattern.trim().toLowerCase();
    if (p.length >= 2 && joined.some((n) => n.toLowerCase().includes(p))) return { reason: "listed", match: pattern.trim() };
  }
  const all = joined.flatMap((n) => words(n));
  for (let i = 0; i < all.length; i += 1) {
    const word = all[i]!;
    const pair = `${word}${all[i + 1] ?? ""}`;
    if (MONEY_WORDS.has(word) || MONEY_WORDS.has(pair)) return { reason: "money", match: MONEY_WORDS.has(word) ? word : pair };
    if (PERSONAL_WORDS.has(word) || PERSONAL_WORDS.has(pair)) return { reason: "personal", match: PERSONAL_WORDS.has(word) ? word : pair };
  }
  return null;
}

export function neverGrantText(found: { reason: NeverReason; match: string }): string {
  if (found.reason === "money") return `it looks like a payment or banking credential ("${found.match}")`;
  if (found.reason === "personal") return `it looks like a personal login ("${found.match}")`;
  return `it is on the company's never-grant list ("${found.match}")`;
}

const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

export function validEnvName(value: unknown): value is string {
  return typeof value === "string" && ENV_NAME.test(value);
}

/** An environment name for a secret when the asker gave none: its key in upper snake case. */
export function envNameFor(secret: Pick<InvSecret, "key" | "name">): string {
  const base = (secret.key || secret.name).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  const named = /^[A-Z]/.test(base) ? base : `S_${base}`;
  return ENV_NAME.test(named) ? named : "SECRET_VALUE";
}

function oneLine(value: string, max: number): string {
  return value.replace(/[`#\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * The one line the board's queue gets for a secret the deciding seat approved.
 * The part in backticks is the exact command the owner session runs; the rest
 * says what it is for. Fixed format, so it can be read by a script.
 */
export function bindLine(input: { agentId: string; envName: string; secretId: string; seatName: string; secretName: string; taskRef: string; requestRef: string | null; deciderName: string; reason: string }): string {
  const request = input.requestRef ? ` (request ${oneLine(input.requestRef, 20)})` : "";
  return `\`bind-secret.py ${input.agentId} ${input.envName}=${input.secretId}\` BIND-SECRET: ${oneLine(input.seatName, 60)} gets "${oneLine(input.secretName, 100)}" as ${input.envName} for ${oneLine(input.taskRef, 20)}${request}. Decided by ${oneLine(input.deciderName, 60)}: ${oneLine(input.reason, 200)}`;
}

/** Reads a bind line back (the server script and the tests use the same pattern). */
export function parseBindLine(line: string): { agentId: string; envName: string; secretId: string } | null {
  const match = /^`bind-secret\.py ([0-9a-f-]{36}) ([A-Z][A-Z0-9_]{1,63})=([0-9a-f-]{36})` BIND-SECRET: /i.exec(line.trim());
  return match ? { agentId: match[1]!, envName: match[2]!, secretId: match[3]! } : null;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export type AccessKind = "tool" | "secret";

/** One open request per seat and thing: the origin id carries everything the later steps need. */
export function requestOriginId(input: { kind: "tool"; seatAgentId: string; toolName: string } | { kind: "secret"; seatAgentId: string; secretId: string; envName: string }): string {
  return input.kind === "tool" ? `cockpit:access:tool:${input.seatAgentId}:${input.toolName}` : `cockpit:access:secret:${input.seatAgentId}:${input.secretId}:${input.envName}`;
}

export type ParsedRequest = { kind: "tool"; seatAgentId: string; toolName: string } | { kind: "secret"; seatAgentId: string; secretId: string; envName: string };

export function parseRequestOriginId(originId: string | null | undefined): ParsedRequest | null {
  if (!originId) return null;
  const tool = /^cockpit:access:tool:([0-9a-f-]{36}):(.+)$/i.exec(originId);
  if (tool) return { kind: "tool", seatAgentId: tool[1]!, toolName: tool[2]! };
  const secret = /^cockpit:access:secret:([0-9a-f-]{36}):([0-9a-f-]{36}):([A-Z][A-Z0-9_]{1,63})$/i.exec(originId);
  if (secret) return { kind: "secret", seatAgentId: secret[1]!, secretId: secret[2]!.toLowerCase(), envName: secret[3]! };
  return null;
}

export interface AccessSettings {
  /** The seat that decides access that already exists (decision rights: `access`, else `other`). */
  seatAgentId: string | null;
  /** The issue the board's queue lives on (identifier, e.g. PAR-9356), for what only the board can do. */
  boardQueueIssue: string | null;
  /** Plain text: a secret or tool whose name contains one of these is never granted by an agent. */
  neverGrant: string[];
  /** Keep `access-check` and `access-request` callable by every seat whose tools grant names tools. */
  grantLookupTools: boolean;
}

/** Reads `access` from the Cockpit settings. Malformed values are dropped. */
export function parseAccessSettings(config: unknown, seatAgentId: string | null): AccessSettings {
  const root = record(record(config)?.access) ?? {};
  const queue = typeof root.boardQueueIssue === "string" && /^[A-Za-z][A-Za-z0-9]{1,9}-\d{1,7}$/.test(root.boardQueueIssue.trim()) ? root.boardQueueIssue.trim().toUpperCase() : null;
  const neverList = Array.isArray(root.neverGrant) ? [...new Set(root.neverGrant.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter((v) => v.length >= 2 && v.length <= 80))].slice(0, 100) : [];
  return { seatAgentId, boardQueueIssue: queue, neverGrant: neverList, grantLookupTools: root.grantLookupTools !== false };
}
