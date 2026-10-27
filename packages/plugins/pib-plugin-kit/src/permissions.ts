/**
 * Fine-grained access control for the PiB plugins. Paperclip's own roles are
 * company-wide (owner, admin, member), so this layer adds per-area, per-action
 * permissions and record scoping on top of them.
 *
 * Model: a permission is `<resource>:<action>` (e.g. `billing.invoices:view`).
 * A member's effective permissions are their preset, plus `allow`, minus `deny`.
 * Default is deny. Owners and admins bypass the whole layer. Scoping: a
 * scopable resource is either `all` records or `linked` (only the CRM companies
 * listed in `linkedCompanyIds`; an empty list sees nothing).
 *
 * Storage: one `ctx.state` row per member (company scope, namespace `access`,
 * key `u:<userId>`), so two admins editing two people never overwrite each
 * other. Every change is written to the activity log with before and after.
 *
 * Enforcement is only as real as the caller identity it is given: actions, API
 * routes and tool runs carry a verified actor; `getData` handlers do not (host
 * limitation, see PIB-GUIDE.md), so a userId a UI passes there is a hint, not proof.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { LOCAL_BOARD_USER_ID } from "./cockpit.js";

export const PERMISSION_ACTIONS = ["view", "create", "edit", "delete", "export", "approve"] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];
export type ScopeMode = "all" | "linked";

export type PermissionResource = {
  id: string;
  area: string;
  label: string;
  actions: readonly PermissionAction[];
  /** Records belong to a CRM company, so they can be limited to linked companies. */
  scopable?: boolean;
};

const CRUD = ["view", "create", "edit", "delete"] as const;
const r = (
  id: string,
  label: string,
  actions: readonly PermissionAction[],
  scopable = false,
): PermissionResource => ({ id, area: id.split(".")[0]!, label, actions, scopable });

/** The catalog. Adding a resource here is the only place a new gate is declared. */
export const PERMISSION_CATALOG: readonly PermissionResource[] = [
  r("crm.contacts", "CRM contacts", [...CRUD, "export"], true),
  r("crm.companies", "CRM companies", CRUD, true),
  r("crm.deals", "CRM deals", CRUD, true),
  r("crm.projects", "Client projects", CRUD, true),
  r("crm.reports", "CRM reports and dashboards", ["view", "export"], true),
  r("crm.settings", "CRM settings", ["view", "edit"]),
  r("billing.invoices", "Invoices", [...CRUD, "export", "approve"], true),
  r("billing.quotes", "Quotes", [...CRUD, "approve"], true),
  r("billing.reports", "Billing reports and dashboards", ["view", "export"]),
  r("billing.settings", "Billing settings", ["view", "edit"]),
  r("accounting.ledger", "Ledger and journals", [...CRUD, "approve"]),
  r("accounting.reports", "Financial statements and dashboards", ["view", "export"]),
  r("accounting.settings", "Accounting settings", ["view", "edit"]),
  r("payroll.employees", "Employees", CRUD),
  r("payroll.payruns", "Pay runs", ["view", "create", "edit", "approve", "export"]),
  r("payroll.settings", "Payroll settings", ["view", "edit"]),
  r("social.posts", "Social posts", [...CRUD, "approve"], true),
  r("social.accounts", "Social accounts", ["view", "create", "edit", "delete"], true),
  r("social.settings", "Social settings", ["view", "edit"]),
  r("mailbox.mail", "Mail", ["view", "create", "edit", "delete"]),
  r("mailbox.settings", "Mailbox settings", ["view", "edit"]),
  r("seo.work", "SEO work and reports", [...CRUD, "approve", "export"], true),
  r("seo.settings", "SEO settings", ["view", "edit"]),
  r("campaigns.campaigns", "Campaigns", [...CRUD, "approve"], true),
  r("campaigns.settings", "Campaign settings", ["view", "edit"]),
  r("partners.grants", "Partner links and grants", ["view", "create", "edit", "delete"]),
  r("cockpit.dashboards", "Cockpit dashboards", ["view", "export"]),
  r("cockpit.settings", "Cockpit settings", ["view", "edit"]),
  r("setup.settings", "Setup and entitlements", ["view", "edit"]),
];

const RESOURCES = new Map(PERMISSION_CATALOG.map((x) => [x.id, x]));
export const permissionKey = (resource: string, action: PermissionAction) => `${resource}:${action}`;
const ALL_KEYS = new Set(PERMISSION_CATALOG.flatMap((x) => x.actions.map((a) => permissionKey(x.id, a))));

