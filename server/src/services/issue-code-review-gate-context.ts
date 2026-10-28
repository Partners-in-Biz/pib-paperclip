import { and, asc, eq, ne } from "drizzle-orm";
import { agents, issueComments, issueLabels, labels, projects, type Db } from "@paperclipai/db";
import {
  evaluateCodeReviewGate,
  isCodeWork,
  isExemptFromCodeReview,
  type CodeReviewGateInput,
  type CodeReviewGateResult,
} from "./issue-code-review-gate.js";

type GateIssue = {
  id: string;
  companyId: string;
  projectId: string | null;
  description: string | null;
  executionPolicy: unknown;
  executionState: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Ids of review stages in `policy` that name a Code Reviewer and are listed as completed in `state`. */
function hasCompletedCodeReviewerStage(
  policy: unknown,
  state: unknown,
  codeReviewerAgentIds: ReadonlySet<string>,
): boolean {
  const stages = asRecord(policy)?.stages;
  const completed = asRecord(state)?.completedStageIds;
  if (!Array.isArray(stages) || !Array.isArray(completed)) return false;
  const completedIds = new Set(completed.filter((id): id is string => typeof id === "string"));
  return stages.some((raw) => {
    const stage = asRecord(raw);
    if (!stage || stage.type !== "review" || typeof stage.id !== "string" || !completedIds.has(stage.id)) return false;
    const participants = Array.isArray(stage.participants) ? stage.participants : [];
    return participants.some((participant) => {
      const entry = asRecord(participant);
      return entry?.type === "agent" && typeof entry.agentId === "string" && codeReviewerAgentIds.has(entry.agentId);
    });
  });
}

export async function loadCodeReviewGateInput(
  db: Db,
  issue: GateIssue,
  assigneeAgentId: string | null,
  state: unknown = issue.executionState,
): Promise<CodeReviewGateInput> {
  const [reviewerRows, assignee, project, labelRows, comments] = await Promise.all([
    db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, issue.companyId), eq(agents.role, "Code Reviewer"), ne(agents.status, "terminated")))
      .orderBy(asc(agents.createdAt)),
    assigneeAgentId
      ? db
          .select({ id: agents.id, role: agents.role, name: agents.name })
          .from(agents)
          .where(and(eq(agents.id, assigneeAgentId), eq(agents.companyId, issue.companyId)))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
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

  const codeReviewerAgentIds = new Set(reviewerRows.map((row) => row.id));
  return {
    assignee,
    projectName: project?.name ?? null,
    labels: labelRows.map((row) => row.name),
    description: issue.description,
    comments,
    codeReviewerAgentIds,
    completedCodeReviewerStage: hasCompletedCodeReviewerStage(issue.executionPolicy, state, codeReviewerAgentIds),
  };
}

export async function evaluateIssueCodeReviewGate(
  db: Db,
  issue: GateIssue,
  assigneeAgentId: string | null,
  state?: unknown,
): Promise<CodeReviewGateResult> {
  return evaluateCodeReviewGate(await loadCodeReviewGateInput(db, issue, assigneeAgentId, state));
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
