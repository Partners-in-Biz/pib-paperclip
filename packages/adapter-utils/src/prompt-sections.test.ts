import { describe, expect, it } from "vitest";
import {
  boundContinuationHistory,
  CONTINUATION_HISTORY_MAX_BYTES,
  CONTINUATION_HISTORY_MAX_MESSAGES,
  omitContinuationSummarySectionsInBrief,
  selectPaperclipPromptSections as selectSections,
} from "./server-utils.js";
import { createPromptContextFixture } from "./test-fixtures/prompt-context.js";

describe("task and event section ownership", () => {
  it("preserves resumed wake data without reintroducing generic procedures", () => {
    const context = createPromptContextFixture();
    for (const includeExecutionContract of [undefined, false, true]) {
      const sections = selectSections(context, { resumedSession: true, includeExecutionContract });
      expect(sections.taskContextNote).toBe(context.paperclipTaskMarkdownAssignmentCompact);
      expect(sections.wakePrompt).toContain('"id":"comment-second"');
      expect(sections.wakePrompt).not.toContain("Execution contract:");
    }
  });

  it("preserves user repetition and distinct same-body comments under their source owners", () => {
    const context = createPromptContextFixture();
    const { taskContextNote, wakePrompt } = selectSections(context);
    expect(taskContextNote).toContain(context.paperclipTaskMarkdownAssignment);
    expect(taskContextNote).toContain(context.paperclipWake.issue.description);
    expect(taskContextNote).not.toContain("comment-first");
    expect(wakePrompt).not.toContain(context.paperclipWake.issue.description);
    expect(wakePrompt).not.toContain('"objective":');
    expect(wakePrompt).toContain('"objectiveSource":{"kind":"description","id":"issue-1"');
    for (const message of context.executionContinuation.messages) {
      expect(wakePrompt).toContain(`"id":"${message.id}"`);
      expect(wakePrompt).toContain(message.body);
    }
    expect(wakePrompt.indexOf('"id":"comment-first"')).toBeLessThan(wakePrompt.indexOf('"id":"comment-second"'));
    expect(wakePrompt.indexOf('"id":"comment-second"')).toBeLessThan(wakePrompt.indexOf('"id":"comment-scope"'));
    expect(wakePrompt).toContain('"sourceTrust":"human"');
    expect(wakePrompt).toContain("Untrusted continuation evidence");
    expect(wakePrompt).toContain("receipt-1");
    expect(wakePrompt).toContain("Do not repeat completed actions");
  });

  it("reselects full bootstrap and history when the attempt becomes fresh", () => {
    const context = createPromptContextFixture();
    const resumed = selectSections(context, { resumedSession: true });
    expect(resumed.taskContextNote).toBe(context.paperclipTaskMarkdownAssignmentCompact);
    expect(resumed.wakePrompt).not.toContain('"id":"comment-first"');
    const fresh = selectSections(context, { resumedSession: false });
    expect(fresh.taskContextNote).toContain(context.paperclipTaskCommunicationGuidance);
    expect(fresh.taskContextNote).toContain(context.paperclipTaskMarkdownAssignment);
    expect(fresh.wakePrompt).toContain('"id":"comment-first"');
    expect(context.executionContinuation.messages).toHaveLength(3);
  });

  it("retains old input fields and the wake description when no assignment was provided", () => {
    const context = createPromptContextFixture();
    expect(selectSections({ paperclipTaskMarkdown: "Legacy assignment" }).taskContextNote).toBe("Legacy assignment");
    const sections = selectSections({ paperclipWake: context.paperclipWake });
    expect(sections.taskContextNote).toBe("");
    expect(sections.wakePrompt).toContain(context.paperclipWake.issue.description);
  });
});

describe("continuation summary beside the issue brief", () => {
  const objective = "Ship the ledger export with per-row audit trails and a nightly schedule.";
  const criteria = "- Export runs nightly\n- Every row links to its audit entry";
  const description = `## Objective\n\n${objective}\n\n## Acceptance Criteria\n\n${criteria}`;
  const summary = [
    "# Continuation Summary", "", "- Issue: PAP-1 — Release ledger", "",
    "## Objective", "", objective, "",
    "## Acceptance Criteria", "", criteria, "",
    "## Next Action", "", "- Write the export job",
  ].join("\n");
  const contextWith = (summaryBody: string) => {
    const context = createPromptContextFixture();
    return {
      ...context,
      paperclipTaskMarkdownAssignment: `## Owned assignment\n\nIssue description:\n${description}`,
      paperclipWake: {
        ...context.paperclipWake,
        issue: { ...context.paperclipWake.issue, description },
        continuationSummary: { key: "continuation-summary", title: "Continuation Summary", body: summaryBody },
      },
    };
  };

  it("renders the brief once and keeps the summary's own sections", () => {
    const { taskContextNote, wakePrompt } = selectSections(contextWith(summary));
    const prompt = `${taskContextNote}\n${wakePrompt}`;
    expect(prompt.split(objective)).toHaveLength(2);
    expect(prompt.split("Every row links to its audit entry")).toHaveLength(2);
    expect(wakePrompt).toContain("## Objective\n\n(Same as the issue description in this prompt; not repeated.)");
    expect(wakePrompt).toContain("## Next Action\n\n- Write the export job");
    expect(wakePrompt).toContain("- Issue: PAP-1 — Release ledger");
    const unchanged = `${taskContextNote}\n${wakePrompt.replace("(Same as the issue description in this prompt; not repeated.)", objective)}`;
    expect(Buffer.byteLength(prompt)).toBeLessThan(Buffer.byteLength(unchanged));
  });

  it("keeps a section that is not in the brief, and every section when no brief is shown", () => {
    const agentWritten = summary.replace(objective, "Agent-revised objective: export only finance rows after the scope change.");
    expect(selectSections(contextWith(agentWritten)).wakePrompt).toContain("Agent-revised objective: export only finance rows");
    expect(omitContinuationSummarySectionsInBrief(summary, ["", ""])).toBe(summary);
  });

  it("matches a summary objective that the server truncated", () => {
    const long = "Long objective sentence. ".repeat(80).trim();
    const truncated = summary.replace(objective, `${long.slice(0, 1_180).trimEnd()}\n[truncated]`);
    const result = omitContinuationSummarySectionsInBrief(truncated, [`## Objective\n\n${long}`]);
    expect(result).not.toContain("Long objective sentence.");
    expect(result).toContain("## Next Action");
  });
});

