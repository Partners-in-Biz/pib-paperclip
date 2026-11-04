/**
 * Check that the ad platform has the required caps set before a spend-kind change.
 * Fail closed: if we cannot verify the caps exist, refuse the proposal.
 */
import { getAccount, getConnection, type AccountRow } from "./db.js";
import { AdsError, errorMessage } from "./domain.js";
import { tokenFor } from "./connections.js";
import { SPEND_KINDS, type ProposalKind } from "./platforms.js";
import type { CampaignTarget } from "./proposal-input.js";
import { providerEnv, type AdsRuntime } from "./runtime.js";

/**
 * Verify that the ad account has the required platform-side caps set.
 * - spendCapMinor must not be null (the account's platform spend cap must exist)
 * - All ad sets for the campaign (or all ad sets if campaignExternalId is null) must have lifetimeBudgetMinor set
 * Throws AdsError if any check fails.
 */
export async function assertPlatformCaps(
  rt: AdsRuntime,
  account: { id: string; connection_id: string | null },
  campaignExternalId: string | null
): Promise<void> {
  const conn = account.connection_id ? await getConnection(rt.ctx, rt.companyId, account.connection_id) : null;
  if (!conn || (conn.status !== "connected" && conn.status !== "expiring")) {
    throw new AdsError("The connection for this ad account needs signing in again before anything can change.");
  }

  let env;
  try {
    env = await providerEnv(rt, conn.platform);
  } catch (error) {
    throw new AdsError(errorMessage(error));
  }

  let token;
  try {
    token = await tokenFor(rt, conn);
  } catch (error) {
    throw new AdsError(errorMessage(error));
  }

  const provider = rt.provider(conn.platform);
  const acc = await getAccount(rt.ctx, rt.companyId, account.id);
  if (!acc) throw new AdsError("That ad account was not found.");

  const ref = {
    externalId: acc.external_id,
    currency: acc.currency,
    loginCustomerId: acc.login_customer_id,
  };

  let caps;
  try {
    caps = await provider.accountCaps(env, token, ref);
  } catch (error) {
    throw new AdsError(`Could not verify platform spend caps: ${errorMessage(error)}`, "platform_caps_unverified");
  }

  if (caps.spendCapMinor === null) {
    throw new AdsError("The ad account has no platform spend cap (Meta spend_cap / Google account budget limit). Set one on the platform first.", "no_platform_cap");
  }

  const relevantSets = campaignExternalId ? caps.adSets.filter((s) => s.campaignExternalId === campaignExternalId) : caps.adSets;
  const withoutBudget = relevantSets.filter((s) => s.lifetimeBudgetMinor === null);
  if (withoutBudget.length > 0) {
    const ids = withoutBudget
      .slice(0, 3)
      .map((s) => s.externalId)
      .join(", ");
    const suffix = withoutBudget.length > 3 ? ` and ${withoutBudget.length - 3} more` : "";
    throw new AdsError(`Ad set${withoutBudget.length === 1 ? "" : "s"} ${ids}${suffix} ${withoutBudget.length === 1 ? "has" : "have"} no lifetime budget set on the platform. Set one on each first.`, "adset_no_lifetime_budget");
  }
}

/** The account a spend change is on; a missing id or a missing account refuses (fail closed, PAR-6684). */
async function accountOrRefuse(rt: AdsRuntime, accountId: unknown): Promise<AccountRow> {
  const account = accountId ? await getAccount(rt.ctx, rt.companyId, String(accountId)) : null;
  if (!account) throw new AdsError("The ad account for this change was not found, so its platform spend cap cannot be checked. Nothing runs.", "no_account");
  return account;
}

/**
 * Dispatch per-kind platform caps assertions for spend-kind changes.
 * Gates on SPEND_KINDS: does nothing for non-spend kinds. Refuses when an account is missing, and throws for a spend kind with no branch
 * here (PAR-3765: a kind added to SPEND_KINDS needs a branch and a test).
 */
export async function assertPlatformCapsFor(rt: AdsRuntime, kind: ProposalKind, payload: Record<string, unknown>, spendKinds: readonly ProposalKind[] = SPEND_KINDS): Promise<void> {
  if (!spendKinds.includes(kind)) return;

  if (kind === "create_campaign") {
    await assertPlatformCaps(rt, await accountOrRefuse(rt, payload.accountId), null);
  } else if (kind === "change_budget" || kind === "create_ad_set") {
    await assertPlatformCaps(rt, await accountOrRefuse(rt, payload.accountId), String(payload.campaignExternalId));
  } else if (kind === "resume_campaign") {
    const targets = (payload.targets as CampaignTarget[]) ?? [];
    if (targets.length === 0) throw new AdsError("This resume names no campaign, so its platform spend cap cannot be checked. Nothing runs.", "no_account");
    for (const t of targets) await assertPlatformCaps(rt, await accountOrRefuse(rt, t.accountId), t.campaignExternalId);
  } else {
    throw new AdsError(`No platform cap check exists for "${kind}", so this change that adds spend will not run.`, "platform_caps_unchecked");
  }
}
