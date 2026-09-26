/**
 * Host API calls from the Cockpit page (same origin, board session cookie).
 * Every call degrades to "nothing" on failure: one broken source never
 * breaks the page.
 */
import type { CockpitSnapshot } from "@partnersinbiz/pib-plugin-kit/cockpit";
import { MODULES, SETUP_PLUGIN } from "@partnersinbiz/pib-plugin-kit/setup";
import { PLUGIN_KEY } from "../constants.js";
import { OPEN_ISSUE_STATUSES, parseSnapshot, type AgentLite, type ApprovalLite, type HostActivityLite, type IssueLite, type RunLite } from "../merge.js";
import type { InstalledLite } from "../view.js";

/** Plugins behind the modules, plus Setup and the Cockpit. */
export const MODULE_PLUGIN_KEYS: string[] = Object.values(MODULES).flatMap((module) => [...module.plugins] as string[]);
const PIB_KEYS = new Set<string>([...MODULE_PLUGIN_KEYS, SETUP_PLUGIN, PLUGIN_KEY]);

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { credentials: "include", headers: { accept: "application/json" } });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const text = body && typeof body === "object" ? (body as Record<string, unknown>).error : null;
    throw new Error(typeof text === "string" && text ? text : `Request failed (${res.status})`);
  }
  return body;
}

function list(body: unknown, key?: string): Record<string, unknown>[] {
  const raw = Array.isArray(body)
    ? body
    : body && typeof body === "object"
      ? ((key ? (body as Record<string, unknown>)[key] : undefined) ?? (body as Record<string, unknown>).data ?? (body as Record<string, unknown>).items)
      : null;
  return Array.isArray(raw) ? raw.filter((row): row is Record<string, unknown> => !!row && typeof row === "object") : [];
}

const iso = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const enc = encodeURIComponent;

/** Installed PiB plugins by key. */
export async function fetchInstalledPlugins(): Promise<Record<string, InstalledLite> | null> {
  try {
    const out: Record<string, InstalledLite> = {};
    for (const row of list(await getJson("/api/plugins"))) {
      const key = typeof row.pluginKey === "string" ? row.pluginKey : null;
      if (!key || !PIB_KEYS.has(key) || typeof row.id !== "string") continue;
      out[key] = { id: row.id, status: typeof row.status === "string" ? row.status : "unknown" };
    }
    return out;
  } catch {
    return null;
  }
}

/** A plugin's live snapshot: GET /api/plugins/<key>/api/cockpit. Null when it cannot answer. */
export async function fetchLiveSnapshot(pluginKey: string, companyId: string): Promise<CockpitSnapshot | null> {
  try {
    return parseSnapshot(await getJson(`/api/plugins/${enc(pluginKey)}/api/cockpit?companyId=${enc(companyId)}`), pluginKey);
  } catch {
    return null;
  }
}

export async function fetchApprovals(companyId: string): Promise<ApprovalLite[]> {
  try {
    return list(await getJson(`/api/companies/${enc(companyId)}/approvals`)).map((row) => ({
      id: String(row.id),
      type: String(row.type ?? ""),
      status: String(row.status ?? ""),
      payload: row.payload && typeof row.payload === "object" ? (row.payload as Record<string, unknown>) : null,
      createdAt: iso(row.createdAt),
    }));
  } catch {
    return [];
  }
}

/** Open issues assigned to the signed-in person. */
export async function fetchMyIssues(companyId: string): Promise<IssueLite[]> {
  try {
    const url = `/api/companies/${enc(companyId)}/issues?assigneeUserId=me&status=${OPEN_ISSUE_STATUSES.join(",")}&limit=50`;
    return list(await getJson(url)).map((row) => ({
      id: String(row.id),
      identifier: typeof row.identifier === "string" ? row.identifier : null,
      title: String(row.title ?? ""),
      status: String(row.status ?? ""),
      priority: typeof row.priority === "string" ? row.priority : null,
      updatedAt: iso(row.updatedAt),
      createdAt: iso(row.createdAt),
    }));
  } catch {
    return [];
  }
}

function monthStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/**
 * Agents with spend and budget this month: the agent record, overridden by
 * this month's costs (`costs/by-agent`) and the agent's monthly budget policy
 * (`budgets/overview`) when those answer.
 */
