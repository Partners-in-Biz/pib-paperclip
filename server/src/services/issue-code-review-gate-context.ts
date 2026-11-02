import { and, asc, eq, ilike, inArray, ne } from "drizzle-orm";
import {
  agents,
  issueComments,
  issueExecutionDecisions,
  issueLabels,
  labels,
  projects,
  type Db,
} from "@paperclipai/db";
import {
  evaluateCodeReviewGate,
  isCodeWork,
  isEngineerAgent,
  isExemptFromCodeReview,
  type CodeReviewGateInput,
  type CodeReviewGateResult,
} from "./issue-code-review-gate.js";

type GateIssue = {
  id: string;
  companyId: string;
  projectId: string | null;
  description: string | null;
};

/** The Code Reviewer is matched by name: the live `role` column is an enum (`qa`), not a job title. */
async function listCodeReviewerAgentIds(db: Db, companyId: string): Promise<string[]> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), ilike(agents.name, "Code Reviewer"), ne(agents.status, "terminated")))
    .orderBy(asc(agents.createdAt));
  return rows.map((row) => row.id);
}

export async function loadCodeReviewGateInput(
  db: Db,
  issue: GateIssue,
  assigneeAgentId: string | null,
): Promise<CodeReviewGateInput> {
  const assignee = assigneeAgentId
    ? await db
        .select({ id: agents.id, role: agents.role, name: agents.name })
        .from(agents)
        .where(and(eq(agents.id, assigneeAgentId), eq(agents.companyId, issue.companyId)))
        .limit(1)
        .then((rows) => rows[0] ?? null)
    : null;
  const base: CodeReviewGateInput = {
    assignee,
    projectName: null,
    labels: [],
    description: issue.description,
    comments: [],
    codeReviewerAgentIds: new Set(),
    reviewerStageApprovals: [],
  };
  // Only engineer assignees are gated, so skip the remaining reads for everyone else.
  if (!isEngineerAgent(assignee)) return base;

  const [reviewerIds, project, labelRows, comments] = await Promise.all([
    listCodeReviewerAgentIds(db, issue.companyId),
    issue.projectId
      ? db
          .select({ name: projects.name })
          .from(projects)
          .where(eq(projects.id, issue.projectId))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
    db
      .select({ name: labels.name })
      .from(issueLabels)
      .innerJoin(labels, eq(labels.id, issueLabels.labelId))
      .where(eq(issueLabels.issueId, issue.id)),
    db
      .select({
        authorAgentId: issueComments.authorAgentId,
        body: issueComments.body,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id)),
  ]);
  const approvals = reviewerIds.length
    ? await db
        .select({ createdAt: issueExecutionDecisions.createdAt })
        .from(issueExecutionDecisions)
        .where(
          and(
            eq(issueExecutionDecisions.issueId, issue.id),
            eq(issueExecutionDecisions.stageType, "review"),
            eq(issueExecutionDecisions.outcome, "approved"),
            inArray(issueExecutionDecisions.actorAgentId, reviewerIds),
          ),
        )
    : [];

  return {
    ...base,
    projectName: project?.name ?? null,
    labels: labelRows.map((row) => row.name),
    comments,
    codeReviewerAgentIds: new Set(reviewerIds),
    reviewerStageApprovals: approvals.map((row) => row.createdAt),
  };
}

export async function evaluateIssueCodeReviewGate(
  db: Db,
  issue: GateIssue,
  assigneeAgentId: string | null,
): Promise<CodeReviewGateResult> {
  return evaluateCodeReviewGate(await loadCodeReviewGateInput(db, issue, assigneeAgentId));
}

/** The Code Reviewer to put on an automatically added review stage, or null when none applies. */
export async function pickAutoReviewStageReviewer(
  db: Db,
  issue: GateIssue,
  assigneeAgentId: string,
): Promise<string | null> {
  const input = await loadCodeReviewGateInput(db, issue, assigneeAgentId);
  if (!isCodeWork(input) || isExemptFromCodeReview(input)) return null;
  const reviewerId = [...input.codeReviewerAgentIds][0] ?? null;
  return reviewerId && reviewerId !== assigneeAgentId ? reviewerId : null;
}
