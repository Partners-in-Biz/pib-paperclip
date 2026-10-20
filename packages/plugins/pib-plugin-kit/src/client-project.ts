/**
 * Which Paperclip project a client's work belongs in (Q1a-12).
 *
 * The gap. Social opened every client issue in its own shared Social project
 * (9 call sites) and Campaigns passed no project at all; only SEO routed to a
 * client project, and it did that by matching project names, not from the CRM's
 * `client_projects` link (27 rows exist). Client work belongs in the client's own
 * Paperclip project and client scope, never mixed into PiB's own.
 *
 * The cleanest supported way: a CRM projection, like `site.upserted`. A plugin
 * cannot read another plugin's tables, so the CRM publishes each client's link
 * list as an event and every consumer keeps a copy in plugin state (no
 * migration). `client.projects.updated` carries the FULL, authoritative list of
 * project ids for one client, newest wins, so a missed unlink heals on the next
 * hourly re-send and an unlink is just a shorter list.
 *
 * Contract for the CRM (the CRM builder implements it; nothing here needs the
 * CRM to change to compile):
 * - emit `client.projects.updated` with `ClientProjectsEvent` after
 *   `link-client-project` and `unlink-client-project` (the client's full list
 *   after the change, `[]` after the last unlink);
 * - re-emit the list of EVERY client that has links in the hourly job that
 *   re-emits sites, and from the `resync` action;
 * - send ids only (no names or repo urls).
 *
 * Consumers call `registerClientProjectWatch(ctx)` once in `setup`, then
 * `resolveClientProjectId` wherever they open a client's issue.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { formatClientParam, type ClientKind, type ClientScope } from "./client-ref.js";
import { stampMs } from "./cockpit.js";
import { CRM_PLUGIN_ID } from "./crm-projection.js";

export const CLIENT_PROJECT_EVENTS = {
  /** CRM -> every plugin. Payload: `ClientProjectsEvent`. */
  updated: "client.projects.updated",
} as const;

/** One client's complete list of linked projects. */
export interface ClientProjectsEvent {
  clientKind: ClientKind;
  clientRef: string;
  /** Every Paperclip project linked to the client, oldest link first. Empty after the last unlink. (Legacy: project ids only, kinds unknown.) */
  projectIds?: string[];
  /** Every Paperclip project linked to the client, oldest link first, each with its CRM-owned kind (or null if kind unknown). (New payload.) */
  projects?: Array<{ projectId: string; kind: string | null }>;
  updatedAt: string;
}

/** A single client-to-project link. */
export interface ClientProjectLink {
  projectId: string;
  kind: string | null;
}

interface StoredClientProjects {
  projectIds: string[];
  projects?: ClientProjectLink[];
  updatedAt: string;
}

const clientProjectsState = (companyId: string, scope: { kind: ClientKind; id: string }) => ({
  scopeKind: "company" as const,
  scopeId: companyId,
  namespace: "pib-kit",
  stateKey: `client-projects:${formatClientParam(scope)}`,
});

/** Stores one client's list; an older event than the stored one is ignored. Returns whether it stored. */
export async function rememberClientProjects(ctx: PluginContext, companyId: string, event: ClientProjectsEvent): Promise<boolean> {
  if ((event.clientKind !== "company" && event.clientKind !== "contact") || !event.clientRef) return false;
  // Accept either legacy projectIds or new projects format
  if (!Array.isArray(event.projectIds) && !Array.isArray(event.projects)) return false;

  const key = clientProjectsState(companyId, { kind: event.clientKind, id: event.clientRef });
  const current = (await ctx.state.get(key)) as StoredClientProjects | null;
  const have = stampMs(current?.updatedAt);
  const next = stampMs(event.updatedAt);
  // Reject if stored updatedAt is strictly newer than incoming; equal updatedAt from a later arrival overwrites.
  if (Number.isFinite(have) && Number.isFinite(next) && have > next) return false;

  // Normalize projects: filter and normalize kinds
  const normalized: ClientProjectLink[] = [];
  const seen = new Set<string>();

  if (Array.isArray(event.projects)) {
    for (const p of event.projects) {
      if (typeof p === "object" && p !== null && typeof p.projectId === "string" && p.projectId.length > 0 && !seen.has(p.projectId)) {
        const kind = typeof p.kind === "string" ? p.kind.trim() || null : null;
        normalized.push({ projectId: p.projectId, kind });
        seen.add(p.projectId);
      }
    }
  } else if (Array.isArray(event.projectIds)) {
    // Legacy: filter valid ids, no projects key
    for (const id of event.projectIds) {
      if (typeof id === "string" && id.length > 0 && !seen.has(id)) {
        normalized.push({ projectId: id, kind: null });
        seen.add(id);
      }
    }
  }

  const stored: StoredClientProjects = {
    projectIds: normalized.map((l) => l.projectId),
    updatedAt: event.updatedAt,
  };

  // Only include projects if the event provided the new format
  if (Array.isArray(event.projects)) {
    stored.projects = normalized;
  }

  await ctx.state.set(key, stored);
  return true;
}

