/** Determines whether agent Elon (owner delegate) can approve a proposal, or if Peet's approval is required. */
import { daysBetween } from "./dates.js";
import type { ApprovalRow, ProposalRow, ScopeRow } from "./db.js";

export const ELON_AGENT_ID = "7734f065-7c4a-4fc7-b80a-b1f36c0f0c7f";
export const DEFAULT_OWNER_THRESHOLD_MINOR = 50_000;

export interface OwnerRoute {
  route: "elon" | "peet_required";
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

/** Determine if Elon can approve (within threshold) or if Peet is required from a spend amount. */
export function routeForSpend(scope: Pick<ScopeRow, "currency" | "owner_threshold_minor">, lifetimeMinor: number | null): OwnerRoute {
  const threshold = ownerThresholdMinor(scope);
  const route: OwnerRoute["route"] = lifetimeMinor === null || lifetimeMinor > threshold ? "peet_required" : "elon";
  return {
    route,
    lifetimeMinor,
    thresholdMinor: threshold,
  };
}

/** Determine if Elon can approve (within threshold) or if Peet is required. */
export function ownerRouteOf(scope: Pick<ScopeRow, "currency" | "owner_threshold_minor">, p: Pick<ProposalRow, "kind" | "payload" | "impact">): OwnerRoute {
  const lifetime = lifetimeBudgetMinor(p);
  return routeForSpend(scope, lifetime);
}

/** Extract owner route from proposal impact object. */
export function routeFromImpact(impact: Record<string, unknown>): OwnerRoute | null {
  const route = impact.ownerRoute as OwnerRoute | undefined;
  return route && (route.route === "elon" || route.route === "peet_required") ? route : null;
}

/** Check if an approval is Elon's owner-delegate approval (within threshold). */
export function isOwnerDelegateApproval(a: Pick<ApprovalRow, "decided_by" | "role" | "decision" | "over_cap_ack">): boolean {
  return (
    a.decided_by === `agent:${ELON_AGENT_ID}` &&
    a.role === "owner" &&
    a.decision === "approved" &&
    !a.over_cap_ack
  );
}
