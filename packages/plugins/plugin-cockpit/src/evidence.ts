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

const T = `${NAMESPACE}.issue_evidence`;

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

    return ok("Evidence recorded and comment posted", {
      recorded: true,
      evidenceId,
      attachmentId: trimmedAttachmentId,
    });
  } catch (error) {
    return fail(`Failed to record evidence: ${message(error)}`);
  }
}