/** Keeps a copy of the CRM's client-to-project links (call once in `setup`). */
export function registerClientProjectWatch(ctx: PluginContext): void {
  ctx.events.on(`plugin.${CRM_PLUGIN_ID}.${CLIENT_PROJECT_EVENTS.updated}`, async (event: PluginEvent) => {
    const payload = event.payload as Partial<ClientProjectsEvent> | undefined;
    if (!event.companyId || !payload) return;
    try {
      await rememberClientProjects(ctx, event.companyId, payload as ClientProjectsEvent);
    } catch (error) {
      ctx.logger.info("Client project link update failed", { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

/** The project links the CRM linked to the client, with their kinds (empty for own work or an unlinked client). */
export async function clientProjectLinks(ctx: PluginContext, companyId: string, scope: ClientScope): Promise<ClientProjectLink[]> {
  if (!scope) return [];
  try {
    const stored = (await ctx.state.get(clientProjectsState(companyId, scope))) as StoredClientProjects | null;
    if (!stored) return [];

    // If stored has the new projects format, use it (re-normalize defensively)
    if (Array.isArray(stored.projects)) {
      const normalized: ClientProjectLink[] = [];
      const seen = new Set<string>();
      for (const p of stored.projects) {
        if (typeof p === "object" && p !== null && typeof p.projectId === "string" && p.projectId.length > 0 && !seen.has(p.projectId)) {
          normalized.push({ projectId: p.projectId, kind: typeof p.kind === "string" && p.kind.length > 0 ? p.kind : null });
          seen.add(p.projectId);
        }
      }
      return normalized;
    }

    // Fall back to legacy: map projectIds to links with kind null
    if (Array.isArray(stored.projectIds)) {
      return stored.projectIds
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .map((projectId) => ({ projectId, kind: null }));
    }

    return [];
  } catch {
    return [];
  }
}

/** The project ids the CRM linked to the client (empty for own work or an unlinked client). */
export async function clientProjectIds(ctx: PluginContext, companyId: string, scope: ClientScope): Promise<string[]> {
  const links = await clientProjectLinks(ctx, companyId, scope);
  return links.map((l) => l.projectId);
}

export interface ClientProjectChoice {
  projectId: string | null;
  /** `client-link`: the client's own project from the CRM; `fallback`: the plugin's own project, because the client has none linked; `own`: own work, so the plugin's own project; `none`: no project at all. */
  source: "client-link" | "fallback" | "own" | "none";
  /** The kind of the chosen link (null for fallback/own/none, or when the link's kind is unknown). */
  kind: string | null;
  /** Every project the CRM linked to the client. */
  linked: string[];
}

/**
 * The project to open a piece of work in. Own work (`scope` null) takes
 * `fallbackProjectId`, the plugin's own managed project. A client with a linked
 * project gets it (the first, when several; pass `pick` to choose). When `kind`
 * is specified, selection proceeds in steps:
 * - Step 1: Exact match on the requested kind.
 * - Step 2: If no step 1 match and kind != "platform", fall through to "platform" kind.
 * - Step 3: If no steps 1–2 match, use any legacy link with kind=null (for backward compatibility).
 * - Step 4: Fall back to fallbackProjectId.
 * A client with no suitable link gets the fallback, never another client's.
 * Linked projects that no longer exist or are archived are skipped when the plugin
 * may read projects (`projects.read`); without that capability the link is trusted.
 */
export async function resolveClientProjectId(
  ctx: PluginContext,
  companyId: string,
  scope: ClientScope,
  options: { fallbackProjectId?: string | null; pick?: (projectIds: string[]) => string | null; verify?: boolean; kind?: string } = {},
): Promise<ClientProjectChoice> {
  const fallback = options.fallbackProjectId ?? null;
  if (!scope) return { projectId: fallback, source: fallback ? "own" : "none", kind: null, linked: [] };

  const links = await clientProjectLinks(ctx, companyId, scope);
  const linkedIds = links.map((l) => l.projectId);

  // Helper: check if a project is usable (exists, not archived)
  const isUsable = (() => {
    const cache = new Map<string, boolean>();
    return async (id: string): Promise<boolean> => {
      if (cache.has(id)) return cache.get(id)!;
      let result = true; // default: trust the link
      if (options.verify !== false) {
        try {
          const project = (await ctx.projects.get(id, companyId)) as { archivedAt?: unknown } | null;
          // usable only if project exists and is not archived
          result = !!(project && !project.archivedAt);
        } catch {
          result = true; // on error (projects.read not granted), trust the link
        }
      }
      cache.set(id, result);
      return result;
    };
  })();

  // Normalize kind parameter
  const requestedKind = options.kind ? options.kind.trim() : undefined;

  // If no kind requested, use the old behavior (first linked, usable)
  if (!requestedKind) {
    const usable: string[] = [];
    for (const id of linkedIds) {
      if (await isUsable(id)) usable.push(id);
    }
    const chosen = usable.length > 0 ? (options.pick ? options.pick(usable) : usable[0]!) : null;
    if (chosen) {
      const chosenLink = links.find((l) => l.projectId === chosen);
      return { projectId: chosen, source: "client-link", kind: chosenLink?.kind ?? null, linked: linkedIds };
    }
    return { projectId: fallback, source: fallback ? "fallback" : "none", kind: null, linked: linkedIds };
  }

  // Kind was requested. Step 1: Try exact match with requested kind
  const step1Candidates: Array<{ projectId: string; kind: string | null }> = [];
  for (const link of links) {
    if (link.kind === requestedKind) {
      if (await isUsable(link.projectId)) {
        step1Candidates.push(link);
      }
    }
  }

  if (step1Candidates.length > 0) {
    const ids = step1Candidates.map((l) => l.projectId);
    const chosen = options.pick ? options.pick(ids) : ids[0];
    if (chosen) {
      const chosenLink = step1Candidates.find((l) => l.projectId === chosen);
      return { projectId: chosen, source: "client-link", kind: chosenLink?.kind ?? null, linked: linkedIds };
    }
  }

  // Step 2: If no step 1 match and requested kind is not "platform", try "platform"
  if (requestedKind !== "platform") {
    const step2Candidates: Array<{ projectId: string; kind: string | null }> = [];
    for (const link of links) {
      if (link.kind === "platform") {
        if (await isUsable(link.projectId)) {
          step2Candidates.push(link);
        }
      }
    }

    if (step2Candidates.length > 0) {
      const ids = step2Candidates.map((l) => l.projectId);
      const chosen = options.pick ? options.pick(ids) : ids[0];
      if (chosen) {
        const chosenLink = step2Candidates.find((l) => l.projectId === chosen);
        return { projectId: chosen, source: "client-link", kind: chosenLink?.kind ?? null, linked: linkedIds };
      }
    }
  }

  // Step 3: If no step 1 or 2 match, try legacy data (kind=null) for backward compatibility
  const step3Candidates: Array<{ projectId: string; kind: string | null }> = [];
  for (const link of links) {
    if (link.kind === null) {
      if (await isUsable(link.projectId)) {
        step3Candidates.push(link);
      }
    }
  }

  if (step3Candidates.length > 0) {
    const ids = step3Candidates.map((l) => l.projectId);
    const chosen = options.pick ? options.pick(ids) : ids[0];
    if (chosen) {
      return { projectId: chosen, source: "client-link", kind: null, linked: linkedIds };
    }
  }

  // Step 4: Fall back to the plugin's own project
  return { projectId: fallback, source: fallback ? "fallback" : "none", kind: null, linked: linkedIds };
}
