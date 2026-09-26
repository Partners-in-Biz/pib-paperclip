/**
 * Host API calls from the Setup page (same-origin, board session cookie).
 */
import { MODULES, type SetupStatus } from "../kit-setup.js";
import { parseSetupStatus } from "../status.js";

export interface PluginRecordLite {
  id: string;
  pluginKey: string;
  status: string;
  version: string | null;
  displayName: string;
  schema: unknown;
}

export interface CompanyLite {
  id: string;
  name: string;
  issuePrefix: string | null;
}

const PIB_KEYS = new Set<string>(Object.values(MODULES).flatMap((module) => [...module.plugins]));

async function readJson(res: Response): Promise<unknown> {
  return res.json().catch(() => null);
}

function errorFrom(body: unknown, fallback: string): Error {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const text = record.error ?? record.message;
    if (typeof text === "string" && text) return new Error(text);
  }
  return new Error(fallback);
}

/** Installed PiB plugins by key (every install state, not only ready). */
export async function fetchInstalledPlugins(): Promise<Record<string, PluginRecordLite>> {
  const res = await fetch("/api/plugins", { credentials: "include", headers: { accept: "application/json" } });
  const body = await readJson(res);
  if (!res.ok) throw errorFrom(body, "Could not list plugins");
  const list = Array.isArray(body) ? body : Array.isArray((body as { data?: unknown })?.data) ? ((body as { data: unknown[] }).data) : [];
  const out: Record<string, PluginRecordLite> = {};
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const key = typeof row.pluginKey === "string" ? row.pluginKey : null;
    if (!key || !PIB_KEYS.has(key) || typeof row.id !== "string") continue;
    const manifest = row.manifestJson && typeof row.manifestJson === "object" ? (row.manifestJson as Record<string, unknown>) : {};
    out[key] = {
      id: row.id,
      pluginKey: key,
      status: typeof row.status === "string" ? row.status : "unknown",
      version: typeof row.version === "string" ? row.version : null,
      displayName: typeof manifest.displayName === "string" ? manifest.displayName : key,
      schema: manifest.instanceConfigSchema ?? null,
    };
  }
  return out;
}

export type LiveResult = { ok: true; status: SetupStatus } | { ok: false; reason: string };

/** The plugin's own setup check: GET /api/plugins/<key>/api/setup-status. */
export async function fetchLiveStatus(pluginKey: string, companyId: string): Promise<LiveResult> {
  try {
    const res = await fetch(`/api/plugins/${encodeURIComponent(pluginKey)}/api/setup-status?companyId=${encodeURIComponent(companyId)}`, {
      credentials: "include",
      headers: { accept: "application/json" },
    });
    const body = await readJson(res);
    if (!res.ok) {
      if (res.status === 404) return { ok: false, reason: "This version of the plugin has no setup check yet. Upgrade it." };
      if (res.status === 503) return { ok: false, reason: "The plugin is not running. Enable it, or wait for it to start." };
      return { ok: false, reason: errorFrom(body, `Setup check failed (${res.status})`).message };
    }
    const status = parseSetupStatus(body, pluginKey);
    return status ? { ok: true, status } : { ok: false, reason: "The plugin answered, but not with a setup status. Upgrade it." };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Setup check failed" };
  }
}

/** Runs another plugin's action ("Do it for me"). */
export async function runPluginAction(pluginKey: string, actionKey: string, companyId: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch(`/api/plugins/${encodeURIComponent(pluginKey)}/actions/${encodeURIComponent(actionKey)}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ companyId, params }),
  });
  const body = await readJson(res);
  if (!res.ok) throw errorFrom(body, `The action failed (${res.status})`);
  return body && typeof body === "object" && "data" in body ? (body as { data: unknown }).data : body;
}

export async function fetchCompanies(): Promise<CompanyLite[]> {
  const res = await fetch("/api/companies?scope=accessible", { credentials: "include", headers: { accept: "application/json" } });
  const body = await readJson(res);
  if (!res.ok) throw errorFrom(body, "Could not list companies");
  const list = Array.isArray(body) ? body : [];
  return list
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && typeof (row as Record<string, unknown>).id === "string")
    .map((row) => ({
      id: row.id as string,
      name: typeof row.name === "string" ? row.name : (row.id as string),
      issuePrefix: typeof row.issuePrefix === "string" ? row.issuePrefix : null,
    }));
}

/** A plugin's saved settings for a company (`{}` when never saved). */
export async function fetchPluginConfig(pluginId: string, companyId: string): Promise<{ saved: boolean; config: Record<string, unknown> }> {
  const res = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/config?companyId=${encodeURIComponent(companyId)}`, {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  const body = await readJson(res);
  if (!res.ok) throw errorFrom(body, `Could not read settings (${res.status})`);
  if (!body || typeof body !== "object") return { saved: false, config: {} };
  const record = body as Record<string, unknown>;
  const config = record.configJson && typeof record.configJson === "object" && !Array.isArray(record.configJson)
    ? (record.configJson as Record<string, unknown>)
    : {};
  return { saved: true, config };
}

export async function savePluginConfig(pluginId: string, companyId: string, configJson: Record<string, unknown>): Promise<void> {
  const res = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/config`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ companyId, configJson }),
  });
  if (!res.ok) throw errorFrom(await readJson(res), `Could not save settings (${res.status})`);
}
