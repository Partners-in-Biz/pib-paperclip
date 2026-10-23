/**
 * The autonomy ladder (PAR-4701, decided on PAR-2885 and PAR-4691): a low-risk post with a clean owner streak
 * is approved without the team member's click. Nothing else is: no campaign, invoice, quote, sequence or
 * any other outward send, and no post that is not low-risk. Pure; the caller supplies the facts.
 *
 * Low risk, all of: the format is text or a single image; the source is our own writing or a repurposed page
 * (never an RSS item or an inbox reply). The complaint, legal, safety and PR exclusion works by source only: an
 * inbox reply is out, but an agent-written original on such a topic is eligible and nothing here reads its content;
 * the scope's policy does not ask for the client; `validate-post` passes. A Reviewer's pass the policy asks
 * for still has to be in. The streak is the owner stage's approvals in a row for that post type in that scope,
 * counting human verdicts only (an auto-approval never extends its own streak).
 */
import type { TypeStats } from "./review-outcomes.js";

export const AUTO_APPROVE_STREAK = 5;
export const AUTO_KINDS = ["original", "repurpose"] as const;
export const AUTO_FORMATS = ["text", "image"] as const;

export interface AutoFacts {
  kind: string;
  format: string;
  /** True when the scope's policy asks for the client's approval. */
  requireClient: boolean;
  /** Sign-offs still missing for this version (after the Reviewer's pass, if one is required). */
  missing: string[];
  validateOk: boolean;
  /** Owner-stage approvals in a row for this post type in this scope (0 when there is no data). */
  streak: number;
}

export interface AutoDecision {
  eligible: boolean;
  reasons: string[];
}

export function lowRiskType(kind: string, format: string): boolean {
  return (AUTO_KINDS as readonly string[]).includes(kind) && (AUTO_FORMATS as readonly string[]).includes(format);
}

export function autoApprovalDecision(facts: AutoFacts): AutoDecision {
  const reasons: string[] = [];
  if (!(AUTO_KINDS as readonly string[]).includes(facts.kind)) reasons.push(`a ${facts.kind} post is never auto-approved`);
  if (!(AUTO_FORMATS as readonly string[]).includes(facts.format)) reasons.push(`format ${facts.format} is not text or a single image`);
  if (facts.requireClient) reasons.push("the scope asks for the client's approval");
  if (facts.missing.some((stage) => stage !== "owner")) reasons.push("a required sign-off other than the team member's is still missing");
  if (!facts.missing.includes("owner")) reasons.push("no team member's click is waiting");
  if (!facts.validateOk) reasons.push("validate-post does not pass");
  if (facts.streak < AUTO_APPROVE_STREAK) reasons.push(`the owner streak is ${facts.streak} of ${AUTO_APPROVE_STREAK}`);
  return { eligible: reasons.length === 0, reasons };
}

/** The owner-stage streak of one post type, from `summariseOutcomes` rows. 0 with no data. */
export function ownerStreak(types: TypeStats[], postType: string): number {
  return types.find((row) => row.stage === "owner" && row.postType === postType)?.streak ?? 0;
}
