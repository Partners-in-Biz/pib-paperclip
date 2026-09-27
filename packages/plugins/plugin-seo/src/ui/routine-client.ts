/**
 * The SEO routines, browser side (no React here, so tests can import it).
 *
 * The worker cannot read a routine's triggers, and an active routine with
 * its trigger off never runs. The page runs as the signed-in board user, who
 * can: it reads each routine from the host (`GET /api/routines/:id`), reports
 * the trigger state to the worker (`seo.routine-report`, for the setup
 * checklist), and "Switch on" sets a routine active and its schedule trigger
 * on (`PATCH /api/routines/:id`, `PATCH /api/routine-triggers/:id`), the same
 * calls the Routines page makes.
 */

export interface RoutineTrigger {
  id: string;
  kind: string;
  enabled: boolean;
  archived: boolean;
}

export interface RoutineInfo {
  id: string;
  status: string;
  triggers: RoutineTrigger[];
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

/** The routine and its triggers from the host's routine detail. Pure. */
export function parseRoutine(body: unknown): RoutineInfo | null {
  if (!body || typeof body !== "object") return null;
  const r = body as Record<string, unknown>;
  if (typeof r.id !== "string") return null;
  const triggers = Array.isArray(r.triggers)
    ? r.triggers
        .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === "object" && typeof (t as Record<string, unknown>).id === "string")
        .map((t) => ({ id: String(t.id), kind: String(t.kind ?? ""), enabled: t.enabled === true, archived: t.archived === true }))
    : [];
  return { id: r.id, status: String(r.status ?? ""), triggers };
}

/** Schedule triggers that are not archived: all on, and at least one. Pure. */
export function scheduleOn(info: Pick<RoutineInfo, "triggers">): boolean {
  const live = info.triggers.filter((t) => t.kind === "schedule" && !t.archived);
  return live.length > 0 && live.every((t) => t.enabled);
}

/** The routine runs on its own: active, with its schedule on. Pure. */
export function routineRunning(info: RoutineInfo | null): boolean {
  return Boolean(info && info.status === "active" && scheduleOn(info));
}

export async function readRoutine(routineId: string): Promise<RoutineInfo | null> {
  return parseRoutine(await hostJson<unknown>(`/api/routines/${encodeURIComponent(routineId)}`));
}

/** Set the routine active and every schedule trigger that is off on. Returns the routine as it is now. */
export async function switchOnRoutine(info: RoutineInfo): Promise<RoutineInfo> {
  if (info.status !== "active") {
    await hostJson(`/api/routines/${encodeURIComponent(info.id)}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) });
  }
  for (const trigger of info.triggers) {
    if (trigger.kind !== "schedule" || trigger.archived || trigger.enabled) continue;
    await hostJson(`/api/routine-triggers/${encodeURIComponent(trigger.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
  }
  return (await readRoutine(info.id)) ?? info;
}

/** The report the worker stores (`seo.routine-report`). Pure. */
export function routineReportParams(info: RoutineInfo): Record<string, unknown> {
  return { routineId: info.id, status: info.status, triggers: info.triggers.map((t) => ({ id: t.id, kind: t.kind, enabled: t.enabled, archived: t.archived })) };
}