export async function fetchAgents(companyId: string, now = new Date()): Promise<AgentLite[]> {
  let rows: Record<string, unknown>[] = [];
  try {
    rows = list(await getJson(`/api/companies/${enc(companyId)}/agents`));
  } catch {
    return [];
  }
  const [costs, budgets] = await Promise.all([
    getJson(`/api/companies/${enc(companyId)}/costs/by-agent?from=${enc(monthStartIso(now))}`).then((b) => list(b)).catch(() => null),
    getJson(`/api/companies/${enc(companyId)}/budgets/overview`).then((b) => list(b, "policies")).catch(() => null),
  ]);
  const spend = new Map<string, number>();
  for (const row of costs ?? []) if (typeof row.agentId === "string" && typeof row.costCents === "number") spend.set(row.agentId, row.costCents);
  const policy = new Map<string, { amount: number; observed: number }>();
  for (const row of budgets ?? []) {
    if (row.scopeType !== "agent" || typeof row.scopeId !== "string" || row.isActive === false) continue;
    if (row.windowKind !== "calendar_month_utc" || typeof row.amount !== "number") continue;
    policy.set(row.scopeId, { amount: row.amount, observed: typeof row.observedAmount === "number" ? row.observedAmount : 0 });
  }
  return rows.map((row) => {
    const id = String(row.id);
    const p = policy.get(id);
    const budget = p && p.amount > 0 ? p.amount : Number(row.budgetMonthlyCents ?? 0) || 0;
    const spent = spend.get(id) ?? (p ? p.observed : Number(row.spentMonthlyCents ?? 0) || 0);
    return {
      id,
      name: String(row.name ?? "Agent"),
      title: typeof row.title === "string" ? row.title : null,
      role: typeof row.role === "string" ? row.role : null,
      urlKey: typeof row.urlKey === "string" ? row.urlKey : null,
      status: String(row.status ?? ""),
      budgetMonthlyCents: budget,
      spentMonthlyCents: spent,
      lastRunAt: iso(row.lastHeartbeatAt),
      errorReason: typeof row.errorReason === "string" ? row.errorReason : null,
      pauseReason: typeof row.pauseReason === "string" ? row.pauseReason : null,
    };
  });
}

export async function fetchActivity(companyId: string): Promise<HostActivityLite[]> {
  try {
    return list(await getJson(`/api/companies/${enc(companyId)}/activity?limit=200`)).map((row) => ({
      actorType: String(row.actorType ?? ""),
      actorId: String(row.actorId ?? ""),
      action: String(row.action ?? ""),
      entityType: String(row.entityType ?? ""),
      entityId: String(row.entityId ?? ""),
      agentId: typeof row.agentId === "string" ? row.agentId : null,
      details: row.details && typeof row.details === "object" ? (row.details as Record<string, unknown>) : null,
      createdAt: String(row.createdAt ?? ""),
    }));
  } catch {
    return [];
  }
}

export async function fetchRuns(companyId: string): Promise<RunLite[]> {
  try {
    return list(await getJson(`/api/companies/${enc(companyId)}/heartbeat-runs?limit=500&summary=true`)).map((row) => ({
      agentId: String(row.agentId ?? ""),
      status: String(row.status ?? ""),
      startedAt: iso(row.startedAt) ?? iso(row.createdAt),
      finishedAt: iso(row.finishedAt),
      error: typeof row.error === "string" ? row.error : null,
    }));
  } catch {
    return [];
  }
}

/** Latest database backup from `GET /api/health` (board sessions see it). Null when not exposed. */
export async function fetchBackup(): Promise<{ mtime: string | null; ageHours: number | null } | null> {
  try {
    const body = (await getJson("/api/health")) as Record<string, unknown> | null;
    const backup = body?.databaseBackup as Record<string, unknown> | undefined;
    if (!backup || backup.enabled === false) return null;
    const latest = backup.latestBackup as Record<string, unknown> | null | undefined;
    if (latest && typeof latest === "object") {
      return { mtime: iso(latest.mtime), ageHours: typeof latest.ageHours === "number" ? latest.ageHours : null };
    }
    return backup.status === "warning" ? { mtime: null, ageHours: null } : null;
  } catch {
    return null;
  }
}

export interface UserLite {
  id: string;
  name: string;
}

export async function fetchUsers(companyId: string): Promise<UserLite[]> {
  try {
    return list(await getJson(`/api/companies/${enc(companyId)}/user-directory`), "users")
      .map((row) => row.user as Record<string, unknown> | null)
      .filter((user): user is Record<string, unknown> => !!user && typeof user.id === "string")
      .map((user) => ({ id: String(user.id), name: String(user.name ?? user.email ?? user.id) }));
  } catch {
    return [];
  }
}

/** Setup's own page data (module switches and stored statuses), or null. */
export async function fetchSetupLoad(companyId: string): Promise<{ modules: Record<string, boolean> | null; statuses: Record<string, { status: unknown }> } | null> {
  try {
    const res = await fetch(`/api/plugins/${enc(SETUP_PLUGIN)}/actions/setup.load`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ companyId, params: {} }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const data = (body && typeof body === "object" && "data" in body ? body.data : body) as Record<string, unknown> | null;
    if (!data) return null;
    return { modules: (data.modules as Record<string, boolean> | null) ?? null, statuses: (data.statuses as Record<string, { status: unknown }>) ?? {} };
  } catch {
    return null;
  }
}

export async function savePluginConfig(companyId: string, configJson: Record<string, unknown>): Promise<void> {
  const res = await fetch(`/api/plugins/${enc(PLUGIN_KEY)}/config`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ companyId, configJson }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const text = body && typeof body === "object" ? (body as Record<string, unknown>).error : null;
    throw new Error(typeof text === "string" && text ? text : `Could not save settings (${res.status})`);
  }
}
