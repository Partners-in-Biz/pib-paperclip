/**
 * Ask deadline sweep: every 15 minutes, find asks with expired deadlines
 * and apply standing policy or escalate to owner.
 *
 * The 24-hour rule (decision rights, 11 Nov 2026): a question that is not a
 * hard stop and has a recommended answer applies that answer by itself once it
 * is 24 hours old, and says so on the issue. A hard stop never does: it waits
 * for the owner however long that takes.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { evaluate, type PolicyAsk, type PolicyClass, POLICY_CLASSES } from "./owner-defaults-model.js";
import { answerAskByPolicy, askHardStop, getAsk, type AskRow, listCompaniesWithDueAsks, listDueAsks } from "./asks.js";
import { defaultAppliedComment } from "./ask-model.js";
import { readDecisionRights } from "./decision-rights.js";
import { DEFAULT_APPLY_HOURS, HARD_STOPS } from "./decision-rights-model.js";
import { recordRepair, listRepairs } from "./repairs.js";
import { getRoles } from "./db.js";
import { listSubscriptionsForUser } from "./push/store.js";
import { sendPush } from "./push/send.js";
import { readOwnerDefaults } from "./owner-defaults-store.js";
import { message, type Env } from "./env.js";
import { NAMESPACE } from "./namespace.js";

/** The name stored as the policy of an answer applied by the 24-hour rule. */
export const DEFAULT_RULE_NAME = "24-hour default";

/**
 * Find all ancestors of an issue by walking up the parent_id chain.
 * Returns an array of issue IDs including the issue itself.
 * Company-scoped to prevent walking into other companies' issues.
 */
async function findAncestors(ctx: PluginContext, companyId: string, issueId: string): Promise<string[]> {
  const ancestors: string[] = [issueId];
  let current = issueId;
  const visited = new Set<string>([issueId]);
  const maxDepth = 20;
  let depth = 0;

  while (depth < maxDepth) {
    const rows = await ctx.db.query<{ parent_id: unknown }>(
      `SELECT parent_id FROM public.issues WHERE id::text = $1 AND company_id = $2 LIMIT 1`,
      [current, companyId],
    );

    if (!rows || rows.length === 0 || !rows[0].parent_id) {
      break;
    }

    const parentId = String(rows[0].parent_id);
    if (visited.has(parentId)) {
      break; // Cycle detected, stop
    }

    ancestors.push(parentId);
    visited.add(parentId);
    current = parentId;
    depth += 1;
  }

  return ancestors;
}

/**
 * Check if owner was pushed for this issue within the last N hours.
 * Tracks both ask_deadline push_owner and ladder create_L4 escalations.
 */
