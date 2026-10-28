/**
 * Code Reviewer gate (PAR-5969).
 *
 * An engineer agent must not close code work with `status: done` unless a Code
 * Reviewer approved it. The helpers here are pure so the route can load the
 * rows once and the rules stay unit-testable.
 */

export const CODE_REVIEW_REQUIRED_MESSAGE =
  "Request Code Reviewer review (set the review stage) instead of closing";

const ENGINEER_ROLES = new Set(["developer", "senior developer", "release engineer"]);
const ENGINEER_NAMES = new Set(["arjun", "kai"]);
const PR_URL_PATTERN = /https?:\/\/[^\s)]+\/pull\/\d+/i;
const REVIEWER_PASS_PATTERN = /^\s*(?:approved\s*:|pass\b)/i;
const CODE_LABEL = "code";
const NO_REVIEW_LABEL = "no-code-review";
const EXEMPT_PROJECT_PATTERN = /loyalty\s*plus/i;

export interface CodeReviewGateAgent {
  id: string;
  role: string | null;
  name: string | null;
}

export interface CodeReviewGateComment {
  authorAgentId: string | null;
  body: string;
  createdAt: Date;
}

export interface CodeReviewGateInput {
  assignee: CodeReviewGateAgent | null;
  projectName: string | null;
  labels: string[];
  description: string | null;
  comments: CodeReviewGateComment[];
  codeReviewerAgentIds: ReadonlySet<string>;
  /** A review stage that names a Code Reviewer is already completed on the issue. */
  completedCodeReviewerStage: boolean;
}

export interface CodeReviewGateResult {
  allowed: boolean;
  reason?: string;
}

export function isEngineerAgent(agent: CodeReviewGateAgent | null): boolean {
  if (!agent) return false;
  const role = agent.role?.trim().toLowerCase() ?? "";
  const name = agent.name?.trim().toLowerCase() ?? "";
  return ENGINEER_ROLES.has(role) || ENGINEER_NAMES.has(name);
}

export function isCodeReviewerAgent(agent: CodeReviewGateAgent | null): boolean {
  return agent?.role?.trim().toLowerCase() === "code reviewer";
}

function hasLabel(labels: string[], wanted: string): boolean {
  return labels.some((label) => label.trim().toLowerCase() === wanted);
}

function hasPrLink(text: string | null | undefined): boolean {
  return Boolean(text && PR_URL_PATTERN.test(text));
}

/** Engineer assignee AND (a PR URL in the description/comments OR the `code` label). */
export function isCodeWork(input: Pick<CodeReviewGateInput, "assignee" | "labels" | "description" | "comments">): boolean {
  if (!isEngineerAgent(input.assignee)) return false;
  return (
    hasLabel(input.labels, CODE_LABEL) ||
    hasPrLink(input.description) ||
    input.comments.some((comment) => hasPrLink(comment.body))
  );
}

/**
 * Exempt: the Loyalty Plus project, and issues labelled `no-code-review` that carry a
 * one-line justification comment mentioning the label.
 */
export function isExemptFromCodeReview(
  input: Pick<CodeReviewGateInput, "projectName" | "labels" | "comments">,
): boolean {
  if (input.projectName && EXEMPT_PROJECT_PATTERN.test(input.projectName)) return true;
  if (!hasLabel(input.labels, NO_REVIEW_LABEL)) return false;
  return input.comments.some((comment) => comment.body.toLowerCase().includes(NO_REVIEW_LABEL));
}

/**
 * A Code Reviewer comment starting with `Approved:` or `PASS`, newer than the last
 * non-reviewer comment that links a PR.
 */
export function hasCodeReviewerPass(
  input: Pick<CodeReviewGateInput, "comments" | "codeReviewerAgentIds">,
): boolean {
  let latestPass: number | null = null;
  let latestPrLink: number | null = null;
  for (const comment of input.comments) {
    const at = comment.createdAt.getTime();
    const byReviewer = comment.authorAgentId !== null && input.codeReviewerAgentIds.has(comment.authorAgentId);
    if (byReviewer) {
      if (REVIEWER_PASS_PATTERN.test(comment.body) && (latestPass === null || at > latestPass)) latestPass = at;
    } else if (hasPrLink(comment.body) && (latestPrLink === null || at > latestPrLink)) {
      latestPrLink = at;
    }
  }
  if (latestPass === null) return false;
  return latestPrLink === null || latestPass > latestPrLink;
}

export function evaluateCodeReviewGate(input: CodeReviewGateInput): CodeReviewGateResult {
  if (!isCodeWork(input)) return { allowed: true };
  if (isExemptFromCodeReview(input)) return { allowed: true };
  if (input.completedCodeReviewerStage || hasCodeReviewerPass(input)) return { allowed: true };
  return { allowed: false, reason: CODE_REVIEW_REQUIRED_MESSAGE };
}
