/**
 * Browser helpers for plugin pages that assign a role to an existing agent
 * (import via `@partnersinbiz/pib-plugin-kit/agent-client`).
 *
 * A plugin worker cannot change an agent's skills, but the page runs as the
 * signed-in board user, who can: this calls the same host endpoint the
 * Agents → Skills tab uses (`POST /api/agents/:id/skills/sync`, mode "add",
 * which keeps the agent's other skills).
 */

export interface AgentSkillSnapshot {
  desiredSkills?: string[];
  warnings?: string[];
}

/** Canonical key the host gives a plugin-managed skill: `plugin/<slug(pluginKey)>/<skillKey>`. */
export function pluginSkillKey(pluginKey: string, skillKey: string): string {
  const slug = pluginKey.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "plugin";
  return `plugin/${slug}/${skillKey}`;
}

async function hostJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "include", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

/** The agent's current desired skill keys. */
export async function agentSkills(agentId: string, companyId: string): Promise<string[]> {
  const snap = await hostJson<AgentSkillSnapshot>(`/api/agents/${encodeURIComponent(agentId)}/skills?companyId=${encodeURIComponent(companyId)}`);
  return Array.isArray(snap?.desiredSkills) ? snap.desiredSkills : [];
}

/**
 * Add skills to an agent (keeps its other skills). Returns the keys that were
 * missing and got added; [] when it already had them all.
 */
export async function attachAgentSkills(agentId: string, companyId: string, skillKeys: string[]): Promise<string[]> {
  const wanted = [...new Set(skillKeys.filter(Boolean))];
  if (wanted.length === 0) return [];
  let current: string[] = [];
  try {
    current = await agentSkills(agentId, companyId);
  } catch {
    current = [];
  }
  const missing = wanted.filter((key) => !current.includes(key));
  if (missing.length === 0) return [];
  await hostJson(`/api/agents/${encodeURIComponent(agentId)}/skills/sync?companyId=${encodeURIComponent(companyId)}`, {
    method: "POST",
    body: JSON.stringify({ mode: "add", desiredSkills: missing }),
  });
  return missing;
}

/** Which of these skills the agent is missing ([] when unknown or all present). */
export async function missingAgentSkills(agentId: string, companyId: string, skillKeys: string[]): Promise<string[]> {
  try {
    const current = await agentSkills(agentId, companyId);
    return skillKeys.filter((key) => !current.includes(key));
  } catch {
    return [];
  }
}
