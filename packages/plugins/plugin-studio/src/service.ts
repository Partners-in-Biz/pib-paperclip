/** What the page and the tools share: who is asking, and the usage and cap views. */
import { balanceView } from "./balance.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { formatClientParam, listCrmClients, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { listAssets } from "./assets.js";
import { capCheck, capHistory, currentPeriod, isAgentLimitKey, listCaps, usage } from "./ledger.js";
import { StudioConfig } from "./config.js";
import { providerStatus } from "./providers/registry.js";
import { PAGE_MODELS, UNAVAILABLE_MODELS } from "./page.js";

const LOCAL_BOARD = "local-board";

type Actor = { type?: string | null; userId?: string | null };

/** A person's role in the company, or null for agents, outsiders and inactive members. The local board is an owner. */
export async function memberRole(ctx: PluginContext, companyId: string, actor: Actor): Promise<string | null> {
  if (actor.type !== "user" || !actor.userId) return null;
  if (actor.userId === LOCAL_BOARD) return "owner";
  const members = await ctx.access.members.list({ companyId });
  const member = members.find((m) => m.principalType === "user" && m.principalId === actor.userId && m.status === "active");
  return member ? (member.membershipRole ?? "member") : null;
}

/** Caps spend real money, so this is stricter than Studio's other actions: an owner, not an admin or an agent. */
export async function isCompanyOwner(ctx: PluginContext, companyId: string, actor: Actor): Promise<boolean> {
  return (await memberRole(ctx, companyId, actor)) === "owner";
}

/** Agent limits spend real money too: an owner or an admin. */
export async function isOwnerOrAdmin(ctx: PluginContext, companyId: string, actor: Actor): Promise<boolean> {
  const role = await memberRole(ctx, companyId, actor);
  return role === "owner" || role === "admin";
}

/** Generating spends credits: any active member but a viewer. */
export function canGenerate(role: string | null): boolean {
  return role !== null && role !== "viewer";
}

export async function usageView(ctx: PluginContext, companyId: string, scope: ClientScope) {
  const period = currentPeriod();
  const check = await capCheck(ctx, companyId, scope, period);
  return {
    period,
    monthlyCap: check.cap.monthlyCredits,
    capSource: check.cap.source,
    measuredOn: check.cap.measuredOn,
    usedThisMonth: check.used,
    remaining: check.remaining,
    generationOff: check.cap.monthlyCredits === null || check.cap.monthlyCredits === 0,
  };
}

/** The Studio page's data. The host checks the caller's company access (see worker.ts); the owner check is on the write action. */
export async function overview(ctx: PluginContext, companyId: string) {
  const period = currentPeriod();
  const [caps, history, clients, assets, companyUsed, projects, agents, balance, providers] = await Promise.all([
    listCaps(ctx, companyId),
    capHistory(ctx, companyId),
    listCrmClients(ctx, ctx.db.namespace, companyId).catch(() => []),
    listAssets(ctx, companyId, { limit: 24 }),
    usage(ctx, companyId, period),
    ctx.projects.list({ companyId, limit: 200 }).catch(() => []),
    ctx.agents.list({ companyId, limit: 500 }).catch(() => []),
    balanceView(ctx, companyId).catch(() => null),
    providerStatus(new StudioConfig(ctx, companyId)).catch(() => []),
  ]);
  const clientUsage = await Promise.all(
    caps
      .filter((c) => c.scopeKey.includes(":") && !isAgentLimitKey(c.scopeKey))
      .map(async (c) => {
        const [kind, id] = c.scopeKey.split(":") as ["company" | "contact", string];
        return { scopeKey: c.scopeKey, used: await usage(ctx, companyId, period, { kind, id }) };
      }),
  );
  return {
    period,
    companyUsed,
    balance,
    providers,
    caps,
    clientUsage,
    history,
    assets,
    clients: clients.map((c) => ({ scopeKey: formatClientParam({ kind: c.kind, id: c.id }), name: c.name })),
    projects: projects.map((p) => ({ id: String(p.id), name: String((p as { name?: string | null }).name ?? p.id) })),
    agents: (agents as unknown as Array<{ id: string; name?: string | null; title?: string | null; status?: string }>)
      .filter((a) => a.status !== "terminated")
      .map((a) => ({ id: String(a.id), name: String(a.name ?? a.id), title: a.title ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    models: PAGE_MODELS,
    unavailableModels: UNAVAILABLE_MODELS,
  };
}
