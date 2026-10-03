/**
 * Two honesty checks on "done" and on "reviewed", pure part (Q5-4, Q5-6, Q5-7).
 *
 * "Done" on developer work was a convention: nothing in code or host config forced
 * a review or proof before a Developer closed a manual issue (done-checks only run
 * for plugin-opened issues; the host's review stage was set on 0 of 652 issues).
 * Review coverage was about half to three quarters depending on how it was
 * counted, so the count itself is in `measure-model.ts` (REVIEW_COVERAGE_RULE) and
 * this module reuses it: an issue the coverage count calls unreviewed is a
 * candidate; it is only flagged when it also shows no evidence.
 *
 * Approvals were opened with nobody assigned, so cold email reached the owner
 * without the Reviewer ever seeing it (Q5-6). The kit's check finds approvals
 * nobody holds; this finds outward approvals a person holds that the Reviewer never
 * commented on while the company reviews outward work.
 */
import type { HealthCheck } from "@partnersinbiz/pib-plugin-kit";

// ---------------------------------------------------------------------------
// Proof on finished code work
// ---------------------------------------------------------------------------

/** Finished work is looked at for this long after it closes. */
export const PROOF_WINDOW_DAYS = 7;
/** A close is not flagged until it is this old: a review that was just asked for takes time. */
export const PROOF_GRACE_HOURS = 6;
/** At most this many unreviewed closes have their comments read per run. */
export const PROOF_READ_LIMIT = 25;

/** What counts as evidence in a comment. Strong kinds each stand alone; a claim ("tests pass") is none of them. */
export const EVIDENCE_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "commit", re: /\b(commit|sha|pushed|merged|landed in)\b[^\n]{0,60}\b[0-9a-f]{7,40}\b|\b[0-9a-f]{7,40}\b[^\n]{0,20}\b(commit|pushed)\b|\/commit\/[0-9a-f]{7,40}/i },
  { kind: "pull-request", re: /\/pull\/\d+|pull request\s*#?\d+|\bPR\s*#\d+/i },
  { kind: "test-output", re: /\b(npm|pnpm|yarn|npx)\s+(run\s+)?(test|build|smoke|probe|typecheck|lint)\b[^\n]{0,80}\b(pass|passed|ok|green|exit(ed)?\s*0|\d+\/\d+|✓)|\bvitest\b[^\n]{0,60}\d+|\b\d+\s+(tests?\s+)?passed\b|\btests?\s+passed:?\s*\d+/i },
  { kind: "http-check", re: /\bHTTP\/\d(\.\d)?\s+(200|201|204|301|302)\b|\bhttps?\s+status\s*:?\s*(200|201|204)\b|\bstatus(\s+code)?\s*:?\s*(200|201|204)\b|\bcurl\b[^\n]{0,120}\b(200|201|204)\b|\breturns?\s+200\b|\banswers?\s+200\b/i },
  { kind: "screenshot", re: /\.(png|jpe?g|webp)\b|\bpib-shot\b|\battached\b|\battachment\b/i },
  { kind: "deploy", re: /\bstatus\.json\b|\b(deployed|deploy)\b[^\n]{0,60}\b(ok|healthy|live|200|succeeded)\b/i },
];

export function evidenceKinds(body: string): string[] {
  return EVIDENCE_PATTERNS.filter((p) => p.re.test(body)).map((p) => p.kind);
}

export function hasEvidence(comments: Array<{ body?: string | null }>): boolean {
  return comments.some((c) => evidenceKinds(String(c.body ?? "")).length > 0);
}

export interface DoneCandidate {
  id: string;
  identifier: string | null;
  completedAt: string | null;
  /** The coverage count calls it reviewed: an approved review stage, or a linked Reviewer issue. */
  reviewed: boolean;
}

/** The closes the coverage count calls unreviewed, old enough to flag, newest first, at most `PROOF_READ_LIMIT`. */
export function proofCandidates(done: DoneCandidate[], now: Date): DoneCandidate[] {
  const cutoff = now.getTime() - PROOF_GRACE_HOURS * 3_600_000;
  return done
    .filter((d) => !d.reviewed && Date.parse(d.completedAt ?? "") <= cutoff)
    .sort((a, b) => Date.parse(b.completedAt ?? "") - Date.parse(a.completedAt ?? ""))
    .slice(0, PROOF_READ_LIMIT);
}

export interface ProofGap {
  id: string;
  identifier: string | null;
  completedAt: string | null;
}

