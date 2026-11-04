/** What the page and the tools share: who is asking, and the usage and cap views. */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { formatClientParam, listCrmClients, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { listAssets } from "./assets.js";
import { capCheck, capHistory, currentPeriod, listCaps, usage } from "./ledger.js";

const LOCAL_BOARD = "local-board";

/** Caps spend real money, so this is stricter than Studio's other actions: an owner, not an admin or an agent. */
export async function isCompanyOwner(ctx: PluginContext, companyId: string, actor: { type?: string | null; userId?: string | null }): Promise<boolean> {
  if (actor.type !== "user" || !actor.userId) return false;
  if (actor.userId === LOCAL_BOARD) return true;
  const members = await ctx.access.members.list({ companyId });
  return members.some((m) => m.principalType === "user" && m.principalId === actor.userId && m.status === "active" && m.membershipRole === "owner");
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
  const [caps, history, clients, assets, companyUsed] = await Promise.all([
    listCaps(ctx, companyId),
    capHistory(ctx, companyId),
    listCrmClients(ctx, ctx.db.namespace, companyId).catch(() => []),
    listAssets(ctx, companyId, { limit: 24 }),
    usage(ctx, companyId, period),
  ]);
  const clientUsage = await Promise.all(
    caps
      .filter((c) => c.scopeKey.includes(":"))
      .map(async (c) => {
        const [kind, id] = c.scopeKey.split(":") as ["company" | "contact", string];
        return { scopeKey: c.scopeKey, used: await usage(ctx, companyId, period, { kind, id }) };
      }),
  );
  return {
    period,
    companyUsed,
    caps,
    clientUsage,
    history,
    assets,
    clients: clients.map((c) => ({ scopeKey: formatClientParam({ kind: c.kind, id: c.id }), name: c.name })),
  };
}
