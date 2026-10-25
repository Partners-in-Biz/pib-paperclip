/**
 * Entitlements: what a company bought. Pure helpers shared by the worker and
 * the page. No node imports (the UI bundle uses this file).
 */
import { MODULE_KEYS, TIER_MODULES, type ModuleKey } from "./kit-setup.js";

export const PLANS = ["starter", "growth", "business", "pib"] as const;
export type Plan = (typeof PLANS)[number];

export type EntitlementState = "entitled" | "trial" | "off";
export const ENTITLEMENT_STATES: readonly EntitlementState[] = ["entitled", "trial", "off"];

export interface EntitlementRow {
  companyId: string;
  module: ModuleKey;
  state: EntitlementState;
  plan: string | null;
  until: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

/** Always entitled: the platform, not sold. */
export const PLATFORM_MODULES: readonly ModuleKey[] = ["cockpit", "memory"];

/** The sellable modules a plan entitles, plus the platform modules. `pib` is everything (our own companies). */
export function planModules(plan: Plan): ModuleKey[] {
  if (plan === "pib") return [...MODULE_KEYS];
  return [...TIER_MODULES[plan], ...PLATFORM_MODULES];
}

export function isPlan(value: unknown): value is Plan {
  return typeof value === "string" && (PLANS as readonly string[]).includes(value);
}

/**
 * Which modules the company may use now. A module with no row is not entitled,
 * except Cockpit (always) and the Company wiki (by default, unless a row says off).
 * A trial counts until its `until` time.
 */
export function entitledModules(rows: readonly Pick<EntitlementRow, "module" | "state" | "until">[], now: Date): Record<ModuleKey, boolean> {
  const result = Object.fromEntries(MODULE_KEYS.map((key) => [key, false])) as Record<ModuleKey, boolean>;
  result.memory = true;
  for (const row of rows) {
    if (row.state === "entitled") result[row.module] = true;
    else if (row.state === "trial") result[row.module] = !row.until || new Date(row.until).getTime() > now.getTime();
    else result[row.module] = false;
  }
  result.cockpit = true;
  return result;
}

/**
 * Why a change to the operator company's own entitlements is refused, or null. It stays on `pib`:
 * every module entitled, so a mistaken target can never switch Partners in Biz itself off.
 */
export function operatorDowngrade(plan: unknown, modules: unknown): string | null {
  const refusal = "The operator company stays on the pib plan with every module entitled; it cannot be downgraded";
  if (plan !== undefined && plan !== null && plan !== "pib") return refusal;
  if (modules && typeof modules === "object" && !Array.isArray(modules) && Object.values(modules).some((state) => state !== "entitled")) return refusal;
  return null;
}
