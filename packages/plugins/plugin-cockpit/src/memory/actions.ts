/**
 * Page actions for the Cockpit's Memory tab (board users).
 */
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { isMemoryArea, MEMORY_AREAS, MEMORY_KINDS, MEMORY_LIMITS } from "@partnersinbiz/pib-plugin-kit";
import { parseClientParam } from "@partnersinbiz/pib-plugin-kit/client-ref";
import { assignableUser } from "../constants.js";
import { CockpitError, type Env } from "../env.js";
import { SELECTION, type FactStatus } from "./engine.js";
import { memoryJevConfig } from "./jev.js";
import { addFact, clientDirectory, exportMemory, feedback, importMemory, MemoryError, recall, review, uniqueClients, updateFact, type Actor } from "./service.js";
import * as store from "./store.js";

function companyOf(context: PluginPerformActionContext): string {
  if (!context.companyId) throw new CockpitError("Company is required");
  return context.companyId;
}

function userActor(context: PluginPerformActionContext): Actor {
  if (context.actor.type !== "user") throw new CockpitError("Only a board user can change company memory here");
  return { agentId: null, runId: null, userId: assignableUser(context.actor.userId ?? null) ?? context.actor.userId ?? null };
}

function str(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

async function wrap<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MemoryError) throw new CockpitError(error.message);
    throw error;
  }
}

export function registerMemoryActions(env: Env): void {
  const { ctx } = env;

  ctx.actions.register("memory.overview", async (_params, context) => {
    const companyId = companyOf(context);
    const [stats, briefs, jev, known, coverage] = await Promise.all([
      store.memoryStats(ctx, companyId),
      store.recentBriefs(ctx, companyId, 20),
      memoryJevConfig(ctx, companyId),
      clientDirectory(env, companyId),
      store.recallCoverage(ctx, companyId).catch(() => []),
    ]);
    // Every CRM client plus clients only memory knows, by name (so a fact can be added for a new client).
    const clients = uniqueClients(known).sort((a, b) => a.clientName.localeCompare(b.clientName)).slice(0, 500);
    return {
      stats,
      coverage,
      briefs: briefs.map((b) => ({
        id: b.id,
        issueId: b.issueId,
        issueIdentifier: b.issueIdentifier,
        agentId: b.agentId,
        query: b.query,
        method: b.method,
        facts: b.factIds.length,
        baseline: b.baselineIds.length,
        totalFacts: b.totalFacts,
        tokens: b.tokens,
        latencyMs: b.latencyMs,
        createdAt: b.createdAt,
      })),
      jevConfigured: Boolean(jev),
      clients,
      areas: MEMORY_AREAS,
      kinds: MEMORY_KINDS,
      limits: { ...MEMORY_LIMITS, scopeActiveCap: SELECTION.scopeActiveCap },
    };
  });

  ctx.actions.register("memory.list", async (params, context) => {
    const companyId = companyOf(context);
    const status = ["active", "superseded", "archived", "all"].includes(String(params.status)) ? (String(params.status) as FactStatus | "all") : "active";
    const client = str(params.client, 200);
    // One client known under several refs (the page shows it once): `clients: [ref, …]`.
    const clientRefs = Array.isArray(params.clients)
      ? [...new Set(params.clients.filter((ref): ref is string => typeof ref === "string" && !!parseClientParam(ref)))].slice(0, 20)
      : [];
    const result = await store.listFacts(ctx, companyId, {
      status,
      own: client === "own" && clientRefs.length === 0,
      clientRef: client && client !== "own" ? client : null,
      clientRefs: clientRefs.length ? clientRefs : null,
      area: isMemoryArea(params.area) ? params.area : null,
      q: str(params.q, 200),
      pinned: params.pinned === true,
      limit: typeof params.limit === "number" ? params.limit : 50,
      offset: typeof params.offset === "number" ? params.offset : 0,
    });
    return result;
  });

  ctx.actions.register("memory.brief", async (params, context) => {
    const companyId = companyOf(context);
    const id = str(params.id, 40);
    const brief = id ? await store.getBrief(ctx, companyId, id) : null;
    if (!brief) throw new CockpitError("Brief not found");
    const facts = await store.getFacts(ctx, companyId, [...new Set([...brief.factIds, ...brief.baselineIds])]);
    return { brief, facts };
  });

  ctx.actions.register("memory.preview", async (params, context) => {
    const companyId = companyOf(context);
    return wrap(() =>
      recall(env, companyId, { issueId: params.issueId, query: params.query, client: params.client, area: params.area }, { agentId: null, runId: null, userId: null }, { preview: true }),
    );
  });

  ctx.actions.register("memory.add", async (params, context) => {
    const companyId = companyOf(context);
    const actor = userActor(context);
    return wrap(() => addFact(env, companyId, params, actor, { origin: "person" }));
  });

  ctx.actions.register("memory.update", async (params, context) => {
    const companyId = companyOf(context);
    userActor(context);
    return wrap(() => updateFact(env, companyId, params));
  });

  ctx.actions.register("memory.feedback", async (params, context) => {
    const companyId = companyOf(context);
    const actor = userActor(context);
    return wrap(() => feedback(env, companyId, params, actor));
  });

  ctx.actions.register("memory.review", async (_params, context) => wrap(() => review(env, companyOf(context))));

  // Backup / restore (board users): a JSON file with every fact, and its import.
  ctx.actions.register("memory.export", async (_params, context) => {
    const companyId = companyOf(context);
    userActor(context);
    return wrap(() => exportMemory(env, companyId));
  });

  ctx.actions.register("memory.import", async (params, context) => {
    const companyId = companyOf(context);
    const actor = userActor(context);
    return wrap(() => importMemory(env, companyId, params.data, actor));
  });
}
