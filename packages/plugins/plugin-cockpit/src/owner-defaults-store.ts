import type { PluginContext } from "@paperclipai/plugin-sdk";
import { POLICY_CLASSES, type PolicyClass, type OwnerDefaultsPolicy, pinDeadline } from "./owner-defaults-model.js";

export const OWNER_DEFAULTS_STATE_KEY = "ownerDefaults";
export const DISABLED_POLICY: OwnerDefaultsPolicy = { enabled: false, name: "", rootIssueIds: [], classes: [], minHours: null };

const STATE_CONFIG = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "cockpit", stateKey: OWNER_DEFAULTS_STATE_KEY });

export function parseOwnerDefaults(payload: unknown): OwnerDefaultsPolicy {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return DISABLED_POLICY;
  const row = payload as Record<string, unknown>;
  const enabled = row.enabled === true;
  const name = typeof row.name === "string" ? row.name.trim().slice(0, 80) : "";
  const minHours = typeof row.minHours === "number" && Number.isFinite(row.minHours) && row.minHours > 0 ? row.minHours : null;
  const rootIds = new Set<string>();
  if (Array.isArray(row.rootIssueIds)) {
    for (const id of row.rootIssueIds) {
      if (typeof id === "string") {
        const trimmed = id.trim();
        if (trimmed && !/\s/.test(trimmed)) {
          rootIds.add(trimmed);
          if (rootIds.size >= 20) break;
        }
      }
    }
  }
  const classes: PolicyClass[] = [];
  const classSet = new Set<PolicyClass>();
  if (Array.isArray(row.classes)) {
    for (const cls of row.classes) {
      if (POLICY_CLASSES.includes(cls as PolicyClass) && !classSet.has(cls as PolicyClass)) {
        classes.push(cls as PolicyClass);
        classSet.add(cls as PolicyClass);
      }
    }
  }
  const finalEnabled = enabled && rootIds.size > 0 && classes.length > 0;
  return { enabled: finalEnabled, name: finalEnabled ? name : "", rootIssueIds: finalEnabled ? Array.from(rootIds) : [], classes: finalEnabled ? classes : [], minHours: finalEnabled ? minHours : null };
}
export async function readOwnerDefaults(ctx: Pick<PluginContext, "state">, companyId: string): Promise<OwnerDefaultsPolicy> {
  try { return parseOwnerDefaults(await ctx.state.get(STATE_CONFIG(companyId))); } catch { return DISABLED_POLICY; }
}
export async function writeOwnerDefaults(ctx: Pick<PluginContext, "state">, companyId: string, policy: OwnerDefaultsPolicy): Promise<OwnerDefaultsPolicy> {
  const normalized = parseOwnerDefaults(policy);
  await ctx.state.set(STATE_CONFIG(companyId), normalized);
  return normalized;
}
export async function pinAskDeadline(ctx: Pick<PluginContext, "state">, companyId: string, askKey: string, firstAskedAt: string, hours: number): Promise<string | null> {
  if (typeof askKey !== "string" || askKey.length === 0 || askKey.length > 200) return null;
  if (!firstAskedAt || Number.isNaN(Date.parse(firstAskedAt))) return null;
  const dc = { scopeKind: "company" as const, scopeId: companyId, namespace: "cockpit", stateKey: "ownerDefaultsDeadlines" };
  try {
    const dl = (await ctx.state.get(dc)) as Record<string, string | null> | null;
    const ex = dl?.[askKey];
    if (ex && !Number.isNaN(Date.parse(ex))) return ex;
    const nd = pinDeadline(null, firstAskedAt, hours);
    if (!nd) return null;
    const upd = { ...dl } as Record<string, string | null>;
    upd[askKey] = nd;
    if (Object.keys(upd).length > 500) {
      const kp = Object.entries(upd).filter(([, v]) => v !== null).sort(([, a], [, b]) => new Date(a!).getTime() - new Date(b!).getTime()).slice(Math.max(0, Object.keys(upd).length - 500));
      await ctx.state.set(dc, Object.fromEntries(kp));
      return nd;
    }
    await ctx.state.set(dc, upd);
    return nd;
  } catch {
    const nd = pinDeadline(null, firstAskedAt, hours);
    if (!nd) return null;
    await ctx.state.set(dc, { [askKey]: nd });
    return nd;
  }
}
