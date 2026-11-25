import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, documents, heartbeatRunEvents, heartbeatRuns, issueComments, issueDocuments, issues, issueThreadInteractions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { buildNativeSessionHandoff, createNativeSessionHandoffLoader, currentRequestHistoryCommentIds, NATIVE_HANDOFF_MAX_BYTES, renderNativeSessionHandoff } from "./native-session-handoff.js";
import { selectPaperclipPromptSections } from "@paperclipai/adapter-utils/server-utils";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { buildNativeModelEnvelope } from "@paperclipai/paperclip-runner";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

describe("bounded fresh-session handoff", () => {
  it("marks omissions and stays within its byte budget for huge Unicode histories", () => {
    const rendered = renderNativeSessionHandoff({ issueId: "task", generation: 1, omittedEntriesAtLeast: 1,
      entries: Array.from({ length: 100 }, (_, i) => ({ kind: "message", id: String(i), body: "🦖".repeat(10_000) })),
    });
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(NATIVE_HANDOFF_MAX_BYTES);
    expect(rendered).toContain('"truncated":true');
    expect(rendered).toContain("content omitted");
    expect(rendered).toContain("get_task_history");
    expect(rendered).toContain("Legacy adapters can use the equivalent Paperclip");
  });

  it("restores the handoff on fresh bootstrap and resume failure, without replaying it on resume", () => {
    const input = buildNativeExecutionInput({
      companyId: "company", runId: "run", agentId: "agent", normalizedSessionId: "session", conversationMode: true,
      issue: { id: "task", identifier: "BOT-2", title: "Chat", description: null, workMode: "standard" },
      taskPrompt: "GitHub is connected", freshSessionHandoff: "original goal: build the PR review bot", initialCommunicationGuidance: "Lead with the answer",
      workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      completionContract: { id: "contract", sha256: "a".repeat(64), schemaVersion: "paperclip.run-result.v1", contract: {
        revision: "1", objective: "Build bot", criteria: [{ id: "objective", requirement: "Build bot" }],
      } }, runtimeContext: nativeRuntimeContextFixture(),
    });
    expect(buildNativeModelEnvelope(input).task.prompt).toContain("original goal");
    const resumed = buildNativeModelEnvelope(input, { resumedSession: true });
    expect("task" in resumed && resumed.task.prompt).not.toContain("original goal");
    // The runtime uses the same full envelope if actual recovery fails.
    expect(buildNativeModelEnvelope(input).task.prompt).toContain("Lead with the answer");
  });

  it("reads comment IDs only from a full-history continuation envelope", () => {
    const messages = [{ id: "a" }, { id: "b" }, { id: 7 }, {}];
    expect(currentRequestHistoryCommentIds({ executionContinuation: { coverage: { kind: "full_task_history" }, messages } })).toEqual(["a", "b"]);
    expect(currentRequestHistoryCommentIds({ executionContinuation: { coverage: { kind: "task_history_delta" }, messages } })).toEqual([]);
    expect(currentRequestHistoryCommentIds({ executionContinuation: { coverage: { kind: "full_task_history" } } })).toEqual([]);
    expect(currentRequestHistoryCommentIds(null)).toEqual([]);
    expect(currentRequestHistoryCommentIds({})).toEqual([]);
  });

  it("names comments left to the current request context", () => {
    const rendered = renderNativeSessionHandoff({ issueId: "task", generation: null, omittedEntriesAtLeast: 0, commentsInCurrentRequest: 3,
      entries: [{ kind: "document", id: "d", body: "plan" }] });
    expect(rendered).toContain("Current request and continuation context");
    expect(JSON.parse(rendered.split("\n").at(-1)!)).toMatchObject({ commentsInCurrentRequest: 3, truncated: false });
    const plain = renderNativeSessionHandoff({ issueId: "task", generation: null, omittedEntriesAtLeast: 0, entries: [{ kind: "document", id: "d", body: "plan" }] });
    expect(plain).not.toContain("commentsInCurrentRequest");
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("handoff history scope", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), boundaryId = randomUUID(), requestId = randomUUID();
  const workflowDocumentId = randomUUID(), workflowRevisionId = randomUUID();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-native-handoff-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Handoff", issuePrefix: "HAND" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Dickens", role: "general", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", assigneeAgentId: agentId,
      conversationAgentId: agentId, conversationUserId: "user", conversationState: "active", conversationSessionGeneration: 2 });
    await db.insert(issueComments).values([
      { companyId, issueId, body: "OLD TOPIC", authorUserId: "user", createdAt: new Date(1_000) },
      { id: boundaryId, companyId, issueId, body: "/new", authorUserId: "user", createdAt: new Date(2_000) },
      { id: requestId, companyId, issueId, body: "Build a GitHub PR review bot\n" + "x".repeat(6_000) + "\nFinal constraint: require a team review", authorUserId: "user", createdAt: new Date(3_000) },
      { companyId, issueId, body: "Deleted private message", authorUserId: "user", createdAt: new Date(4_000), deletedAt: new Date(5_000) },
      { companyId, issueId, body: "UNTRUSTED BODY", authorAgentId: agentId, createdAt: new Date(5_000),
        sourceTrust: { preset: "low_trust_review", disposition: "quarantined", sourceIssueId: issueId } },
      { companyId, issueId, body: "FUTURE MESSAGE", authorUserId: "user", createdAt: new Date(30_000) },
      { companyId, issueId, body: "I’ll check the review request.", authorAgentId: agentId, origin: "fast_response", createdAt: new Date(4_500) },
    ]);
    const { eq } = await import("drizzle-orm");
    await db.update(issues).set({ conversationBoundaryCommentId: boundaryId }).where(eq(issues.id, issueId));
    await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "ask_user_questions", status: "answered",
      createdByAgentId: agentId, createdAt: new Date(6_000), resolvedAt: new Date(7_000),
      payload: { version: 1, questions: [] }, result: { version: 1, summaryMarkdown: "Use CODEOWNERS and publish a Storybook per PR" },
    });
    // An activity can start before the wake while its answer arrives later.
    // The answer timestamp, not just the activity's start, fences replay.
    await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "ask_user_questions", status: "answered",
      createdByAgentId: agentId, createdAt: new Date(2_500), resolvedAt: new Date(3_500),
      payload: { version: 1, questions: [] }, result: { version: 1, summaryMarkdown: "LATER CUTOFF DECISION" },
    });
    const laterAnswerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: laterAnswerRunId, companyId, agentId, invocationSource: "automation", triggerDetail: "system", status: "succeeded",
      nativeIssueId: issueId, contextSnapshot: { issueId, conversationSessionGeneration: 2 }, createdAt: new Date(2_500), finishedAt: new Date(3_600),
      runnerProfileJson: { sessionCheckpoint: { semanticResult: { summary: "LATER CUTOFF RUN SUMMARY" } } } });
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: laterAnswerRunId, seq: 1, eventType: "item.completed", createdAt: new Date(3_500),
      payload: { prpEvent: { payload: { kind: "agentMessage", channel: "final", text: "LATER CUTOFF REPLY" } } } });
    const runId = randomUUID(), documentId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "automation", triggerDetail: "system", status: "succeeded",
      nativeIssueId: issueId, contextSnapshot: { issueId, conversationSessionGeneration: 2 }, createdAt: new Date(8_000), finishedAt: new Date(9_500),
      runnerProfileJson: { sessionCheckpoint: { semanticResult: { summary: "Waiting for GitHub access before configuring PR checks" } } } });
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId, seq: 1, eventType: "item.completed", createdAt: new Date(9_000),
      payload: { prpEvent: { payload: { kind: "agentMessage", channel: "final", text: "Repository research complete; next configure PR checks" } } } });
    await db.insert(documents).values({ id: documentId, companyId, latestBody: "Saved plan: review changed files by CODEOWNERS", updatedAt: new Date(10_000) });
    await db.insert(issueDocuments).values({ companyId, issueId, documentId, key: "plan", createdAt: new Date(10_000) });
    await db.insert(documents).values({ id: workflowDocumentId, companyId, title: "Workflow",
      latestBody: "WORKFLOW_BODY_CANARY: triage then implementation then verification.\n".repeat(100),
      latestRevisionId: workflowRevisionId, updatedAt: new Date(11_000) });
    await db.insert(issueDocuments).values({ companyId, issueId, documentId: workflowDocumentId, key: "workflow", createdAt: new Date(11_000) });
    await db.insert(heartbeatRuns).values([
      { companyId, agentId, status: "succeeded", runtimeMode: "legacy", contextSnapshot: { issueId, conversationSessionGeneration: 2 },
        resultJson: { summary: "Legacy answer: repository selection is complete" }, createdAt: new Date(12_000), finishedAt: new Date(13_000) },
      { companyId, agentId, status: "succeeded", runtimeMode: "legacy", contextSnapshot: { issueId: randomUUID(), conversationSessionGeneration: 2 },
        resultJson: { summary: "UNRELATED TASK ANSWER" }, createdAt: new Date(14_000), finishedAt: new Date(15_000) },
    ]);
  });
  afterAll(async () => database?.cleanup());
  it("preserves the original goal and prior answer while excluding reset, deleted and future history", async () => {
    const result = await buildNativeSessionHandoff({ db, companyId, issueId, agentId, before: new Date(20_000) });
    expect(result).toContain("Build a GitHub PR review bot");
    expect(result).toContain('"author":"paperclip_receipt"');
    expect(result).toContain("[Paperclip acknowledgement; not agent work] I’ll check the review request.");
    expect(result).toContain("Final constraint: require a team review");
    expect(result).toContain('"truncated":true');
    expect(Buffer.byteLength(result!)).toBeLessThanOrEqual(NATIVE_HANDOFF_MAX_BYTES);
    expect(result).toContain("CODEOWNERS");
    expect(result).toContain("Repository research complete");
    expect(result).toContain("Saved plan");
    expect(result).toContain("Waiting for GitHub access");
    expect(result).toContain("Legacy answer: repository selection is complete");
    expect(result).not.toContain("UNRELATED TASK ANSWER");
    expect(result).not.toContain("OLD TOPIC");
    expect(result).not.toContain("Deleted private message");
    expect(result).not.toContain("FUTURE MESSAGE");
    expect(result).not.toContain("UNTRUSTED BODY");
    expect(result).not.toContain("/new");
    expect(await buildNativeSessionHandoff({ db, companyId: randomUUID(), issueId, agentId, before: new Date(20_000) })).toBeNull();
    expect(await buildNativeSessionHandoff({ db, companyId, issueId, agentId: randomUUID(), before: new Date(20_000) })).toBeNull();
  });
  it("honors the exact wake-comment cutoff when building a fresh replay", async () => {
    const result = await buildNativeSessionHandoff({ db, companyId, issueId, agentId, before: new Date(20_000), throughCommentId: requestId });
    expect(result).toContain("Build a GitHub PR review bot");
    expect(result).not.toContain("CODEOWNERS");
    expect(result).not.toContain("Legacy answer");
    expect(result).not.toContain("LATER CUTOFF DECISION");
    expect(result).not.toContain("LATER CUTOFF REPLY");
    expect(result).not.toContain("LATER CUTOFF RUN SUMMARY");
    expect(result).not.toContain(workflowDocumentId);
    expect(await buildNativeSessionHandoff({ db, companyId, issueId, agentId, before: new Date(20_000), throughCommentId: randomUUID() })).toBeNull();
  });

  it("keeps workflow history reference-only for fresh bootstrap and resume fallback while preserving plan excerpts", async () => {
    const load = createNativeSessionHandoffLoader({ db, companyId, issueId, agentId, before: new Date(20_000) });
    const history = await load();
    expect(history).not.toContain("WORKFLOW_BODY_CANARY");
    expect(history).toContain("Saved plan: review changed files by CODEOWNERS");
    const packet = JSON.parse(history!.split("\n").at(-1)!);
    expect(packet.entries).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: "document", id: workflowDocumentId, key: "workflow", revisionId: workflowRevisionId,
      body: 'Read this task\'s workflow instructions with read_document using key "workflow" before choosing the next phase.',
      readPath: `/api/issues/${issueId}/documents/workflow`, truncated: false,
    })]));
    const input = buildNativeExecutionInput({
      companyId, runId: randomUUID(), agentId, normalizedSessionId: "session", conversationMode: true,
      issue: { id: issueId, identifier: "HAND-1", title: "Chat", description: null, workMode: "standard" },
      taskPrompt: "Continue the current phase", freshSessionHandoff: history,
      workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      completionContract: { id: "contract", sha256: "a".repeat(64), schemaVersion: "paperclip.run-result.v1", contract: {
        revision: "1", objective: "Follow the workflow", criteria: [{ id: "objective", requirement: "Follow the workflow" }],
      } }, runtimeContext: nativeRuntimeContextFixture(),
    });
    const fresh = buildNativeModelEnvelope(input);
    expect(fresh.task.prompt).toContain(workflowRevisionId);
    expect(fresh.task.prompt).not.toContain("WORKFLOW_BODY_CANARY");
    const resumed = buildNativeModelEnvelope(input, { resumedSession: true });
    expect("task" in resumed && resumed.task.prompt).not.toContain(workflowRevisionId);
    // A failed provider resume uses the same cached history and full envelope.
    expect(await load()).toBe(history);
    const fallback = buildNativeModelEnvelope(input);
    expect(fallback.task.prompt).toContain(`/api/issues/${issueId}/documents/workflow`);
    expect(fallback.task.prompt).not.toContain("WORKFLOW_BODY_CANARY");
  });

  it("loads and redacts history once only when a fresh attempt requests it", async () => {
    const select = vi.spyOn(db, "select");
    try {
      const load = createNativeSessionHandoffLoader({ db, companyId, issueId, agentId, before: new Date(20_000) });
      expect(select).not.toHaveBeenCalled();
      const first = await load();
      const reads = select.mock.calls.length;
      expect(reads).toBeGreaterThan(0);
      expect(await load()).toBe(first);
      expect(select).toHaveBeenCalledTimes(reads);
    } finally { select.mockRestore(); }
  });

  it("retains a prior run's quarantine after the current agent and task use standard policy", async () => {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", nativeIssueId: issueId,
      contextSnapshot: { issueId, conversationSessionGeneration: 2, executionPolicy: {
        trustPreset: "low_trust_review", authorizationPolicy: { trustPreset: "low_trust_review",
          trustBoundary: { mode: "low_trust_review", companyId, issueIds: [issueId] } },
      } }, createdAt: new Date(16_000), finishedAt: new Date(18_000),
      runnerProfileJson: { sessionCheckpoint: { semanticResult: { summary: "QUARANTINED RUN SUMMARY" } } } });
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId, seq: 1, eventType: "item.completed", createdAt: new Date(17_000),
      payload: { prpEvent: { payload: { kind: "agentMessage", channel: "final", text: "QUARANTINED RUN REPLY" } } } });
    const result = await buildNativeSessionHandoff({ db, companyId, issueId, agentId, before: new Date(20_000) });
    expect(result).not.toContain("QUARANTINED RUN REPLY");
    expect(result).not.toContain("QUARANTINED RUN SUMMARY");
    expect(result).toContain("Quarantined low-trust output omitted");
    expect(result).toContain(runId);
  });
});