export function isPermissionKey(key: unknown): key is string {
  return typeof key === "string" && ALL_KEYS.has(key);
}

export type PresetId = "salesperson" | "accountant" | "client" | "viewer" | "manager";
export type Preset = { id: PresetId; label: string; scope: ScopeMode; permissions: readonly string[] };

/** Keys for the given resources: only the listed actions (or all of them), skipping ones a resource lacks. */
function keys(resources: readonly string[], actions?: readonly PermissionAction[]): string[] {
  return resources.flatMap((id) => {
    const res = RESOURCES.get(id);
    if (!res) throw new Error(`Unknown resource ${id}`);
    return res.actions.filter((a) => !actions || actions.includes(a)).map((a) => permissionKey(id, a));
  });
}
const inArea = (...areas: string[]) => PERMISSION_CATALOG.filter((x) => areas.includes(x.area)).map((x) => x.id);
const notSettings = (ids: string[]) => ids.filter((id) => !id.endsWith(".settings"));
const READ_MOST = notSettings(PERMISSION_CATALOG.map((x) => x.id)).filter(
  (id) => !id.startsWith("accounting.") && !id.startsWith("payroll."),
);

export const PRESETS: Record<PresetId, Preset> = {
  salesperson: {
    id: "salesperson",
    label: "Salesperson",
    scope: "all",
    permissions: [
      ...keys(["crm.contacts", "crm.companies", "crm.deals", "crm.projects"], ["view", "create", "edit"]),
      ...keys(["billing.invoices"], ["view"]),
      ...keys(["billing.quotes"], ["view", "create", "edit"]),
      ...keys(["mailbox.mail"], ["view", "create"]),
      ...keys(["campaigns.campaigns"], ["view"]),
    ],
  },
  accountant: {
    id: "accountant",
    label: "Accountant",
    scope: "all",
    permissions: [
      ...keys(inArea("accounting")),
      ...keys(inArea("billing")),
      ...keys(["payroll.employees", "payroll.payruns"], ["view", "export"]),
      ...keys(["crm.companies", "crm.contacts"], ["view"]),
    ],
  },
  client: {
    id: "client",
    label: "Client (linked companies only)",
    scope: "linked",
    permissions: keys(["crm.companies", "crm.projects", "billing.invoices", "billing.quotes"], ["view"]),
  },
  viewer: { id: "viewer", label: "Viewer", scope: "all", permissions: keys(READ_MOST, ["view"]) },
  manager: {
    id: "manager",
    label: "Manager",
    scope: "all",
    permissions: keys(PERMISSION_CATALOG.map((x) => x.id).filter((id) => !id.startsWith("payroll.") && !id.startsWith("accounting.") && id !== "setup.settings")),
  },
};

export type AccessGrant = {
  userId: string;
  preset: PresetId | null;
  allow: string[];
  deny: string[];
  /** CRM company ids a `linked` scope is limited to. */
  linkedCompanyIds: string[];
  /** Per resource id or whole area, overrides the preset's scope. */
  scopeOverrides: Record<string, ScopeMode>;
  updatedBy: string | null;
  updatedAt: string;
};

/** What a verified caller may do. `bypass` is true for owners, admins and the local board. */
export type Access = {
  userId: string | null;
  bypass: boolean;
  grant: AccessGrant | null;
  /** Why access is missing, for refusals. */
  reason?: string;
};

export type Decision =
  | { allowed: false; reason: string }
  | { allowed: true; scope: "all" }
  | { allowed: true; scope: "linked"; companyIds: string[] };

export const BYPASS: Access = { userId: null, bypass: true, grant: null };

function effectiveScope(grant: AccessGrant, resource: PermissionResource): ScopeMode {
  if (!resource.scopable) return "all";
  const own = grant.scopeOverrides[resource.id] ?? grant.scopeOverrides[resource.area];
  if (own) return own;
  // No preset and no override: fail closed. An admin must say `all` explicitly.
  return grant.preset ? PRESETS[grant.preset].scope : "linked";
}