export async function ownerPushedWithin(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  now: Date,
  hours: number = 24,
): Promise<boolean> {
  const since = new Date(now.getTime() - hours * 3600000).toISOString();
  const rows = await ctx.db.query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM ${NAMESPACE}.repairs WHERE company_id = $1 AND target_kind = 'issue' AND target_id = $2 AND action = ANY($3::text[]) AND created_at >= $4) AS exists`,
    [companyId, issueId, ["push_owner", "create_L4"], since],
  );
  return rows.length > 0 && rows[0].exists;
}

/**
 * Record an owner push for an issue (after attempting to send).
 */
export async function recordOwnerPush(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
): Promise<void> {
  await recordRepair(ctx, companyId, {
    kind: "ask_deadline",
    targetKind: "issue",
    targetId: issueId,
    action: "push_owner",
    outcome: "sent",
    actor: "cockpit-ask-deadlines",
  });
}

/**
 * Send a push notification to the owner for an ask deadline.
 * If push is not enabled, post a comment on the health issue instead.
 * Only records the push if something was actually delivered.
 * Dedupes on issue within 24h (via ownerPushedWithin).
 */
async function pushOnce(
  env: Env,
  companyId: string,
  ask: AskRow,
  pushMessage: string,
  pushEnabled: boolean,
): Promise<void> {
  try {
    // Check if we already pushed for this issue within 24h
    if (await ownerPushedWithin(env.ctx, companyId, ask.issueId, env.now())) {
      return; // Already pushed recently, skip
    }

    let delivered = false;

    if (pushEnabled) {
      // Try to send push notification
      const roles = await getRoles(env.ctx, companyId);
      const ownerUserId = roles?.ownerUserId ?? null;

      if (!ownerUserId) {
        // No owner, try health issue fallback
        delivered = await postHealthComment(env, companyId, `Ask deadline escalated: ${ask.issueIdentifier ?? ask.issueId}`);
        if (!delivered) return; // Nothing delivered, don't record push
      } else {
        const subs = await listSubscriptionsForUser(env.ctx, companyId, ownerUserId);
        const okSubs = subs.filter((s) => s.state === "ok");

        if (okSubs.length === 0) {
          // No subscriptions, try health issue fallback
          delivered = await postHealthComment(env, companyId, `Ask deadline escalated: ${ask.issueIdentifier ?? ask.issueId}`);
          if (!delivered) return; // Nothing delivered, don't record push
        } else {
          await sendPush(
            env.ctx,
            companyId,
            okSubs,
            {
              title: "Ask deadline",
              body: pushMessage,
              url: `/issues/${ask.issueIdentifier ?? ask.issueId}`,
              tag: ask.issueIdentifier ?? ask.issueId,
              class: "needs_you",
            },
            { class: "needs_you" },
          );
          delivered = true;
        }
      }
    } else {
      // Push disabled, use health issue fallback
      delivered = await postHealthComment(env, companyId, `Ask deadline escalated: ${ask.issueIdentifier ?? ask.issueId}`);
      if (!delivered) return; // Nothing delivered, don't record push
    }

    // Record the push only if something was delivered
    if (delivered) {
      await recordOwnerPush(env.ctx, companyId, ask.issueId);
    }
  } catch (err) {
    env.ctx.logger.warn("Push failed for ask deadline", {
      companyId,
      askId: ask.id,
      error: message(err),
    });
  }
}

/**
 * Post a comment on the company's health issue instead of pushing.
 * Returns true if the comment was posted, false otherwise.
 */
async function postHealthComment(env: Env, companyId: string, text: string): Promise<boolean> {
  try {
    const config = (await env.ctx.config.get(companyId)) as Record<string, unknown> | undefined;
    const healthIssueId = (config?.healthIssueId ?? config?.healthIssue) as string | undefined;
    if (!healthIssueId) return false;

    await env.ctx.issues.createComment(healthIssueId, text, companyId);
    return true;
  } catch {
    // Silently ignore health comment failures
    return false;
  }
}

/**
 * Escalate an ask and push once.
 */
async function escalate(
  env: Env,
  companyId: string,
  ask: AskRow,
  reason: string,
  pushEnabled: boolean,
): Promise<void> {
  await recordRepair(env.ctx, companyId, {
    kind: "ask_deadline",
    targetKind: "ask",
    targetId: ask.id,
    action: "escalate_ask",
    outcome: "escalated",
    detail: reason,
    actor: "cockpit-ask-deadlines",
  });

  await pushOnce(env, companyId, ask, "Ask deadline reached, needs your decision", pushEnabled);
}

/**
 * Find all asks due for a company and process them.
 * Returns the number of asks processed.
 */
export async function sweepAskDeadlines(
  env: Env,
  now?: Date,
): Promise<{ processed: number; applied: number; escalated: number; errors: number }> {
  const nowTime = now ?? env.now();
  const companies = await listCompaniesWithDueAsks(env, nowTime.toISOString());

  let processed = 0;
  let applied = 0;
  let escalated = 0;
  let errors = 0;

  for (const companyId of companies) {
    try {
      // Get the real standing policy from the store
      const policy = await readOwnerDefaults(env.ctx, companyId);
      const pushConfig = (await env.ctx.config.get(companyId)) as Record<string, unknown> | undefined;
      const { ownProducts } = await readDecisionRights(env, companyId);

      // Find open asks with expired deadlines and no defaultAppliedAt
      const dueAsks = await listDueAsks(env, companyId, nowTime.toISOString());

      // Load repairs for these asks to dedupe, using targetIds to avoid truncation at LIMIT
      const askIds = dueAsks.map((a) => a.id);
      const handledKeys = new Set<string>();
      if (askIds.length > 0) {
        const repairs = await listRepairs(env.ctx, companyId, { kind: "ask_deadline", targetIds: askIds });
        for (const repair of repairs) {
          if (
            repair.targetKind === "ask" &&
            (repair.action === "apply_default" || repair.action === "escalate_ask")
          ) {
            handledKeys.add(`${repair.targetId}:${repair.action}`);
          }
        }
      }

      for (const ask of dueAsks) {
        try {
          // Check if already handled (dedupe)
          if (handledKeys.has(`${ask.id}:apply_default`) || handledKeys.has(`${ask.id}:escalate_ask`)) {
            continue; // Already processed
          }

          // Case 1: Ask has an effect -> escalate only
          if (ask.effect) {
            processed += 1;
            await escalate(env, companyId, ask, "Ask has effect, escalation only", pushConfig?.pushEnabled === true);
            escalated += 1;
            continue;
          }

          // Check if ask is safe for auto-application: never money, legal or a grant, and never a hard stop.
          const isSafeKind = !["money", "legal", "grant"].includes(ask.kind);
          const hardStop = askHardStop(ask, ownProducts);
          const isPolicyClassAllowed = !ask.defaultPolicy || POLICY_CLASSES.includes(ask.defaultPolicy as PolicyClass);

          if (!isSafeKind || hardStop || !isPolicyClassAllowed) {
            // Dangerous kind, hard stop or disallowed class -> escalate
            const reason = !isSafeKind ? `kind=${ask.kind}` : hardStop ? `hard stop: ${HARD_STOPS[hardStop].label}` : `policyClass=${ask.defaultPolicy}`;
            processed += 1;
            await escalate(env, companyId, ask, `Escalated: ${reason}`, pushConfig?.pushEnabled === true);
            escalated += 1;
            continue;
          }

          const policyAsk: PolicyAsk = {
            key: ask.id,
            issueId: ask.issueId,
            kind: ask.kind,
            question: ask.question,
            options: ask.options,
            recommended: ask.recommended,
            policyClass: ask.defaultPolicy,
            defaultAfterHours: ask.defaultAfterHours,
            effect: ask.effect,
            askedAt: ask.askedAt,
            deadlineAt: ask.deadlineAt,
          };

          const rootsOfIssue = await findAncestors(env.ctx, companyId, ask.issueId);
          const decision = evaluate({
            ask: policyAsk,
            policy,
            now: nowTime,
            rootsOfIssue,
          });

          // The 24-hour rule: when the standing policy does not answer, the recommended answer still applies once the question is 24 hours old.
          const recommended = ask.recommended && ask.options.includes(ask.recommended) ? ask.recommended : null;
          const byRule = decision.action !== "apply" && recommended !== null;
          if (byRule && nowTime.getTime() - Date.parse(ask.askedAt) < DEFAULT_APPLY_HOURS * 3_600_000) {
            continue; // Not 24 hours old yet: looked at again on the next sweep.
          }

          processed += 1;

          if (decision.action === "apply" || byRule) {
            // Case 2: the policy covers it, or the 24-hour rule does -> apply
            const answer = decision.action === "apply" ? decision.answer : recommended!;
            const policyName = byRule ? DEFAULT_RULE_NAME : policy?.name ?? "Policy";
            const result = await answerAskByPolicy(
              env,
              companyId,
              ask.id,
              policyName,
              answer,
            );

            // Only post comment and record repair if actually changed from open to answered
            if (result) {
              // Post comment
              try {
                await env.ctx.issues.createComment(
                  ask.issueId,
                  byRule ? defaultAppliedComment(answer) : `Applied by standing policy ${policyName} at ${nowTime.toISOString()}`,
                  companyId,
                );
              } catch (err) {
                env.ctx.logger.warn("Failed to post apply comment on ask deadline", {
                  companyId,
                  askId: ask.id,
                  error: message(err),
                });
              }

              await recordRepair(env.ctx, companyId, {
                kind: "ask_deadline",
                targetKind: "ask",
                targetId: ask.id,
                action: "apply_default",
                outcome: "applied",
                detail: byRule ? `Applied by the 24-hour rule: ${answer}` : `Applied by policy: ${answer}`,
                actor: "cockpit-ask-deadlines",
              });

              // A standing-policy answer pushes the owner once per 24h per issue. A 24-hour-rule answer does not: the daily digest lists it.
              if (!byRule) {
                await pushOnce(
                  env,
                  companyId,
                  ask,
                  `Applied ${ask.issueIdentifier ?? ask.issueId}: ${answer}`,
                  pushConfig?.pushEnabled === true,
                );
              }
              applied += 1;
              continue;
            }

            // Case 3: apply returned null; ask may have been answered concurrently.
            // Re-read to check if it's still open; if closed, skip it; if open, escalate.
            const updatedAsk = await getAsk(env, companyId, ask.id);
            if (!updatedAsk || updatedAsk.status !== "open") {
              // Ask was closed by owner or another sweep; skip escalation
              continue;
            }
          }

          // Case 4: Escalate (policy disabled, doesn't cover, or apply failed/ask still open)
          await escalate(env, companyId, ask, decision.reason ?? "Escalated due to deadline", pushConfig?.pushEnabled === true);
          escalated += 1;
        } catch (err) {
          errors += 1;
          env.ctx.logger.warn("Failed to process ask deadline", {
            companyId,
            askId: ask.id,
            error: message(err),
          });
        }
      }
    } catch (err) {
      errors += 1;
      env.ctx.logger.warn("Failed to process company deadline sweep", {
        companyId,
        error: message(err),
      });
    }
  }

  return { processed, applied, escalated, errors };
}
