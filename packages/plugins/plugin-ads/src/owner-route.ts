/** Determines whether the owner's delegate (the company's Account Manager agent) can approve a proposal, or if the owner must. */
import { teamAgentId, type TeamRoleKey } from "@partnersinbiz/pib-plugin-kit";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { daysBetween } from "./dates.js";
import type { ApprovalRow, ProposalRow, ScopeRow } from "./db.js";

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

/** Determine if the owner's delegate can approve (within threshold) or if the owner is required, from a spend amount. */
export function routeForSpend(scope: Pick<ScopeRow, "currency" | "owner_threshold_minor">, lifetimeMinor: number | null): OwnerRoute {
  const threshold = ownerThresholdMinor(scope);
  const route: OwnerRoute["route"] = lifetimeMinor === null || lifetimeMinor > threshold ? "owner_required" : "delegate";
  return {
    route,
    lifetimeMinor,
    thresholdMinor: threshold,
  };
}

/** Determine if the owner's delegate can approve (within threshold) or if the owner is required. */
export function ownerRouteOf(scope: Pick<ScopeRow, "currency" | "owner_threshold_minor">, p: Pick<ProposalRow, "kind" | "payload" | "impact">): OwnerRoute {
  const lifetime = lifetimeBudgetMinor(p);
  return routeForSpend(scope, lifetime);
}

/** Extract owner route from proposal impact object. */
export function routeFromImpact(impact: Record<string, unknown>): OwnerRoute | null {
  const route = impact.ownerRoute as OwnerRoute | undefined;
  return route && (route.route === "delegate" || route.route === "owner_required") ? route : null;
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
