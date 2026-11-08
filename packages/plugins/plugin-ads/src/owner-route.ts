/** Determines whether the owner's delegate (the company's Account Manager agent) can approve a proposal, or if the owner must. */
import { teamAgentId, type TeamRoleKey } from "@partnersinbiz/pib-plugin-kit";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { daysBetween } from "./dates.js";
import type { ApprovalRow, ProposalRow, ScopeRow } from "./db.js";
import type { ProposalKind } from "./platforms.js";

/** The team role whose agent may approve, as the owner's delegate, a proposal within the owner threshold. */
export const OWNER_DELEGATE_ROLE: TeamRoleKey = "account-manager";

/** The running Account Manager agent, or null (then only the owner, a person, can approve). */
export async function ownerDelegateAgentId(ctx: PluginContext, companyId: string): Promise<string | null> {
  return await teamAgentId(ctx, companyId, OWNER_DELEGATE_ROLE);
}

export const DEFAULT_OWNER_THRESHOLD_MINOR = 50_000;

export interface OwnerRoute {
  route: "delegate" | "owner_required";
  lifetimeMinor: number | null;
  thresholdMinor: number;
}

/** The owner threshold for a scope: explicit value, or 50_000 for ZAR, otherwise 0 (fail closed). */
export function ownerThresholdMinor(scope: Pick<ScopeRow, "currency" | "owner_threshold_minor">): number {
  if (scope.owner_threshold_minor !== null && scope.owner_threshold_minor !== undefined) {
    return scope.owner_threshold_minor;
  }
  return scope.currency === "ZAR" ? DEFAULT_OWNER_THRESHOLD_MINOR : 0;
}

/** Lifetime budget for a proposal, null when unbounded. */
export function lifetimeBudgetMinor(p: Pick<ProposalRow, "kind" | "payload" | "impact">): number | null {
  const x = p.payload;
  const impact = p.impact;

  // pause_campaign and creative_check always cost 0
  if (p.kind === "pause_campaign" || p.kind === "creative_check") {
    return 0;
  }

  // change_budget and resume_campaign use addedThisMonthMinor from impact
  if (p.kind === "change_budget" || p.kind === "resume_campaign") {
    const added = (impact as Record<string, unknown>).addedThisMonthMinor;
    if (typeof added === "number" && Number.isFinite(added) && added >= 0) {
      return added;
    }
    return null;
  }

  // create_campaign: sum campaign daily budget + all ad sets' budgets
  if (p.kind === "create_campaign") {
    const dailyBudgetMinor = typeof x.dailyBudgetMinor === "number" ? x.dailyBudgetMinor : 0;
    const startDate = typeof x.startDate === "string" ? x.startDate : null;
    const endDate = typeof x.endDate === "string" ? x.endDate : null;

    // If either date is invalid or missing with a daily budget, return null (unbounded)
    if (dailyBudgetMinor > 0 && (!startDate || !endDate)) {
      return null;
    }

    let campaignTotal = 0;
    if (dailyBudgetMinor > 0 && startDate && endDate) {
      const days = daysBetween(startDate, endDate) + 1;
      if (days <= 0) return null;
      campaignTotal = dailyBudgetMinor * days;
    }

    // Sum ad sets
    const adSets = x.adSets as Array<{ dailyBudgetMinor?: number; startDate?: string; endDate?: string }> | undefined;
    let adSetsTotal = 0;
    if (Array.isArray(adSets)) {
      for (const adSet of adSets) {
        const adSetDaily = typeof adSet.dailyBudgetMinor === "number" ? adSet.dailyBudgetMinor : 0;
        const adSetStart = typeof adSet.startDate === "string" ? adSet.startDate : startDate;
        const adSetEnd = typeof adSet.endDate === "string" ? adSet.endDate : endDate;

        if (adSetDaily === 0) {
          adSetsTotal += 0;
        } else if (!adSetStart || !adSetEnd) {
          return null;
        } else {
          const days = daysBetween(adSetStart, adSetEnd) + 1;
          if (days <= 0) return null;
          adSetsTotal += adSetDaily * days;
        }
      }
    }

    return campaignTotal + adSetsTotal;
  }

  return null;
}

