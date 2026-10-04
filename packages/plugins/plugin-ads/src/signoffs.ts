/**
 * Who has said yes to exactly these numbers (pure). An approval counts only when a person gave it, it is for the proposal's current
 * content hash, it has not expired and it has not been used. Changing a proposal changes its hash, so every earlier yes stops counting.
 */
import type { ApprovalRow, ProposalRow } from "./db.js";

export const APPROVAL_TTL_MS = 72 * 3_600_000;
export const PROPOSAL_TTL_MS = 7 * 86_400_000;

export type Role = "owner" | "client";

export interface SignoffState {
  required: Role[];
  /** The valid yes for each role that has one. */
  valid: Partial<Record<Role, ApprovalRow>>;
  missing: Role[];
  /** A person's no on the current numbers. */
  rejected: ApprovalRow | null;
  complete: boolean;
}

export function signoffState(proposal: Pick<ProposalRow, "content_hash" | "requires_signoffs">, approvals: ApprovalRow[], now: Date): SignoffState {
  const required = proposal.requires_signoffs.length ? proposal.requires_signoffs : (["owner"] as Role[]);
  const forThis = approvals.filter((a) => a.content_hash === proposal.content_hash && a.decided_by.startsWith("user:"));
  const rejected = forThis.find((a) => a.decision === "rejected") ?? null;
  const valid: Partial<Record<Role, ApprovalRow>> = {};
  for (const a of forThis) {
    if (a.decision !== "approved" || a.consumed_at || !a.expires_at || Date.parse(a.expires_at) <= now.getTime()) continue;
    const have = valid[a.role];
    if (!have || (a.created_at ?? "") > (have.created_at ?? "")) valid[a.role] = a;
  }
  const missing = required.filter((role) => !valid[role]);
  return { required, valid, missing, rejected, complete: !rejected && missing.length === 0 };
}

/** The Reviewer's check stands for these numbers: not needed, passed on this hash, or waived by a person. */
export function reviewStands(p: Pick<ProposalRow, "review_state" | "review_hash" | "content_hash">): boolean {
  if (p.review_state === "not_required") return true;
  if (p.review_state === "waived") return true;
  return p.review_state === "pass" && p.review_hash === p.content_hash;
}
