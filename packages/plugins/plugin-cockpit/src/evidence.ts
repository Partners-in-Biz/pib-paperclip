/**
 * Issue evidence: recording redacted screenshot attachment evidence for audit trails.
 * Stores associations between issues, evidence attachments, and work steps.
 */
import { randomBytes } from "node:crypto";
import type { ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { toolFail, toolOk } from "@partnersinbiz/pib-plugin-kit";
import type { Env } from "./env.js";
import { message } from "./env.js";
import { NAMESPACE } from "./namespace.js";
import { notifyOwner, type NotifyOwnerDeps, type NotifyOutcome } from "./push/notify.js";
import { resolveOwner } from "./push/triggers-critical.js";

const T = `${NAMESPACE}.issue_evidence`;

export type ConfirmOutcome = NotifyOutcome | "already_notified" | "error";

type EvidenceRow = {
  id: string;
  companyId: string;
  issueId: string;
  runId: string | null;
  agentId: string | null;
  step: string;
  kind: "shot" | "exempt";
  attachmentId: string | null;
  note: string | null;
  inboxPostedAt: string | null;
  createdAt: string;
};

const newId = (): string => `evid${randomBytes(6).toString("hex")}`;

/**
 * Records evidence (screenshot/attachment) for an issue step.
 * Validates attachment ownership, image type, and SHA256 match.
 * Posts a comment with the evidence summary.
 * Optionally sends a confirmation push to the owner.
 * Returns toolOk/toolFail with the recorded evidence or error.
 */
export async function recordEvidence(
  env: Env,
  companyId: string,
  issueId: string | null,
  attachmentId: string | null,
  sha256Claim: string | null,
  step: string | null,
  summary: string | null,
  run: { runId: string | null; agentId: string | null },
  opts?: { notify?: boolean; deliver?: NotifyOwnerDeps["deliver"] },
): Promise<ToolResult> {
  const ok = (content: string, data: unknown): ToolResult => toolOk(content, data) as ToolResult;
  const fail = (text: string): ToolResult => toolFail(text) as ToolResult;

  // 1. Validate args present
  if (!issueId || typeof issueId !== "string" || !issueId.trim()) {
    return fail("issueId is required");
  }
  if (!step || typeof step !== "string" || !step.trim()) {
    return fail("step is required");
  }
  if (!attachmentId || typeof attachmentId !== "string" || !attachmentId.trim()) {
    return fail("attachmentId is required");
  }
  if (!sha256Claim || typeof sha256Claim !== "string" || !sha256Claim.trim()) {
    return fail("sha256 is required");
  }

  const trimmedIssueId = issueId.trim();
  const trimmedStep = step.trim().slice(0, 60);
  const trimmedAttachmentId = attachmentId.trim();
  const claimedSha256 = sha256Claim.trim().toLowerCase();
  const trimmedSummary = summary && typeof summary === "string"
    ? summary.trim().replace(/\s+/g, " ").slice(0, 300)
    : null;

  // 2. Load the issue
  let issue;
  try {
    issue = await env.ctx.issues.get(trimmedIssueId, companyId);
  } catch {
    issue = null;
  }
  if (!issue) {
    return fail(`Issue not found or is in another company`);
  }

  // 3. List attachments and find the one specified
  let attachments: Array<{ id: string; companyId: string; issueId: string; filename?: string | null; contentType?: string | null; sha256?: string | null; createdByAgentId?: string | null }> = [];
  try {
    attachments = await env.ctx.issues.listAttachments(issue.id, companyId);
  } catch {
    // attachments already initialized to empty array
  }

  const attachment = attachments.find((a) => a.id === trimmedAttachmentId);
  if (!attachment) {
    return fail("Attachment is not on this issue");
  }

  // 4. Defence in depth: verify company and issue match
  if (attachment.companyId !== companyId || attachment.issueId !== issue.id) {
    return fail("Attachment company or issue mismatch");
  }

  // 5. Verify it's an image
  if (!attachment.contentType || !attachment.contentType.startsWith("image/")) {
    return fail("Attachment is not an image");
  }

  // 6. Verify SHA256 matches (case-insensitive)
  const attachmentSha256 = attachment.sha256 ? attachment.sha256.toLowerCase() : "";
  if (attachmentSha256 !== claimedSha256) {
    return fail("Attachment SHA256 does not match the claimed value");
  }

  // 7. Verify the attachment was created by the current agent
  if (attachment.createdByAgentId !== run.agentId) {
    return fail("Attachment must be from the calling agent");
  }

  // 8. Insert or do nothing (identical retry handling)
  const now = env.now().toISOString();
  const evidenceId = newId();

  try {
    const result = await env.ctx.db.execute(
      `INSERT INTO ${T} (id, company_id, issue_id, run_id, agent_id, step, kind, attachment_id, note, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (company_id, issue_id, step, attachment_id) WHERE attachment_id IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [
        evidenceId,
        companyId,
        issue.id,
        run.runId ?? null,
        run.agentId ?? null,
        trimmedStep,
        "shot",
        trimmedAttachmentId,
        trimmedSummary,
        now,
      ],
    );

    // If nothing returned, this is an identical retry
    if (result.rowCount === 0) {
      return ok("Evidence already recorded for this step and attachment", {
        recorded: false,
        reason: "identical retry",
      });
    }

    // 9. Post comment
    const originalFilename = attachment.filename || trimmedAttachmentId;
    const commentBody = `**Evidence:** ${originalFilename}${trimmedSummary ? ` - ${trimmedSummary}` : ""}`;

    try {
      await env.ctx.issues.createComment(issue.id, commentBody, companyId);
    } catch (error) {
      // If comment fails, delete the just-inserted row and return toolFail
      await env.ctx.db.execute(
        `DELETE FROM ${T} WHERE id = $1`,
        [evidenceId],
      ).catch(() => undefined);
      return fail(`Failed to post evidence comment: ${message(error)}`);
    }

    // 10. Optionally push confirmation to owner
    const data: Record<string, unknown> = {
      recorded: true,
      evidenceId,
      attachmentId: trimmedAttachmentId,
    };
    if (opts?.notify === true) {
      const outcome = await confirmEvidencePush(env, {
        companyId,
        issue: { id: issue.id, identifier: issue.identifier ?? null, title: issue.title ?? null },
        step: trimmedStep,
        summary: trimmedSummary,
        evidenceId,
        filename: originalFilename,
        deliver: opts.deliver,
      });
      data.notify = outcome;
    }

    return ok("Evidence recorded and comment posted", data);
  } catch (error) {
    return fail(`Failed to record evidence: ${message(error)}`);
  }
}

/**
 * Confirm evidence recording by posting to owner's subscriptions.
 * Atomically claims one row per (issue, step) to ensure single notification.
 * If already claimed, returns "already_notified".
 * Handles no_subscription by posting to PAR-1844, or returns the push outcome.
 * Never throws; catches all errors and returns "error".
 */
export async function confirmEvidencePush(
  env: Env,
  args: {
    companyId: string;
    issue: { id: string; identifier?: string | null; title?: string | null };
    step: string;
    summary: string | null;
    evidenceId: string;
    filename: string;
    deliver?: NotifyOwnerDeps["deliver"];
  },
): Promise<ConfirmOutcome> {
  const now = env.now();
  const nowIso = now.toISOString();
  let claimed = false;

  // Helper: Release an atomic claim by setting inbox_posted_at to NULL
  const releaseClaim = async (): Promise<void> => {
    await env.ctx.db.execute(
      `UPDATE ${T} SET inbox_posted_at = NULL WHERE company_id = $1 AND issue_id = $2 AND step = $3 AND inbox_posted_at IS NOT NULL`,
      [args.companyId, args.issue.id, args.step],
    ).catch(() => undefined);
  };

  // Helper: Post a no-subscription comment to PAR-1844 if it exists
  const postNoSubscriptionComment = async (): Promise<boolean> => {
    const commentText = `No push subscription for the owner, confirmation not delivered: ${args.issue.identifier ?? args.issue.id} ${args.step}${args.summary ? " - " + args.summary : ""}. Evidence: ${args.filename}`;
    try {
      const parIssue = await env.ctx.issues.get("PAR-1844", args.companyId).catch(() => null);
      if (!parIssue) {
        // PAR-1844 not found; treat as failure
        return false;
      }
      await env.ctx.issues.createComment(parIssue.id, commentText, args.companyId);
      return true;
    } catch {
      // If comment fails, return false
      return false;
    }
  };

  try {
    // CLAIM: atomic UPDATE to mark inbox_posted_at for one canonical row per (issue, step)
    // ORDER BY (inbox_posted_at IS NULL) sorts claimed rows first (0 for false), then unclaimed rows (1 for true)
    // This ensures we always try to claim an unclaimed row; if all are claimed, the UPDATE WHERE clause fails
    const claimResult = await env.ctx.db.execute(
      `UPDATE ${T} SET inbox_posted_at = $1 WHERE id = (SELECT id FROM ${T} WHERE company_id = $2 AND issue_id = $3 AND step = $4 ORDER BY (inbox_posted_at IS NULL), created_at, id LIMIT 1) AND inbox_posted_at IS NULL`,
      [nowIso, args.companyId, args.issue.id, args.step],
    );

    // Check if any row was claimed (rowCount > 0 means a row was updated)
    if ((claimResult.rowCount ?? 0) === 0) {
      return "already_notified";
    }

    claimed = true;

    // Construct identifier and title
    const identifier = args.issue.identifier ?? args.issue.id;
    const title = `Confirmation: ${identifier} ${args.step}: ${args.summary ?? "evidence recorded"}`.slice(0, 120);

    // Get the public base URL and build the issue link
    let publicBaseUrl = "https://paperclip.partnersinbiz.online";
    try {
      const config = await env.ctx.config.get(args.companyId);
      if (config && typeof config === "object" && typeof (config as Record<string, unknown>).publicBaseUrl === "string") {
        const configUrl = (config as Record<string, unknown>).publicBaseUrl as string;
        if (configUrl) {
          publicBaseUrl = configUrl;
        }
      }
    } catch {
      // Use default
    }
    publicBaseUrl = publicBaseUrl.replace(/\/+$/, "");
    const prefix = identifier.includes("-") ? identifier.split("-")[0] : identifier;
    const url = `${publicBaseUrl}/${prefix}/issues/${identifier}`;

    // Resolve owner
    const ownerUserId = await resolveOwner(env.ctx, args.companyId);
    if (!ownerUserId) {
      // No owner role found - try to post to PAR-1844
      const posted = await postNoSubscriptionComment();
      if (!posted) {
        // PAR-1844 not found or comment failed; release the claim
        await releaseClaim();
        env.ctx.logger.warn("Failed to post no_subscription comment to PAR-1844", { issueId: args.issue.id, step: args.step });
        return "no_subscription";
      }
      // Keep claim
      return "no_subscription";
    }

    // Call notifyOwner
    const result = await notifyOwner(
      env.ctx,
      {
        companyId: args.companyId,
        class: "confirmation",
        title,
        body: args.summary ?? args.step,
        issueRef: `${identifier}:${args.step}`,
        ownerUserId,
        url,
      },
      { now: () => now, deliver: args.deliver },
    );

    const outcome = result.outcome;

    if (outcome === "sent" || outcome === "deferred") {
      // Keep the claim
      return outcome;
    }

    if (outcome === "no_subscription") {
      // Post to PAR-1844 if possible
      const posted = await postNoSubscriptionComment();
      if (!posted) {
        // PAR-1844 not found or comment failed; release the claim
        await releaseClaim();
        env.ctx.logger.warn("Failed to post no_subscription comment to PAR-1844", { issueId: args.issue.id, step: args.step });
      }
      return "no_subscription";
    }

    // capped, duplicate: release the claim
    if (outcome === "capped" || outcome === "duplicate") {
      await releaseClaim();
      return outcome;
    }

    // Unknown outcome: keep the claim and return it
    return outcome;
  } catch (error) {
    // Release claim if held
    if (claimed) {
      await releaseClaim();
    }
    env.ctx.logger.warn("confirmEvidencePush failed", { message: message(error) });
    return "error";
  }
}
