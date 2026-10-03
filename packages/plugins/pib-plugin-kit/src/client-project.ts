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
  /** Every Paperclip project linked to the client, oldest link first. Empty after the last unlink. */
  projectIds: string[];
  updatedAt: string;
}

interface StoredClientProjects {
  projectIds: string[];
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
  if ((event.clientKind !== "company" && event.clientKind !== "contact") || !event.clientRef || !Array.isArray(event.projectIds)) return false;
  const key = clientProjectsState(companyId, { kind: event.clientKind, id: event.clientRef });
  const current = (await ctx.state.get(key)) as StoredClientProjects | null;
  const have = stampMs(current?.updatedAt);
  const next = stampMs(event.updatedAt);
  if (Number.isFinite(have) && Number.isFinite(next) && have > next) return false;
  await ctx.state.set(key, { projectIds: event.projectIds.filter((id) => typeof id === "string" && id), updatedAt: event.updatedAt });
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

/** The project ids the CRM linked to the client (empty for own work or an unlinked client). */
export async function clientProjectIds(ctx: PluginContext, companyId: string, scope: ClientScope): Promise<string[]> {
  if (!scope) return [];
  try {
    const stored = (await ctx.state.get(clientProjectsState(companyId, scope))) as StoredClientProjects | null;
    return Array.isArray(stored?.projectIds) ? stored.projectIds.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  } catch {
    return [];
  }
}

export interface ClientProjectChoice {
  projectId: string | null;
  /** `client-link`: the client's own project from the CRM; `fallback`: the plugin's own project, because the client has none linked; `own`: own work, so the plugin's own project; `none`: no project at all. */
  source: "client-link" | "fallback" | "own" | "none";
  /** Every project the CRM linked to the client. */
  linked: string[];
}

/**
 * The project to open a piece of work in. Own work (`scope` null) takes
 * `fallbackProjectId`, the plugin's own managed project. A client with a linked
 * project gets it (the first, when several; pass `pick` to choose); a client
 * with none gets the fallback, never another client's. Linked projects that no
 * longer exist or are archived are skipped when the plugin may read projects
 * (`projects.read`); without that capability the link is trusted.
 */
export async function resolveClientProjectId(
  ctx: PluginContext,
  companyId: string,
  scope: ClientScope,
  options: { fallbackProjectId?: string | null; pick?: (projectIds: string[]) => string | null; verify?: boolean } = {},
): Promise<ClientProjectChoice> {
  const fallback = options.fallbackProjectId ?? null;
  if (!scope) return { projectId: fallback, source: fallback ? "own" : "none", linked: [] };
  const linked = await clientProjectIds(ctx, companyId, scope);
  const usable: string[] = [];
  for (const id of linked) {
    if (options.verify === false) {
      usable.push(id);
      continue;
    }
    try {
      const project = (await ctx.projects.get(id, companyId)) as { archivedAt?: unknown } | null;
      if (project && !project.archivedAt) usable.push(id);
    } catch {
      usable.push(id);
    }
  }
  const chosen = usable.length > 0 ? (options.pick ? options.pick(usable) : usable[0]!) : null;
  if (chosen) return { projectId: chosen, source: "client-link", linked };
  return { projectId: fallback, source: fallback ? "fallback" : "none", linked };
}
