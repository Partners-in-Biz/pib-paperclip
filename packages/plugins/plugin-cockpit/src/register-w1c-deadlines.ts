/**
 * Ask deadline sweep: every 15 minutes, find asks with expired deadlines
 * and apply standing policy or escalate to owner.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { evaluate, type PolicyAsk, type PolicyClass, POLICY_CLASSES } from "./owner-defaults-model.js";
import { answerAskByPolicy, type AskRow, listCompaniesWithDueAsks, listDueAsks } from "./asks.js";
import { recordRepair, listRepairs } from "./repairs.js";
import { getRoles } from "./db.js";
import { listSubscriptionsForUser } from "./push/store.js";
import { sendPush } from "./push/send.js";
import { readOwnerDefaults } from "./owner-defaults-store.js";
import { message, type Env } from "./env.js";
import { NAMESPACE } from "./namespace.js";

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

    if (pushEnabled) {
      // Try to send push notification
      const roles = await getRoles(env.ctx, companyId);
      const ownerUserId = roles?.ownerUserId ?? null;

      if (!ownerUserId) {
        // No owner, try health issue fallback
        await postHealthComment(env, companyId, `Ask deadline escalated: ${ask.issueIdentifier ?? ask.issueId}`);
        return;
      }

      const subs = await listSubscriptionsForUser(env.ctx, companyId, ownerUserId);
      const okSubs = subs.filter((s) => s.state === "ok");

      if (okSubs.length === 0) {
        // No subscriptions, try health issue fallback
        await postHealthComment(env, companyId, `Ask deadline escalated: ${ask.issueIdentifier ?? ask.issueId}`);
        return;
      }

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
    } else {
      // Push disabled, use health issue fallback
      await postHealthComment(env, companyId, `Ask deadline escalated: ${ask.issueIdentifier ?? ask.issueId}`);
    }

    // Record the push attempt
    await recordOwnerPush(env.ctx, companyId, ask.issueId);
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
 */
async function postHealthComment(env: Env, companyId: string, text: string): Promise<void> {
  try {
    const config = (await env.ctx.config.get(companyId)) as Record<string, unknown> | undefined;
    const healthIssueId = (config?.healthIssueId ?? config?.healthIssue) as string | undefined;
    if (!healthIssueId) return;

    await env.ctx.issues.createComment(healthIssueId, text, companyId).catch(() => undefined);
  } catch {
    // Silently ignore health comment failures
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
): Promise<{ processed: number; applied: number; escalated: number; pushed: number; errors: number }> {
  const nowTime = now ?? env.now();
  const companies = await listCompaniesWithDueAsks(env, nowTime.toISOString());

  let processed = 0;
  let applied = 0;
  let escalated = 0;
  let pushed = 0;
  let errors = 0;

  for (const companyId of companies) {
    try {
      // Get the real standing policy from the store
      const policy = await readOwnerDefaults(env.ctx, companyId);
      const pushEnabled = (await env.ctx.config.get(companyId)) as Record<string, unknown> | undefined;

      // Find open asks with expired deadlines and no defaultAppliedAt
      const dueAsks = await listDueAsks(env, companyId, nowTime.toISOString());

      // Load repairs for these asks to dedupe, filtering by ask IDs to avoid truncation
      const askIds = dueAsks.map((a) => a.id);
      const askIdSet = new Set(askIds);
      const handledKeys = new Set<string>();
      if (askIds.length > 0) {
        const repairs = await listRepairs(env.ctx, companyId, { kind: "ask_deadline" });
        for (const repair of repairs) {
          if (
            repair.targetKind === "ask" &&
            askIdSet.has(repair.targetId) &&
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

          processed += 1;

          // Case 1: Ask has an effect -> escalate only
          if (ask.effect) {
            await escalate(env, companyId, ask, "Ask has effect, escalation only", pushEnabled?.pushEnabled === true);
            escalated += 1;
            continue;
          }

          // Check if ask is safe for auto-application
          const isSafeKind = !["money", "legal", "grant"].includes(ask.kind);
          const isPolicyClassAllowed = !ask.defaultPolicy || POLICY_CLASSES.includes(ask.defaultPolicy as PolicyClass);

          if (!isSafeKind || !isPolicyClassAllowed) {
            // Dangerous kind or disallowed class -> escalate
            const reason = !isSafeKind ? `kind=${ask.kind}` : `policyClass=${ask.defaultPolicy}`;
            await escalate(env, companyId, ask, `Escalated: ${reason}`, pushEnabled?.pushEnabled === true);
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

          if (decision.action === "apply") {
            // Case 2: Policy covers and recommends -> apply
            const result = await answerAskByPolicy(
              env,
              companyId,
              ask.id,
              policy?.name ?? "Policy",
              decision.answer,
            );

            // Only post comment and record repair if actually changed from open to answered
            if (result) {
              // Post comment
              await env.ctx.issues
                .createComment(
                  ask.issueId,
                  `Applied by standing policy ${policy?.name ?? "Policy"} at ${nowTime.toISOString()}`,
                  companyId,
                )
                .catch(() => undefined);

              await recordRepair(env.ctx, companyId, {
                kind: "ask_deadline",
                targetKind: "ask",
                targetId: ask.id,
                action: "apply_default",
                outcome: "applied",
                detail: `Applied by policy: ${decision.answer}`,
                actor: "cockpit-ask-deadlines",
              });

              // Push owner once per 24h per issue
              await pushOnce(
                env,
                companyId,
                ask,
                `Applied ${ask.issueIdentifier ?? ask.issueId}: ${decision.answer}`,
                pushEnabled?.pushEnabled === true,
              );
              applied += 1;
              continue;
            }
          }

          // Case 3: Escalate (policy disabled, doesn't cover, or apply failed)
          await escalate(env, companyId, ask, decision.reason ?? "Escalated due to deadline", pushEnabled?.pushEnabled === true);
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

  return { processed, applied, escalated, pushed, errors };
}
