import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENGINEER_ID = "33333333-3333-4333-8333-333333333333";
const REVIEWER_ID = "44444444-4444-4444-8444-444444444444";
const NEW_ASSIGNEE_ID = "66666666-6666-4666-8666-666666666666";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdForUpdate: vi.fn(),
  findOpenAncestorCreatedByAgent: vi.fn(async () => null),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  createChild: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  triggerIssueMonitor: vi.fn(async () => ({ outcome: "triggered" as const })),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));
const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => false),
  decide: vi.fn(),
  hasPermission: vi.fn(async () => false),
}));
const runRow = {
  id: "55555555-5555-4555-8555-555555555555",
  companyId: "company-1",
  agentId: ENGINEER_ID,
  contextSnapshot: { issueId: ISSUE_ID },
  permissions: null,
};
const mockDbSelectWhere = vi.hoisted(() => vi.fn());
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({
  select: mockDbSelect,
  transaction: vi.fn(async (callback: (tx: { select: typeof mockDbSelect }) => Promise<unknown>) =>
    callback({ select: mockDbSelect })),
}));
const mockGate = vi.hoisted(() => ({
  evaluateIssueCodeReviewGate: vi.fn(),
  pickAutoReviewStageReviewer: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
  listForIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
}));
const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(async () => []),
}));
const mockRunnerGoalService = vi.hoisted(() => ({
  projection: vi.fn(async () => null),
  act: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/queued-interaction-response.js", () => ({
    hasQueuedInteractionResponse: vi.fn(async () => false),
  }));
  vi.doMock("../services/runner-goals.js", () => ({
    runnerGoalService: () => mockRunnerGoalService,
    RunnerGoalActionError: class RunnerGoalActionError extends Error {},
    RunnerGoalConflictError: class RunnerGoalConflictError extends Error {},
  }));
  vi.doMock("../services/issue-code-review-gate-context.js", () => mockGate);
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({ getById: vi.fn(async () => ({ id: "company-1" })) }),
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: vi.fn(async (agentId: string) => ({ id: agentId, companyId: "company-1", permissions: null })),
      resolveByReference: vi.fn(async (_companyId: string, reference: string) => ({
        ambiguous: false,
        agent: { id: reference, companyId: "company-1", status: "idle", orgChainHealth: { status: "healthy" } },
      })),
    }),
    companySkillService: () => ({ completeTestRunForIssue: vi.fn(async () => null) }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    environmentService: () => ({ getById: vi.fn(async () => null) }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => mockIssueApprovalService,
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({}),
  }));
}

type TestActor =
  | { type: "board"; userId: string; companyIds: string[]; source: "local_implicit"; isInstanceAdmin: boolean }
  | { type: "agent"; agentId: string; companyId: string; runId: string | null };

const boardActor: TestActor = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};
const engineerActor: TestActor = {
  type: "agent",
  agentId: ENGINEER_ID,
  companyId: "company-1",
  runId: runRow.id,
};

async function createApp(actor: TestActor) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

function thenable(rows: unknown[]) {
  return {
    for: () => thenable(rows),
    then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(onFulfilled, onRejected),
  };
}

function baseIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    status: "in_progress",
    reviewPolicy: "anyone",
    assigneeAgentId: ENGINEER_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAR-5969",
    title: "Code work",
    projectId: null,
    description: null,
    executionPolicy: null,
    executionState: null,
    ...overrides,
  };
}

describe("code review gate on PATCH /issues/:id", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getByIdForUpdate.mockImplementation(async () => mockIssueService.getById());
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...baseIssue(),
      ...patch,
    }));
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelectWhere.mockImplementation(() => thenable([runRow]));
    mockGate.evaluateIssueCodeReviewGate.mockResolvedValue({ allowed: true });
    mockGate.pickAutoReviewStageReviewer.mockResolvedValue(null);
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async (input: { actor?: { type?: string; source?: string }; action?: string }) => {
      const allowed =
        input.actor?.type === "board" ||
        (input.actor?.type === "agent" &&
          ["company_scope:read", "issue:read", "issue:mutate", "runtime:manage"].includes(input.action ?? ""));
      return {
        allowed,
        action: input.action,
        reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
        explanation: allowed ? "Allowed by test grant." : `Missing permission: ${input.action ?? "action"}`,
      };
    });
  });

  it("rejects done from the assignee with 422 when the gate denies", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue());
    mockGate.evaluateIssueCodeReviewGate.mockResolvedValue({
      allowed: false,
      reason: "Request Code Reviewer review (set the review stage) instead of closing",
    });

    const res = await request(await createApp(engineerActor)).patch(`/api/issues/${ISSUE_ID}`).send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Request Code Reviewer review");
    expect(mockGate.evaluateIssueCodeReviewGate).toHaveBeenCalledTimes(1);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("lets the assignee close when the gate allows (PASS present, or exempt)", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue());

    const res = await request(await createApp(engineerActor)).patch(`/api/issues/${ISSUE_ID}`).send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockGate.evaluateIssueCodeReviewGate).toHaveBeenCalledTimes(1);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("does not gate a board actor", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue());

    const res = await request(await createApp(boardActor)).patch(`/api/issues/${ISSUE_ID}`).send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockGate.evaluateIssueCodeReviewGate).not.toHaveBeenCalled();
  });

  it("does not gate non-done status changes", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "todo" }));

    const res = await request(await createApp(engineerActor)).patch(`/api/issues/${ISSUE_ID}`).send({ status: "in_progress" });

    expect(res.status).toBe(200);
    expect(mockGate.evaluateIssueCodeReviewGate).not.toHaveBeenCalled();
  });

  it("keeps the review stage in executionPolicy when status moves to in_progress", async () => {
    const executionPolicy = {
      mode: "normal",
      commentRequired: true,
      stages: [
        {
          id: "063a068c-8a75-4d32-a6ac-a4290d477842",
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: "80d79a88-43b7-47cb-a2a1-0228f069ff0f", type: "agent", agentId: REVIEWER_ID }],
        },
      ],
    };
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "todo", executionPolicy }));

    const res = await request(await createApp(engineerActor)).patch(`/api/issues/${ISSUE_ID}`).send({ status: "in_progress" });

    expect(res.status).toBe(200);
    const patch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect("executionPolicy" in patch ? patch.executionPolicy : executionPolicy).toMatchObject({ stages: [{ type: "review" }] });
  });

  it("adds a Code Reviewer review stage when an engineer is assigned matching code work", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ assigneeAgentId: null }));
    mockGate.pickAutoReviewStageReviewer.mockResolvedValue(REVIEWER_ID);

    const res = await request(await createApp(boardActor))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ assigneeAgentId: NEW_ASSIGNEE_ID });

    expect(res.status).toBe(200);
    const patch = mockIssueService.update.mock.calls[0]?.[1] as { executionPolicy?: { stages: any[] } };
    expect(patch.executionPolicy?.stages).toHaveLength(1);
    expect(patch.executionPolicy?.stages[0]).toMatchObject({
      type: "review",
      participants: [{ type: "agent", agentId: REVIEWER_ID }],
    });
  });

  it("leaves the policy alone when no review stage applies", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ assigneeAgentId: null }));

    const res = await request(await createApp(boardActor))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ assigneeAgentId: NEW_ASSIGNEE_ID });

    expect(res.status).toBe(200);
    const patch = mockIssueService.update.mock.calls[0]?.[1] as { executionPolicy?: unknown };
    expect(patch.executionPolicy).toBeUndefined();
  });
});