(support.supported ? describe : describe.skip)("fresh handoff beside a full-history wake", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), documentId = randomUUID();
  const description = "## Objective\n\nShip the ledger export with per-row audit trails.\n\n## Acceptance Criteria\n\n- Export runs nightly";
  const comments = Array.from({ length: 8 }, (_, i) => ({
    id: randomUUID(), body: `COMMENT_${i}: ` + "detail ".repeat(300), authorUserId: i % 2 ? null : "user", authorAgentId: i % 2 ? agentId : null,
    createdAt: new Date(1_000 + i * 1_000),
  }));
  const lateComment = { id: randomUUID(), body: "LATE_COMMENT_NOT_IN_WAKE", authorUserId: "user", createdAt: new Date(12_000) };
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-native-handoff-dedupe-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Dedupe", issuePrefix: "DEDU" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Leo", role: "general", adapterType: "claude_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Ledger export", description, status: "in_progress", assigneeAgentId: agentId });
    await db.insert(issueComments).values([...comments, lateComment].map((comment) => ({ companyId, issueId, ...comment })));
    await db.insert(documents).values({ id: documentId, companyId, latestBody: "PLAN_BODY: nightly job then audit table", updatedAt: new Date(5_000) });
    await db.insert(issueDocuments).values({ companyId, issueId, documentId, key: "plan", createdAt: new Date(5_000) });
  });
  afterAll(async () => database?.cleanup());

  const wakeFor = (messages: typeof comments) => {
    const executionContinuation = {
      version: 1, companyId, issueId, trigger: { reason: "issue_assigned", interactionId: null, sourceRunId: null }, originCommentIds: [],
      objective: description, objectiveSource: { kind: "description", id: issueId, revision: "rev" },
      messages: messages.map((comment) => ({ id: comment.id, authorType: comment.authorAgentId ? "agent" : "user", authorId: comment.authorAgentId ?? comment.authorUserId,
        body: comment.body, createdAt: comment.createdAt.toISOString(), updatedAt: comment.createdAt.toISOString(), deleted: false, sourceTrust: null })),
      humanResponses: [], interactionOutcomes: [], completedWork: null, unresolvedInteractionIds: [],
      coverage: { kind: "full_task_history", throughCommentId: messages.at(-1)!.id, summaryThroughCommentId: null },
    };
    return { reason: "issue_assigned", issue: { id: issueId, identifier: "DEDU-1", title: "Ledger export", description, status: "in_progress" }, executionContinuation };
  };
  const renderPrompt = (wake: unknown, handoff: string | null) => {
    const { taskContextNote, wakePrompt } = selectPaperclipPromptSections({
      paperclipTaskMarkdownAssignment: `Issue description:\n${description}`,
      paperclipFreshSessionHandoffMarkdown: handoff ?? undefined,
      paperclipWake: wake,
    });
    return `${taskContextNote}\n\n${wakePrompt}`;
  };
  const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

  it("serializes each comment body once and shrinks the fresh prompt", async () => {
    const wake = wakeFor(comments);
    const before = new Date(20_000);
    const full = await buildNativeSessionHandoff({ db, companyId, issueId, agentId, before });
    const deduped = await createNativeSessionHandoffLoader({ db, companyId, issueId, agentId, before,
      currentRequestCommentIds: () => currentRequestHistoryCommentIds(wake) })();
    const fullPrompt = renderPrompt(wake, full);
    const dedupedPrompt = renderPrompt(wake, deduped);
    // Baseline: the old handoff repeated every recent comment.
    expect(occurrences(fullPrompt, "COMMENT_7: ")).toBe(2);
    for (const comment of comments) expect(occurrences(dedupedPrompt, comment.body)).toBe(1);
    // Comments the wake does not carry, documents and retrieval pointers stay.
    expect(deduped).toContain("LATE_COMMENT_NOT_IN_WAKE");
    expect(deduped).toContain("PLAN_BODY");
    expect(deduped).toContain("get_task_history");
    expect(JSON.parse(deduped!.split("\n").at(-1)!)).toMatchObject({ commentsInCurrentRequest: comments.length, truncated: false, omittedEntriesAtLeast: 0 });
    const saved = Buffer.byteLength(fullPrompt) - Buffer.byteLength(dedupedPrompt);
    expect(saved).toBeGreaterThan(comments.reduce((total, comment) => total + comment.body.length, 0) / 2);
  });

  it("keeps the full comment replay when the wake has no full-history envelope", async () => {
    const wake = { ...wakeFor(comments), executionContinuation: { ...wakeFor(comments).executionContinuation, coverage: { kind: "task_history_delta" } } };
    const load = createNativeSessionHandoffLoader({ db, companyId, issueId, agentId, before: new Date(20_000),
      currentRequestCommentIds: () => currentRequestHistoryCommentIds(wake) });
    const history = await load();
    expect(history).toContain("COMMENT_7: ");
    expect(history).not.toContain("commentsInCurrentRequest");
  });

  it("returns no handoff when the wake already carries every history entry", async () => {
    const all = [...comments, lateComment as typeof comments[number]];
    await db.delete(issueDocuments).where((await import("drizzle-orm")).eq(issueDocuments.issueId, issueId));
    const history = await buildNativeSessionHandoff({ db, companyId, issueId, agentId, before: new Date(20_000),
      currentRequestCommentIds: [...all.map(({ id }) => id), "not-a-uuid"] });
    expect(history).toBeNull();
  });
});