/** The single decision point. Unknown resources or actions are denied. */
export function decideAccess(access: Access, resourceId: string, action: PermissionAction): Decision {
  const resource = RESOURCES.get(resourceId);
  if (!resource || !resource.actions.includes(action)) return { allowed: false, reason: `Unknown permission ${resourceId}:${action}` };
  if (access.bypass) return { allowed: true, scope: "all" };
  const grant = access.grant;
  if (!grant) return { allowed: false, reason: access.reason ?? "No access has been granted to you" };
  const key = permissionKey(resourceId, action);
  const fromPreset = grant.preset ? PRESETS[grant.preset].permissions.includes(key) : false;
  if (grant.deny.includes(key) || !(fromPreset || grant.allow.includes(key))) {
    return { allowed: false, reason: `You do not have permission to ${action} ${resource.label.toLowerCase()}` };
  }
  return effectiveScope(grant, resource) === "linked"
    ? { allowed: true, scope: "linked", companyIds: grant.linkedCompanyIds }
    : { allowed: true, scope: "all" };
}

export const can = (access: Access, resourceId: string, action: PermissionAction) => decideAccess(access, resourceId, action).allowed;

export class PermissionDeniedError extends Error {
  readonly code = "PERMISSION_DENIED";
  constructor(message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

/** Throws unless allowed; returns the decision so callers can apply its scope. */
export function assertCan(access: Access, resourceId: string, action: PermissionAction): Extract<Decision, { allowed: true }> {
  const d = decideAccess(access, resourceId, action);
  if (!d.allowed) throw new PermissionDeniedError(d.reason);
  return d;
}

/** Can this person touch a record that belongs to the given CRM company? */
export function canSeeCompany(decision: Extract<Decision, { allowed: true }>, crmCompanyId: string | null | undefined): boolean {
  return decision.scope === "all" || (typeof crmCompanyId === "string" && decision.companyIds.includes(crmCompanyId));
}

/** Filter rows to the decision's scope. Rows without a company are dropped for linked scope (fail closed). */
export function scopeRows<T>(decision: Extract<Decision, { allowed: true }>, rows: readonly T[], companyOf: (row: T) => string | null | undefined): T[] {
  return decision.scope === "all" ? [...rows] : rows.filter((row) => canSeeCompany(decision, companyOf(row)));
}

/** Ids to put in a `WHERE company_id = ANY(...)`, or null for no filter. Empty array means match nothing. */
export function scopeCompanyIds(decision: Extract<Decision, { allowed: true }>): string[] | null {
  return decision.scope === "all" ? null : decision.companyIds;
}

// ---------------------------------------------------------------------------
// Resolving the caller

export type ActorInput = { type?: string | null; userId?: string | null } | null | undefined;

const NAMESPACE = "access";
const userScope = (companyId: string, userId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: NAMESPACE, stateKey: `u:${userId}` });
export const MAX_LINKED_COMPANIES = 200;
const SCOPE_MODES: readonly string[] = ["all", "linked"];
const unique = (xs: readonly string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

function clean(grant: unknown, userId: string): AccessGrant | null {
  if (!grant || typeof grant !== "object" || Array.isArray(grant)) return null;
  const g = grant as Partial<AccessGrant>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const overrides: Record<string, ScopeMode> = {};
  for (const [k, v] of Object.entries(g.scopeOverrides && typeof g.scopeOverrides === "object" ? g.scopeOverrides : {})) {
    if (SCOPE_MODES.includes(v as string)) overrides[k] = v as ScopeMode;
  }
  return {
    userId,
    preset: g.preset && Object.hasOwn(PRESETS, g.preset) ? g.preset : null,
    allow: list(g.allow).filter(isPermissionKey),
    deny: list(g.deny).filter(isPermissionKey),
    linkedCompanyIds: unique(list(g.linkedCompanyIds)).slice(0, MAX_LINKED_COMPANIES),
    scopeOverrides: overrides,
    updatedBy: typeof g.updatedBy === "string" ? g.updatedBy : null,
    updatedAt: typeof g.updatedAt === "string" ? g.updatedAt : "",
  };
}

export async function loadGrant(ctx: PluginContext, companyId: string, userId: string): Promise<AccessGrant | null> {
  return clean(await ctx.state.get(userScope(companyId, userId)), userId);
}

async function roleOf(ctx: PluginContext, companyId: string, userId: string): Promise<string | null> {
  const members = await ctx.access.members.list({ companyId });
  return members.find((m) => m.principalType === "user" && m.principalId === userId && m.status === "active")?.membershipRole ?? null;
}

/**
 * Who is this and what may they do. Agents are not restricted by this layer
 * (they act on assigned work under the host's own agent policy). A human whose
 * role or grant cannot be read is denied, never allowed.
 */
export async function resolveAccess(ctx: PluginContext, companyId: string, actor: ActorInput): Promise<Access> {
  if (actor?.type === "agent" || actor?.type === "system") return BYPASS;
  const userId = actor?.type === "user" && typeof actor.userId === "string" ? actor.userId.trim() : "";
  if (!userId) return { userId: null, bypass: false, grant: null, reason: "Sign in to continue" };
  if (userId === LOCAL_BOARD_USER_ID) return { ...BYPASS, userId };
  try {
    const role = await roleOf(ctx, companyId, userId);
    if (!role) return { userId, bypass: false, grant: null, reason: "You are not an active member of this company" };
    if (role === "owner" || role === "admin") return { ...BYPASS, userId };
    return { userId, bypass: false, grant: await loadGrant(ctx, companyId, userId) };
  } catch {
    return { userId, bypass: false, grant: null, reason: "Cannot verify your access" };
  }
}

// ---------------------------------------------------------------------------
// Managing grants (owner or admin only)

export type SaveGrantInput = {
  userId: string;
  preset?: PresetId | null;
  allow?: string[];
  deny?: string[];
  linkedCompanyIds?: string[];
  scopeOverrides?: Record<string, ScopeMode>;
};
export type SaveGrantResult = { ok: true; grant: AccessGrant } | { ok: false; error: string };

async function requireAdmin(ctx: PluginContext, companyId: string, actor: ActorInput): Promise<{ userId: string } | { error: string }> {
  const access = await resolveAccess(ctx, companyId, actor?.type === "user" ? actor : null);
  if (!access.bypass || !access.userId) return { error: "Only a company owner or admin can manage access" };
  return { userId: access.userId };
}

/** An input list that is an array of strings, or null when it is anything else. */
const stringList = (v: unknown): string[] | null => (v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);

/** Validates, stores and audits one member's grant. Fails closed; writes nothing on any problem. */
export async function saveGrant(
  ctx: PluginContext,
  action: { companyId?: string | null; actor?: ActorInput },
  input: SaveGrantInput,
): Promise<SaveGrantResult> {
  const companyId = typeof action.companyId === "string" ? action.companyId.trim() : "";
  if (!companyId) return { ok: false, error: "A company is required" };
  const admin = await requireAdmin(ctx, companyId, action.actor);
  if ("error" in admin) return { ok: false, error: admin.error };
  const userId = typeof input?.userId === "string" ? input.userId.trim() : "";
  if (!userId) return { ok: false, error: "Choose a person" };
  if (input.preset != null && !Object.hasOwn(PRESETS, input.preset)) return { ok: false, error: "Unknown preset" };
  const rawAllow = stringList(input.allow);
  const rawDeny = stringList(input.deny);
  const rawLinked = stringList(input.linkedCompanyIds);
  if (!rawAllow || !rawDeny || !rawLinked) return { ok: false, error: "Permissions and linked companies must be lists of text" };
  if (input.scopeOverrides != null && (typeof input.scopeOverrides !== "object" || Array.isArray(input.scopeOverrides))) return { ok: false, error: "Scope overrides must be an object" };
  const allow = unique(rawAllow);
  const deny = unique(rawDeny);
  const bad = [...allow, ...deny].find((k) => !isPermissionKey(k));
  if (bad) return { ok: false, error: `Unknown permission "${bad}"` };
  const linked = unique(rawLinked);
  if (linked.length > MAX_LINKED_COMPANIES) return { ok: false, error: `At most ${MAX_LINKED_COMPANIES} linked companies` };
  const overrides: Record<string, ScopeMode> = {};
  for (const [k, v] of Object.entries(input.scopeOverrides ?? {})) {
    if (!RESOURCES.has(k) && !PERMISSION_CATALOG.some((x) => x.area === k)) return { ok: false, error: `Unknown area "${k}"` };
    if (!SCOPE_MODES.includes(v)) return { ok: false, error: `Scope for "${k}" must be all or linked` };
    overrides[k] = v;
  }

  let target: string | null;
  try {
    target = await roleOf(ctx, companyId, userId);
  } catch {
    return { ok: false, error: "Cannot verify the person's role" };
  }
  if (!target) return { ok: false, error: "That person is not an active member of this company" };
  if (target === "owner" || target === "admin") return { ok: false, error: "Owners and admins always have full access; change their role instead" };

  const before = await loadGrant(ctx, companyId, userId);
  const grant: AccessGrant = {
    userId,
    preset: input.preset ?? null,
    allow,
    deny,
    linkedCompanyIds: linked,
    scopeOverrides: overrides,
    updatedBy: admin.userId,
    updatedAt: new Date().toISOString(),
  };
  try {
    await ctx.state.set(userScope(companyId, userId), grant);
  } catch (error) {
    ctx.logger.info("Could not save access", { error: error instanceof Error ? error.message : String(error) });
    return { ok: false, error: "Could not save access" };
  }
  if (!(await audit(ctx, companyId, admin.userId, userId, before, grant))) {
    await restore(ctx, companyId, userId, before);
    return { ok: false, error: "Could not record the change in the audit log, so it was not saved" };
  }
  return { ok: true, grant };
}

/** Removes a member's grant (back to default deny). */
export async function clearGrant(ctx: PluginContext, action: { companyId?: string | null; actor?: ActorInput }, rawUserId: string): Promise<SaveGrantResult | { ok: true; grant: null }> {
  const companyId = typeof action.companyId === "string" ? action.companyId.trim() : "";
  if (!companyId) return { ok: false, error: "A company is required" };
  const admin = await requireAdmin(ctx, companyId, action.actor);
  if ("error" in admin) return { ok: false, error: admin.error };
  const userId = typeof rawUserId === "string" ? rawUserId.trim() : "";
  if (!userId) return { ok: false, error: "Choose a person" };
  const before = await loadGrant(ctx, companyId, userId);
  try {
    await ctx.state.delete(userScope(companyId, userId));
  } catch {
    return { ok: false, error: "Could not remove access" };
  }
  if (!(await audit(ctx, companyId, admin.userId, userId, before, null))) {
    await restore(ctx, companyId, userId, before);
    return { ok: false, error: "Could not record the change in the audit log, so it was not saved" };
  }
  return { ok: true, grant: null };
}

/** Puts the previous grant back after a failed audit write. Best effort; logs if it also fails. */
async function restore(ctx: PluginContext, companyId: string, userId: string, before: AccessGrant | null): Promise<void> {
  try {
    if (before) await ctx.state.set(userScope(companyId, userId), before);
    else await ctx.state.delete(userScope(companyId, userId));
  } catch (error) {
    ctx.logger.info("Could not restore access after a failed audit write", { error: error instanceof Error ? error.message : String(error) });
  }
}

/** True when the entry was written. A change is only kept if its audit entry exists. */
async function audit(ctx: PluginContext, companyId: string, by: string, target: string, before: AccessGrant | null, after: AccessGrant | null): Promise<boolean> {
  const summary = (g: AccessGrant | null) => (g ? { preset: g.preset, allow: g.allow, deny: g.deny, linkedCompanyIds: g.linkedCompanyIds, scopeOverrides: g.scopeOverrides } : null);
  try {
    await ctx.activity.log({
      companyId,
      message: after ? `Access changed for ${target}` : `Access removed for ${target}`,
      entityType: "plugin_access",
      entityId: target,
      metadata: { changedBy: by, before: summary(before), after: summary(after) },
    });
    return true;
  } catch (error) {
    ctx.logger.info("Could not write the access audit entry", { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

export type AccessRow = {
  userId: string;
  role: string;
  grant: AccessGrant | null;
};

/** Members with their grants, for the manage-access screen. Owner or admin only. */
export async function listAccess(ctx: PluginContext, action: { companyId?: string | null; actor?: ActorInput }): Promise<{ ok: true; rows: AccessRow[] } | { ok: false; error: string }> {
  const companyId = typeof action.companyId === "string" ? action.companyId.trim() : "";
  if (!companyId) return { ok: false, error: "A company is required" };
  const admin = await requireAdmin(ctx, companyId, action.actor);
  if ("error" in admin) return { ok: false, error: admin.error };
  try {
    const members = await ctx.access.members.list({ companyId });
    const users = members.filter((m) => m.principalType === "user" && m.status === "active");
    const rows = await Promise.all(
      users.map(async (m) => ({ userId: m.principalId, role: m.membershipRole ?? "member", grant: await loadGrant(ctx, companyId, m.principalId) })),
    );
    return { ok: true, rows };
  } catch {
    return { ok: false, error: "Cannot read members" };
  }
}

/** Serializable catalog and presets for the manage-access screen. */
export function describePermissions() {
  return {
    actions: PERMISSION_ACTIONS,
    resources: PERMISSION_CATALOG,
    presets: Object.values(PRESETS).map((p) => ({ id: p.id, label: p.label, scope: p.scope, permissions: p.permissions })),
  };
}