describe("turn-1 history cap", () => {
  const message = (index: number, overrides: Record<string, unknown> = {}) => ({
    id: `comment-${index}`, authorType: index % 2 ? "agent" : "user", authorId: index % 2 ? "agent-1" : "user-1",
    createdByRunId: null, body: `BODY_${index}_END ` + "x".repeat(400), createdAt: "2026-11-19T00:00:00.000Z",
    updatedAt: "2026-11-19T00:00:00.000Z", deleted: false, sourceTrust: index % 2 ? "agent" : "human", ...overrides,
  });
  const longThread = (count: number, overrides: (index: number) => Record<string, unknown> = () => ({})) => {
    const context = createPromptContextFixture();
    const messages = Array.from({ length: count }, (_, index) => message(index, overrides(index)));
    const executionContinuation = {
      ...context.executionContinuation, messages, originCommentIds: [messages.at(-1)!.id],
      humanResponses: [{ id: "answer-1", kind: "question", status: "answered", resolvedByUserId: "user-1", resolvedAt: "2026-11-19T00:00:00.000Z", result: { answer: "ship it" } }],
      unresolvedInteractionIds: ["pending-1"],
      coverage: { kind: "full_task_history" as const, throughCommentId: messages.at(-1)!.id, summaryThroughCommentId: null },
    };
    return { ...context, executionContinuation, paperclipWake: { ...context.paperclipWake, executionContinuation } };
  };

  it("lists at most the cap on a fresh prompt and points to older history", () => {
    const context = longThread(200);
    const { wakePrompt } = selectSections(context);
    const listed = context.executionContinuation.messages.filter((entry) => wakePrompt.includes(`BODY_${entry.id.slice(8)}_END`));
    expect(listed.length).toBeLessThanOrEqual(CONTINUATION_HISTORY_MAX_MESSAGES + 2);
    expect(wakePrompt).toContain("BODY_199_END");
    // The original request stays even though it is the oldest message.
    expect(wakePrompt).toContain("BODY_0_END");
    expect(wakePrompt).not.toContain("BODY_100_END");
    expect(wakePrompt).toContain('"historyWindow":{"omittedMessages":');
    expect(wakePrompt).toContain("get_task_history");
    expect(wakePrompt).toContain('"humanResponses":[{"id":"answer-1"');
    expect(wakePrompt).toContain('"unresolvedInteractionIds":["pending-1"]');
    expect(wakePrompt).toContain("Untrusted continuation evidence");
    expect(Buffer.byteLength(wakePrompt)).toBeLessThan(CONTINUATION_HISTORY_MAX_BYTES * 2);
  });

  it("keeps the byte budget for few large messages", () => {
    const context = longThread(10, () => ({ body: "y".repeat(9_000) }));
    const window = boundContinuationHistory(context.executionContinuation);
    expect(window.omitted?.omittedMessages).toBeGreaterThan(0);
    const unpinned = window.messages.filter((entry) => entry.id !== "comment-0" && entry.id !== "comment-8" && entry.id !== "comment-6" && entry.id !== "comment-4" && entry.id !== "comment-9");
    expect(unpinned).toHaveLength(0);
    expect(window.omitted?.omittedThroughCommentId).toBe("comment-7");
  });

  it("always keeps the latest human messages, trigger comments and comment objective", () => {
    const context = longThread(60, (index) => (index < 50 && index % 2 === 0 ? { createdByRunId: "run-1" } : {}));
    const window = boundContinuationHistory({ ...context.executionContinuation, originCommentIds: ["comment-20"],
      objectiveSource: { kind: "comment", id: "comment-30", revision: "r" } }, { maxMessages: 2, maxBytes: 100 });
    const ids = window.messages.map((entry) => entry.id);
    expect(ids).toEqual(expect.arrayContaining(["comment-20", "comment-30", "comment-54", "comment-56", "comment-58"]));
    // Run-authored user comments are not human direction and are not pinned.
    expect(ids).not.toContain("comment-0");
    expect(ids).toEqual([...ids].sort((a, b) => Number(a.slice(8)) - Number(b.slice(8))));
  });

  it("leaves short histories and resumed deltas unchanged", () => {
    const context = createPromptContextFixture();
    expect(boundContinuationHistory(context.executionContinuation).omitted).toBeNull();
    expect(selectSections(context).wakePrompt).not.toContain("historyWindow");
    const long = longThread(200);
    const resumed = selectSections({ ...long, paperclipWake: { ...long.paperclipWake, executionContinuation: {
      ...long.executionContinuation, resumeDelta: { baseRunId: "prior-run", messages: long.executionContinuation.messages.slice(-2) } } } },
    { resumedSession: true });
    expect(resumed.wakePrompt).not.toContain("historyWindow");
    expect(resumed.wakePrompt).toContain("BODY_199_END");
  });
});
