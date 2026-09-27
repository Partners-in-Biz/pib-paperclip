/**
 * Company wiki from the Setup page (same origin, board session cookie).
 *
 * Reads LLM Wiki's `settings` data (falls back to its `/overview` route), the
 * company's agents and routines, and turns them into a `WikiSnapshot`. The
 * "Do it for me" action (`memory.setup`) runs here too: it only calls LLM
 * Wiki's own routes/actions and the host routine API, and skips what is done.
 */
import { memoryStatus, WIKI_PLUGIN, WIKI_ROUTINES, wikiSnapshotFrom, type MemorySetupParams, type WikiSnapshot } from "../memory.js";
import type { LiveResult } from "./api.js";

const enc = encodeURIComponent;
const WIKI = `/api/plugins/${enc(WIKI_PLUGIN)}`;

async function request(url: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, {
    credentials: "include",
    ...init,
    headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const text = record.error ?? record.message;
    throw Object.assign(new Error(typeof text === "string" && text ? text : `Request failed (${res.status})`), { status: res.status });
  }
  return body;
}

const post = (url: string, body: unknown) => request(url, { method: "POST", body: JSON.stringify(body) });
const patch = (url: string, body: unknown) => request(url, { method: "PATCH", body: JSON.stringify(body) });

async function wikiAction(companyId: string, key: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return post(`${WIKI}/actions/${enc(key)}`, { companyId, params: { ...params, companyId } });
}

/** LLM Wiki's view: `settings` data (with routines and agent options), else `/overview`. */
async function readWiki(companyId: string): Promise<unknown> {
  try {
    return await post(`${WIKI}/data/settings`, { companyId, params: { companyId } });
  } catch (settingsError) {
    try {
      return await request(`${WIKI}/api/overview?companyId=${enc(companyId)}`);
    } catch {
      throw settingsError;
    }
  }
}

export async function fetchWikiSnapshot(companyId: string): Promise<{ ok: true; snapshot: WikiSnapshot } | { ok: false; reason: string }> {
  const [wiki, agents, routines] = await Promise.allSettled([
    readWiki(companyId),
    request(`/api/companies/${enc(companyId)}/agents`),
    request(`/api/companies/${enc(companyId)}/routines`),
  ]);
  if (wiki.status === "rejected") {
    const error = wiki.reason as Error & { status?: number };
    const reason = error?.status === 404
      ? "LLM Wiki did not answer the check. Upgrade or enable it, then check again."
      : `Could not read LLM Wiki: ${error?.message ?? "unknown error"}.`;
    return { ok: false, reason };
  }
  return {
    ok: true,
    snapshot: wikiSnapshotFrom({
      companyId,
      wiki: wiki.value,
      agents: agents.status === "fulfilled" ? agents.value : null,
      routines: routines.status === "fulfilled" ? routines.value : null,
    }),
  };
}

/** Live check for Company wiki; `report` sends the snapshot to the Setup worker (Finish setup issue). */
export async function fetchMemoryLive(companyId: string, report?: (snapshot: WikiSnapshot) => Promise<unknown>): Promise<LiveResult> {
  const result = await fetchWikiSnapshot(companyId);
  if (!result.ok) return result;
  if (report) {
    // Best effort: the page still shows the live checklist if storing fails.
    await report(result.snapshot).catch(() => undefined);
  }
  return { ok: true, status: memoryStatus(result.snapshot) };
}

interface RoutineRow {
  id: string;
  status: string | null;
  triggers: Array<{ id: string; enabled: boolean; archived: boolean }>;
}

/** The company's LLM Wiki routines by routine key. */
async function wikiRoutines(companyId: string): Promise<Map<string, RoutineRow>> {
  const body = await request(`/api/companies/${enc(companyId)}/routines`);
  const rows = Array.isArray(body) ? body : Array.isArray((body as { data?: unknown })?.data) ? (body as { data: unknown[] }).data : [];
  const out = new Map<string, RoutineRow>();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== "string") continue;
    const managed = row.managedByPlugin && typeof row.managedByPlugin === "object" ? (row.managedByPlugin as Record<string, unknown>) : null;
    const key = managed?.pluginKey === WIKI_PLUGIN
      ? String(managed.resourceKey)
      : WIKI_ROUTINES.find((routine) => routine.title === row.title)?.key;
    if (!key || (out.has(key) && managed?.pluginKey !== WIKI_PLUGIN)) continue;
    const triggers = Array.isArray(row.triggers)
      ? row.triggers
        .filter((t): t is Record<string, unknown> => !!t && typeof t === "object" && typeof (t as Record<string, unknown>).id === "string")
        .map((t) => ({ id: t.id as string, enabled: t.enabled === true, archived: t.archived === true }))
      : [];
    out.set(key, { id: row.id, status: typeof row.status === "string" ? row.status : null, triggers });
  }
  return out;
}

/**
 * "Do it for me" for Company wiki. Runs only what `params` asks for, in
 * order: wiki folder (bootstrap also creates the Maintainer, project and
 * skills) → routines (create missing, set active, switch schedules on) →
 * event ingestion. Returns what it did.
 */
export async function runMemorySetup(companyId: string, params: MemorySetupParams): Promise<string[]> {
  const done: string[] = [];
  if (params.folderPath) {
    await post(`${WIKI}/api/bootstrap`, { companyId, path: params.folderPath });
    done.push(`Wiki folder set to ${params.folderPath}`);
  }
  if (params.routines) {
    let routines = await wikiRoutines(companyId);
    if (WIKI_ROUTINES.some((routine) => !routines.has(routine.key))) {
      await wikiAction(companyId, "reconcile-managed-routines");
      routines = await wikiRoutines(companyId);
      done.push("Created the wiki routines");
    }
    let changed = 0;
    for (const { key } of WIKI_ROUTINES) {
      const routine = routines.get(key);
      if (!routine) continue;
      if (routine.status !== "active") {
        await patch(`/api/routines/${enc(routine.id)}`, { status: "active" });
        changed += 1;
      }
      for (const trigger of routine.triggers) {
        if (trigger.enabled || trigger.archived) continue;
        await patch(`/api/routine-triggers/${enc(trigger.id)}`, { enabled: true });
        changed += 1;
      }
    }
    if (changed) done.push("Turned the wiki routines and their schedules on");
  }
  if (params.ingestion) {
    await wikiAction(companyId, "update-event-ingestion-settings", { enabled: true, sources: { issues: true, comments: true, documents: true } });
    done.push("Turned on distilling of issues, comments and documents");
  }
  return done;
}
