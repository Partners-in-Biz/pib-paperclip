/** Shared scenario helpers for the governance tests: a synced account with campaigns, proposals, and a person or an agent closing an issue. */
import { getAccount, getProposal, listApprovals } from "../../src/db.js";
import { createProposal } from "../../src/proposals.js";
import { syncAccount } from "../../src/sync.js";
import type { ProposalRow } from "../../src/db.js";
import { ADS_AGENT, COMPANY, OWNER, type World } from "./world.js";

export const campaign = (id: string, status: "active" | "paused" = "active", daily: number | null = 10_000) => ({ externalId: id, name: `Campaign ${id}`, status, rawStatus: status.toUpperCase(), objective: "OUTCOME_LEADS", channel: "mock", dailyBudgetMinor: daily, lifetimeBudgetMinor: null });

/** An account with two campaigns, a week of spend, synced once. `spend` is per day for c1. */
export async function syncedAccount(w: World, options: { scope?: string; externalId?: string; cap?: number | null; allowWrites?: boolean; signoffs?: "owner" | "owner_client"; canWrite?: boolean; spend?: number; currency?: string; platform?: "mock" | "meta" | "google" } = {}) {
  const ext = options.externalId ?? "ext-1";
  const made = await w.account({ scope: options.scope ?? "own", externalId: ext, cap: options.cap === undefined ? 500_000 : options.cap, allowWrites: options.allowWrites ?? true, ...(options.signoffs ? { signoffs: options.signoffs } : {}), ...(options.canWrite !== undefined ? { canWrite: options.canWrite } : {}), ...(options.currency ? { currency: options.currency } : {}), ...(options.platform ? { platform: options.platform } : {}) });
  w.mock.campaigns[ext] = [campaign("c1"), campaign("c2", "paused", 5000), campaign("c3")];
  const spend = options.spend ?? 8000;
  const days = ["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"];
  w.mock.insightRows[ext] = [
    ...days.map((day) => ({ campaignExternalId: "c1", campaignName: "Campaign c1", day, spendMinor: spend, impressions: 2000, clicks: 80, conversions: 3, valueMinor: 30_000 })),
    ...days.map((day) => ({ campaignExternalId: "c3", campaignName: "Campaign c3", day, spendMinor: 2000, impressions: 500, clicks: 20, conversions: 1, valueMinor: 8000 })),
  ];
  await syncAccount(w.rt(), (await getAccount(w.ctx, COMPANY, made.accountId))!);
  return made;
}

export const CREATE = (accountId: string, extra: Record<string, unknown> = {}) => ({ kind: "create_campaign", scopeKey: "own", accountId, name: "Spring leads", objective: "OUTCOME_LEADS", dailyBudgetMinor: 5000, reason: "The last campaign returned 3x.", ...extra });

export async function propose(w: World, input: Record<string, unknown>, actor: { userId?: string | null; agentId?: string | null } = { agentId: ADS_AGENT }): Promise<ProposalRow> {
  const result = await createProposal(w.rt(), actor, input);
  return (await getProposal(w.ctx, COMPANY, result.proposalId))!;
}

/** A person (or an agent) changes an issue's status; the host then tells the plugin with an `issue.updated` event. */
export async function closeIssueAs(w: World, issueId: string, status: "done" | "cancelled", by: { type: "user" | "agent"; id: string }): Promise<void> {
  await w.asHost(() => w.ctx.issues.update(issueId, { status }, COMPANY));
  await w.harness.emit("issue.updated", { status }, { companyId: COMPANY, entityId: issueId, entityType: "issue", actorType: by.type, actorId: by.id });
}

export const person = { type: "user" as const, id: OWNER };

export async function approvalsOf(w: World, proposalId: string) {
  return listApprovals(w.ctx, COMPANY, proposalId);
}