export function proofCheck(gaps: ProofGap[], totalDone: number): HealthCheck | null {
  if (gaps.length === 0) return null;
  const list = gaps.slice(0, 5).map((g) => g.identifier ?? g.id).join(", ");
  const oldest = gaps.reduce((a, b) => (Date.parse(a.completedAt ?? "") < Date.parse(b.completedAt ?? "") ? a : b));
  return {
    key: "proof:done-without-proof",
    title: `${gaps.length} finished code ${gaps.length === 1 ? "issue has" : "issues have"} no review and no proof`,
    status: "warn",
    detail: `Closed in the last ${PROOF_WINDOW_DAYS} days with no review (an approved review stage, or a linked issue assigned to a Reviewer or Code Reviewer) and no comment showing evidence (a commit or pull request link, test or build output, an HTTP check, a screenshot): ${list}${gaps.length > 5 ? ", ..." : ""}. ${gaps.length} of ${totalDone} closed.`,
    href: "/cockpit",
    fix: "Open a review issue for the Code Reviewer for each (the identifier in its title links it), or ask the author for the evidence; a UI change needs a pib-shot screenshot. The Operator's quality-gates reference says how.",
    since: oldest.completedAt,
  };
}

// ---------------------------------------------------------------------------
// Outward approvals the Reviewer never saw
// ---------------------------------------------------------------------------

/** Plugins whose approvals leave the company. The kit's `outward` flag decides for new approvals; this mirrors what each plugin passes today. */
export const OUTWARD_PLUGINS = new Set(["crm", "campaigns", "social", "billing", "mailbox", "seo"]);
const OUTWARD_WORDS = /\b(emails?|sequences?|campaigns?|newsletters?|broadcasts?|posts?|invoices?|quotes?|reminders?|client reports?|monthly reports?|pull requests?|previews?|sign[- ]?offs?|outreach|sms|whatsapp)\b/i;
const REVIEWER_SECTION = /## Reviewer: check before the person approves/i;
/** A review is asked for after this long: an approval younger than that is not late. */
export const REVIEW_GRACE_HOURS = 2;
/** At most this many approvals have their comments read per run. */
export const APPROVAL_READ_LIMIT = 30;

export interface ApprovalLike {
  id: string;
  identifier?: string | null;
  title: string;
  description?: string | null;
  originKind?: string | null;
  createdAt?: string | null;
  status?: string | null;
}

/** An approval for work that leaves the company: a plugin that sends, and either the Reviewer section or outward words in the title. */
export function isOutwardApproval(issue: ApprovalLike): boolean {
  const plugin = /^plugin:partnersinbiz\.([a-z]+)/.exec(issue.originKind ?? "")?.[1];
  if (!plugin || !OUTWARD_PLUGINS.has(plugin)) return false;
  return REVIEWER_SECTION.test(issue.description ?? "") || OUTWARD_WORDS.test(issue.title);
}

/** Outward approvals past the grace period that need their comments read (the caller reads them and keeps those with no Reviewer comment). */
export function approvalCandidates(issues: ApprovalLike[], now: Date): ApprovalLike[] {
  const cutoff = now.getTime() - REVIEW_GRACE_HOURS * 3_600_000;
  return issues
    .filter((i) => isOutwardApproval(i) && Date.parse(i.createdAt ?? "") <= cutoff)
    .sort((a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? ""))
    .slice(0, APPROVAL_READ_LIMIT);
}

export interface UnreviewedApproval {
  id: string;
  identifier: string | null;
  title: string;
  createdAt: string | null;
}

export function unreviewedApprovalsCheck(items: UnreviewedApproval[]): HealthCheck | null {
  if (items.length === 0) return null;
  const list = items.slice(0, 5).map((a) => `${a.identifier ?? a.id}: ${a.title.slice(0, 60)}`);
  return {
    key: "approvals:unreviewed",
    title: `${items.length} outward ${items.length === 1 ? "approval was" : "approvals were"} never reviewed`,
    status: "warn",
    detail: `${list.join("; ")}${items.length > 5 ? "; ..." : ""}. The company reviews outward work, but the Reviewer never commented on ${items.length === 1 ? "it" : "these"}, so the owner would decide ${items.length === 1 ? "it" : "them"} unreviewed.`,
    href: "/cockpit",
    fix: "Hand each to the Reviewer for a late review (assign it and wake it); it comments, then hands it back to the same person. The Operator's quality-gates reference has the steps.",
    since: items.reduce((a, b) => (Date.parse(a.createdAt ?? "") < Date.parse(b.createdAt ?? "") ? a : b)).createdAt,
  };
}
