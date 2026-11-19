import { describe, expect, it } from "vitest";
import { omitContinuationSummarySectionsInBrief, selectPaperclipPromptSections as selectSections } from "./server-utils.js";
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
