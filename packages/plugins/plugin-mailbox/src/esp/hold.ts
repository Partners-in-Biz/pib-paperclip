/**
 * A person lifts a reputation hold (0.6.1).
 *
 * A provider domain whose hard bounce rate reached 2%, or whose complaint rate reached 0.1%, over the last 7 UTC days has its marketing held
 * back (`warmup.ts`, `reputationOf`). The hold used to clear only as the bad days left the window: a person who had fixed the cause (the
 * list was cleaned, the audience tightened) had no way to say so. This is that way, and it is deliberately narrow:
 *
 * - **A person, never an agent.** The page action that calls it takes the signed-in user from the host's actor (`requiredUser` in the worker
 *   refuses an agent, because the host lets any agent with company access call an action), and nothing in the request body can say who it
 *   was. An agent that wants the hold lifted tells the owner (an ask); the tools have no way to do it.
 * - **With a reason**, kept in the audit row (`esp_domain_audit`) together with what the window said when it was lifted.
 * - **Only while there is a hold.** Lifting nothing is refused, so the page cannot be used to wipe a record of a healthy domain.
 * - **It lifts, it does not forget.** From the moment it is lifted only what happens after it is judged (`ReputationClearance`): the days
 *   before are left out and the clearing day's counts at that moment are taken off that day's row. A new bounce or complaint counts, and a
 *   domain that goes bad again is held again. Transactional mail was never held and the daily cap is untouched.
 */
import { randomUUID } from "node:crypto";
import { sendingDomain } from "../dns.js";
import { applyReputation, defaultResolver, judgeReputation, type DomainRunEnv } from "../domain-health.js";
import { MailboxError } from "../domain.js";
import { errorMessage, type Env } from "../gmail/env.js";
import type { ReputationBaseline } from "./types.js";
import { utcDay } from "./warmup.js";

export const MIN_REASON_LENGTH = 10;
export const MAX_REASON_LENGTH = 500;

export interface HoldLiftedResult {
  domain: string;
  lifted: true;
  at: string;
  by: string;
  day: string;
  /** What was holding the domain, as it read when it was lifted. */
  was: string[];
  note: string;
}

/**
 * Lifts the reputation hold of one provider domain. `userId` is the signed-in person the host reported. Throws `MailboxError` with the
 * reason when there is nothing to lift, the reason is missing or the domain is not a provider domain of the company.
 */
export async function liftReputationHold(env: Env, companyId: string, input: { domain: string; reason: string; userId: string }): Promise<HoldLiftedResult> {
  const userId = input.userId.trim();
  if (!userId) throw new MailboxError("Only a signed-in person can lift a reputation hold.");
  const domain = sendingDomain(input.domain);
  if (!domain) throw new MailboxError("domain is required, e.g. updates.client.co.za");
  const reason = input.reason.replace(/\s+/g, " ").trim();
  if (reason.length < MIN_REASON_LENGTH) throw new MailboxError(`Say why the hold may be lifted (at least ${MIN_REASON_LENGTH} characters: what was fixed). It is kept with your name.`);
  const s = env.store;
  const row = await s.getEspDomain(companyId, domain);
  if (!row) throw new MailboxError(`${domain} is not a sending domain of the email provider.`);

  const now = env.now();
  const before = await judgeReputation(s, companyId, domain, now);
  if (before.problems.length === 0) {
    throw new MailboxError(`Nothing to lift: ${domain} has no reputation hold (its last ${before.windowDays} days are inside the limits).`);
  }

  const today = utcDay(now);
  const day = (await s.espDayRows(companyId, domain, today)).find((entry) => entry.day === today);
  const baseline: ReputationBaseline = {
    sent: Number(day?.sent ?? 0),
    delivered: Number(day?.delivered ?? 0),
    hard_bounces: Number(day?.hard_bounces ?? 0),
    soft_bounces: Number(day?.soft_bounces ?? 0),
    complaints: Number(day?.complaints ?? 0),
  };
  const at = new Date(now).toISOString();
  const by = `user:${userId}`;
  await s.patchEspDomain(companyId, domain, { reputation_cleared_at: at, reputation_cleared_by: by, reputation_cleared_day: today, reputation_cleared_baseline: baseline });
  try {
    await s.insertEspAudit({
      id: randomUUID(),
      companyId,
      domain,
      action: "clear_reputation_hold",
      actor: by,
      detail: {
        reason: reason.slice(0, MAX_REASON_LENGTH),
        problems: before.problems.map((problem) => ({ code: problem.code, message: problem.message })),
        window: { days: before.windowDays, sent: before.sent, hardBounces: before.hardBounces, complaints: before.complaints },
        countedFrom: today,
        baseline,
      },
    });
  } catch (error) {
    // No audit row, no lifted hold: undo the one without the other.
    await s.patchEspDomain(companyId, domain, { reputation_cleared_at: row.reputation_cleared_at ?? null, reputation_cleared_by: row.reputation_cleared_by ?? null, reputation_cleared_day: row.reputation_cleared_day ?? null, reputation_cleared_baseline: row.reputation_cleared_baseline ?? null }).catch(() => undefined);
    throw new MailboxError(`The hold was not lifted: its audit record could not be written (${errorMessage(error)}). Try again.`);
  }

  // The stored judgement and the announcement follow at once, so Campaigns stops refusing a launch from the domain now, not at the daily check.
  try {
    const run: DomainRunEnv = { ctx: env.ctx, store: s, dns: env.dns ?? defaultResolver(env.ctx), now: env.now };
    await applyReputation(run, companyId, domain);
  } catch (error) {
    env.ctx.logger.info("Domain reputation not re-judged after the hold was lifted", { domain, error: errorMessage(error) });
  }
  return {
    domain,
    lifted: true,
    at,
    by,
    day: today,
    was: before.problems.map((problem) => problem.message),
    note: `Marketing from ${domain} is no longer held. Only what happens from now on is counted: a new bounce or complaint can hold it again.`,
  };
}