/**
 * Kinds that can raise spend: only the owner (Peet, a person) approves them, whatever the amount or currency (PAR-6684). Pause and a true budget
 * decrease keep the role route. A kind here that is also in SPEND_KINDS needs a branch in `assertPlatformCapsFor` (PAR-3765).
 */
export const SPEND_RAISING_KINDS: readonly ProposalKind[] = ["create_campaign", "create_ad_set", "resume_campaign", "change_budget", "create_ad_group", "add_keywords", "create_responsive_search_ad", "create_ad"];

/** Kinds that create something on the platform: always created PAUSED. */
export const CREATE_KINDS: readonly ProposalKind[] = ["create_campaign", "create_ad_set", "create_ad_creative", "create_ad", "create_ad_group", "add_keywords", "create_responsive_search_ad"];

/**
 * Whether a proposal can raise spend. change_budget is a decrease only when the new and the current daily budget are both numbers and new < current;
 * a missing value on either side counts as spend-raising (fail closed). `currentDailyBudgetMinor` overrides the payload's copy (a fresh campaigns read).
 */
export function isSpendRaising(p: Pick<ProposalRow, "kind" | "payload">, currentDailyBudgetMinor?: number | null): boolean {
  if (!SPEND_RAISING_KINDS.includes(p.kind)) return false;
  if (p.kind !== "change_budget") return true;
  const next = p.payload.newDailyBudgetMinor;
  const current = currentDailyBudgetMinor !== undefined ? currentDailyBudgetMinor : p.payload.currentDailyBudgetMinor;
  const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  return !(isNum(next) && isNum(current) && next < current);
}

/** A create payload that asks for anything but PAUSED (e.g. ACTIVE): refused at proposal time and at run time. */
export function asksForActive(p: Pick<ProposalRow, "kind" | "payload">): boolean {
  return CREATE_KINDS.includes(p.kind) && p.payload.status !== undefined && p.payload.status !== null && p.payload.status !== "PAUSED";
}

/** Determine if the owner's delegate can approve (within threshold) or if the owner is required, from a spend amount. A spend-raising kind is always owner_required. */
export function routeForSpend(scope: Pick<ScopeRow, "currency" | "owner_threshold_minor">, lifetimeMinor: number | null, spendRaising = false): OwnerRoute {
  const threshold = ownerThresholdMinor(scope);
  const route: OwnerRoute["route"] = spendRaising || lifetimeMinor === null || lifetimeMinor > threshold ? "owner_required" : "delegate";
  return {
    route,
    lifetimeMinor,
    thresholdMinor: threshold,
  };
}

/** Determine if the owner's delegate can approve (within threshold) or if the owner is required. */
export function ownerRouteOf(scope: Pick<ScopeRow, "currency" | "owner_threshold_minor">, p: Pick<ProposalRow, "kind" | "payload" | "impact">, currentDailyBudgetMinor?: number | null): OwnerRoute {
  const lifetime = lifetimeBudgetMinor(p);
  return routeForSpend(scope, lifetime, isSpendRaising(p, currentDailyBudgetMinor));
}

/** Route codes stored in a proposal's impact before 0.3.9 (named the person); they read as the role-based codes. */
const LEGACY_ROUTES: Record<string, OwnerRoute["route"]> = { elon: "delegate", peet_required: "owner_required" };

/** Extract owner route from proposal impact object. A row stored with a pre-0.3.9 code reads as its role-based equivalent. */
export function routeFromImpact(impact: Record<string, unknown>): OwnerRoute | null {
  const route = impact.ownerRoute as (Omit<OwnerRoute, "route"> & { route?: string }) | undefined;
  if (!route || typeof route.route !== "string") return null;
  const code = LEGACY_ROUTES[route.route] ?? route.route;
  return code === "delegate" || code === "owner_required" ? { ...route, route: code } : null;
}

/** An owner-delegate approval (within threshold): the current Account Manager agent's yes as owner, no cap override. No delegate (null) means none counts. */
export function isOwnerDelegateApproval(a: Pick<ApprovalRow, "decided_by" | "role" | "decision" | "over_cap_ack">, delegateAgentId: string | null): boolean {
  return (
    delegateAgentId !== null &&
    a.decided_by === `agent:${delegateAgentId}` &&
    a.role === "owner" &&
    a.decision === "approved" &&
    !a.over_cap_ack
  );
}
